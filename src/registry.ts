import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientInfo } from "./clients.js";
import { mailboxHasMessages, migrateMailbox } from "./mailbox.js";

export type StateCard = {
  purpose: string | null;
  updated_at: number;
};

export type RegistryEntry = {
  server_pid: number;
  started_at: number;
  client: ClientInfo;
  tmux_pane: string | null;
  tmux_session: string | null;
  state: StateCard | null;
  capabilities?: RegistryCapabilities;
};

export type RegistryCapabilities = {
  mailbox?: {
    reply_to?: boolean;
    provenance?: boolean;
    push_budget?: boolean;
  };
};

export const CURRENT_CAPABILITIES: RegistryCapabilities = {
  mailbox: {
    reply_to: true,
    provenance: true,
    push_budget: true,
  },
};

// Lazy so tests can swap HOME between cases; homedir() defers to $HOME on POSIX.
function registryDir(): string {
  return join(homedir(), ".oxtail", "sessions");
}

function ensureDir(): void {
  const dir = registryDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return;
  }
  // Migration: tighten perms for users upgrading from <0.4.0, where the dir
  // and entries were created at default umask (typically 0o755 / 0o644).
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not our dir or fs doesn't support; leave it
  }
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      chmodSync(join(dir, file), 0o600);
    } catch {
      // ignore
    }
  }
}

function entryPath(pid: number): string {
  return join(registryDir(), `${pid}.json`);
}

function resolveTmuxSessionFromPane(pane: string | null): string | null {
  if (!pane) return null;
  try {
    const out = execFileSync("tmux", ["display-message", "-p", "-t", pane, "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const name = out.trim();
    return name || null;
  } catch {
    return null;
  }
}

function listTmuxPanePids(): Map<number, string> {
  try {
    const out = execFileSync("tmux", ["list-panes", "-a", "-F", "#{pane_pid}|#{pane_id}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const map = new Map<number, string>();
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [pidStr, paneId] = line.split("|");
      const pid = Number(pidStr);
      if (Number.isFinite(pid) && pid > 0 && paneId) map.set(pid, paneId);
    }
    return map;
  } catch {
    return new Map();
  }
}

function listAllPpids(): Map<number, number> {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const map = new Map<number, number>();
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (Number.isFinite(pid) && Number.isFinite(ppid)) map.set(pid, ppid);
    }
    return map;
  } catch {
    return new Map();
  }
}

// Walk pid → ppid until we hit a process that tmux registered as a pane_pid
// (typically the shell tmux forked into the pane). Lets us recover tmux_pane
// when the immediate parent stripped TMUX_PANE from our env — Codex does this,
// and any future MCP host that scrubs env vars would too.
export function findTmuxPaneByAncestry(
  startPid: number,
  panePids: Map<number, string>,
  ppids: Map<number, number>,
): string | null {
  if (panePids.size === 0) return null;
  let pid: number | undefined = startPid;
  for (let i = 0; i < 64 && pid !== undefined && pid > 1; i++) {
    const paneId = panePids.get(pid);
    if (paneId) return paneId;
    pid = ppids.get(pid);
  }
  return null;
}

export function resolveTmuxPane(env: NodeJS.ProcessEnv = process.env, pid = process.pid): string | null {
  if (env.TMUX_PANE) return env.TMUX_PANE;
  return findTmuxPaneByAncestry(pid, listTmuxPanePids(), listAllPpids());
}

// Resolve the tmux pane currently hosting a given server pid by walking the
// process tree. Unlike resolveTmuxPane(), this does NOT trust env vars — it
// queries live tmux + ps state. Used by the ask_peer wake path to detect a
// stale cached tmux_pane: if a peer's pane was killed and its pane_id reused
// by an unrelated pane, the cached id no longer points at our peer. Returns
// null if the server pid is no longer in any tmux pane's process tree.
export function currentPaneForServerPid(serverPid: number): string | null {
  return findTmuxPaneByAncestry(serverPid, listTmuxPanePids(), listAllPpids());
}

export function buildEntry(client: ClientInfo, env = process.env): RegistryEntry {
  const tmux_pane = resolveTmuxPane(env);
  return {
    server_pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
    client,
    tmux_pane,
    tmux_session: resolveTmuxSessionFromPane(tmux_pane),
    state: null,
    capabilities: CURRENT_CAPABILITIES,
  };
}

export function refreshTmuxBinding(entry: RegistryEntry): void {
  const tmux_pane = resolveTmuxPane();
  entry.tmux_pane = tmux_pane;
  entry.tmux_session = resolveTmuxSessionFromPane(tmux_pane);
}

export function register(entry: RegistryEntry): void {
  ensureDir();
  // PUBLICATION ORDER (per Codex review): write OUR registry breadcrumb BEFORE
  // touching dead siblings. gcDeadSiblings() migrates a dead sibling's mail into
  // entry.server_pid's mailbox and then unlinks that sibling's registry file; if
  // we GC'd first, a crash after the migration but before our own file existed
  // would leave the migrated mail in ${entry.server_pid}.jsonl with NO registry
  // breadcrumb for either pid — invisible to sessionPidsForId / the union-drain.
  // Publishing first guarantees a dead-but-claimed breadcrumb for our pid
  // survives such a crash, so readAll()'s reap-deferral keeps the mail reachable.
  //
  // Temp file + atomic rename. Concurrent peers running readAll() can otherwise
  // catch a torn write, fail JSON.parse, and silently drop the entry until the
  // next write completes.
  const final = entryPath(entry.server_pid);
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(entry, null, 2), { mode: 0o600 });
    renameSync(tmp, final);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone, fine
    }
    throw err;
  }
  // Now that our breadcrumb is published, consolidate + GC dead siblings: drop
  // stale entries from dead processes that share our session_id (accumulate when
  // oxtail is configured in multiple MCP scopes — user + project), migrating any
  // undrained mail into us first. Leaves live siblings alone; readAll() collapses
  // those by session_id.
  gcDeadSiblings(entry);
}

function gcDeadSiblings(entry: RegistryEntry): void {
  const sid = entry.client.session_id;
  if (!sid) return;
  const dir = registryDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const full = join(dir, file);
    let other: RegistryEntry;
    try {
      other = JSON.parse(readFileSync(full, "utf8")) as RegistryEntry;
    } catch {
      continue;
    }
    if (other.server_pid === entry.server_pid) continue;
    if (other.client.session_id !== sid) continue;
    if (isAlive(other.server_pid)) continue;
    // Consolidate before dropping: a peer may have enqueued to this dead
    // sibling's pid mailbox before we (the restarted/sibling child) registered.
    // Move that undrained mail into our own mailbox — same session_id, same
    // agent identity — so the message survives the pid rotation instead of
    // being orphaned with the registry file. Best-effort; never blocks register.
    try {
      migrateMailbox(other.server_pid, entry.server_pid);
    } catch {
      // migration is best-effort; we decide below whether to drop the breadcrumb
    }
    // Only drop the registry file once the dead sibling's mailbox is actually
    // empty. If migration failed, or a send raced in after migrate read it, the
    // mail is still there — keep the file so the session union-drain
    // (read_my_messages / hook) can still reach it; readAll() reap-deferral and
    // a later register() retry the consolidation.
    let stillHasMail = true;
    try {
      stillHasMail = mailboxHasMessages(other.server_pid);
    } catch {
      stillHasMail = true; // conservative: keep the breadcrumb on uncertainty
    }
    if (!stillHasMail) {
      try {
        unlinkSync(full);
      } catch {
        // already gone, fine
      }
    }
  }
}

export function unregister(pid = process.pid): void {
  try {
    unlinkSync(entryPath(pid));
  } catch {
    // already gone, fine
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

export function readAll(): RegistryEntry[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  const live: RegistryEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const full = join(dir, file);
    let entry: RegistryEntry;
    try {
      entry = JSON.parse(readFileSync(full, "utf8")) as RegistryEntry;
    } catch {
      continue;
    }
    if (!isAlive(entry.server_pid)) {
      // Reap-deferral: a dead child's mailbox may still hold undrained mail
      // that the session's union-drain (PreToolUse hook + read_my_messages)
      // must reach. Keep the registry file as a routing breadcrumb until the
      // mailbox is empty — but ONLY for a claimed (non-null session_id) entry:
      // a null-session dead child is not identity-addressable, so retaining it
      // would only grow ambiguity. Either way it is excluded from `live`.
      const keepForMail =
        entry.client.session_id != null && mailboxHasMessages(entry.server_pid);
      if (!keepForMail) {
        try {
          unlinkSync(full);
        } catch {
          // ignore
        }
      }
      continue;
    }
    live.push(entry);
  }
  return dedupeBySessionId(live);
}

// One Claude/Codex session can be backed by multiple MCP server children when
// oxtail is declared in more than one MCP scope (e.g. user-level config +
// project `.mcp.json`). Each child registers separately, so the registry ends
// up with N entries that share the same client.session_id. session_id is the
// unique agent identity downstream (resolver UUID lookup, peer messaging),
// so collapse the duplicates here. Keep the freshest by started_at — that's
// the most likely to have an up-to-date transcript path and tmux binding.
// Entries with no session_id are left alone: they're either pre-claim
// (haven't called claim_session yet) or unclaimed peers, and conflating
// them would be wrong.
export function dedupeBySessionId(entries: RegistryEntry[]): RegistryEntry[] {
  const winnerBySession = new Map<string, RegistryEntry>();
  const noSession: RegistryEntry[] = [];
  for (const e of entries) {
    const sid = e.client.session_id;
    if (!sid) {
      noSession.push(e);
      continue;
    }
    const prior = winnerBySession.get(sid);
    if (!prior || e.started_at > prior.started_at) {
      winnerBySession.set(sid, e);
    }
  }
  return [...winnerBySession.values(), ...noSession];
}

export function findByTmuxSession(name: string): RegistryEntry[] {
  return readAll().filter((e) => e.tmux_session === name);
}

// Every MCP-child pid that has a registry file on disk under this session_id,
// live or dead, WITHOUT reaping or liveness filtering — oldest-first by
// started_at. Mirrors the PreToolUse hook's session_id→pid grep
// (assets/pretooluse.sh) so read_my_messages can drain the same union: a
// message enqueued to a prior/sibling pid stays reachable (via reap-deferral)
// until that pid's mail is drained or migrated. Oldest-first so a dead sibling's
// older orphaned mail is drained ahead of the current child's newer mail;
// read_my_messages still re-sorts the merged result chronologically.
export function sessionPidsForId(sessionId: string): number[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  const entries: RegistryEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    let e: RegistryEntry;
    try {
      e = JSON.parse(readFileSync(join(dir, file), "utf8")) as RegistryEntry;
    } catch {
      continue;
    }
    if (e.client.session_id === sessionId) entries.push(e);
  }
  entries.sort((a, b) => a.started_at - b.started_at);
  return entries.map((e) => e.server_pid);
}

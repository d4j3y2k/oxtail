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
import {
  gcDeliveryArtifacts,
  gcOrphanMailboxes,
  mailboxHasMessages,
  mailboxSessionKey,
  migrateMailbox,
} from "./mailbox.js";

export type StateCard = {
  purpose: string | null;
  updated_at: number;
};

export type RegistryEntry = {
  server_pid: number;
  started_at: number;
  // The server process's OS start-time signature, captured at register time.
  // Lets a reader detect pid reuse: a recycled pid (now an unrelated process)
  // has a different start time even though the stale on-disk entry is unchanged.
  // Optional for backward compat with entries written before this field existed.
  proc_sig?: string;
  client: ClientInfo;
  // Precomputed session-box filename stem (mailboxSessionKey of
  // client.session_id; null pre-claim). Stored so the bash hooks can read the
  // key from the registry file they already grep — they must NEVER re-derive it
  // (single named protocol primitive, per Codex review). register() recomputes
  // it on every write, so it can't go stale against session_id.
  mailbox_key?: string | null;
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
    // v0.17+: this peer drains its SESSION box (mailboxSessionKey-keyed), so
    // senders should deliver there. Absent/false = pre-v0.17 reader that only
    // drains pid boxes — senders must fall back to the legacy pid path or the
    // message would never be seen.
    session_keyed?: boolean;
    // v0.19+: this peer understands durable-delegation OBLIGATIONS — it surfaces
    // open_work_count / my_open_work and closes via complete_work / block_work.
    // Absent/false = a pre-v0.19 peer that has no such tools, so a sender's
    // action_required can't become an actionable obligation there; the send
    // degrades to ordinary mail (obligation_durable:false), never a silent
    // phantom-obligation the peer can't see or close.
    obligations?: boolean;
  };
};

export const CURRENT_CAPABILITIES: RegistryCapabilities = {
  mailbox: {
    reply_to: true,
    provenance: true,
    push_budget: true,
    session_keyed: true,
    obligations: true,
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

// tmux's own identifiers, used to sanitize registry-sourced values before they
// reach a `tmux` command. A pane id is always `%<n>`; a session name, per tmux's
// rules for names we create, is `[A-Za-z0-9_-]+`. Validating defends against a
// malicious local peer writing a crafted `tmux_pane`/`tmux_session` into its own
// registry file to redirect or trick our wake send-keys (issue #6).
export function isValidTmuxPane(s: string): boolean {
  return /^%\d+$/.test(s);
}

export function isValidTmuxSession(s: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(s);
}

// The ONLY trustworthy send-keys target for waking a peer: the pane the live
// process tree says currently hosts the peer's `server_pid`. This is computed
// from `ps`/`tmux` state (currentPaneForServerPid), so it cannot be forged by a
// peer editing its own `~/.oxtail/sessions/<pid>.json` — unlike the cached
// `tmux_pane`/`tmux_session` fields, which the peer self-writes. Returns null
// (caller must refuse to wake) when:
//   - the peer never registered a pane: a legit tmux-hosted peer always does
//     (its session is derived from the pane), so a pane-less/session-only entry
//     is hand-written or spoofed and must never be blind-fired; gating on a
//     registered pane also avoids fishing for a pane from server_pid alone,
//     which in tests can collide with the test runner's own pane.
//   - server_pid isn't under any live tmux pane: we can't bind a trustworthy
//     target, so we refuse rather than fall back to the self-written cached value.
//   - the resolved pane isn't a well-formed pane id (tmux output anomaly).
// resolvePane is injected in tests; production uses currentPaneForServerPid.
export function chooseVerifiedWakePane(
  peer: { tmux_pane: string | null; server_pid: number; proc_sig?: string },
  resolvePane: (serverPid: number) => string | null = currentPaneForServerPid,
  resolveSig: (pid: number) => string = processStartSig,
): string | null {
  if (!peer.tmux_pane) return null;
  // PID-reuse guard: if the entry recorded the server process's start-time
  // signature, confirm the live pid is STILL that process before resolving and
  // waking its pane. Otherwise an OS-recycled pid — now an unrelated process
  // that happens to sit under a different tmux pane — would resolve to, and get
  // our wake keystrokes typed into, a stranger's pane (M3). Only refuse on a
  // positively-different signature; an empty reading (transient ps failure)
  // falls through to pane resolution, which fails closed for a truly dead pid.
  if (peer.proc_sig) {
    const liveSig = resolveSig(peer.server_pid);
    if (liveSig && liveSig !== peer.proc_sig) return null;
  }
  const live = resolvePane(peer.server_pid);
  if (!live || !isValidTmuxPane(live)) return null;
  return live;
}

// Extract the pid a registry filename encodes: `<pid>.json` → pid, else null.
export function filenamePid(file: string): number | null {
  const m = /^(\d+)\.json$/.exec(file);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Read + parse a registry file, enforcing the provenance invariant that a
// process only ever writes its OWN `<pid>.json`: the parsed `server_pid` MUST
// equal the pid in the filename. register() always writes them in agreement, so
// a mismatch means the entry was hand-forged to borrow another process's pid —
// the #6 redirect where a peer self-writes `server_pid: <victimPid>` so that
// chooseVerifiedWakePane → currentPaneForServerPid resolves (and wakes) the
// victim's pane. Such entries, plus non-`<pid>.json` names and parse failures,
// are rejected (returns null) so no raw-registry reader trusts them. The
// local-user trust boundary still holds (a same-user process can overwrite any
// file), but this stops one peer's entry from impersonating another pid.
export function readEntryFile(dir: string, file: string): RegistryEntry | null {
  const fnamePid = filenamePid(file);
  if (fnamePid === null) return null;
  let entry: RegistryEntry;
  try {
    entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as RegistryEntry;
  } catch {
    return null;
  }
  if (entry.server_pid !== fnamePid) return null;
  return entry;
}

// Re-read a single pid's on-disk entry, enforcing the same filename/server_pid
// provenance rule as readEntryFile. Used for freshness checks against a cached
// in-memory entry: PID-reuse guards (compare started_at/proc_sig) and the
// legacy-send breadcrumb re-check in delivery.ts.
export function entryForPid(pid: number): RegistryEntry | null {
  return readEntryFile(registryDir(), `${pid}.json`);
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
  // TMUX_PANE is a peer-controllable env var: only trust it if it has tmux's
  // pane-id shape (%N). A spoofed/malformed value falls through to process-tree
  // ancestry, which can't be forged by editing the environment (issue #6).
  if (env.TMUX_PANE && isValidTmuxPane(env.TMUX_PANE)) return env.TMUX_PANE;
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

// Resolve, in ONE batched pass, which of the given server pids currently OWN a live
// tmux pane — i.e. which agents `jump`/nudge/wake can actually reach. Uses the SAME
// process-subtree ancestry signal as currentPaneForServerPid / chooseVerifiedWakePane,
// but computes the pane-pid + ppid maps ONCE and reuses them for every pid, so it
// stays a single `tmux list-panes` + single `ps` regardless of fleet size (calling
// chooseVerifiedWakePane per agent re-execs BOTH on every call). Empty set when tmux
// is absent / has no panes. The cockpit uses this to separate real, navigable fleet
// windows from DETACHED background processes — registered MCP children and `codex
// exec` subprocesses that own a registry entry but live in no tmux pane, so a jump to
// them can only ever fail "couldn't verify a live pane".
export function resolveJumpablePids(serverPids: Iterable<number>): Set<number> {
  const panePids = listTmuxPanePids();
  const out = new Set<number>();
  if (panePids.size === 0) return out; // tmux absent / no panes — nothing is jumpable
  const ppids = listAllPpids();
  for (const pid of serverPids) {
    const pane = findTmuxPaneByAncestry(pid, panePids, ppids);
    if (pane && isValidTmuxPane(pane)) out.add(pid);
  }
  return out;
}

// The OS start-time signature (lstart) of a process, or "" if it can't be read
// (dead pid, or ps unavailable). Same provenance signal claims.ts uses on
// ancestor pids: an OS-recycled pid yields a DIFFERENT start time, so comparing
// a live pid's signature against one captured at register time detects pid reuse
// — distinguishing "our process is still alive" from "the pid now belongs to an
// unrelated process."
export function processStartSig(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

// A process's start time never changes, so capture our own once and reuse it.
let cachedSelfProcSig: string | undefined;
function selfProcSig(): string {
  if (cachedSelfProcSig === undefined) cachedSelfProcSig = processStartSig(process.pid);
  return cachedSelfProcSig;
}

export function buildEntry(client: ClientInfo, env = process.env): RegistryEntry {
  const tmux_pane = resolveTmuxPane(env);
  return {
    server_pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
    proc_sig: selfProcSig(),
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
  // Recompute the session-box key on every write so it can never drift from
  // client.session_id (claim_session, sticky recovery, and handshake refinement
  // all mutate session_id and then re-register).
  entry.mailbox_key = entry.client.session_id
    ? mailboxSessionKey(entry.client.session_id)
    : null;
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
  // Finally sweep mailbox files nothing can route to anymore (empty + old +
  // unreferenced) — registry reaping removes the breadcrumbs but used to leave
  // the 0-byte box files behind forever. register() also re-fires on claim /
  // sticky refinement / state updates, so this runs more than once per server
  // lifetime; that's fine — it's bounded to old empty orphans and the rescan
  // is a cheap readdir when there's nothing to do (Codex round-2 wording nit).
  gcOrphanMailboxesFromRegistry();
}

// Build the referenced-box sets from the registry and hand off to the mailbox
// GC. Conservative on parse failures: any `<pid>.json` FILENAME marks that pid
// box referenced even when the entry is unreadable, and a claimed entry marks
// its session box referenced even when `mailbox_key` is absent (pre-v0.17
// writers) by recomputing the key from session_id. Best-effort; never blocks
// register().
function gcOrphanMailboxesFromRegistry(): void {
  try {
    const dir = registryDir();
    if (!existsSync(dir)) return;
    const pids = new Set<number>();
    const sessionKeys = new Set<string>();
    for (const file of readdirSync(dir)) {
      const m = /^(\d+)\.json$/.exec(file);
      if (!m) continue;
      pids.add(Number(m[1]));
      const other = readEntryFile(dir, file);
      if (!other) continue;
      if (other.mailbox_key) sessionKeys.add(other.mailbox_key);
      if (other.client.session_id) {
        try {
          sessionKeys.add(mailboxSessionKey(other.client.session_id));
        } catch {
          // malformed id — recomputation is belt-and-braces only
        }
      }
    }
    gcOrphanMailboxes(pids, sessionKeys);
    gcDeliveryArtifacts();
  } catch {
    // housekeeping must never break registration
  }
}

function gcDeadSiblings(entry: RegistryEntry): void {
  const sid = entry.client.session_id;
  if (!sid) return;
  const dir = registryDir();
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    const other = readEntryFile(dir, file);
    if (!other) continue; // skip non-<pid>.json, parse errors, and forged entries
    const full = join(dir, file);
    if (other.server_pid === entry.server_pid) continue;
    if (other.client.session_id !== sid) continue;
    if (isAlive(other.server_pid)) continue;
    // Consolidate before dropping: a peer may have enqueued to this dead
    // sibling's pid mailbox before we (the restarted/sibling child) registered.
    // Move that undrained mail into our own inbox — the SESSION box when
    // claimed (the canonical v0.17+ inbox, immune to further pid rotation),
    // else our own pid box — so the message survives the rotation instead of
    // being orphaned with the registry file. Best-effort; never blocks register.
    try {
      migrateMailbox(
        other.server_pid,
        sid ? mailboxSessionKey(sid) : entry.server_pid,
      );
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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

// A child whose parent exits is reparented to init/launchd (pid 1). So a CURRENT
// ppid of 1, when we did NOT start under pid 1, means our host process (the codex /
// claude that spawned this MCP server) is gone — the server is orphaned and should
// self-reap so it stops leaking a live, unclaimed registry breadcrumb. Pure so it's
// unit-testable; the server polls process.ppid against the ppid captured at startup.
// (initialPpid === 1 can't use this signal — a server genuinely launched under init
// has no parent to lose — so it returns false and the caller falls back to stdin EOF.)
export function parentLikelyDied(initialPpid: number, currentPpid: number): boolean {
  return initialPpid !== 1 && currentPpid === 1;
}

export function readAll(): RegistryEntry[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  const live: RegistryEntry[] = [];
  for (const file of readdirSync(dir)) {
    const entry = readEntryFile(dir, file);
    if (!entry) continue; // non-<pid>.json, parse error, or forged server_pid
    const full = join(dir, file);
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

// Like readAll() but a PASSIVE, read-only VIEW: it never reaps/unlinks dead
// entries and never filters them out — it returns every registered agent (live
// AND dead), deduped by session_id. A read-only consumer (the oxpit cockpit) uses
// this so it can render a recently-exited agent as ⚫dead and detect waits
// orphaned on it, instead of the agent silently vanishing (which readAll() causes
// by reaping). Mutation — reaping, GC, mailbox migration — stays in the writer
// paths (register/readAll); a viewer must never have side effects on the registry
// it observes. Liveness of each returned entry is the caller's call (isAlive).
export function readAllPassive(): RegistryEntry[] {
  const dir = registryDir();
  if (!existsSync(dir)) return [];
  const all: RegistryEntry[] = [];
  for (const file of readdirSync(dir)) {
    const entry = readEntryFile(dir, file);
    if (!entry) continue; // non-<pid>.json, parse error, or forged server_pid
    all.push(entry);
  }
  return dedupeBySessionId(all);
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
    const e = readEntryFile(dir, file);
    if (!e) continue; // skip non-<pid>.json, parse errors, and forged entries
    if (e.client.session_id === sessionId) entries.push(e);
  }
  entries.sort((a, b) => a.started_at - b.started_at);
  return entries.map((e) => e.server_pid);
}

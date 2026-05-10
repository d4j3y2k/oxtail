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
};

const REGISTRY_DIR = join(homedir(), ".oxtail", "sessions");

function ensureDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
    return;
  }
  // Migration: tighten perms for users upgrading from <0.4.0, where the dir
  // and entries were created at default umask (typically 0o755 / 0o644).
  try {
    chmodSync(REGISTRY_DIR, 0o700);
  } catch {
    // not our dir or fs doesn't support; leave it
  }
  for (const file of readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith(".json")) continue;
    try {
      chmodSync(join(REGISTRY_DIR, file), 0o600);
    } catch {
      // ignore
    }
  }
}

function entryPath(pid: number): string {
  return join(REGISTRY_DIR, `${pid}.json`);
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

export function buildEntry(client: ClientInfo, env = process.env): RegistryEntry {
  const tmux_pane = resolveTmuxPane(env);
  return {
    server_pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
    client,
    tmux_pane,
    tmux_session: resolveTmuxSessionFromPane(tmux_pane),
    state: null,
  };
}

export function refreshTmuxBinding(entry: RegistryEntry): void {
  const tmux_pane = resolveTmuxPane();
  entry.tmux_pane = tmux_pane;
  entry.tmux_session = resolveTmuxSessionFromPane(tmux_pane);
}

export function register(entry: RegistryEntry): void {
  ensureDir();
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
  if (!existsSync(REGISTRY_DIR)) return [];
  const out: RegistryEntry[] = [];
  for (const file of readdirSync(REGISTRY_DIR)) {
    if (!file.endsWith(".json")) continue;
    const full = join(REGISTRY_DIR, file);
    let entry: RegistryEntry;
    try {
      entry = JSON.parse(readFileSync(full, "utf8")) as RegistryEntry;
    } catch {
      continue;
    }
    if (!isAlive(entry.server_pid)) {
      try {
        unlinkSync(full);
      } catch {
        // ignore
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

export function findByTmuxSession(name: string): RegistryEntry[] {
  return readAll().filter((e) => e.tmux_session === name);
}

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientInfo } from "./clients.js";

export type RegistryEntry = {
  server_pid: number;
  started_at: number;
  client: ClientInfo;
  tmux_pane: string | null;
  tmux_session: string | null;
};

const REGISTRY_DIR = join(homedir(), ".oxtail", "sessions");

function ensureDir(): void {
  if (!existsSync(REGISTRY_DIR)) {
    mkdirSync(REGISTRY_DIR, { recursive: true });
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

export function buildEntry(client: ClientInfo, env = process.env): RegistryEntry {
  const tmux_pane = env.TMUX_PANE ?? null;
  return {
    server_pid: process.pid,
    started_at: Math.floor(Date.now() / 1000),
    client,
    tmux_pane,
    tmux_session: resolveTmuxSessionFromPane(tmux_pane),
  };
}

export function register(entry: RegistryEntry): void {
  ensureDir();
  writeFileSync(entryPath(entry.server_pid), JSON.stringify(entry, null, 2));
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

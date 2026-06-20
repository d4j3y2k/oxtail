// Fleet mutation lock: one spawn/reset at a time per repo root. Reuses the
// v0.14.0 owner-token sidecar advisory lock (src/locks.ts) — the same primitive
// the mailbox and received-ledger use, with stale recovery for a crashed holder.
// This is what excludes two concurrent oxpit instances (or a cross-fleet-same-
// repo race) from interleaving tmux mutations on one fleet (max's D3 + codex).

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, releaseDirLock } from "../../locks.js";

// Generous stale window: a sequential SPAWN of N agents (each waiting for
// readiness) can legitimately run for a minute-plus, and the lock dir's mtime is
// not refreshed during the hold — so the stale window must comfortably exceed
// the longest realistic mutation, while still reclaiming a crashed oxpit's lock.
const FLEET_LOCK_STALE_MS = 5 * 60 * 1000;
// Fail fast when another oxpit holds it: concurrent fleet mutation is the race
// we're excluding, so we surface it rather than queue behind a long operation.
const FLEET_LOCK_BUDGET_MS = 3_000;

// Resolved lazily (re-reads homedir each call) so tests can swap HOME, mirroring
// the registry/mailbox dir helpers.
export function fleetLocksDir(): string {
  return join(homedir(), ".oxtail", "fleet-locks");
}

function slug(repoRoot: string): string {
  return repoRoot.replace(/[^A-Za-z0-9_-]/g, "-") || "root";
}

export function fleetLockPath(repoRoot: string): string {
  return join(fleetLocksDir(), slug(repoRoot));
}

export class FleetBusyError extends Error {
  constructor(public readonly repoRoot: string) {
    super(`another oxpit fleet operation is already in progress for ${repoRoot}`);
    this.name = "FleetBusyError";
  }
}

// Run `fn` while holding the per-repo fleet-mutation lock; release in finally
// (only if still owner). Throws FleetBusyError if another oxpit holds it.
export async function withFleetLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(fleetLocksDir(), { recursive: true });
  const lock = fleetLockPath(repoRoot);
  let token: string;
  try {
    token = acquireDirLock(
      lock,
      FLEET_LOCK_STALE_MS,
      "fleet_lock_stale_cleared",
      { lock },
      FLEET_LOCK_BUDGET_MS,
    );
  } catch {
    throw new FleetBusyError(repoRoot);
  }
  try {
    return await fn();
  } finally {
    releaseDirLock(lock, token);
  }
}

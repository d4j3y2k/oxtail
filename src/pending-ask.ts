// Pending-ask registry — durable ask_peer (the long-effort liveness fix).
//
// When an ask_peer wait TIMES OUT, the requester records a "pending ask" here:
// a durable note that it is still awaiting a reply correlated by request_id.
// When that reply eventually arrives — minutes or hours later, long after the
// 5-minute fresh-idle window the strict reply-default wake is gated to — the
// reply handler (server.ts resolveSendWake) finds the matching record and fires
// a LENIENT wake to pull the requester back, instead of stranding it idle until
// its next turn. This is what turns ask_peer into "delegate a long task and get
// pulled back the moment it's done", and it also reaches a markerless idle Codex
// requester that the fresh-idle gate would skip as skipped_no_fresh_idle.
//
// Design mirrors autowake.ts exactly: one small file per record under
// ~/.oxtail/pending-ask/, mtime is the source of truth (driven by an injected
// nowMs so it's deterministic in tests), the body is a debug breadcrumb, GC'd by
// age. Keyed on the REQUESTER's client.session_id + the request_id (the agent
// identity per AGENTS.md, never server_pid). Best-effort: a broken store
// degrades to "no record" — it NEVER throws, because a thrown error here would
// surface on an already-enqueued/already-delivered message and invite a retry.

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function envPosInt(name: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// How long a recorded pending-ask is honored before GC reclaims it. Sized for
// long efforts (a delegated task that runs for the better part of an hour) — a
// reply arriving after this window still delivers durably via read_my_messages,
// it just won't fire the pull-back wake. Generous by default; tunable.
export const PENDING_ASK_TTL_MS = envPosInt("OXTAIL_PENDING_ASK_TTL_MS", 60 * 60 * 1000);

export function defaultPendingAskDir(): string {
  return join(homedir(), ".oxtail", "pending-ask");
}

function hash(s: string): string {
  // request_id is caller-influenced, so never build a filename from it directly.
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function recordPath(dir: string, sessionId: string, requestId: string): string {
  // JSON-encode the pair so the (sessionId, requestId) boundary is unambiguous
  // and can't be crafted to collide with a different split (mirrors autowake.ts).
  return join(dir, `p-${hash(JSON.stringify([sessionId, requestId]))}`);
}

function setMtime(path: string, nowMs: number): void {
  const t = nowMs / 1000;
  try {
    utimesSync(path, t, t);
  } catch {
    // best effort — mtime drives TTL math; a failure only skews freshness by the
    // small real-vs-injected clock delta.
  }
}

// Record a pending ask. Atomic create-exclusive so a duplicate record (same
// requester + request_id) is a no-op rather than resetting the TTL clock.
// Returns true if a record now exists for this pair (freshly written OR already
// present), false only on a missing identity or an unusable store. Never throws.
export function recordPendingAsk(
  dir: string,
  sessionId: string | null,
  requestId: string,
  nowMs: number,
): boolean {
  // Never key on an empty identity: an unclaimed requester can't be correlated
  // or replied-to, so there's nothing to wake later.
  if (!sessionId || !requestId) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = recordPath(dir, sessionId, requestId);
    try {
      const fd = openSync(p, "wx"); // atomic create-exclusive
      try {
        writeFileSync(fd, JSON.stringify({ sessionId, requestId, at: nowMs }));
      } finally {
        closeSync(fd);
      }
      setMtime(p, nowMs);
      return true;
    } catch (e) {
      // EEXIST: a record already exists → fine, leave its original mtime so the
      // TTL counts from the first record, not this duplicate.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return true;
      throw e;
    }
  } catch {
    // Store unusable (e.g. ~/.oxtail/pending-ask is a file, permission error) —
    // degrade to "no durable record"; the strict fresh-idle reply-default still
    // covers a Claude requester that went idle <5 min ago.
    return false;
  }
}

// Read-only: is there a live (within TTL) pending-ask for this pair?
export function hasPendingAsk(
  dir: string,
  sessionId: string | null,
  requestId: string,
  nowMs: number,
  ttlMs: number = PENDING_ASK_TTL_MS,
): boolean {
  if (!sessionId || !requestId) return false;
  try {
    const st = statSync(recordPath(dir, sessionId, requestId));
    return nowMs - st.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

// Atomically consume (delete) the pending-ask for this pair. Returns true iff a
// record existed, was within the TTL, and THIS caller removed it — the
// single-winner signal the reply handler uses to fire exactly one pull-back
// wake. A concurrent second reply (or a re-delivered duplicate) racing the same
// key loses: unlinkSync throws ENOENT for the loser, so it returns false and
// does not re-wake.
//
// When nowMs is supplied, an OVER-TTL record is still unlinked (so a stale
// record can't leak) but the function returns false — honoring the contract that
// a reply arriving after PENDING_ASK_TTL_MS still delivers durably but does NOT
// fire the late wake. Omit nowMs to consume regardless of age (used right after
// recordPendingAsk, where the record is freshly written).
export function consumePendingAsk(
  dir: string,
  sessionId: string | null,
  requestId: string,
  nowMs?: number,
  ttlMs: number = PENDING_ASK_TTL_MS,
): boolean {
  if (!sessionId || !requestId) return false;
  const p = recordPath(dir, sessionId, requestId);
  let withinTtl = true;
  if (nowMs !== undefined) {
    try {
      withinTtl = nowMs - statSync(p).mtimeMs < ttlMs;
    } catch {
      return false; // no record to consume
    }
  }
  try {
    unlinkSync(p); // remove regardless of age so a stale record can't leak
  } catch {
    // ENOENT (no record / already consumed by a racing caller) or any store
    // error → not ours to act on.
    return false;
  }
  return withinTtl;
}

export type LivePendingAsk = {
  sessionId: string;
  requestId: string;
  ageS: number;
  mtimeMs: number;
};

// Canonical read-only listing of every LIVE (within-TTL) pending ask. A read-only
// consumer (the oxpit cockpit) uses this instead of re-scanning the dir and
// re-deriving the TTL-liveness rule itself — keeping the staleness semantics in
// ONE place (don't-fork-truth). mtime is the source of truth (driven by the
// injected nowMs in tests). Best-effort: a broken store / torn record yields a
// shorter list, never throws.
export function listLivePendingAsks(
  dir: string,
  nowMs: number,
  ttlMs: number = PENDING_ASK_TTL_MS,
): LivePendingAsk[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LivePendingAsk[] = [];
  for (const name of names) {
    if (name[0] !== "p") continue;
    const p = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - mtimeMs >= ttlMs) continue; // stale → not a live wait
    let body: { sessionId?: string; requestId?: string };
    try {
      body = JSON.parse(readFileSync(p, "utf8")) as { sessionId?: string; requestId?: string };
    } catch {
      continue;
    }
    if (!body.sessionId || !body.requestId) continue;
    out.push({
      sessionId: body.sessionId,
      requestId: body.requestId,
      ageS: Math.max(0, Math.floor((nowMs - mtimeMs) / 1000)),
      mtimeMs,
    });
  }
  return out;
}

// Remove pending-ask records older than the TTL. Cheap, low-volume dir; run
// opportunistically so abandoned records (a reply that never came) can't
// accumulate. Mirrors gcAutowake.
export function gcPendingAsk(dir: string, nowMs: number, ttlMs: number = PENDING_ASK_TTL_MS): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir not created yet
  }
  for (const name of names) {
    if (name[0] !== "p") continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (nowMs - st.mtimeMs >= ttlMs) unlinkSync(p);
    } catch {
      // best effort
    }
  }
}

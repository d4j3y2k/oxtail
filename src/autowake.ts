// Slice 1 — wake-on-reply (interim liveness patch).
//
// When a `send_message` carries a `reply_to` (i.e. it is answering an earlier
// ask) and the caller did NOT explicitly pass `wake:"off"`, oxtail auto-wakes
// the original requester so an awaited answer doesn't strand an idle peer and
// force a human relay. This module is the GATE that decides whether that
// reply-default wake is allowed to fire. The actual send-keys is left to the
// caller (server.ts `wakePeer`) so this module stays free of tmux/process
// concerns and is unit-testable against a temp directory.
//
// The guards are deliberately conservative. A reply auto-wake types into the
// peer's terminal WITHOUT the human at that terminal having asked for anything
// this turn, so we only do it when ALL of these hold:
//   1. kill-switch `OXTAIL_AUTOWAKE` is not "off"
//   2. the target is FRESH-IDLE — its activity marker says "idle" AND is newer
//      than a max-age threshold. Stale / unknown / missing ⇒ no wake (we do NOT
//      fall back to a best-effort wake the way the lenient wake:auto path does).
//   3. we have not woken this target too recently (per-target rate limit)
//   4. we have not already woken for THIS exact (session_id, reply_to) — a
//      one-wake dedupe that survives duplicate / late hook drains.
//
// Everything is keyed on the target's `client.session_id` (the agent identity,
// per AGENTS.md), never server_pid / tmux name.

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
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

// Fresh-idle window: how recently the peer must have gone idle for a reply
// auto-wake to fire. This is the MAX-AGE threshold the spec calls for, and it
// is intentionally a SEPARATE, stricter gate than the 10-minute busy-TTL used
// by the lenient `wake:"auto"` path: that path wakes on idle/unknown/stale, but
// a reply auto-wake fires unprompted, so we cap how old "idle" may be before we
// stop trusting that the peer is still sitting at its prompt. The 5-minute
// default leans conservative (an unprompted wake into a possibly-unattended
// terminal is the risk) while still covering a normal minute-scale
// ask→work→reply round-trip; raise it via OXTAIL_AUTOWAKE_FRESH_IDLE_MS if
// dogfooding shows replies regularly land later.
export const FRESH_IDLE_MAX_AGE_MS = envPosInt("OXTAIL_AUTOWAKE_FRESH_IDLE_MS", 5 * 60 * 1000);

// Per-target rate limit: the minimum gap between two reply auto-wakes to the
// same session_id. A single recent wake already pulls an idle peer into a turn
// that drains its whole mailbox, so additional keystroke wakes inside this
// window are redundant noise into a terminal. Conservative by design.
export const MIN_INTERVAL_MS = envPosInt("OXTAIL_AUTOWAKE_MIN_INTERVAL_MS", 4000);

// One-wake dedupe lifetime: how long a (session_id, reply_to) wake record is
// honored before it is GC'd. Comfortably longer than any single ask/reply
// round-trip so a late/duplicate hook drain of the same reply can't re-wake.
export const DEDUPE_TTL_MS = envPosInt("OXTAIL_AUTOWAKE_DEDUPE_TTL_MS", 60 * 60 * 1000);

export type ActivitySnapshot = { status: string; ageMs: number } | null;

export type AutoWakeSkip =
  | "disabled" // OXTAIL_AUTOWAKE=off
  | "skipped_no_fresh_idle" // not idle, too old, unknown, or no session_id
  | "skipped_rate_limited" // woke this target too recently
  | "skipped_deduped" // already woke for this exact (session_id, reply_to)
  | "skipped_store_error"; // the dedupe/rate store was unusable — degrade, never throw

export type AutoWakeOutcome = { fire: true } | { fire: false; status: AutoWakeSkip };

// The kill-switch. Any casing of "off" disables reply auto-wake entirely.
export function autowakeKillSwitchOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.OXTAIL_AUTOWAKE ?? "").trim().toLowerCase() === "off";
}

// FRESH-IDLE gate. Only a recent "idle" marker qualifies. A negative age means
// the activity file's mtime is in the future (clock skew) — untrusted, treated
// as not-fresh.
export function isFreshIdle(act: ActivitySnapshot, maxAgeMs: number = FRESH_IDLE_MAX_AGE_MS): boolean {
  if (!act || act.status !== "idle") return false;
  return act.ageMs >= 0 && act.ageMs < maxAgeMs;
}

// --- persistent dedupe / rate-limit store ------------------------------------
// One small file per record under ~/.oxtail/autowake/. mtime is the source of
// truth (driven by the injected nowMs so the store is deterministic in tests);
// the body is a debug breadcrumb. GC'd by age.

export function defaultAutowakeDir(): string {
  return join(homedir(), ".oxtail", "autowake");
}

function hash(s: string): string {
  // reply_to is caller-controlled, so never build a filename from it directly.
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function dedupePath(dir: string, sessionId: string, replyTo: string): string {
  // JSON-encode the pair so the boundary is unambiguous: reply_to is
  // caller-controlled and could otherwise be crafted to collide with a
  // different (sessionId, replyTo) split under a plain separator.
  return join(dir, `d-${hash(JSON.stringify([sessionId, replyTo]))}`);
}

function ratePath(dir: string, sessionId: string): string {
  return join(dir, `r-${hash(sessionId)}`);
}

function setMtime(path: string, nowMs: number): void {
  const t = nowMs / 1000;
  try {
    utimesSync(path, t, t);
  } catch {
    // best effort — mtime drives TTL math, but a failure here only makes the
    // record look fresher/staler by the small real-vs-injected clock delta.
  }
}

// Read-only: has a wake for this (session_id, reply_to) happened within the TTL?
export function isDuplicateWake(
  dir: string,
  sessionId: string,
  replyTo: string,
  nowMs: number,
  ttlMs: number = DEDUPE_TTL_MS,
): boolean {
  try {
    const st = statSync(dedupePath(dir, sessionId, replyTo));
    return nowMs - st.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

// Read-only: have we woken this target within the min-interval window?
export function isRateLimited(
  dir: string,
  sessionId: string,
  nowMs: number,
  minIntervalMs: number = MIN_INTERVAL_MS,
): boolean {
  try {
    const st = statSync(ratePath(dir, sessionId));
    return nowMs - st.mtimeMs < minIntervalMs;
  } catch {
    return false;
  }
}

function stampRate(dir: string, sessionId: string, nowMs: number): void {
  const p = ratePath(dir, sessionId);
  try {
    writeFileSync(p, String(nowMs));
    setMtime(p, nowMs);
  } catch {
    // best effort
  }
}

// Atomically claim the (session_id, reply_to) wake slot. Returns true if THIS
// caller won (no fresh record existed) and may proceed to fire; false if a
// concurrent / duplicate claim already holds it. On a win, also stamps the
// per-target rate record so distinct replies inside MIN_INTERVAL_MS are
// suppressed. A stale record (older than TTL) is cleared first so the slot can
// be reclaimed after the GC horizon.
export function claimWake(
  dir: string,
  sessionId: string,
  replyTo: string,
  nowMs: number,
  ttlMs: number = DEDUPE_TTL_MS,
): boolean {
  mkdirSync(dir, { recursive: true });
  const dpath = dedupePath(dir, sessionId, replyTo);
  try {
    const st = statSync(dpath);
    if (nowMs - st.mtimeMs >= ttlMs) unlinkSync(dpath);
  } catch (e) {
    // ENOENT = no prior record (the common path) → fine. Any OTHER error (e.g.
    // failing to unlink a STALE record because the store is unhealthy) must
    // propagate so the caller degrades to skipped_store_error — otherwise the
    // imminent openSync("wx") EEXIST on the un-removed stale record would be
    // misreported as a genuine dedupe hit.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let won = false;
  try {
    const fd = openSync(dpath, "wx"); // atomic create-exclusive: closes the race
    try {
      writeFileSync(fd, JSON.stringify({ sessionId, replyTo, at: nowMs }));
    } finally {
      closeSync(fd);
    }
    setMtime(dpath, nowMs);
    won = true;
  } catch (e) {
    // EEXIST: a fresh claim already exists → genuine duplicate (skip, no throw).
    // Any OTHER error means the store itself is unusable (e.g. a permission
    // problem) — don't misreport it as a duplicate; rethrow so the caller can
    // degrade it to a deterministic store-error status instead of silently
    // suppressing a legitimate wake.
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      won = false;
    } else {
      throw e;
    }
  }
  if (won) stampRate(dir, sessionId, nowMs);
  return won;
}

// Remove autowake records older than the dedupe TTL. Cheap, low-volume dir;
// run opportunistically on each decision so records can't accumulate.
export function gcAutowake(dir: string, nowMs: number, ttlMs: number = DEDUPE_TTL_MS): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir not created yet
  }
  for (const name of names) {
    if (name[0] !== "d" && name[0] !== "r") continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (nowMs - st.mtimeMs >= ttlMs) unlinkSync(p);
    } catch {
      // best effort
    }
  }
}

// The decision. Pure of tmux/process concerns: given the target identity, the
// reply_to, a snapshot of the target's activity, the current time, and the
// store directory, return whether the reply-default wake may fire. The caller
// performs the actual send-keys when fire === true.
export function decideReplyAutoWake(input: {
  dir: string;
  sessionId: string | null;
  replyTo: string;
  activity: ActivitySnapshot;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
}): AutoWakeOutcome {
  const { dir, sessionId, replyTo, activity, nowMs } = input;
  if (autowakeKillSwitchOff(input.env)) return { fire: false, status: "disabled" };
  // Identity is required: dedupe/rate/activity all key on session_id, and
  // without it we cannot confirm fresh-idle. An unclaimed peer is never auto-woken.
  if (!sessionId) return { fire: false, status: "skipped_no_fresh_idle" };
  if (!isFreshIdle(activity)) return { fire: false, status: "skipped_no_fresh_idle" };

  // Wake bookkeeping is best-effort: send_message has ALREADY enqueued the
  // reply by the time we run, so a broken dedupe/rate store (e.g. ~/.oxtail/
  // autowake is a file, or a permission error) must degrade to a deterministic
  // status — NEVER throw, which would surface as a tool error on an already-
  // delivered message and invite a duplicate retry.
  try {
    gcAutowake(dir, nowMs); // opportunistic sweep before we read/claim

    // Read-only dedupe first so a sequential duplicate reply reports the precise
    // reason; then the per-target rate limit; then an atomic claim to close the
    // concurrent-duplicate race (and to stamp the rate record on success).
    if (isDuplicateWake(dir, sessionId, replyTo, nowMs)) return { fire: false, status: "skipped_deduped" };
    if (isRateLimited(dir, sessionId, nowMs)) return { fire: false, status: "skipped_rate_limited" };
    if (!claimWake(dir, sessionId, replyTo, nowMs)) return { fire: false, status: "skipped_deduped" };
  } catch {
    return { fire: false, status: "skipped_store_error" };
  }
  return { fire: true };
}

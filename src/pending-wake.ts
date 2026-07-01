// Pending-wake registry — the self-heal backstop for a missed wake.
//
// A message delivered to an idle peer is DURABLE (it's in the mailbox); the WAKE
// that tells the peer to take a turn and read it is only best-effort (tmux
// send-keys, whose Enter can be suppressed, and whose strict fresh-idle gate can
// skip). When a wake-intended send is NOT confidently delivered, the sender
// records a "pending wake" here: a durable note that recipient R has message M
// sitting unread behind a wake that may not have landed. R's OWN MCP server (the
// one process guaranteed alive exactly when R is idle-but-stuck) later scans these
// records; for any whose delivery RECEIPT hasn't appeared, it re-nudges its own
// pane so the fleet self-heals instead of stalling on a dropped baton.
//
// Design mirrors pending-ask.ts exactly: one small file per record under
// ~/.oxtail/pending-wake/, mtime is the source of truth (driven by an injected
// nowMs so it's deterministic in tests), GC'd by age. Keyed on the RECIPIENT's
// client.session_id + the message_id (the agent identity per AGENTS.md, never
// server_pid). Best-effort: a broken store degrades to "no record" — it NEVER
// throws (a throw here would surface on an already-delivered message). This is a
// last-resort ACCELERATOR; if it degrades, behavior falls back to today's (the
// mailbox delivery is already durable), which is no worse than the status quo.

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
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

// How long a recorded pending-wake is honored before GC reclaims it. After this
// the record is dropped; the message still delivered durably (mailbox), it just
// won't get a self-heal re-nudge. Generous by default; tunable.
export const PENDING_WAKE_TTL_MS = envPosInt("OXTAIL_PENDING_WAKE_TTL_MS", 60 * 60 * 1000);

export function defaultPendingWakeDir(): string {
  return join(homedir(), ".oxtail", "pending-wake");
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 32);
}

function recordPath(dir: string, recipientSessionId: string, messageId: string): string {
  // JSON-encode the pair so the (recipient, messageId) boundary is unambiguous and
  // can't be crafted to collide with a different split (mirrors pending-ask.ts).
  return join(dir, `w-${hash(JSON.stringify([recipientSessionId, messageId]))}`);
}

// Exact record-file shape. `list` matches on THIS (not a bare `w` prefix) so a
// bumpAttempt temp orphaned by a crash (`w-<hash>.tmp.<pid>.<hex>`) is never mistaken
// for a real record. gc keeps the broad `w` prefix so it still reclaims such orphans.
const RECORD_RE = /^w-[0-9a-f]{32}$/;

function setMtime(path: string, nowMs: number): void {
  const t = nowMs / 1000;
  try {
    utimesSync(path, t, t);
  } catch {
    // best effort — mtime drives TTL math; a failure only skews freshness slightly.
  }
}

type PendingWakeBody = {
  recipientSessionId: string;
  messageId: string;
  senderSessionId: string | null;
  sentAt: number;
  attempts: number;
  lastAttemptAt: number | null;
};

// Record a pending wake. Atomic create-exclusive so a duplicate (same recipient +
// message_id) is a no-op rather than resetting the TTL clock OR the attempt count.
// Returns true if a record now exists (freshly written OR already present), false
// only on a missing identity or an unusable store. Never throws.
export function recordPendingWake(
  dir: string,
  recipientSessionId: string | null,
  messageId: string,
  senderSessionId: string | null,
  nowMs: number,
): boolean {
  // Never key on an empty recipient identity: an unclaimed peer has no stable
  // session key, no received-ledger, and no self-heal server to act on it.
  if (!recipientSessionId || !messageId) return false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const p = recordPath(dir, recipientSessionId, messageId);
    try {
      const fd = openSync(p, "wx"); // atomic create-exclusive
      try {
        const body: PendingWakeBody = {
          recipientSessionId,
          messageId,
          senderSessionId: senderSessionId ?? null,
          sentAt: nowMs,
          attempts: 0,
          lastAttemptAt: null,
        };
        writeFileSync(fd, JSON.stringify(body));
      } finally {
        closeSync(fd);
      }
      setMtime(p, nowMs);
      return true;
    } catch (e) {
      // EEXIST: a record already exists → leave its original mtime AND attempts so
      // the TTL counts from the first send and the cap isn't reset by a duplicate.
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return true;
      throw e;
    }
  } catch {
    return false; // store unusable — degrade to "no durable record"
  }
}

export type LivePendingWake = {
  recipientSessionId: string;
  messageId: string;
  senderSessionId: string | null;
  attempts: number;
  ageS: number;
  mtimeMs: number;
};

// Read-only listing of every LIVE (within-TTL) pending-wake addressed to
// `recipientSessionId`. Passive: it filters stale by TTL but NEVER unlinks — a VIEW
// must not reap (only gc/consume mutate). Best-effort: a broken/torn record yields a
// shorter list, never throws.
export function listPendingWakesForRecipient(
  dir: string,
  recipientSessionId: string | null,
  nowMs: number,
  ttlMs: number = PENDING_WAKE_TTL_MS,
): LivePendingWake[] {
  if (!recipientSessionId) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LivePendingWake[] = [];
  for (const name of names) {
    if (!RECORD_RE.test(name)) continue; // exact shape — skip crash-orphaned .tmp files
    const p = join(dir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(p).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - mtimeMs >= ttlMs) continue; // stale → not a live wait
    let body: Partial<PendingWakeBody>;
    try {
      body = JSON.parse(readFileSync(p, "utf8")) as Partial<PendingWakeBody>;
    } catch {
      continue;
    }
    if (!body.recipientSessionId || !body.messageId) continue;
    if (body.recipientSessionId !== recipientSessionId) continue; // not addressed to me
    out.push({
      recipientSessionId: body.recipientSessionId,
      messageId: body.messageId,
      senderSessionId: body.senderSessionId ?? null,
      attempts: typeof body.attempts === "number" && body.attempts >= 0 ? body.attempts : 0,
      ageS: Math.max(0, Math.floor((nowMs - mtimeMs) / 1000)),
      mtimeMs,
    });
  }
  return out;
}

// Atomically consume (delete) the pending-wake for this pair. Returns true iff a
// record existed and THIS caller removed it — the single-winner signal used when a
// delivery receipt confirms the message landed (or the self-heal gives up). A
// concurrent racer loses (unlinkSync throws ENOENT) → false.
export function consumePendingWake(
  dir: string,
  recipientSessionId: string | null,
  messageId: string,
): boolean {
  if (!recipientSessionId || !messageId) return false;
  try {
    unlinkSync(recordPath(dir, recipientSessionId, messageId));
    return true;
  } catch {
    return false; // ENOENT (already consumed) or store error — not ours to act on
  }
}

// Increment the attempt counter (and stamp lastAttemptAt) WITHOUT touching the
// record's mtime — mtime is the TTL clock, and a re-nudge must NOT extend the
// tracking window. Atomic temp+rename to avoid a torn read, then restore the
// original mtime. Best-effort: a failure just means the cap counts slower. Never
// throws.
export function bumpAttempt(
  dir: string,
  recipientSessionId: string | null,
  messageId: string,
  nowMs: number,
): void {
  if (!recipientSessionId || !messageId) return;
  const p = recordPath(dir, recipientSessionId, messageId);
  try {
    const st = statSync(p);
    const body = JSON.parse(readFileSync(p, "utf8")) as PendingWakeBody;
    body.attempts = (typeof body.attempts === "number" ? body.attempts : 0) + 1;
    body.lastAttemptAt = nowMs;
    const tmp = `${p}.tmp.${process.pid}.${createHash("sha256").update(String(nowMs)).digest("hex").slice(0, 8)}`;
    try {
      writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
      // Restore the TTL clock on the TMP, BEFORE the atomic swap — renameSync
      // preserves the source's mtime, so the record carries the original mtime the
      // instant it becomes visible. (Restoring AFTER the rename left a crash window
      // where the record kept its fresh wall-clock mtime and outlived its TTL.)
      setMtime(tmp, st.mtimeMs);
      renameSync(tmp, p);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw err;
    }
  } catch {
    // record gone / store error — best effort
  }
}

// Remove pending-wake records older than the TTL. Cheap, low-volume dir; run
// opportunistically so abandoned records can't accumulate. Mirrors gcPendingAsk.
export function gcPendingWake(dir: string, nowMs: number, ttlMs: number = PENDING_WAKE_TTL_MS): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return; // dir not created yet
  }
  for (const name of names) {
    if (name[0] !== "w") continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (nowMs - st.mtimeMs >= ttlMs) unlinkSync(p);
    } catch {
      // best effort
    }
  }
}

// ── Persistent per-session self-wake throttle ────────────────────────────────
// One self-wake per recipient session per throttle window, regardless of how many
// pending-wake records it holds OR how many MCP children (dual-scope: user +
// project config) run the watchdog. The in-process wakePeer debounce doesn't cross
// processes, so this MUST be persistent — mirrors the operator-wake throttle. mtime
// is the source of truth. Best-effort; a store failure never blocks the wake.

export const SELF_WAKE_THROTTLE_MS = envPosInt("OXTAIL_SELF_WAKE_THROTTLE_MS", 60 * 1000);

function selfWakeThrottleDir(): string {
  return join(homedir(), ".oxtail", "self-wake");
}
function selfWakeThrottlePath(sessionId: string): string {
  return join(selfWakeThrottleDir(), hash(sessionId));
}

// Read-only: did a self-wake for this session fire within the throttle window?
export function selfWokeRecently(
  sessionId: string | null,
  nowMs: number,
  throttleMs: number = SELF_WAKE_THROTTLE_MS,
): boolean {
  if (!sessionId) return false;
  try {
    return nowMs - statSync(selfWakeThrottlePath(sessionId)).mtimeMs < throttleMs;
  } catch {
    return false; // no record / store unusable — don't block the wake
  }
}

// Stamp the throttle (mtime = nowMs). Stamped BEFORE the keystrokes fire so a
// sibling MCP child ticking at the same time sees the claim and skips — the
// single-winner guard against a dual-child double-nudge. A residual TOCTOU window
// remains (two children between the check and this stamp); the per-record attempt
// cap bounds any resulting extra nudges.
export function stampSelfWoke(sessionId: string | null, nowMs: number): void {
  if (!sessionId) return;
  try {
    mkdirSync(selfWakeThrottleDir(), { recursive: true, mode: 0o700 });
    const p = selfWakeThrottlePath(sessionId);
    writeFileSync(p, "", { mode: 0o600 });
    setMtime(p, nowMs);
  } catch {
    // store unusable — throttle silently degrades (best-effort posture)
  }
}

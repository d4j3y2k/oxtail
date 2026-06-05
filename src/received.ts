import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, releaseDirLock } from "./locks.js";
import type { Mailbox } from "./mailbox.js";
import { trace } from "./trace.js";

// The received-message ledger: a durable, per-session index of every inbound
// envelope, keyed by message_id. It exists because both delivery paths are
// DESTRUCTIVE — mailbox.drain() truncates the queue to 0 after a read, and the
// PreToolUse hook does `:> "$m"` after rendering messages into model context.
// So once a message is delivered, the mailbox no longer holds it. A reply verb
// (reply_to_message) that looks a message up by id therefore cannot rely on the
// mailbox; it needs this separate ledger.
//
// Correctness hinges on ORDERING, enforced by delivery.ts: the ledger entry is
// written BEFORE the mailbox line becomes visible. A drainer can only observe
// the line after the append, which happens strictly after this write — so any
// message_id a receiver can see has a ledger entry behind it. (The reverse order
// left a window where the hook rendered a handle reply_to_message couldn't yet
// resolve — the race Codex caught in review.)
//
// Ownership is structural: the ledger lives at received/<hash(session_id)>, and
// lookups only ever read the caller's own file. You can only reply to a message
// that was delivered to YOU.

function receivedDir(): string {
  // Resolved lazily so tests can swap HOME between cases (mirrors mailbox.ts).
  return join(homedir(), ".oxtail", "received");
}

// Hash the session_id into the filename (mirrors claims.ts) so two distinct ids
// can never collide onto one ledger file — a lossy character-sanitize could map
// different sessions to the same path. UUIDs are already path-safe; the hash is
// defensive and collision-free.
function ledgerKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
}

function ledgerPath(sessionId: string): string {
  return join(receivedDir(), `${ledgerKey(sessionId)}.jsonl`);
}

function lockPath(sessionId: string): string {
  return `${ledgerPath(sessionId)}.lock`;
}

// Lock idiom mirrors mailbox.ts (owner-token mkdir lock — see locks.ts). The
// ledger read-modify-write is small (bounded by receivedMax() lines) so the lock
// window is short.
const LOCK_STALE_MS = 30_000;

// Bounded retention: keep at most this many of the most-recent inbound messages
// per session. Read lazily so tests can tune it per-case. Generous by default so
// a realistic mailbox burst (read_my_messages budgets 50/drain) can't push a
// just-displayed handle out of the ledger before the receiver replies; when the
// cap DOES bite, recordReceived traces the drop so it is never silent.
export function receivedMax(): number {
  const n = Number(process.env.OXTAIL_RECEIVED_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

// Owner tokens for held ledger locks (see mailbox.ts for the rationale).
const lockTokens = new Map<string, string>();

function acquireLock(sessionId: string): void {
  mkdirSync(receivedDir(), { recursive: true, mode: 0o700 });
  lockTokens.set(
    sessionId,
    acquireDirLock(lockPath(sessionId), LOCK_STALE_MS, "received_lock_stale_clear", {
      session_id: sessionId,
    }),
  );
}

function releaseLock(sessionId: string): void {
  const token = lockTokens.get(sessionId);
  lockTokens.delete(sessionId);
  releaseDirLock(lockPath(sessionId), token ?? "");
}

// Atomically replace the ledger: write a unique temp file, then renameSync over
// the target. rename(2) is atomic on POSIX, so a crash/torn write can't leave a
// half-rewritten ledger that loses older reply handles — unlike a direct
// writeFileSync, which issues multiple write() syscalls.
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

function readLines(sessionId: string): string[] {
  try {
    const raw = readFileSync(ledgerPath(sessionId), "utf8");
    if (!raw) return [];
    return raw.split("\n").filter((l) => l.length > 0);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

// The message_id of a serialized ledger line, or null if unparseable. Used to
// keep recordReceived idempotent without fully deserializing every envelope.
function lineMessageId(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

// Append an inbound envelope to the receiver's ledger and prune to receivedMax()
// (oldest dropped first). Called by delivery.ts BEFORE the mailbox append.
// Idempotent by message_id: re-recording an id replaces its prior line.
export function recordReceived(receiverSessionId: string, msg: Mailbox): void {
  if (!receiverSessionId) return;
  acquireLock(receiverSessionId);
  try {
    const lines = readLines(receiverSessionId);
    // Idempotent by message_id: a re-record (ask_peer abort recovery, chained
    // re-delivery) must not append a duplicate ledger line. Duplicates waste the
    // receivedMax prune budget and can evict still-needed handles early,
    // surfacing as spurious reply_to_message "message-not-found" (M4). Drop any
    // prior line for this id, then append the latest. lookupReceived already
    // returns first-match newest-first, so behavior is unchanged for callers.
    const deduped = msg.id ? lines.filter((l) => lineMessageId(l) !== msg.id) : lines;
    deduped.push(JSON.stringify(msg));
    const max = receivedMax();
    let pruned = deduped;
    if (deduped.length > max) {
      pruned = deduped.slice(deduped.length - max);
      // No silent caps: a dropped handle becomes reply_to_message
      // "message-not-found", so surface that the bound bit.
      trace("received_ledger_pruned", {
        session_id: receiverSessionId,
        dropped: deduped.length - max,
        kept: max,
      });
    }
    atomicWrite(ledgerPath(receiverSessionId), pruned.join("\n") + "\n");
  } finally {
    releaseLock(receiverSessionId);
  }
}

// Look up a previously-received envelope by message_id in this session's ledger.
// Newest-first scan (ids are unique, so the first match is the only match).
// Returns null when not found / aged out — the fail-closed signal the reply
// verb turns into message-not-found. Read under the same lock so a concurrent
// recordReceived rewrite can't be observed half-written.
export function lookupReceived(
  receiverSessionId: string,
  messageId: string,
): Mailbox | null {
  if (!receiverSessionId) return null;
  acquireLock(receiverSessionId);
  try {
    const lines = readLines(receiverSessionId);
    for (let i = lines.length - 1; i >= 0; i--) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Mailbox).id === messageId
      ) {
        return parsed as Mailbox;
      }
    }
    return null;
  } finally {
    releaseLock(receiverSessionId);
  }
}

export function receivedFilePath(sessionId: string): string {
  return ledgerPath(sessionId);
}

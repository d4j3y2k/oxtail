import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, releaseDirLock } from "./locks.js";
import type { Mailbox } from "./mailbox.js";
import { trace } from "./trace.js";

// v0.19 durable-delegation obligations.
//
// An inbound message carrying `action_required` is an OPEN OBLIGATION owned by
// the receiver. The received-ledger is already the durable, per-session,
// record-before-append index of every inbound message — so it is also the
// natural source of truth for "actionable work I own that I haven't finished":
// an obligation is OPEN iff its ledger line has action_required===true and no
// terminal `obligation` field. complete_work/block_work stamp the terminal
// field IN-PLACE on that same ledger line (single source of truth: no separate
// obligations dir, so the 7-day delivery-artifact GC can never delete an open
// obligation nor resurrect a completed one). Wake is irrelevant to all of this:
// the obligation is on the owner's disk the instant delivery records it.
export type ObligationState = {
  state: "done" | "blocked";
  at: number; // unix seconds
  note?: string;
};

// What is actually stored on a ledger line: the inbound envelope plus the
// receiver-side obligation outcome (absent until closed).
export type LedgerRecord = Mailbox & { obligation?: ObligationState };

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
  try {
    writeFileSync(tmp, data, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    // ENOSPC mid-write (the exact condition H1's fail-loud path now exercises)
    // can leave a partial temp file behind; remove it so disk pressure doesn't
    // compound into temp-file accumulation, then rethrow so the caller decides
    // (H1: an action_required delivery fails loud and the sender retries). (max N3)
    try {
      unlinkSync(tmp);
    } catch {
      // already gone / never created — fine
    }
    throw err;
  }
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

// Parse one ledger line into a record, or null if torn/invalid. Validates the
// same minimal shape lookupReceived requires.
function parseLedgerRecord(line: string): LedgerRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    (parsed as Mailbox).schema_version === 1 &&
    typeof (parsed as Mailbox).id === "string" &&
    typeof (parsed as Mailbox).body === "string"
  ) {
    return parsed as LedgerRecord;
  }
  return null;
}

// An OPEN obligation: a delegation (action_required) the receiver has not yet
// closed (no terminal obligation field).
function isOpenObligation(rec: LedgerRecord): boolean {
  return rec.action_required === true && !rec.obligation;
}

// The terminal obligation outcome already recorded on a ledger line, if any —
// so a re-record of the SAME message_id (e.g. abort-recovery re-delivery) does
// not resurrect a completed obligation back to OPEN.
function lineObligation(line: string): ObligationState | undefined {
  const rec = parseLedgerRecord(line);
  return rec?.obligation;
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
    //
    // CARRY-FORWARD: if a prior line for this id had already been CLOSED
    // (terminal obligation), preserve that outcome onto the re-recorded line so
    // a re-delivery can't resurrect a completed obligation back to OPEN. In
    // practice an action_required obligation is recorded exactly ONCE (via
    // deliverToPeer at send time) — deliverExistingToPeer re-records only
    // ask_peer replies to self, which are never action_required — so this is
    // defense-in-depth for any future re-record path. Prefer ANY terminal
    // outcome among matching lines: dedup keeps one line per id, but if that
    // invariant is ever violated a closed outcome must win over an open one.
    let carriedObligation: ObligationState | undefined;
    const deduped: string[] = [];
    for (const l of lines) {
      if (msg.id && lineMessageId(l) === msg.id) {
        const ob = lineObligation(l);
        if (ob) carriedObligation = ob;
        continue;
      }
      deduped.push(l);
    }
    const toStore: LedgerRecord = carriedObligation
      ? { ...msg, obligation: carriedObligation }
      : msg;
    deduped.push(JSON.stringify(toStore));

    // Prune to receivedMax(), oldest-first — but NEVER evict an OPEN obligation
    // out of its own source of truth (that would orphan owned work the owner can
    // never rediscover). Open obligations are exempt; everything else (plain
    // messages, replies, and CLOSED obligations) prunes normally. complete_work
    // marks an obligation terminal, which makes it prunable again, so the open
    // set — and thus ledger growth — stays bounded by how much work is actually
    // outstanding.
    const max = receivedMax();
    let pruned = deduped;
    if (deduped.length > max) {
      let toDrop = deduped.length - max;
      const drop = new Set<number>();
      for (let i = 0; i < deduped.length && toDrop > 0; i++) {
        const rec = parseLedgerRecord(deduped[i]);
        // Drop oldest-first. An OPEN obligation is exempt (never evict owned
        // work). Everything else is prunable: plain messages, CLOSED
        // obligations, AND torn/unparseable lines — a torn line carries no
        // resolvable handle, so keeping it only leaks ledger space (it can't be
        // an open obligation we could ever surface anyway).
        if (!rec || !isOpenObligation(rec)) {
          drop.add(i);
          toDrop--;
        }
      }
      if (drop.size > 0) {
        pruned = deduped.filter((_, i) => !drop.has(i));
        // No silent caps: a dropped handle becomes reply_to_message
        // "message-not-found", so surface that the bound bit.
        trace("received_ledger_pruned", {
          session_id: receiverSessionId,
          dropped: drop.size,
          kept: pruned.length,
        });
      }
      if (toDrop > 0) {
        // The cap is exceeded purely by OPEN obligations we refused to evict —
        // the ledger is over its soft cap because the owner is parking a large
        // backlog of unfinished delegated work. Surface it loudly (an observable
        // signal for a runaway delegator) rather than dropping owned work.
        trace("received_ledger_over_cap_open_obligations", {
          session_id: receiverSessionId,
          kept: pruned.length,
          soft_cap: max,
          over_by: toDrop,
        });
      }
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
        (parsed as Mailbox).schema_version === 1 &&
        typeof (parsed as Mailbox).body === "string" &&
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

// List this session's OPEN obligations (action_required, not yet closed),
// newest-first. Lock-free: atomicWrite renames a complete file into place, so a
// reader never observes a torn ledger and a concurrent close just means this
// read reflects the pre- or post-close state (both consistent). Read-only and
// side-effect-free, so it is cheap to call at any turn boundary.
export function listOpenObligations(receiverSessionId: string): Mailbox[] {
  if (!receiverSessionId) return [];
  const out: Mailbox[] = [];
  const lines = readLines(receiverSessionId);
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parseLedgerRecord(lines[i]);
    if (!rec) {
      // A torn line is invisible to the owner (can't be listed/closed). Trace it
      // — mirrors the mailbox parser — so corruption is observable, not silent.
      if (lines[i].length > 0) trace("received_ledger_skip_invalid", { session_id: receiverSessionId, op: "list_open" });
      continue;
    }
    if (isOpenObligation(rec)) out.push(rec);
  }
  return out;
}

// Cheap count of OPEN obligations — the integer read_my_messages surfaces as
// open_work_count so the one turn-boundary call already made by every client
// (including a hookless Codex) reveals owned work with no extra discipline.
export function countOpenObligations(receiverSessionId: string): number {
  if (!receiverSessionId) return 0;
  let n = 0;
  for (const line of readLines(receiverSessionId)) {
    const rec = parseLedgerRecord(line);
    if (!rec) {
      if (line.length > 0) trace("received_ledger_skip_invalid", { session_id: receiverSessionId, op: "count_open" });
      continue;
    }
    if (isOpenObligation(rec)) n++;
  }
  return n;
}

export type ClaimObligationResult =
  | { result: "claimed"; inbound: Mailbox }
  | { result: "already-closed"; state: ObligationState["state"] }
  | { result: "not-found" }
  | { result: "not-an-obligation" };

// Atomically CLAIM an open obligation and stamp it terminal, in one locked
// read-modify-write — the single source of truth (no separate obligations file).
// This is the compare-and-set that makes closing race-safe: only ONE caller can
// flip an OPEN obligation to terminal, so a duplicate/concurrent complete_work
// can't double-deliver — the loser gets "already-closed" and must NOT re-notify.
// Returns the inbound record on a successful claim (so the caller can notify the
// requester), "already-closed" with the prior state on a re-close, or
// not-found / not-an-obligation. Mirrors recordReceived's lock so a concurrent
// record/close can't interleave at the line level.
export function claimObligation(
  receiverSessionId: string,
  messageId: string,
  state: ObligationState["state"],
  note?: string,
): ClaimObligationResult {
  if (!receiverSessionId || !messageId) return { result: "not-found" };
  acquireLock(receiverSessionId);
  try {
    const lines = readLines(receiverSessionId);
    for (let i = 0; i < lines.length; i++) {
      if (lineMessageId(lines[i]) !== messageId) continue;
      const rec = parseLedgerRecord(lines[i]);
      if (!rec) continue; // torn line with a matching id — not a claimable obligation
      if (!rec.action_required) return { result: "not-an-obligation" };
      if (rec.obligation) return { result: "already-closed", state: rec.obligation.state };
      const obligation: ObligationState = note
        ? { state, at: Math.floor(Date.now() / 1000), note }
        : { state, at: Math.floor(Date.now() / 1000) };
      lines[i] = JSON.stringify({ ...rec, obligation });
      atomicWrite(ledgerPath(receiverSessionId), lines.join("\n") + "\n");
      return { result: "claimed", inbound: rec };
    }
    return { result: "not-found" };
  } finally {
    releaseLock(receiverSessionId);
  }
}

export function receivedFilePath(sessionId: string): string {
  return ledgerPath(sessionId);
}

// Canonical extraction of (request_id, from_session_id) pairs from a session's
// ledger — every inbound ask_peer is recorded here keyed by request_id. The oxpit
// cockpit consumes this to resolve which peer an ask_peer waiter is blocked on,
// instead of re-implementing ledger parsing (don't-fork-truth: parseLedgerRecord
// stays the one parser). Read-only, lock-free (atomicWrite renames a whole file
// into place, so a reader never sees a torn ledger), tolerates torn lines.
export function listLedgerRequestPairs(
  sessionId: string,
): Array<{ request_id: string; from_session_id: string }> {
  if (!sessionId) return [];
  const out: Array<{ request_id: string; from_session_id: string }> = [];
  for (const line of readLines(sessionId)) {
    const rec = parseLedgerRecord(line);
    if (rec?.request_id && rec.from_session_id) {
      out.push({ request_id: rec.request_id, from_session_id: rec.from_session_id });
    }
  }
  return out;
}

// Every reply_to value in a session's ledger — i.e. the request_ids this session
// has RECEIVED a reply for. (An ask_peer reply is delivered to the requester, so it
// lands in the requester's OWN ledger correlated by reply_to == request_id.) The
// oxpit wait-graph uses this to confirm an ask was answered from observed message
// evidence and suppress a stale pending-ask "wait" (kills the 1h-lingering H1
// phantom). Read-only, lock-free, torn-tolerant; reuses parseLedgerRecord.
export function listLedgerReplyTargets(sessionId: string): string[] {
  if (!sessionId) return [];
  const out: string[] = [];
  for (const line of readLines(sessionId)) {
    const rec = parseLedgerRecord(line);
    if (rec?.reply_to) out.push(rec.reply_to);
  }
  return out;
}

// A flattened, render-friendly view of one inbound ledger record (the obligation
// outcome collapsed to its terminal state). Used by the oxpit comms-log.
export type LedgerEntry = {
  id: string;
  from_session_id: string | null;
  body: string;
  enqueued_at: number;
  origin?: "peer" | "operator"; // provenance; "operator" = sent from the oxpit cockpit
  operator_source?: string;
  request_id?: string;
  reply_to?: string;
  action_required?: boolean;
  closed?: ObligationState["state"]; // "done" | "blocked" if the obligation was closed
};

// Canonical reader of a session's most-recent inbound messages (newest-first,
// capped at `limit`). The oxpit comms-log merges these across the fleet into a
// cross-agent message feed. Read-only, lock-free, tolerates torn lines — reuses
// parseLedgerRecord (don't-fork-truth). A session's ledger is its RECEIVED inbox,
// so each record's receiver is `sessionId` and its sender is `from_session_id`.
export function listRecentLedgerRecords(sessionId: string, limit = 50): LedgerEntry[] {
  if (!sessionId || limit <= 0) return [];
  const out: LedgerEntry[] = [];
  const lines = readLines(sessionId);
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const rec = parseLedgerRecord(lines[i]);
    if (!rec) continue;
    out.push({
      id: rec.id,
      from_session_id: rec.from_session_id ?? null,
      body: rec.body,
      enqueued_at: rec.enqueued_at,
      origin: rec.origin,
      operator_source: rec.operator_source,
      request_id: rec.request_id,
      reply_to: rec.reply_to,
      action_required: rec.action_required,
      closed: rec.obligation?.state,
    });
  }
  return out;
}

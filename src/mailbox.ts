import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireDirLock, releaseDirLock } from "./locks.js";
import { trace } from "./trace.js";

export type Mailbox = {
  schema_version: 1;
  id: string;
  body: string;
  enqueued_at: number;
  body_bytes?: number;
  origin?: "peer";
  from_session_id?: string;
  request_id?: string;
  reply_to?: string;
  source_message_id?: string;
  // v0.19: marks this delivery as a durable DELEGATION. When true, the
  // receiver's ledger entry becomes an OPEN OBLIGATION (see received.ts) that
  // survives a missed/mistimed wake — discoverable via my_open_work and closed
  // via complete_work/block_work. Absent/false = an ordinary message (today's
  // exact behavior). An optional envelope key (appended last in the serialized
  // line) so a pre-v0.19 reader simply ignores it.
  action_required?: boolean;
};

export type EnqueueOptions = {
  request_id?: string;
  reply_to?: string;
  source_message_id?: string;
  action_required?: boolean;
  // Optional explicit message id (must be 16 lowercase hex — the serializer's
  // FIELD_ORDER_PREFIX enforces it). Default is a fresh random nonce. Used by
  // complete_work to mint a DETERMINISTIC completion id so a crash-retry or a
  // concurrent close re-delivers the same id and the receiver's dedup collapses
  // it to exactly one event.
  id?: string;
};

// A mailbox is addressed by a BoxId:
//   number — the LEGACY per-MCP-child box, `<server_pid>.jsonl`. Kept for
//            compatibility with pre-v0.17 peers (their senders/readers only
//            know pid boxes) and for unclaimed children (no session_id yet).
//   string — the SESSION box, `<mailboxSessionKey(session_id)>.jsonl`. The
//            canonical inbox from v0.17 on: keyed by the agent identity
//            (client.session_id), so it survives MCP-child pid rotation
//            without the migrate/reap-deferral machinery the pid boxes need.
// The `s-` prefix on session keys means the two namespaces can never collide.
export type BoxId = number | string;

// Single named protocol primitive for the session box filename (per Codex
// review): a human-readable sanitized prefix for debuggability PLUS an 8-hex
// sha256 suffix so two distinct exotic session ids that sanitize identically
// can never collide onto one file. Computed ONLY here (TypeScript); the bash
// hooks never re-derive it — they extract the precomputed `mailbox_key` from
// the registry entry they already grep. Throws on an empty id: callers must
// guard, a silent shared "empty" box would cross-deliver between agents.
export function mailboxSessionKey(sessionId: string): string {
  if (!sessionId) throw new Error("mailboxSessionKey: empty session_id");
  const sanitized = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  const h = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return `s-${sanitized}-${h}`;
}

// Shape guard for string box ids. Every string BoxId must be a well-formed
// session key before it becomes a path component — a malformed value (path
// separator, dotdot, empty) must throw rather than escape the mailboxes dir.
const SESSION_KEY_RE = /^s-[A-Za-z0-9_-]+$/;

function isSessionKey(box: BoxId): box is string {
  return typeof box === "string";
}

// Resolved lazily so tests can swap HOME between cases. Each call re-reads
// homedir(), which on POSIX defers to $HOME.
function mailboxesDir(): string {
  return join(homedir(), ".oxtail", "mailboxes");
}

// Lock staleness window. The drainer reads the file, builds the JSON envelope,
// and writes the truncate back to disk all under lock — under slow disks or OS
// hiccups, a legitimate-but-slow drain can approach the original 5s threshold
// and let a peer steal the lock. 30s widens the window to make accidental
// theft very rare; the trade-off is that a genuinely crashed drainer holds the
// lock 25s longer before recovery. Worth it.
//
// Sync this value with src/hook-drain.ts (the hook delivery helper).
const LOCK_STALE_MS = 30_000;

function mailboxPath(box: BoxId): string {
  if (isSessionKey(box) && !SESSION_KEY_RE.test(box)) {
    throw new Error(`mailbox: malformed session box id ${JSON.stringify(box)}`);
  }
  return join(mailboxesDir(), `${box}.jsonl`);
}

function lockPath(box: BoxId): string {
  return `${mailboxPath(box)}.lock`;
}

// Owner tokens for held locks, so releaseLock can prove ownership (a lock stolen
// out from under a stalled holder is not removed on its late release). Keyed by
// the resolved mailbox path; never two concurrent acquisitions of the same box
// within one process.
const lockTokens = new Map<string, string>();

export function acquireLock(box: BoxId): void {
  mkdirSync(mailboxesDir(), { recursive: true, mode: 0o700 });
  lockTokens.set(
    mailboxPath(box),
    acquireDirLock(lockPath(box), LOCK_STALE_MS, "mailbox_lock_stale_clear", { box }),
  );
}

export function releaseLock(box: BoxId): void {
  const key = mailboxPath(box);
  const token = lockTokens.get(key);
  lockTokens.delete(key);
  releaseDirLock(lockPath(box), token ?? "");
}

// Critical: the serialized JSONL line must always begin
// `{"schema_version":1,"id":"...","body":"`. Pre-v0.17 installed hooks parse
// mailbox lines with an awk extractor that assumes `"body":"` is the third key,
// and those hooks keep running on legacy pid boxes until the user re-runs
// install-hook. A future refactor that uses Object.assign / spread / inserts a
// key could silently reorder and break them without breaking unit tests that
// don't check serialization. The runtime regex below catches that. (The v0.17+
// hook helper parses real JSON and does not depend on key order.)
const FIELD_ORDER_PREFIX = /^\{"schema_version":1,"id":"[0-9a-f]{16}","body":"/;

// Serialize a Mailbox into its on-disk JSONL line, inserting keys in the
// invariant order (schema_version, id, body, …). Node's JSON.stringify
// preserves insertion order for non-integer string keys, which the test suite
// and legacy installed hooks both pin. Shared by enqueue (fresh messages) and
// requeue/migrate (re-homing already-built messages) so the FIELD_ORDER_PREFIX
// invariant is enforced in exactly one place.
export function serializeMailboxLine(msg: Mailbox): string {
  const obj: Record<string, unknown> = {
    schema_version: msg.schema_version,
    id: msg.id,
    body: msg.body,
    enqueued_at: msg.enqueued_at,
    body_bytes: msg.body_bytes ?? Buffer.byteLength(msg.body, "utf8"),
    origin: msg.origin ?? "peer",
  };
  if (msg.from_session_id) obj.from_session_id = msg.from_session_id;
  if (msg.request_id) obj.request_id = msg.request_id;
  if (msg.reply_to) obj.reply_to = msg.reply_to;
  if (msg.source_message_id) obj.source_message_id = msg.source_message_id;
  // Appended LAST so the FIELD_ORDER_PREFIX invariant (schema_version,id,body)
  // is untouched and a pre-v0.19 awk-parsing hook on a legacy pid box ignores it.
  if (msg.action_required) obj.action_required = true;
  const line = JSON.stringify(obj) + "\n";
  if (!FIELD_ORDER_PREFIX.test(line)) {
    throw new Error(
      `mailbox: serialized line violates field-order invariant. ` +
      `Got prefix: ${line.slice(0, 80)}`,
    );
  }
  return line;
}

// Parse a raw mailbox file's contents into valid records, skipping torn/invalid
// lines (each skip is traced). Shared by drain(), migrateMailbox(), and the
// hook delivery helper so the validity rule lives in exactly one place.
export function parseMailboxRecords(raw: string, ctx: Record<string, unknown> = {}): Mailbox[] {
  const out: Mailbox[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      trace("mailbox_drain_skip_invalid", { ...ctx, line });
      continue;
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as Mailbox).schema_version === 1 &&
      typeof (parsed as Mailbox).id === "string" &&
      typeof (parsed as Mailbox).body === "string"
    ) {
      out.push(parsed as Mailbox);
    } else {
      trace("mailbox_drain_skip_invalid", { ...ctx, line });
    }
  }
  return out;
}

// Append JSONL bytes to a mailbox, healing a missing record boundary first.
// appendFileSync of a buffer is NOT a single atomic syscall, so a crash/torn
// write can leave a file ending in a partial line with no trailing "\n". A later
// append would then concatenate onto that partial line, gluing two records into
// one line that fails JSON.parse — silently dropping both messages. If the file
// is non-empty and its last byte isn't "\n", prepend one so the boundary is
// restored (the already-torn record is still lost, but it can no longer eat its
// neighbor). Every append path routes through here.
function appendLines(path: string, buf: string): void {
  let heal = false;
  let fd: number | undefined;
  try {
    const st = statSync(path);
    if (st.size > 0) {
      fd = openSync(path, "r");
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, st.size - 1);
      heal = last[0] !== 0x0a; // 0x0a === "\n"
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw err;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  appendFileSync(path, heal ? "\n" + buf : buf);
}

// Atomically replace a file's contents: write to a unique temp file in the same
// directory, then renameSync over the target. rename(2) is atomic on POSIX, so a
// concurrent reader/crasher never observes a torn file — unlike writeFileSync,
// which issues multiple write() syscalls and can leave a half-written line on
// crash, dropping unrelated surviving records.
function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

// Mint a message envelope WITHOUT writing it anywhere. Split out from enqueue so
// a higher layer (delivery.ts) can record the durable received-ledger entry
// BEFORE the mailbox line becomes visible — the ordering that guarantees any
// message_id a receiver can drain/render already has a ledger entry behind it.
export function buildMessage(
  body: string,
  from_session_id?: string,
  options: EnqueueOptions = {},
): Mailbox {
  return {
    schema_version: 1,
    id: options.id ?? randomBytes(8).toString("hex"),
    body,
    enqueued_at: Math.floor(Date.now() / 1000),
    body_bytes: Buffer.byteLength(body, "utf8"),
    origin: "peer",
    ...(from_session_id ? { from_session_id } : {}),
    ...(options.request_id ? { request_id: options.request_id } : {}),
    ...(options.reply_to ? { reply_to: options.reply_to } : {}),
    ...(options.source_message_id ? { source_message_id: options.source_message_id } : {}),
    ...(options.action_required ? { action_required: true } : {}),
  };
}

export function enqueue(
  target: BoxId,
  body: string,
  from_session_id?: string,
  options: EnqueueOptions = {},
): Mailbox {
  const msg = buildMessage(body, from_session_id, options);
  acquireLock(target);
  try {
    appendLines(mailboxPath(target), serializeMailboxLine(msg));
  } finally {
    releaseLock(target);
  }
  return msg;
}

// Append an already-built message to a mailbox without minting a new id. Used
// by read_my_messages to put budget-deferred overflow back into the caller's
// own mailbox (lossless: the next drain/hook delivers it) and is the building
// block migrateMailbox uses to re-home a dead sibling's mail.
export function requeue(target: BoxId, msg: Mailbox): void {
  const line = serializeMailboxLine(msg);
  acquireLock(target);
  try {
    appendLines(mailboxPath(target), line);
  } finally {
    releaseLock(target);
  }
}

// Re-append several already-built messages under a single lock. Used by
// read_my_messages to put budget-deferred overflow back in one atomic append
// (one failure point instead of N) so the caller can treat it as all-or-nothing.
export function requeueMany(target: BoxId, msgs: Mailbox[]): void {
  if (msgs.length === 0) return;
  let buf = "";
  for (const m of msgs) buf += serializeMailboxLine(m);
  acquireLock(target);
  try {
    appendLines(mailboxPath(target), buf);
  } finally {
    releaseLock(target);
  }
}

// Drain the union of several boxes — a session's inbox is its session box plus
// any current/prior/sibling MCP-child pid boxes (legacy traffic from pre-v0.17
// senders). Each box is drained under its own lock (no nested locks). Mirrors
// the hook's union so read_my_messages reaches a message enqueued to a sibling/
// previous pid instead of silently stranding it. Best-effort per box: a
// contended/unreadable mailbox is skipped (counted) and left for the next poll
// rather than failing the whole drain — one stuck lock must not block a
// session's entire inbox.
//
// Deduped by message_id: a migrateMailbox crash-window (append to dest done, but
// the process died before truncating the source) can leave the SAME message in
// two unioned boxes. Both copies are drained (so neither lingers) but the
// message is returned ONCE. message_id is a unique per-message nonce, so this
// only ever collapses true duplicates, never two distinct messages.
// INVARIANT: every unioned box is drained (and so truncated) before returning —
// do NOT add a budget/early-exit short-circuit here. The dedup is per-call only,
// so a duplicate left in an un-drained sibling would re-surface on a later call
// with no cross-call dedup (M5). Budgeting belongs in the caller, applied to the
// already-fully-drained result.
export function drainMany(boxes: BoxId[]): { messages: Mailbox[]; skipped: number } {
  const out: Mailbox[] = [];
  const seenBoxes = new Set<string>();
  const seenIds = new Set<string>();
  let skipped = 0;
  for (const box of boxes) {
    const key = mailboxPath(box);
    if (seenBoxes.has(key)) continue;
    seenBoxes.add(key);
    try {
      for (const m of drain(box)) {
        if (seenIds.has(m.id)) continue;
        seenIds.add(m.id);
        out.push(m);
      }
    } catch {
      skipped++;
    }
  }
  return { messages: out, skipped };
}

// True if a box's mailbox file holds any bytes. drain() truncates to 0 after a
// successful read, so a non-empty file means "undrained mail is here" — used by
// registry reap-deferral to avoid unlinking a dead child's registry entry while
// its pid box still needs to be reached by the session union-drain.
export function mailboxHasMessages(box: BoxId): boolean {
  try {
    return statSync(mailboxPath(box)).size > 0;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Move every message from a dead sibling's legacy pid box into `toBox` —
// from v0.17 the live entry's SESSION box when claimed (the canonical inbox),
// else its own pid box. Used when a dead MCP child is consolidated into a live
// sibling that shares its session_id, so a message enqueued to the prior pid
// survives the restart. Returns the count migrated. Session boxes never need
// migration themselves — their key derives from the agent identity, not a pid.
//
// Correctness (per Codex review): the source mailbox is now ALSO drainable by
// the session union (read_my_messages / the delivery hook). To stop a
// concurrent drainer from grabbing these same lines and double-delivering, the
// source lock is held across the WHOLE move — read, dest append, and source
// truncate. Append happens BEFORE truncate, so a dest-append failure leaves the
// source intact (its breadcrumb is kept and a later migrate/union-drain retries
// it) — never a lost-in-the-gap window.
//
// Lock order is always source→dest. drainMany holds one mailbox lock at a time
// (never source-then-dest), and the hook helper bounds every lock wait (it
// skips a contended mailbox and proceeds). So this nesting cannot deadlock:
// under contention migrate's dest-lock acquire throws after its budget,
// gcDeadSiblings keeps the breadcrumb, and the move is retried on the next
// register. The only residual failure is a crash BETWEEN the append and the
// truncate, which can duplicate (message_id is stable for dedup) — strictly
// preferable to loss or orphaning.
export function migrateMailbox(fromPid: number, toBox: BoxId): number {
  const src = mailboxPath(fromPid);
  if (src === mailboxPath(toBox)) return 0;
  acquireLock(fromPid);
  try {
    let raw: string;
    try {
      raw = readFileSync(src, "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return 0;
      throw err;
    }
    if (!raw || !raw.trim()) return 0;
    // Migrate only VALID records, reserialized canonically. A crash mid-append
    // into the source can leave a torn final line; copying raw bytes would glue
    // a synthesized newline onto that fragment, promoting garbage into a
    // standalone (unparseable) line in the dest AND over-counting it (H4).
    const valid = parseMailboxRecords(raw, { fromPid, toBox, via: "migrate" });
    if (valid.length === 0) {
      // Only torn/garbage lines — clear the source and report nothing migrated.
      truncateSync(src, 0);
      return 0;
    }
    // serializeMailboxLine already terminates each line with "\n", so join("").
    const block = valid.map((m) => serializeMailboxLine(m)).join("");

    acquireLock(toBox);
    try {
      appendLines(mailboxPath(toBox), block);
    } finally {
      releaseLock(toBox);
    }
    // Append succeeded → clear the source (still under the source lock).
    truncateSync(src, 0);
    return valid.length;
  } finally {
    releaseLock(fromPid);
  }
}

export function drain(box: BoxId): Mailbox[] {
  acquireLock(box);
  try {
    let raw: string;
    try {
      raw = readFileSync(mailboxPath(box), "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw err;
    }
    if (!raw) return [];
    const out = parseMailboxRecords(raw, { box });
    try {
      truncateSync(mailboxPath(box), 0);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }
    return out;
  } finally {
    releaseLock(box);
  }
}

// Drain the first message in this mailbox whose from_session_id matches
// `from_session_id`, leaving any preceding and following messages untouched.
// Used by ask_peer to consume exactly the reply it's waiting on without
// stealing messages from concurrent peers.
//
// Critical invariant: surviving raw lines are written back byte-exact. Legacy
// installed hooks' awk extractor assumes the FIELD_ORDER_PREFIX layout;
// re-serializing via JSON.stringify could reorder keys and silently break them
// for messages that stay in the mailbox.
export function drainMatchingSession(
  box: BoxId,
  from_session_id: string,
): Mailbox | null {
  return drainFirstMatching(box, (msg) => msg.from_session_id === from_session_id);
}

export function drainMatchingReply(
  box: BoxId,
  from_session_id: string,
  reply_to: string,
): Mailbox | null {
  return drainFirstMatching(
    box,
    (msg) => msg.from_session_id === from_session_id && msg.reply_to === reply_to,
  );
}

// Union variant of drainMatchingReply across a session's inbox boxes (session
// box + sibling/previous MCP child pids). ask_peer waits on the requester's
// boxes, but the reply is addressed by client.session_id and routed by the
// REPLIER's view of our capabilities — a new peer writes our session box, an
// old peer writes whichever sibling pid its resolveTarget picked. A single-box
// drain would then miss a reply that already landed elsewhere and strand it.
//
// Returns the FIRST matching reply across the (deduped) boxes. It does NOT pull
// every match: two DISTINCT replies to the same request_id (an answer + a
// follow-up correction) must not both be drained with one silently dropped — the
// second stays for read_my_messages. But once the first match is found, it DOES
// sweep an exact same-message_id duplicate out of the remaining boxes: a
// migrate-crash can leave the SAME message in two boxes, and if we returned
// one copy and left the other, a later union drain would see only the lone
// survivor and re-deliver it as a "new" message. Sweeping by message_id removes
// the duplicate while leaving any distinct reply intact.
//
// `skipped` reports boxes that could not be inspected (lock contention after the
// internal acquire-retry budget). The poll tolerates this (it retries next tick);
// the authoritative final drain in ask_peer retries the skipped boxes so a
// transiently-locked box holding the reply isn't mistaken for "no reply".
export function drainMatchingReplyManyChecked(
  boxes: BoxId[],
  from_session_id: string,
  reply_to: string,
): { reply: Mailbox | null; skipped: BoxId[] } {
  const seen = new Set<string>();
  const skipped: BoxId[] = [];
  let found: Mailbox | null = null;
  for (const box of boxes) {
    const key = mailboxPath(box);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (!found) {
        const m = drainMatchingReply(box, from_session_id, reply_to);
        if (m) found = m;
      } else {
        // Sweep an exact-message_id duplicate (migrate-crash) from this box;
        // a distinct reply (different id) is left untouched.
        const dupId = found.id;
        drainFirstMatching(box, (msg) => msg.id === dupId);
      }
    } catch {
      skipped.push(box);
    }
  }
  return { reply: found, skipped };
}

export function drainMatchingReplyMany(
  boxes: BoxId[],
  from_session_id: string,
  reply_to: string,
): Mailbox | null {
  return drainMatchingReplyManyChecked(boxes, from_session_id, reply_to).reply;
}

// Best-effort removal of an EXACT message_id from each of `boxes`. Used to clean
// up a migrate-crash duplicate that was left in a box the union drain couldn't
// inspect (lock contention) at the time the reply was pulled from another box —
// otherwise a later read_my_messages would re-deliver the lone survivor as a
// "new" message. Matches by message_id only, so a DISTINCT reply (different id)
// in the same box is never touched. Per-box errors are skipped.
export function sweepMessageId(boxes: BoxId[], messageId: string): void {
  const seen = new Set<string>();
  for (const box of boxes) {
    const key = mailboxPath(box);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      drainFirstMatching(box, (msg) => msg.id === messageId);
    } catch {
      // best effort — a still-locked box is left; the dup is a rare crash-window
      // artifact and the cost is at most one re-delivered (same-id) message.
    }
  }
}

function drainFirstMatching(
  box: BoxId,
  matches: (msg: Mailbox) => boolean,
): Mailbox | null {
  acquireLock(box);
  try {
    let raw: string;
    try {
      raw = readFileSync(mailboxPath(box), "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return null;
      throw err;
    }
    if (!raw) return null;
    const lines = raw.split("\n").filter((l) => l.length > 0);
    let matchIdx = -1;
    let matchedMsg: Mailbox | null = null;
    for (let i = 0; i < lines.length; i++) {
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
        matches(parsed as Mailbox)
      ) {
        matchIdx = i;
        matchedMsg = parsed as Mailbox;
        break;
      }
    }
    if (matchIdx < 0 || !matchedMsg) return null;
    const surviving = [
      ...lines.slice(0, matchIdx),
      ...lines.slice(matchIdx + 1),
    ];
    if (surviving.length === 0) {
      try {
        truncateSync(mailboxPath(box), 0);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw err;
      }
    } else {
      atomicWrite(mailboxPath(box), surviving.join("\n") + "\n");
    }
    return matchedMsg;
  } finally {
    releaseLock(box);
  }
}

export function mailboxFilePath(box: BoxId): string {
  return mailboxPath(box);
}

export function mailboxLockPath(box: BoxId): string {
  return lockPath(box);
}

// ── delivery receipts + sender outbox ────────────────────────────────────────
// A receipt answers the sender's question read_session never could: "did my
// message actually reach the peer's CONTEXT, and when?" — turning "is Codex
// asleep or just slow?" from vibes into data. Written by the RECIPIENT side at
// the moment a message is handed to the agent (hook envelope, read_my_messages
// return, ask_peer reply drain), one tiny JSON file per message_id, write-once
// (first delivery wins; duplicate writes are EEXIST no-ops). The sender's
// outbox record (written at enqueue) lets message_status distinguish "still
// queued in an inbox box" from "gone with no receipt". Both stores are
// best-effort — a write failure must never affect the delivery itself — and
// are pruned by mtime alongside the orphan-mailbox GC.
//
// Lives here (not its own module) because mailbox.js ships in the installed
// hook helper closure (HELPER_FILES): the PreToolUse/Stop hook delivery path
// must write receipts with the same code the server uses.

const MESSAGE_ID_RE = /^[0-9a-f]{16}$/;

function receiptsDir(): string {
  return join(homedir(), ".oxtail", "receipts");
}

function outboxDir(): string {
  return join(homedir(), ".oxtail", "outbox");
}

export type ReceiptVia = "hook" | "read_my_messages" | "ask_peer_reply";

export type DeliveryReceipt = {
  schema_version: 1;
  message_id: string;
  delivered_at: number; // unix seconds
  via: ReceiptVia;
  recipient_session_id: string | null;
};

export type OutboxRecord = {
  schema_version: 1;
  message_id: string;
  enqueued_at: number; // unix seconds
  target_session_id: string | null;
  target_server_pid: number;
  from_session_id: string | null;
};

// Record that `ids` were handed to the agent. Write-once via O_EXCL: the first
// delivery event wins (re-delivered duplicates must not move delivered_at).
export function recordDelivered(
  ids: string[],
  via: ReceiptVia,
  recipientSessionId: string | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): void {
  let dirReady = false;
  for (const id of ids) {
    if (!MESSAGE_ID_RE.test(id)) continue; // id is the filename — shape-gate it
    try {
      if (!dirReady) {
        mkdirSync(receiptsDir(), { recursive: true, mode: 0o700 });
        dirReady = true;
      }
      const receipt: DeliveryReceipt = {
        schema_version: 1,
        message_id: id,
        delivered_at: nowSec,
        via,
        recipient_session_id: recipientSessionId,
      };
      writeFileSync(join(receiptsDir(), id), JSON.stringify(receipt), {
        mode: 0o600,
        flag: "wx",
      });
    } catch {
      // EEXIST (already receipted) or any IO failure: receipts are best-effort.
    }
  }
}

export function readDeliveryReceipt(messageId: string): DeliveryReceipt | null {
  if (!MESSAGE_ID_RE.test(messageId)) return null;
  try {
    const d = JSON.parse(readFileSync(join(receiptsDir(), messageId), "utf8")) as DeliveryReceipt;
    if (!d || d.schema_version !== 1 || d.message_id !== messageId) return null;
    return d;
  } catch {
    return null;
  }
}

export function recordOutbox(rec: OutboxRecord): void {
  if (!MESSAGE_ID_RE.test(rec.message_id)) return;
  try {
    mkdirSync(outboxDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(outboxDir(), rec.message_id), JSON.stringify(rec), {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    // best-effort: a missing outbox record only degrades message_status detail
  }
}

export function readOutboxRecord(messageId: string): OutboxRecord | null {
  if (!MESSAGE_ID_RE.test(messageId)) return null;
  try {
    const d = JSON.parse(readFileSync(join(outboxDir(), messageId), "utf8")) as OutboxRecord;
    if (!d || d.schema_version !== 1 || d.message_id !== messageId) return null;
    return d;
  } catch {
    return null;
  }
}

// Lock-free read-only peek for message_status's "pending" check. Torn lines are
// skipped by the parser; a racing drain just flips the answer to "not here",
// which the caller resolves via the receipt that drain writes.
export function boxContainsMessageId(box: BoxId, messageId: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(mailboxPath(box), "utf8");
  } catch {
    return false;
  }
  return parseMailboxRecords(raw, { via: "status-peek" }).some((m) => m.id === messageId);
}

const DELIVERY_ARTIFACT_TTL_MS = 7 * 24 * 3_600_000;

// Prune aged receipts/outbox records (mtime-based). Same cadence and the same
// best-effort posture as gcOrphanMailboxes; called from register().
export function gcDeliveryArtifacts(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const dir of [receiptsDir(), outboxDir()]) {
    let files: string[];
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!MESSAGE_ID_RE.test(f)) continue;
      const full = join(dir, f);
      try {
        if (nowMs - statSync(full).mtimeMs > DELIVERY_ARTIFACT_TTL_MS) {
          unlinkSync(full);
          removed++;
        }
      } catch {
        // vanished or unreadable — skip
      }
    }
  }
  return removed;
}

// Empty boxes only become garbage once nothing references them: a dead pid's
// registry breadcrumb is reaped as soon as its box is empty (readAll), after
// which the box file itself lingered forever — dozens of 0-byte .jsonl files
// (plus lock sidecars) accumulating per month of dogfooding. The age gate keeps
// us far away from any create-then-write or claim-then-route window; an empty
// box is also recreated lazily by the next enqueue, so deletion is always
// recoverable even if a referencing session later resumes.
const MAILBOX_GC_MIN_AGE_MS = 7 * 24 * 3_600_000;

// Remove orphaned, EMPTY mailbox files (and their lock sidecars). A box is an
// orphan when nothing in the registry can route to it: a pid box with no
// `<pid>.json` registry file, or a session box no entry's `mailbox_key` names.
// Never touches a non-empty box — mail is reaped only via drain/migrate paths.
// Best-effort: per-box errors are skipped; returns the number removed.
export function gcOrphanMailboxes(
  referencedPids: ReadonlySet<number>,
  referencedSessionKeys: ReadonlySet<string>,
  nowMs: number = Date.now(),
): number {
  let files: string[];
  try {
    files = readdirSync(mailboxesDir());
  } catch {
    return 0; // no mailboxes dir yet
  }
  let removed = 0;
  for (const f of files) {
    const m = /^(\d+|s-[A-Za-z0-9_-]+)\.jsonl$/.exec(f);
    if (!m) continue; // lock dirs, owner sidecars, foreign files
    const box: BoxId = /^\d+$/.test(m[1]) ? Number(m[1]) : m[1];
    if (typeof box === "number" ? referencedPids.has(box) : referencedSessionKeys.has(box)) {
      continue;
    }
    const path = mailboxPath(box);
    try {
      const st = statSync(path);
      if (st.size > 0 || nowMs - st.mtimeMs < MAILBOX_GC_MIN_AGE_MS) continue;
    } catch {
      continue; // vanished — nothing to do
    }
    try {
      acquireLock(box);
    } catch {
      continue; // contended — try again next server start
    }
    let held = true;
    try {
      // Re-check under the lock: a writer can't be mid-append now, and anything
      // that landed since the unlocked stat survives.
      const st = statSync(path);
      if (st.size > 0) continue;
      unlinkSync(path);
      // Remove the lock infrastructure WHILE STILL HOLDING the lock — we are
      // provably the only holder, so this can never destroy a peer's held lock
      // (a release-then-rmdir would have exactly that race). A concurrent
      // acquirer just recreates the dir fresh and proceeds; the formal release
      // is skipped because there is nothing left to release.
      try {
        rmSync(`${lockPath(box)}.owner`, { force: true });
        rmdirSync(lockPath(box));
        lockTokens.delete(mailboxPath(box));
        held = false;
      } catch {
        // sidecar cleanup is cosmetic; fall through to a normal release
      }
      removed++;
      trace("mailbox_gc_removed", { box: String(box) });
    } catch {
      // vanished/unlink failure — leave it for the next pass
    } finally {
      if (held) releaseLock(box);
    }
  }
  return removed;
}

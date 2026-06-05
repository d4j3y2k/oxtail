import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  truncateSync,
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
};

export type EnqueueOptions = {
  request_id?: string;
  reply_to?: string;
  source_message_id?: string;
};

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
// Sync this value with assets/pretooluse.sh (find -mmin +0.5 ≈ 30s).
const LOCK_STALE_MS = 30_000;

function mailboxPath(pid: number): string {
  return join(mailboxesDir(), `${pid}.jsonl`);
}

function lockPath(pid: number): string {
  return `${mailboxPath(pid)}.lock`;
}

// Owner tokens for held locks, so releaseLock can prove ownership (a lock stolen
// out from under a stalled holder is not removed on its late release). Keyed by
// pid; never two concurrent acquisitions of the same pid within one process.
const lockTokens = new Map<number, string>();

export function acquireLock(pid: number): void {
  mkdirSync(mailboxesDir(), { recursive: true, mode: 0o700 });
  lockTokens.set(
    pid,
    acquireDirLock(lockPath(pid), LOCK_STALE_MS, "mailbox_lock_stale_clear", { pid }),
  );
}

export function releaseLock(pid: number): void {
  const token = lockTokens.get(pid);
  lockTokens.delete(pid);
  releaseDirLock(lockPath(pid), token ?? "");
}

// Critical: the serialized JSONL line must always begin
// `{"schema_version":1,"id":"...","body":"`. The awk extractor in
// assets/pretooluse.sh assumes `"body":"` is the third key. A future refactor
// that uses Object.assign / spread / inserts a key could silently reorder and
// break the hook without breaking unit tests that don't check serialization.
// The runtime regex below catches that.
const FIELD_ORDER_PREFIX = /^\{"schema_version":1,"id":"[0-9a-f]{16}","body":"/;

// Serialize a Mailbox into its on-disk JSONL line, inserting keys in the
// invariant order (schema_version, id, body, …). Node's JSON.stringify
// preserves insertion order for non-integer string keys, which the test suite
// and the awk extractor in assets/pretooluse.sh both pin. Shared by enqueue
// (fresh messages) and requeue/migrate (re-homing already-built messages) so
// the FIELD_ORDER_PREFIX invariant is enforced in exactly one place.
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
  const line = JSON.stringify(obj) + "\n";
  if (!FIELD_ORDER_PREFIX.test(line)) {
    throw new Error(
      `mailbox: serialized line violates field-order invariant. ` +
      `Got prefix: ${line.slice(0, 80)}`,
    );
  }
  return line;
}

// Append JSONL bytes to a mailbox, healing a missing record boundary first.
// appendFileSync of a buffer is NOT a single atomic syscall, so a crash/torn
// write can leave a file ending in a partial line with no trailing "\n". A later
// append would then concatenate onto that partial line, gluing two records into
// one line that fails JSON.parse in BOTH drain() and the awk hook — silently
// dropping both messages. If the file is non-empty and its last byte isn't "\n",
// prepend one so the boundary is restored (the already-torn record is still lost,
// but it can no longer eat its neighbor). Every append path routes through here.
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
    id: randomBytes(8).toString("hex"),
    body,
    enqueued_at: Math.floor(Date.now() / 1000),
    body_bytes: Buffer.byteLength(body, "utf8"),
    origin: "peer",
    ...(from_session_id ? { from_session_id } : {}),
    ...(options.request_id ? { request_id: options.request_id } : {}),
    ...(options.reply_to ? { reply_to: options.reply_to } : {}),
    ...(options.source_message_id ? { source_message_id: options.source_message_id } : {}),
  };
}

export function enqueue(
  target_pid: number,
  body: string,
  from_session_id?: string,
  options: EnqueueOptions = {},
): Mailbox {
  const msg = buildMessage(body, from_session_id, options);
  acquireLock(target_pid);
  try {
    appendLines(mailboxPath(target_pid), serializeMailboxLine(msg));
  } finally {
    releaseLock(target_pid);
  }
  return msg;
}

// Append an already-built message to a mailbox without minting a new id. Used
// by read_my_messages to put budget-deferred overflow back into the caller's
// own mailbox (lossless: the next drain/hook delivers it) and is the building
// block migrateMailbox uses to re-home a dead sibling's mail.
export function requeue(target_pid: number, msg: Mailbox): void {
  const line = serializeMailboxLine(msg);
  acquireLock(target_pid);
  try {
    appendLines(mailboxPath(target_pid), line);
  } finally {
    releaseLock(target_pid);
  }
}

// Re-append several already-built messages under a single lock. Used by
// read_my_messages to put budget-deferred overflow back in one atomic append
// (one failure point instead of N) so the caller can treat it as all-or-nothing.
export function requeueMany(target_pid: number, msgs: Mailbox[]): void {
  if (msgs.length === 0) return;
  let buf = "";
  for (const m of msgs) buf += serializeMailboxLine(m);
  acquireLock(target_pid);
  try {
    appendLines(mailboxPath(target_pid), buf);
  } finally {
    releaseLock(target_pid);
  }
}

// Drain the union of several pid mailboxes — a session's inbox spread across
// its current + prior/sibling MCP-child pids. Each pid is drained under its own
// lock (no nested locks). Mirrors the PreToolUse hook's session_id→pid union so
// read_my_messages reaches a message enqueued to a sibling/previous pid instead
// of silently stranding it. Best-effort per pid: a contended/unreadable mailbox
// is skipped (counted) and left for the next poll rather than failing the whole
// drain — one stuck lock must not block a session's entire inbox.
//
// Deduped by message_id: a migrateMailbox crash-window (append to dest done, but
// the process died before truncating the source) can leave the SAME message in
// two unioned sibling mailboxes. Both copies are drained (so neither lingers) but
// the message is returned ONCE. message_id is a unique per-message nonce, so this
// only ever collapses true duplicates, never two distinct messages.
export function drainMany(pids: number[]): { messages: Mailbox[]; skipped: number } {
  const out: Mailbox[] = [];
  const seenPids = new Set<number>();
  const seenIds = new Set<string>();
  let skipped = 0;
  for (const pid of pids) {
    if (seenPids.has(pid)) continue;
    seenPids.add(pid);
    try {
      for (const m of drain(pid)) {
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

// True if a pid's mailbox file holds any bytes. drain() truncates to 0 after a
// successful read, so a non-empty file means "undrained mail is here" — used by
// registry reap-deferral to avoid unlinking a dead child's registry entry while
// its mailbox still needs to be reached by the session union-drain.
export function mailboxHasMessages(pid: number): boolean {
  try {
    return statSync(mailboxPath(pid)).size > 0;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

// Move every message from `fromPid`'s mailbox into `toPid`'s, preserving the
// raw JSONL lines byte-exact. Used when a dead MCP child is consolidated into a
// live sibling that shares its session_id, so a message enqueued to the prior
// pid survives the restart. Returns the count migrated.
//
// Correctness (per Codex review): the source mailbox is now ALSO drainable by
// the session union (read_my_messages / the PreToolUse hook). To stop a
// concurrent drainer from grabbing these same lines and double-delivering, the
// source lock is held across the WHOLE move — read, dest append, and source
// truncate. Append happens BEFORE truncate, so a dest-append failure leaves the
// source intact (its breadcrumb is kept and a later migrate/union-drain retries
// it) — never a lost-in-the-gap window.
//
// Lock order is always source→dest. drainMany holds one mailbox lock at a time
// (never source-then-dest), and the PreToolUse hook bounds every lock wait at
// ~500ms (it skips a contended mailbox and proceeds). So this nesting cannot
// deadlock: under contention migrate's dest-lock acquire throws after ~500ms,
// gcDeadSiblings keeps the breadcrumb, and the move is retried on the next
// register. The only residual failure is a crash BETWEEN the append and the
// truncate, which can duplicate (message_id is stable for dedup) — strictly
// preferable to loss or orphaning.
export function migrateMailbox(fromPid: number, toPid: number): number {
  if (fromPid === toPid) return 0;
  const src = mailboxPath(fromPid);
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
    // standalone (unparseable) line in the dest AND over-counting it (H4). Parse
    // each line with the same guard drain uses, drop torn/invalid ones, and
    // rebuild a clean block so the count reflects real, deliverable messages.
    const valid: Mailbox[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        trace("mailbox_migrate_skip_invalid", { fromPid, toPid, line });
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Mailbox).schema_version === 1 &&
        typeof (parsed as Mailbox).id === "string" &&
        typeof (parsed as Mailbox).body === "string"
      ) {
        valid.push(parsed as Mailbox);
      } else {
        trace("mailbox_migrate_skip_invalid", { fromPid, toPid, line });
      }
    }
    if (valid.length === 0) {
      // Only torn/garbage lines — clear the source and report nothing migrated.
      truncateSync(src, 0);
      return 0;
    }
    // serializeMailboxLine already terminates each line with "\n", so join("").
    const block = valid.map((m) => serializeMailboxLine(m)).join("");

    acquireLock(toPid);
    try {
      appendLines(mailboxPath(toPid), block);
    } finally {
      releaseLock(toPid);
    }
    // Append succeeded → clear the source (still under the source lock).
    truncateSync(src, 0);
    return valid.length;
  } finally {
    releaseLock(fromPid);
  }
}

export function drain(my_pid: number): Mailbox[] {
  acquireLock(my_pid);
  try {
    let raw: string;
    try {
      raw = readFileSync(mailboxPath(my_pid), "utf8");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") return [];
      throw err;
    }
    if (!raw) return [];
    const out: Mailbox[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        trace("mailbox_drain_skip_invalid", { pid: my_pid, line });
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
        trace("mailbox_drain_skip_invalid", { pid: my_pid, line });
      }
    }
    try {
      truncateSync(mailboxPath(my_pid), 0);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") throw err;
    }
    return out;
  } finally {
    releaseLock(my_pid);
  }
}

// Drain the first message in this mailbox whose from_session_id matches
// `from_session_id`, leaving any preceding and following messages untouched.
// Used by ask_peer to consume exactly the reply it's waiting on without
// stealing messages from concurrent peers.
//
// Critical invariant: surviving raw lines are written back byte-exact. The
// awk extractor in assets/pretooluse.sh assumes the FIELD_ORDER_PREFIX layout;
// re-serializing via JSON.stringify could reorder keys and silently break the
// hook for messages that stay in the mailbox.
export function drainMatchingSession(
  my_pid: number,
  from_session_id: string,
): Mailbox | null {
  return drainFirstMatching(my_pid, (msg) => msg.from_session_id === from_session_id);
}

export function drainMatchingReply(
  my_pid: number,
  from_session_id: string,
  reply_to: string,
): Mailbox | null {
  return drainFirstMatching(
    my_pid,
    (msg) => msg.from_session_id === from_session_id && msg.reply_to === reply_to,
  );
}

// Union variant of drainMatchingReply across a session's sibling/previous MCP
// child pids. ask_peer waits on the requester's OWN pid, but the reply is
// addressed by client.session_id and resolveTarget(readAll) enqueues it to the
// session's freshest sibling — which, in a dual-scope / pid-rotation setup, may
// NOT be the pid blocked in ask_peer. A single-pid drain would then miss a reply
// that already landed in a sibling mailbox and strand it. Mirrors the session
// union read_my_messages / the PreToolUse hook already use.
//
// Returns the FIRST matching reply across the (deduped) pids. It does NOT pull
// every match: two DISTINCT replies to the same request_id (an answer + a
// follow-up correction) must not both be drained with one silently dropped — the
// second stays for read_my_messages. But once the first match is found, it DOES
// sweep an exact same-message_id duplicate out of the remaining pids: a
// migrate-crash can leave the SAME message in two siblings, and if we returned
// one copy and left the other, a later union drain would see only the lone
// survivor and re-deliver it as a "new" message. Sweeping by message_id removes
// the duplicate while leaving any distinct reply intact.
//
// `skipped` reports pids that could not be inspected (lock contention after the
// internal acquire-retry budget). The poll tolerates this (it retries next tick);
// the authoritative final drain in ask_peer retries the skipped pids so a
// transiently-locked sibling holding the reply isn't mistaken for "no reply".
export function drainMatchingReplyManyChecked(
  pids: number[],
  from_session_id: string,
  reply_to: string,
): { reply: Mailbox | null; skipped: number[] } {
  const seen = new Set<number>();
  const skipped: number[] = [];
  let found: Mailbox | null = null;
  for (const pid of pids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      if (!found) {
        const m = drainMatchingReply(pid, from_session_id, reply_to);
        if (m) found = m;
      } else {
        // Sweep an exact-message_id duplicate (migrate-crash) from this sibling;
        // a distinct reply (different id) is left untouched.
        const dupId = found.id;
        drainFirstMatching(pid, (msg) => msg.id === dupId);
      }
    } catch {
      skipped.push(pid);
    }
  }
  return { reply: found, skipped };
}

export function drainMatchingReplyMany(
  pids: number[],
  from_session_id: string,
  reply_to: string,
): Mailbox | null {
  return drainMatchingReplyManyChecked(pids, from_session_id, reply_to).reply;
}

// Best-effort removal of an EXACT message_id from each of `pids`. Used to clean
// up a migrate-crash duplicate that was left in a pid the union drain couldn't
// inspect (lock contention) at the time the reply was pulled from another pid —
// otherwise a later read_my_messages would re-deliver the lone survivor as a
// "new" message. Matches by message_id only, so a DISTINCT reply (different id)
// in the same pid is never touched. Per-pid errors are skipped.
export function sweepMessageId(pids: number[], messageId: string): void {
  const seen = new Set<number>();
  for (const pid of pids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      drainFirstMatching(pid, (msg) => msg.id === messageId);
    } catch {
      // best effort — a still-locked pid is left; the dup is a rare crash-window
      // artifact and the cost is at most one re-delivered (same-id) message.
    }
  }
}

function drainFirstMatching(
  my_pid: number,
  matches: (msg: Mailbox) => boolean,
): Mailbox | null {
  acquireLock(my_pid);
  try {
    let raw: string;
    try {
      raw = readFileSync(mailboxPath(my_pid), "utf8");
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
        truncateSync(mailboxPath(my_pid), 0);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== "ENOENT") throw err;
      }
    } else {
      atomicWrite(mailboxPath(my_pid), surviving.join("\n") + "\n");
    }
    return matchedMsg;
  } finally {
    releaseLock(my_pid);
  }
}

export function mailboxFilePath(pid: number): string {
  return mailboxPath(pid);
}

export function mailboxLockPath(pid: number): string {
  return lockPath(pid);
}

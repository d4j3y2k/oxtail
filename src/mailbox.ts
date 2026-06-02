import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
const LOCK_RETRY_LIMIT = 50;
const LOCK_RETRY_DELAY_MS = 10;

function mailboxPath(pid: number): string {
  return join(mailboxesDir(), `${pid}.jsonl`);
}

function lockPath(pid: number): string {
  return `${mailboxPath(pid)}.lock`;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function acquireLock(pid: number): void {
  mkdirSync(mailboxesDir(), { recursive: true, mode: 0o700 });
  const lock = lockPath(pid);
  for (let i = 0; i < LOCK_RETRY_LIMIT; i++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
      // Check staleness. If older than LOCK_STALE_MS, force-clear and retry.
      try {
        const st = statSync(lock);
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          try {
            rmdirSync(lock);
            trace("mailbox_lock_stale_clear", { pid });
          } catch {
            // raced with another clearer; fall through to retry
          }
          continue;
        }
      } catch {
        // stat may race; just retry
      }
      sleepSync(LOCK_RETRY_DELAY_MS);
    }
  }
  throw new Error(`could not acquire mailbox lock for pid ${pid}`);
}

export function releaseLock(pid: number): void {
  try {
    rmdirSync(lockPath(pid));
  } catch {
    // ignore ENOENT / not-empty / EPERM
  }
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

export function enqueue(
  target_pid: number,
  body: string,
  from_session_id?: string,
  options: EnqueueOptions = {},
): Mailbox {
  const msg: Mailbox = {
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
  const line = serializeMailboxLine(msg);
  acquireLock(target_pid);
  try {
    appendFileSync(mailboxPath(target_pid), line);
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
    appendFileSync(mailboxPath(target_pid), line);
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
    appendFileSync(mailboxPath(target_pid), buf);
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
export function drainMany(pids: number[]): { messages: Mailbox[]; skipped: number } {
  const out: Mailbox[] = [];
  const seen = new Set<number>();
  let skipped = 0;
  for (const pid of pids) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    try {
      for (const m of drain(pid)) out.push(m);
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
    const block = raw.endsWith("\n") ? raw : raw + "\n";
    const count = raw.split("\n").filter((l) => l.trim().length > 0).length;

    acquireLock(toPid);
    try {
      appendFileSync(mailboxPath(toPid), block);
    } finally {
      releaseLock(toPid);
    }
    // Append succeeded → clear the source (still under the source lock).
    truncateSync(src, 0);
    return count;
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
      writeFileSync(mailboxPath(my_pid), surviving.join("\n") + "\n");
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

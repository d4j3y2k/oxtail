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
  from_session_id?: string;
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
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // tight spin — short enough (10ms) that this is acceptable
  }
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

export function enqueue(
  target_pid: number,
  body: string,
  from_session_id?: string,
): Mailbox {
  const msg: Mailbox = {
    schema_version: 1,
    id: randomBytes(8).toString("hex"),
    body,
    enqueued_at: Math.floor(Date.now() / 1000),
    ...(from_session_id ? { from_session_id } : {}),
  };

  // Build the line by inserting keys in the invariant order. Node's
  // JSON.stringify preserves insertion order for non-integer string keys,
  // which the test suite pins.
  const obj: Record<string, unknown> = {
    schema_version: msg.schema_version,
    id: msg.id,
    body: msg.body,
    enqueued_at: msg.enqueued_at,
  };
  if (from_session_id) obj.from_session_id = from_session_id;
  const line = JSON.stringify(obj) + "\n";

  if (!FIELD_ORDER_PREFIX.test(line)) {
    throw new Error(
      `mailbox enqueue: serialized line violates field-order invariant. ` +
      `Got prefix: ${line.slice(0, 80)}`,
    );
  }

  acquireLock(target_pid);
  try {
    appendFileSync(mailboxPath(target_pid), line);
  } finally {
    releaseLock(target_pid);
  }
  return msg;
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
        (parsed as Mailbox).from_session_id === from_session_id
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

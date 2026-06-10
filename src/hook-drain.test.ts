// Unit tests for the hook-drain helper — the bits the bash-spawning pipeline
// tests can't reach deterministically: argv parsing, path validation, and the
// full-write-or-no-truncate guarantee (Codex review BLOCK: a short/failed
// stdout write must never destroy undelivered mail).

import { strict as assert } from "node:assert";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as mailbox from "./mailbox.js";
import {
  EXIT_DELIVERED,
  EXIT_NOTHING,
  isValidMailboxPath,
  parseArgs,
  runHookDrain,
} from "./hook-drain.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-hkdrain-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

test("hook-drain: parseArgs accepts the contract shape, rejects junk", () => {
  const ok = parseArgs(["--event", "pretooluse", "--protocol", "1", "/a.jsonl", "/b.jsonl"]);
  assert.ok(ok);
  assert.equal(ok!.event, "pretooluse");
  assert.equal(ok!.protocol, 1);
  assert.deepEqual(ok!.boxes, ["/a.jsonl", "/b.jsonl"]);

  assert.equal(parseArgs(["--event", "weird", "--protocol", "1"]), null);
  assert.equal(parseArgs(["--event", "stop"]), null, "missing protocol");
  assert.equal(parseArgs([]), null);
});

test("hook-drain: isValidMailboxPath confines to ~/.oxtail/mailboxes", () => {
  const home = "/Users/x";
  const dir = join(home, ".oxtail", "mailboxes");
  assert.ok(isValidMailboxPath(join(dir, "1234.jsonl"), home));
  assert.ok(isValidMailboxPath(join(dir, "s-abc-12345678.jsonl"), home));
  assert.ok(!isValidMailboxPath(join(dir, "..", "sessions", "1.jsonl"), home), "dotdot");
  assert.ok(!isValidMailboxPath("/etc/passwd", home));
  assert.ok(!isValidMailboxPath(join(dir, "nested", "1.jsonl"), home), "no subdirs");
  assert.ok(!isValidMailboxPath(join(dir, "evil name.jsonl"), home), "bad basename");
});

test("hook-drain: failed stdout write FAILS OPEN — no truncate, lock released", () => {
  withHome((home) => {
    const pid = 81001;
    mailbox.enqueue(pid, "must not be destroyed", "sender");
    const path = mailbox.mailboxFilePath(pid);

    // A closed fd makes every writeSync throw (EBADF) — the deterministic
    // stand-in for a broken/short stdout pipe.
    const scratch = openSync(join(home, "scratch"), "w");
    closeSync(scratch);

    const code = runHookDrain(
      ["--event", "pretooluse", "--protocol", "1", path],
      process.env,
      scratch,
    );
    assert.equal(code, EXIT_NOTHING, "delivery failed → report nothing delivered");
    assert.ok(
      mailbox.mailboxHasMessages(pid),
      "mailbox intact — a failed write must never destroy mail",
    );
    // Lock released: a follow-up run with a GOOD fd delivers normally.
    const out = openSync(join(home, "out.json"), "w");
    try {
      const code2 = runHookDrain(["--event", "pretooluse", "--protocol", "1", path], process.env, out);
      assert.equal(code2, EXIT_DELIVERED, "next event delivers the preserved mail");
    } finally {
      closeSync(out);
    }
    assert.equal(mailbox.mailboxHasMessages(pid), false, "delivered → drained");
  });
});

test("hook-drain: torn-only box is truncated so the bash -s gate stops re-spawning the helper", () => {
  withHome((home) => {
    const pid = 81002;
    mailbox.enqueue(pid, "seed", "sender"); // create the box + lock layout
    const path = mailbox.mailboxFilePath(pid);
    // Crash-torn content: non-empty on disk, zero parseable records. Before the
    // fix this returned EXIT_NOTHING without truncating, so the bash trigger's
    // `-s` check re-spawned a Node helper on every subsequent tool call.
    writeFileSync(path, '{"schema_version":1,"id":"torn');
    const out = openSync(join(home, "out.json"), "w");
    let code: number;
    try {
      code = runHookDrain(["--event", "pretooluse", "--protocol", "1", path], process.env, out);
    } finally {
      closeSync(out);
    }
    assert.equal(code, EXIT_NOTHING, "nothing deliverable");
    assert.equal(readFileSync(path, "utf8"), "", "garbage-only box self-heals to empty");
    assert.equal(readFileSync(join(home, "out.json"), "utf8"), "", "no envelope emitted");
  });
});

test("hook-drain: successful write truncates and reports delivered", () => {
  withHome((home) => {
    const box = mailbox.mailboxSessionKey("aaaa1111-2222-4333-8444-555566667777");
    mailbox.enqueue(box, "session-box body", "sender-x", { request_id: "rq-9" });
    const out = openSync(join(home, "envelope.json"), "w");
    let code: number;
    try {
      code = runHookDrain(
        ["--event", "stop", "--protocol", "1", mailbox.mailboxFilePath(box)],
        process.env,
        out,
      );
    } finally {
      closeSync(out);
    }
    assert.equal(code, EXIT_DELIVERED);
    assert.equal(mailbox.mailboxHasMessages(box), false);
    const envelope = JSON.parse(readFileSync(join(home, "envelope.json"), "utf8"));
    assert.equal(envelope.decision, "block");
    assert.ok(envelope.reason.includes("session-box body"));
    assert.ok(envelope.reason.includes("request_id=rq-9"));
  });
});

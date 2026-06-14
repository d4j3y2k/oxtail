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
  renderPreToolUse,
  renderStop,
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

test("hook-drain: --sid writes delivery receipts on the delivered path only", () => {
  withHome((home) => {
    const sid = "12345678-1234-4321-8765-1234567890ab";
    const box = mailbox.mailboxSessionKey(sid);
    const sent = mailbox.enqueue(box, "receipted body", "sender-sid");
    const out = openSync(join(home, "env.json"), "w");
    let code: number;
    try {
      code = runHookDrain(
        ["--event", "pretooluse", "--protocol", "1", "--sid", sid, mailbox.mailboxFilePath(box)],
        process.env,
        out,
      );
    } finally {
      closeSync(out);
    }
    assert.equal(code, EXIT_DELIVERED);
    const receipt = mailbox.readDeliveryReceipt(sent.id);
    assert.ok(receipt, "delivered envelope must leave a receipt");
    assert.equal(receipt!.via, "hook");
    assert.equal(receipt!.recipient_session_id, sid);

    // Failed stdout write (fail-open path) must NOT leave a receipt.
    const sent2 = mailbox.enqueue(box, "must not receipt", "sender-sid");
    const closed = openSync(join(home, "scratch2"), "w");
    closeSync(closed);
    const code2 = runHookDrain(
      ["--event", "pretooluse", "--protocol", "1", "--sid", sid, mailbox.mailboxFilePath(box)],
      process.env,
      closed,
    );
    assert.equal(code2, EXIT_NOTHING);
    assert.equal(mailbox.readDeliveryReceipt(sent2.id), null, "no envelope → no receipt");
  });
});

test("hook-drain: a malformed --sid is dropped, an old-helper-style stray flag is discarded as a non-box", () => {
  const ok = parseArgs(["--event", "stop", "--protocol", "1", "--sid", "not-a-uuid", "/a.jsonl"]);
  assert.ok(ok);
  assert.equal(ok!.sid, null, "shape-gated");
  assert.deepEqual(ok!.boxes, ["/a.jsonl"]);
  // Old helpers route unknown flags into boxes; isValidMailboxPath rejects them.
  assert.ok(!isValidMailboxPath("--sid", "/Users/x"));
});

// --- v13 obligation surfacing: render the functions DIRECTLY (they are exported)
// rather than through runHookDrain, so these assertions don't entangle the
// receipt/truncation side effects of the full drain (Realist review M4).
function ordinaryMsg(over: Partial<mailbox.Mailbox> = {}): mailbox.Mailbox {
  return {
    schema_version: 1,
    id: "00aa11bb22cc33dd",
    body: "just saying hi",
    enqueued_at: 1_700_000_000_000,
    from_session_id: "sender-sid",
    ...over,
  };
}
function delegationMsg(over: Partial<mailbox.Mailbox> = {}): mailbox.Mailbox {
  return ordinaryMsg({ id: "ff00ee11dd22cc33", body: "compute the thing", action_required: true, ...over });
}

const BIG = 24_000;

test("hook-drain v13: ordinary traffic is unchanged — no tag, no obligation steer", () => {
  for (const out of [renderPreToolUse([ordinaryMsg()], BIG), renderStop([ordinaryMsg()], BIG)]) {
    // The byte-budget guard: a non-obligation batch must add ZERO obligation
    // content. Anything else would mean ordinary traffic started paying for the
    // steer (v5 token budget regression).
    assert.ok(!out.includes("action_required"), "no per-message tag on ordinary mail");
    assert.ok(!out.includes("complete_work"), "no obligation steer on ordinary mail");
    assert.ok(!out.includes("block_work"));
    assert.ok(!out.includes("my_open_work"));
    // …but normal rendering still happened.
    assert.ok(out.includes("message_id=00aa11bb22cc33dd"));
    assert.ok(out.includes("just saying hi"));
  }
});

test("hook-drain v13: a delegation renders the tag + steer, steer placed BEFORE the bodies", () => {
  const ctx = renderPreToolUse([delegationMsg({ body: "BODYMARKER" })], BIG);
  assert.ok(ctx.includes("| action_required"), "per-message obligation tag");
  assert.ok(
    ctx.includes("close each with complete_work(message_id, result) or block_work(message_id, reason)"),
    "steer names both closing verbs",
  );
  assert.ok(ctx.includes("not reply_to_message"), "steer routes away from the ordinary reply path");
  assert.ok(ctx.includes("my_open_work"), "steer points at the authoritative owed-work list");
  // M1: the steer must precede the (up to 24k char) message bodies, or it gets buried.
  assert.ok(
    ctx.indexOf("durable obligations") < ctx.indexOf("BODYMARKER"),
    "obligation steer renders before the message body",
  );
});

test("hook-drain v13: the Stop envelope also carries the steer", () => {
  const env = JSON.parse(renderStop([delegationMsg()], BIG));
  assert.equal(env.decision, "block");
  assert.ok(env.reason.includes("| action_required"));
  assert.ok(env.reason.includes("close each with complete_work"));
});

test("hook-drain v13: a budget-omitted obligation body adds the my_open_work recovery note (M2)", () => {
  // Body far exceeds the budget → renderMessages truncates it (truncatedCount>0)
  // while hasObligation stays true: tell the receiver to read the full body via
  // my_open_work before closing, rather than act on content it never saw.
  const ctx = renderPreToolUse([delegationMsg({ body: "X".repeat(200) })], 10);
  assert.ok(ctx.includes("truncated"), "body was truncated by the budget");
  assert.ok(
    ctx.includes("read it in full via my_open_work before closing"),
    "truncated obligation gets the recovery instruction",
  );
});

test("hook-drain v13: a mixed batch tags only the obligation but steers once", () => {
  const ctx = renderPreToolUse([ordinaryMsg(), delegationMsg()], BIG);
  // Exactly one per-message tag (on the delegation), one steer clause for the batch.
  assert.equal(ctx.match(/\| action_required/g)?.length, 1, "only the delegation is tagged");
  assert.equal(
    ctx.match(/durable obligations \(marked action_required\)/g)?.length,
    1,
    "the batch-level steer appears once",
  );
});

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as mailbox from "./mailbox.js";
import { deliverExistingToPeer, deliverToPeer } from "./delivery.js";
import { lookupReceived, receivedFilePath, recordReceived } from "./received.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-deliv-"));
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

const RECEIVER = "11111111-1111-1111-1111-111111111111";
const SENDER = "22222222-2222-2222-2222-222222222222";
const PID = 4242;

// Abort-recovery path: an ALREADY-BUILT reply must be re-delivered without
// minting a new id, and must (re)write the requester's ledger so the displayed
// message_id stays resolvable. The old path used mailbox.enqueue, which minted a
// fresh id and skipped the ledger — breaking reply_to_message on abort.
test("delivery: deliverExistingToPeer preserves the id AND records the ledger handle", () => {
  withHome(() => {
    const original = mailbox.buildMessage("the answer", SENDER, {
      request_id: "ask-7",
      reply_to: "ask-7",
      source_message_id: "q-1",
    });

    deliverExistingToPeer(RECEIVER, PID, original);

    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1, "reply re-delivered to the mailbox");
    assert.equal(drained[0].id, original.id, "id preserved — NOT re-minted");
    assert.equal(drained[0].body, "the answer");
    assert.equal(drained[0].request_id, "ask-7");

    const found = lookupReceived(RECEIVER, original.id);
    assert.ok(found, "displayed message_id stays resolvable for reply_to_message");
    assert.equal(found!.id, original.id);
    assert.equal(found!.source_message_id, "q-1");
  });
});

test("delivery: deliverExistingToPeer to an unclaimed receiver still delivers (no ledger)", () => {
  withHome(() => {
    const original = mailbox.buildMessage("for unclaimed", SENDER);
    deliverExistingToPeer(null, PID, original);
    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].id, original.id, "id preserved even without a ledger");
    assert.equal(lookupReceived(SENDER, original.id), null);
  });
});

test("delivery: deliverToPeer makes the line drainable AND the handle resolvable", () => {
  withHome(() => {
    const msg = deliverToPeer(RECEIVER, PID, "hi peer", SENDER, { request_id: "d1" });

    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1, "message delivered to the mailbox");
    assert.equal(drained[0].id, msg.id);

    const found = lookupReceived(RECEIVER, msg.id);
    assert.ok(found, "reply handle resolvable even after the queue is drained");
    assert.equal(found!.request_id, "d1");
  });
});

// The race Codex caught: with record-BEFORE-append, the ledger entry exists the
// instant the mailbox line first becomes visible — so a hook that drains and
// renders the handle the moment it appears, followed by an immediate reply, can
// always resolve it. This replicates deliverToPeer's internal order with a
// hostile drain injected at the most dangerous point.
test("delivery: record precedes append — handle resolvable when the line is first seen", () => {
  withHome(() => {
    const msg = mailbox.buildMessage("answer", SENDER, { request_id: "race-safe" });
    recordReceived(RECEIVER, msg); // 1) ledger first
    mailbox.requeue(PID, msg); // 2) NOW the line is visible

    // A PreToolUse/Stop hook fires the instant the line appears and drains it:
    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].id, msg.id);

    // The receiver, replying immediately, MUST resolve the handle.
    assert.ok(
      lookupReceived(RECEIVER, msg.id),
      "record-before-append: handle resolvable at first sight",
    );
  });
});

// Regression guard documenting WHY the order matters: append-then-record leaves
// a window where the hook has already rendered/drained the message_id but the
// ledger entry does not exist yet — an immediate reply_to_message would fail.
// deliverToPeer must never produce this ordering.
test("delivery: append-before-record exposes the unresolvable-handle window", () => {
  withHome(() => {
    const msg = mailbox.buildMessage("answer", SENDER, { request_id: "race-bug" });
    mailbox.requeue(PID, msg); // line visible FIRST (the bug)
    mailbox.drain(PID); // hook renders + drains the handle...

    // ...and at this instant, before the (late) record, the handle is unresolvable.
    assert.equal(
      lookupReceived(RECEIVER, msg.id),
      null,
      "old order: handle displayed but not yet resolvable — the race deliverToPeer closes",
    );
  });
});

// Codex review pin: availability over reply-handle. If the ledger write fails
// (here: the ledger lock is held, so recordReceived exhausts retries and throws),
// deliverToPeer must STILL deliver the message — the handle is the only thing
// lost, and reply_to_message degrades to message-not-found / send_message.
test("delivery: ledger write failure still appends the message", () => {
  withHome(() => {
    const lock = receivedFilePath(RECEIVER) + ".lock";
    mkdirSync(dirname(lock), { recursive: true });
    mkdirSync(lock); // occupy the (fresh, non-stale) lock so recordReceived throws
    try {
      const msg = deliverToPeer(RECEIVER, PID, "must still arrive", SENDER, {
        request_id: "avail-1",
      });
      const drained = mailbox.drain(PID);
      assert.equal(drained.length, 1, "delivery proceeds even when the ledger write fails");
      assert.equal(drained[0].id, msg.id);
      assert.equal(drained[0].body, "must still arrive");
    } finally {
      rmdirSync(lock);
    }
  });
});

test("delivery: unclaimed receiver still gets the message, just no ledger handle", () => {
  withHome(() => {
    const msg = deliverToPeer(null, PID, "for an unclaimed peer", SENDER);
    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1, "delivery must not depend on a ledger write");
    assert.equal(drained[0].body, "for an unclaimed peer");
    // No receiver session → nothing to look the handle up under.
    assert.equal(lookupReceived(SENDER, msg.id), null);
  });
});

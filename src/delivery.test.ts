import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as mailbox from "./mailbox.js";
import { deliverExistingToPeer, deliverToPeer, routeBox, type DeliveryRoute } from "./delivery.js";
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

const KEYED: DeliveryRoute = { session_id: RECEIVER, server_pid: PID, session_keyed: true };
const LEGACY: DeliveryRoute = { session_id: RECEIVER, server_pid: PID, session_keyed: false };
const UNCLAIMED: DeliveryRoute = { session_id: null, server_pid: PID, session_keyed: false };

const RECEIVER_BOX = mailbox.mailboxSessionKey(RECEIVER);

// Write a registry breadcrumb for PID claiming RECEIVER, the way a live legacy
// peer's entry looks on disk — so the legacy-send breadcrumb re-check passes.
function writeBreadcrumb(home: string, pid: number, sessionId: string | null): void {
  const dir = join(home, ".oxtail", "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify(
      {
        server_pid: pid,
        started_at: Math.floor(Date.now() / 1000),
        client: {
          type: "claude-code",
          session_id: sessionId,
          transcript_path: null,
          session_id_source: "self-register",
          cwd: home,
        },
        tmux_pane: null,
        tmux_session: null,
        state: null,
      },
      null,
      2,
    ),
  );
}

test("delivery: routeBox — session box for capable claimed peers, pid box otherwise", () => {
  assert.equal(routeBox(KEYED), RECEIVER_BOX);
  assert.equal(routeBox(LEGACY), PID, "no capability advertised → legacy pid box");
  assert.equal(routeBox(UNCLAIMED), PID, "unclaimed → pid box even if capability were set");
  assert.equal(
    routeBox({ session_id: null, server_pid: PID, session_keyed: true }),
    PID,
    "session_keyed without a session_id still has no session box to route to",
  );
});

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

    deliverExistingToPeer(KEYED, original);

    const drained = mailbox.drain(RECEIVER_BOX);
    assert.equal(drained.length, 1, "reply re-delivered to the session box");
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
    deliverExistingToPeer(UNCLAIMED, original);
    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].id, original.id, "id preserved even without a ledger");
    assert.equal(lookupReceived(SENDER, original.id), null);
  });
});

test("delivery: deliverToPeer makes the line drainable AND the handle resolvable", () => {
  withHome(() => {
    const msg = deliverToPeer(KEYED, "hi peer", SENDER, { request_id: "d1" });

    const drained = mailbox.drain(RECEIVER_BOX);
    assert.equal(drained.length, 1, "message delivered to the session box");
    assert.equal(drained[0].id, msg.id);

    const found = lookupReceived(RECEIVER, msg.id);
    assert.ok(found, "reply handle resolvable even after the queue is drained");
    assert.equal(found!.request_id, "d1");
  });
});

// Mixed-version routing: a peer that does NOT advertise session_keyed (a
// pre-v0.17 reader) must keep receiving on its legacy pid box — its reader
// never looks at the session box. With a live breadcrumb, no rescue copy.
test("delivery: legacy peer with a live breadcrumb gets pid-box mail only", () => {
  withHome((home) => {
    writeBreadcrumb(home, PID, RECEIVER);
    const msg = deliverToPeer(LEGACY, "old-school", SENDER);

    const pidDrained = mailbox.drain(PID);
    assert.equal(pidDrained.length, 1, "legacy pid box got the message");
    assert.equal(pidDrained[0].id, msg.id);
    assert.equal(
      mailbox.mailboxHasMessages(RECEIVER_BOX),
      false,
      "no session-box copy when the breadcrumb is alive — old readers would never drain it and a later new reader would re-deliver it",
    );
  });
});

// The Codex-flagged mixed-version hole: a legacy send whose target breadcrumb
// vanished in the resolve→enqueue gap leaves the pid-box mail unreachable by
// ANY reader's session union. The rescue writes a session-box copy so a v0.17+
// reader still receives it. Same message_id, so a union drain dedups.
test("delivery: legacy send with a LOST breadcrumb rescues a session-box copy", () => {
  withHome(() => {
    // No registry file for PID at all — the breadcrumb is gone.
    const msg = deliverToPeer(LEGACY, "rescued", SENDER);

    assert.ok(mailbox.mailboxHasMessages(PID), "pid copy still written (legacy contract)");
    assert.ok(mailbox.mailboxHasMessages(RECEIVER_BOX), "session-box rescue copy written");

    // A v0.17+ reader union-drains both; message_id dedup delivers exactly once.
    const { messages } = mailbox.drainMany([RECEIVER_BOX, PID]);
    assert.equal(messages.length, 1, "union drain dedups the rescue copy");
    assert.equal(messages[0].id, msg.id);
  });
});

// A breadcrumb that exists but belongs to a DIFFERENT identity (pid reuse, or
// the entry rotated to another session) is as lost as a missing one.
test("delivery: legacy send with a breadcrumb claimed by another session rescues too", () => {
  withHome((home) => {
    writeBreadcrumb(home, PID, "99999999-9999-9999-9999-999999999999");
    deliverToPeer(LEGACY, "stolen pid", SENDER);
    assert.ok(mailbox.mailboxHasMessages(RECEIVER_BOX), "rescue copy written");
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
      const msg = deliverToPeer(KEYED, "must still arrive", SENDER, {
        request_id: "avail-1",
      });
      const drained = mailbox.drain(RECEIVER_BOX);
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
    const msg = deliverToPeer(UNCLAIMED, "for an unclaimed peer", SENDER);
    const drained = mailbox.drain(PID);
    assert.equal(drained.length, 1, "delivery must not depend on a ledger write");
    assert.equal(drained[0].body, "for an unclaimed peer");
    // No receiver session → nothing to look the handle up under.
    assert.equal(lookupReceived(SENDER, msg.id), null);
  });
});

// H1 — durable obligation under ledger-write failure (the disk-full incident).
// my_open_work / countOpenObligations read the LEDGER, not the mailbox, so an
// action_required delegation whose ledger write fails must NOT be delivered as
// untracked mail — fail loud so the sender retries. An ordinary message keeps the
// best-effort behaviour (deliver anyway; worst case a missing reply handle).

test("deliverToPeer: action_required + ledger-write failure → throws, nothing enqueued (H1)", () => {
  withHome(() => {
    const boom = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    assert.throws(
      () => deliverToPeer(KEYED, "do the review", SENDER, { action_required: true }, boom),
      /ledger write failed|delivery aborted/,
      "an action_required delegation must fail loud when its ledger record fails",
    );
    assert.equal(
      mailbox.mailboxHasMessages(RECEIVER_BOX),
      false,
      "delivery aborted before enqueue — no obligation stranded invisible in the mailbox",
    );
  });
});

test("deliverToPeer: ordinary message + ledger-write failure → still delivered (best-effort, H1)", () => {
  withHome(() => {
    const boom = () => {
      throw new Error("ENOSPC: no space left on device");
    };
    const msg = deliverToPeer(KEYED, "fyi", SENDER, {}, boom); // not action_required
    assert.ok(msg.id, "ordinary delivery proceeds despite a ledger failure");
    assert.equal(
      mailbox.mailboxHasMessages(RECEIVER_BOX),
      true,
      "ordinary message still enqueued (worst case = a missing reply handle)",
    );
  });
});

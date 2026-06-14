import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as mailbox from "./mailbox.js";
import {
  claimObligation,
  countOpenObligations,
  listOpenObligations,
  lookupReceived,
  reopenObligation,
  receivedFilePath,
  receivedMax,
  recordReceived,
} from "./received.js";

// homedir() defers to $HOME on POSIX; both mailbox.ts and received.ts resolve
// their dirs lazily, so swapping HOME between tests isolates them.
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-recv-"));
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

test("received: recordReceived then lookupReceived returns the envelope", () => {
  withHome(() => {
    const msg = mailbox.enqueue(4242, "hello peer", SENDER, { request_id: "req-abc" });
    recordReceived(RECEIVER, msg);

    const found = lookupReceived(RECEIVER, msg.id);
    assert.ok(found, "message should be found in the ledger");
    assert.equal(found!.id, msg.id);
    assert.equal(found!.body, "hello peer");
    assert.equal(found!.from_session_id, SENDER);
    assert.equal(found!.request_id, "req-abc");
  });
});

// The whole reason the ledger exists: delivery is destructive. drain() truncates
// the mailbox to 0 after a read, so without the ledger the reply handle is gone.
test("received: entry survives a destructive mailbox drain", () => {
  withHome(() => {
    const pid = 4242;
    const msg = mailbox.enqueue(pid, "answer me", SENDER, { request_id: "req-xyz" });
    recordReceived(RECEIVER, msg);

    // Simulate read_my_messages / the poll path consuming the queue.
    const drained = mailbox.drain(pid);
    assert.equal(drained.length, 1);
    assert.equal(readFileSync(mailbox.mailboxFilePath(pid), "utf8"), "", "queue emptied");

    // The reply handle must still resolve.
    const found = lookupReceived(RECEIVER, msg.id);
    assert.ok(found, "ledger entry must survive the mailbox drain");
    assert.equal(found!.request_id, "req-xyz");
  });
});

// The PreToolUse hook is bash; it renders the message then does `:> "$m"`,
// truncating the mailbox file directly without going through mailbox.drain().
// The ledger (written at enqueue, in TypeScript) is untouched by that path.
test("received: entry survives the hook's direct file truncation", () => {
  withHome(() => {
    const pid = 4242;
    const msg = mailbox.enqueue(pid, "hook-delivered", SENDER, { request_id: "req-hook" });
    recordReceived(RECEIVER, msg);

    // Mimic the bash hook's `:> "$m"`.
    truncateSync(mailbox.mailboxFilePath(pid), 0);
    assert.equal(readFileSync(mailbox.mailboxFilePath(pid), "utf8"), "", "hook emptied queue");

    const found = lookupReceived(RECEIVER, msg.id);
    assert.ok(found, "ledger entry must survive hook truncation");
    assert.equal(found!.id, msg.id);
  });
});

// M4: a re-record of the same message_id (ask_peer abort recovery, chained
// re-delivery) must replace the prior line, not append a duplicate — duplicates
// waste the receivedMax prune budget and can evict still-needed handles early.
test("received: re-recording the same message_id is idempotent (one ledger line)", () => {
  withHome(() => {
    const msg = mailbox.enqueue(4242, "answer", SENDER, { request_id: "req-1" });
    recordReceived(RECEIVER, msg);
    recordReceived(RECEIVER, msg); // abort-recovery re-record
    recordReceived(RECEIVER, msg); // and again

    const lines = readFileSync(receivedFilePath(RECEIVER), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "duplicate message_id must not accumulate ledger lines");

    const found = lookupReceived(RECEIVER, msg.id);
    assert.ok(found, "the handle still resolves");
    assert.equal(found!.request_id, "req-1");
  });
});

test("received: lookupReceived returns null for an unknown id", () => {
  withHome(() => {
    const msg = mailbox.enqueue(4242, "x", SENDER);
    recordReceived(RECEIVER, msg);
    assert.equal(lookupReceived(RECEIVER, "deadbeefdeadbeef"), null);
  });
});

// L1: a hand-written/torn ledger line with a matching id but no valid envelope
// (missing schema_version/body) must NOT be returned as a "found" message.
test("received: lookupReceived rejects a malformed line even if the id matches", () => {
  withHome(() => {
    // Seed a valid record so the ledger dir/file exist, then overwrite with a
    // hand-written id-only line (no schema_version/body).
    recordReceived(RECEIVER, mailbox.enqueue(4242, "seed", SENDER));
    writeFileSync(receivedFilePath(RECEIVER), '{"id":"abc123"}\n');
    assert.equal(lookupReceived(RECEIVER, "abc123"), null, "id-only line is not a valid envelope");
  });
});

// Ownership is structural: a session can only resolve handles in its own ledger.
test("received: ledger is isolated per receiver session", () => {
  withHome(() => {
    const msg = mailbox.enqueue(4242, "for receiver only", SENDER, { request_id: "r1" });
    recordReceived(RECEIVER, msg);

    // A different session must NOT be able to look up this message_id.
    assert.equal(lookupReceived(SENDER, msg.id), null);
    assert.equal(lookupReceived("33333333-3333-3333-3333-333333333333", msg.id), null);
    // The owner still sees it.
    assert.ok(lookupReceived(RECEIVER, msg.id));
  });
});

test("received: lookup finds the right envelope among many", () => {
  withHome(() => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const m = mailbox.enqueue(4242, `body ${i}`, SENDER, { request_id: `req-${i}` });
      recordReceived(RECEIVER, m);
      ids.push(m.id);
    }
    const target = lookupReceived(RECEIVER, ids[5]);
    assert.ok(target);
    assert.equal(target!.body, "body 5");
    assert.equal(target!.request_id, "req-5");
  });
});

// Bounded retention: the oldest entries age out once the ledger exceeds the cap.
// Aged-out handles return null (fail-closed), never a wrong match.
test("received: retention bound prunes oldest, keeps newest", () => {
  withHome(() => {
    const prevMax = process.env.OXTAIL_RECEIVED_MAX;
    process.env.OXTAIL_RECEIVED_MAX = "10";
    try {
      const cap = receivedMax();
      assert.equal(cap, 10, "env override should drive the cap");
      const ids: string[] = [];
      const overflow = 5;
      for (let i = 0; i < cap + overflow; i++) {
        const m = mailbox.enqueue(4242, `b${i}`, SENDER, { request_id: `q${i}` });
        recordReceived(RECEIVER, m);
        ids.push(m.id);
      }
      // The first `overflow` should have been pruned.
      for (let i = 0; i < overflow; i++) {
        assert.equal(lookupReceived(RECEIVER, ids[i]), null, `id[${i}] should be pruned`);
      }
      // The most recent should remain.
      const newest = lookupReceived(RECEIVER, ids[ids.length - 1]);
      assert.ok(newest, "newest entry must be retained");
      assert.equal(newest!.body, `b${cap + overflow - 1}`);

      // Ledger never exceeds the cap.
      const lines = readFileSync(receivedFilePath(RECEIVER), "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      assert.equal(lines.length, cap);
    } finally {
      if (prevMax === undefined) delete process.env.OXTAIL_RECEIVED_MAX;
      else process.env.OXTAIL_RECEIVED_MAX = prevMax;
    }
  });
});

// The ledger is rewritten in full on every record; an in-place writeFileSync can
// leave a torn file on crash, corrupting older reply handles. The atomic
// tmp+rename rewrite leaves no temp residue and preserves all entries.
test("received: atomic ledger rewrite leaves no .tmp residue", () => {
  withHome(() => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = mailbox.enqueue(4242, `b${i}`, SENDER, { request_id: `q${i}` });
      recordReceived(RECEIVER, m);
      ids.push(m.id);
    }
    const dir = dirname(receivedFilePath(RECEIVER));
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftover, [], "no temp files left behind after atomic rewrite");
    // Every recorded handle still resolves.
    for (let i = 0; i < ids.length; i++) {
      assert.ok(lookupReceived(RECEIVER, ids[i]), `id[${i}] still resolvable`);
    }
  });
});

test("received: empty/missing session id is a graceful no-op", () => {
  withHome(() => {
    const msg = mailbox.enqueue(4242, "x", SENDER);
    // Must not throw.
    recordReceived("", msg);
    assert.equal(lookupReceived("", msg.id), null);
  });
});

// Provenance chains: a reply is itself recorded into the original asker's ledger
// (mirrors what reply_to_message does after enqueue), so a reply can be replied
// to in turn.
test("received: a recorded reply is itself lookupable for chaining", () => {
  withHome(() => {
    const ask = mailbox.enqueue(4242, "question", SENDER, { request_id: "chain-1" });
    recordReceived(RECEIVER, ask);

    // RECEIVER replies; that reply lands in SENDER's ledger.
    const reply = mailbox.enqueue(5252, "answer", RECEIVER, {
      reply_to: "chain-1",
      source_message_id: ask.id,
    });
    recordReceived(SENDER, reply);

    const found = lookupReceived(SENDER, reply.id);
    assert.ok(found);
    assert.equal(found!.reply_to, "chain-1");
    assert.equal(found!.source_message_id, ask.id);
    assert.equal(found!.from_session_id, RECEIVER);
  });
});

// --- v0.19 durable-delegation obligations ------------------------------------

test("obligations: an action_required message becomes an OPEN obligation", () => {
  withHome(() => {
    const plain = mailbox.enqueue(4242, "fyi", SENDER);
    const deleg = mailbox.enqueue(4242, "please do X", SENDER, {
      request_id: "req-x",
      action_required: true,
    });
    recordReceived(RECEIVER, plain);
    recordReceived(RECEIVER, deleg);

    assert.equal(countOpenObligations(RECEIVER), 1, "only the action_required one counts");
    const open = listOpenObligations(RECEIVER);
    assert.equal(open.length, 1);
    assert.equal(open[0].id, deleg.id);
    assert.equal(open[0].body, "please do X");
    assert.equal(open[0].action_required, true);
    assert.equal(open[0].from_session_id, SENDER);
  });
});

test("obligations: claim closes it — leaves the open set, stays lookupable", () => {
  withHome(() => {
    const deleg = mailbox.enqueue(4242, "do X", SENDER, { request_id: "q", action_required: true });
    recordReceived(RECEIVER, deleg);
    assert.equal(countOpenObligations(RECEIVER), 1);

    const claim = claimObligation(RECEIVER, deleg.id, "done", "did it");
    assert.equal(claim.result, "claimed");
    assert.ok(claim.result === "claimed" && claim.inbound, "returns the inbound so the caller can notify");
    if (claim.result === "claimed") {
      assert.equal(claim.inbound.from_session_id, SENDER);
      assert.equal(claim.inbound.request_id, "q");
    }

    assert.equal(countOpenObligations(RECEIVER), 0, "closed obligation leaves the open set");
    assert.equal(listOpenObligations(RECEIVER).length, 0);
    // The envelope is still resolvable for reply/provenance, now carrying the outcome.
    const found = lookupReceived(RECEIVER, deleg.id) as
      | (mailbox.Mailbox & { obligation?: { state: string; note?: string } })
      | null;
    assert.ok(found);
    assert.equal(found!.obligation?.state, "done");
    assert.equal(found!.obligation?.note, "did it");
  });
});

test("obligations: claim is race-safe — a second claim returns already-closed (no double-close)", () => {
  withHome(() => {
    const deleg = mailbox.enqueue(4242, "do X", SENDER, { request_id: "q", action_required: true });
    recordReceived(RECEIVER, deleg);

    const first = claimObligation(RECEIVER, deleg.id, "done", "first");
    assert.equal(first.result, "claimed", "first close wins");
    const second = claimObligation(RECEIVER, deleg.id, "done", "second");
    assert.equal(second.result, "already-closed", "second close is rejected — caller must NOT re-notify");
    assert.ok(second.result === "already-closed" && second.state === "done");
  });
});

test("obligations: reopen reverts a claim back to OPEN (failed-delivery retry path)", () => {
  withHome(() => {
    const deleg = mailbox.enqueue(4242, "do X", SENDER, { request_id: "q", action_required: true });
    recordReceived(RECEIVER, deleg);
    assert.equal(claimObligation(RECEIVER, deleg.id, "done").result, "claimed");
    assert.equal(countOpenObligations(RECEIVER), 0);

    reopenObligation(RECEIVER, deleg.id);
    assert.equal(countOpenObligations(RECEIVER), 1, "reopen restores it to the open set");
    // And it can be claimed again (retry succeeds).
    assert.equal(claimObligation(RECEIVER, deleg.id, "done").result, "claimed");
  });
});

test("obligations: block closes it as blocked", () => {
  withHome(() => {
    const deleg = mailbox.enqueue(4242, "do Y", SENDER, { action_required: true });
    recordReceived(RECEIVER, deleg);
    const claim = claimObligation(RECEIVER, deleg.id, "blocked", "missing creds");
    assert.equal(claim.result, "claimed");
    assert.equal(countOpenObligations(RECEIVER), 0);
  });
});

test("obligations: claim on an unknown id is not-found; on a plain message is not-an-obligation", () => {
  withHome(() => {
    recordReceived(RECEIVER, mailbox.enqueue(4242, "seed", SENDER));
    assert.equal(claimObligation(RECEIVER, "deadbeefdeadbeef", "done").result, "not-found");
    const plain = mailbox.enqueue(4242, "plain", SENDER);
    recordReceived(RECEIVER, plain);
    assert.equal(claimObligation(RECEIVER, plain.id, "done").result, "not-an-obligation");
  });
});

// The critical durability property (skeptic's fatal-flaw fix): an OPEN obligation
// must NEVER be pruned out of its own source of truth, even under heavy churn —
// plain messages prune around it.
test("obligations: an open obligation is exempt from the receivedMax prune", () => {
  withHome(() => {
    const prevMax = process.env.OXTAIL_RECEIVED_MAX;
    process.env.OXTAIL_RECEIVED_MAX = "5";
    try {
      // One open obligation FIRST (oldest), then a flood of plain messages.
      const deleg = mailbox.enqueue(4242, "long-lived task", SENDER, {
        request_id: "keepme",
        action_required: true,
      });
      recordReceived(RECEIVER, deleg);
      for (let i = 0; i < 50; i++) {
        recordReceived(RECEIVER, mailbox.enqueue(4242, `noise ${i}`, SENDER));
      }
      // Despite being the oldest line and far past the cap, the open obligation
      // survives; plain noise is what got pruned.
      assert.equal(countOpenObligations(RECEIVER), 1, "open obligation not evicted");
      const found = lookupReceived(RECEIVER, deleg.id);
      assert.ok(found, "the oldest line survived because it's an open obligation");
      assert.equal(found!.request_id, "keepme");
    } finally {
      if (prevMax === undefined) delete process.env.OXTAIL_RECEIVED_MAX;
      else process.env.OXTAIL_RECEIVED_MAX = prevMax;
    }
  });
});

// Once CLOSED, an obligation is prunable like any other line (so the ledger
// can't grow unbounded with completed work).
test("obligations: a CLOSED obligation prunes normally", () => {
  withHome(() => {
    const prevMax = process.env.OXTAIL_RECEIVED_MAX;
    process.env.OXTAIL_RECEIVED_MAX = "5";
    try {
      const deleg = mailbox.enqueue(4242, "task", SENDER, { action_required: true });
      recordReceived(RECEIVER, deleg);
      claimObligation(RECEIVER, deleg.id, "done");
      // Flood past the cap; the closed obligation is now eligible to age out.
      for (let i = 0; i < 20; i++) {
        recordReceived(RECEIVER, mailbox.enqueue(4242, `noise ${i}`, SENDER));
      }
      assert.equal(lookupReceived(RECEIVER, deleg.id), null, "closed obligation aged out normally");
      const lines = readFileSync(receivedFilePath(RECEIVER), "utf8")
        .split("\n")
        .filter((l) => l.length > 0);
      assert.equal(lines.length, 5, "ledger respects the cap once obligations are closed");
    } finally {
      if (prevMax === undefined) delete process.env.OXTAIL_RECEIVED_MAX;
      else process.env.OXTAIL_RECEIVED_MAX = prevMax;
    }
  });
});

// Re-delivery of a CLOSED obligation's id (abort-recovery / chained re-delivery)
// must NOT resurrect it back to OPEN — the terminal outcome carries forward.
test("obligations: re-recording a closed obligation does not resurrect it", () => {
  withHome(() => {
    const deleg = mailbox.enqueue(4242, "do X", SENDER, { request_id: "q", action_required: true });
    recordReceived(RECEIVER, deleg);
    claimObligation(RECEIVER, deleg.id, "done", "finished");
    assert.equal(countOpenObligations(RECEIVER), 0);

    // Same id delivered again (preserves id, like deliverExistingToPeer).
    recordReceived(RECEIVER, deleg);
    assert.equal(countOpenObligations(RECEIVER), 0, "terminal state carried forward, not resurrected");
    const found = lookupReceived(RECEIVER, deleg.id) as
      | (mailbox.Mailbox & { obligation?: { state: string } })
      | null;
    assert.equal(found!.obligation?.state, "done");
    // And still exactly one ledger line for that id.
    const lines = readFileSync(receivedFilePath(RECEIVER), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.equal(lines.filter((l) => l.includes(deleg.id)).length, 1);
  });
});

test("obligations: empty session id is a graceful no-op", () => {
  withHome(() => {
    assert.equal(countOpenObligations(""), 0);
    assert.deepEqual(listOpenObligations(""), []);
    assert.equal(claimObligation("", "x", "done").result, "not-found");
    reopenObligation("", "x"); // must not throw
  });
});

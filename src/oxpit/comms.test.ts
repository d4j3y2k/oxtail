import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as mailbox from "../mailbox.js";
import { recordReceived, type LedgerEntry } from "../received.js";
import { buildCommsLog } from "./comms.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-comms-"));
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

function entry(over: Partial<LedgerEntry> & { id: string; enqueued_at: number }): LedgerEntry {
  return { from_session_id: "x", body: "b", ...over };
}

test("buildCommsLog merges ledgers chronologically (asc) and maps from/to", () => {
  const ledgers: Record<string, LedgerEntry[]> = {
    A: [entry({ id: "a1", from_session_id: "B", body: "hi A", enqueued_at: 100 })],
    B: [entry({ id: "b1", from_session_id: "A", body: "hi B", enqueued_at: 200 })],
  };
  const out = buildCommsLog([{ session_id: "A" }, { session_id: "B" }], {
    readLedger: (sid, limit) => (ledgers[sid] ?? []).slice(0, limit),
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].message_id, "a1"); // oldest (at=100) first
  assert.equal(out[0].to_session_id, "A");
  assert.equal(out[1].message_id, "b1"); // newest (at=200) at the bottom
  assert.equal(out[1].from_session_id, "A");
  assert.equal(out[1].to_session_id, "B");
});

test("buildCommsLog keeps the most recent `limit` (asc order)", () => {
  const read = (sid: string) => [
    entry({ id: sid + "1", enqueued_at: 1 }),
    entry({ id: sid + "2", enqueued_at: 2 }),
  ];
  const out = buildCommsLog([{ session_id: "A" }], { readLedger: read, limit: 1 });
  assert.equal(out.length, 1);
  assert.equal(out[0].message_id, "A2"); // most recent survives the cap
});

test("buildCommsLog dedups by message_id across ledgers", () => {
  const read = () => [entry({ id: "dup", enqueued_at: 5 })];
  const out = buildCommsLog([{ session_id: "A" }, { session_id: "B" }], { readLedger: read });
  assert.equal(out.length, 1);
});

test("buildCommsLog carries origin (operator vs peer) through", () => {
  const out = buildCommsLog([{ session_id: "A" }], {
    readLedger: () => [
      entry({ id: "o1", from_session_id: null, origin: "operator", enqueued_at: 1 }),
    ],
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].origin, "operator");
  assert.equal(out[0].from_session_id, null);
});

test("buildCommsLog skips agents with no session_id", () => {
  const out = buildCommsLog([{ session_id: null }], {
    readLedger: () => [entry({ id: "z", enqueued_at: 1 })],
  });
  assert.equal(out.length, 0);
});

test("integration: reads real ledgers via the canonical received reader", () => {
  withHome(() => {
    const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    recordReceived(A, mailbox.buildMessage("hello A", B, { request_id: "r1" }));
    recordReceived(B, mailbox.buildMessage("hello B", A));
    const out = buildCommsLog([{ session_id: A }, { session_id: B }]);
    assert.equal(out.length, 2);
    const toA = out.find((m) => m.to_session_id === A);
    assert.ok(toA, "A's inbound message present");
    assert.equal(toA!.from_session_id, B);
    assert.equal(toA!.body, "hello A");
    assert.equal(toA!.request_id, "r1");
  });
});

test("integration: action_required surfaces, open until closed", () => {
  withHome(() => {
    const A = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    recordReceived(A, mailbox.buildMessage("do X", "boss", { action_required: true }));
    const out = buildCommsLog([{ session_id: A }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].action_required, true);
    assert.equal(out[0].closed, undefined);
  });
});

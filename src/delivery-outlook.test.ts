import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { ActivitySnapshot } from "./autowake.js";
import { classifyDeliveryOutlook } from "./wake.js";

// The send-time delivery-outlook advisory (participant-error feedback). The
// classifier is pure, so the whole decision table is unit-testable against
// activity snapshots without tmux/FS. The seam: an outlook may ONLY ride the
// truly-silent send path (wake unset, no reply correlation); every other mode
// already carries a wake_status and stays silent here.

const SID = "11111111-2222-3333-4444-555555555555";

// The plain-send shape (wake unset, no reply correlation) — the ONLY mode that
// can carry an outlook. Vary just the identity + activity.
function plain(sessionId: string | null, activity: ActivitySnapshot) {
  return classifyDeliveryOutlook({ sessionId, activity, wake: undefined, replyTo: undefined });
}

test("plain send to a claimed IDLE peer → stranded_until_read", () => {
  assert.equal(plain(SID, { status: "idle", ageMs: 30_000 }), "stranded_until_read");
});

test("plain send to a claimed peer with NO activity marker (Codex/hookless) → unknown_liveness", () => {
  assert.equal(plain(SID, null), "unknown_liveness");
});

test("plain send to a FRESH-BUSY peer (mid-turn) → null (its hooks deliver this turn)", () => {
  assert.equal(plain(SID, { status: "busy", ageMs: 1_000 }), null);
});

test("plain send to a STALE-BUSY peer (turn outran the TTL) → stranded_until_read", () => {
  // Age well beyond any reasonable busy-TTL (default 10min): the turn likely
  // ended without a clean Stop, so the message would strand.
  assert.equal(plain(SID, { status: "busy", ageMs: 24 * 60 * 60 * 1000 }), "stranded_until_read");
});

test("plain send to a SKEWED-BUSY peer (future mtime, negative age) → stranded_until_read [codex fix]", () => {
  // A negative age means the activity file's mtime is in the future (clock skew).
  // The old predicate (ageMs < TTL) treated this as fresh-busy and would have
  // returned null — a FALSE 'fine'. The ageMs>=0 guard makes a skewed marker
  // untrusted, so it classifies as a possible strand (the safe direction), and
  // the same predicate makes the wake path wake rather than skip_busy.
  assert.equal(plain(SID, { status: "busy", ageMs: -5_000 }), "stranded_until_read");
});

test("plain send to an UNCLAIMED peer (no session_id) → null (bootstrap/note speaks)", () => {
  assert.equal(plain(null, { status: "idle", ageMs: 1_000 }), null);
});

test("wake:'auto' carries its own wake_status → no outlook on any state", () => {
  const states: ActivitySnapshot[] = [
    { status: "idle", ageMs: 1_000 },
    { status: "busy", ageMs: 1_000 },
    null,
  ];
  for (const activity of states) {
    assert.equal(
      classifyDeliveryOutlook({ sessionId: SID, activity, wake: "auto", replyTo: undefined }),
      null,
    );
  }
});

test("wake:'off' is deliberate fire-and-forget → no outlook (no nagging)", () => {
  assert.equal(
    classifyDeliveryOutlook({
      sessionId: SID,
      activity: { status: "idle", ageMs: 1_000 },
      wake: "off",
      replyTo: undefined,
    }),
    null,
  );
});

test("a reply (replyTo set) carries its own wake_status → no outlook", () => {
  assert.equal(
    classifyDeliveryOutlook({
      sessionId: SID,
      activity: { status: "idle", ageMs: 1_000 },
      wake: undefined,
      replyTo: "req-123",
    }),
    null,
  );
});

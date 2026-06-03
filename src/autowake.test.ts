import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEDUPE_TTL_MS,
  FRESH_IDLE_MAX_AGE_MS,
  MIN_INTERVAL_MS,
  autowakeKillSwitchOff,
  claimWake,
  decideReplyAutoWake,
  gcAutowake,
  isFreshIdle,
  type ActivitySnapshot,
  type AutoWakeOutcome,
} from "./autowake.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oxtail-autowake-"));
}

const SID = "11111111-2222-3333-4444-555555555555";
const NOW = 1_900_000_000_000; // fixed injected clock

// --- kill switch -------------------------------------------------------------

test("kill switch: OXTAIL_AUTOWAKE=off (any casing/whitespace) disables; else enabled", () => {
  assert.equal(autowakeKillSwitchOff({ OXTAIL_AUTOWAKE: "off" }), true);
  assert.equal(autowakeKillSwitchOff({ OXTAIL_AUTOWAKE: "OFF" }), true);
  assert.equal(autowakeKillSwitchOff({ OXTAIL_AUTOWAKE: "  off  " }), true);
  assert.equal(autowakeKillSwitchOff({ OXTAIL_AUTOWAKE: "auto" }), false);
  assert.equal(autowakeKillSwitchOff({}), false);
});

// --- fresh-idle gate ---------------------------------------------------------

test("isFreshIdle: only a recent 'idle' marker qualifies", () => {
  assert.equal(isFreshIdle({ status: "idle", ageMs: 30_000 }), true);
  assert.equal(isFreshIdle({ status: "idle", ageMs: FRESH_IDLE_MAX_AGE_MS + 1 }), false, "too old");
  assert.equal(isFreshIdle({ status: "busy", ageMs: 30_000 }), false, "busy is not idle");
  assert.equal(isFreshIdle(null), false, "no activity file");
  assert.equal(isFreshIdle({ status: "idle", ageMs: -5 }), false, "future mtime / clock skew");
});

// --- decideReplyAutoWake gating ---------------------------------------------

test("decide: kill switch off → disabled, no record written", () => {
  const dir = tmp();
  try {
    const out = decideReplyAutoWake({
      dir,
      sessionId: SID,
      replyTo: "req-a",
      activity: { status: "idle", ageMs: 1000 },
      nowMs: NOW,
      env: { OXTAIL_AUTOWAKE: "off" },
    });
    assert.deepEqual(out, { fire: false, status: "disabled" });
    assert.deepEqual(readdirSync(dir), [], "no store files written when disabled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: missing session_id → skipped_no_fresh_idle", () => {
  const dir = tmp();
  try {
    const out = decideReplyAutoWake({
      dir,
      sessionId: null,
      replyTo: "req-a",
      activity: { status: "idle", ageMs: 1000 },
      nowMs: NOW,
    });
    assert.deepEqual(out, { fire: false, status: "skipped_no_fresh_idle" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: busy / stale / unknown target → skipped_no_fresh_idle", () => {
  const dir = tmp();
  try {
    const cases: ActivitySnapshot[] = [
      { status: "busy", ageMs: 1000 },
      { status: "idle", ageMs: FRESH_IDLE_MAX_AGE_MS + 1000 },
      null,
    ];
    for (const activity of cases) {
      const out = decideReplyAutoWake({ dir, sessionId: SID, replyTo: "req-a", activity, nowMs: NOW });
      assert.deepEqual(out, { fire: false, status: "skipped_no_fresh_idle" }, JSON.stringify(activity));
    }
    assert.deepEqual(readdirSync(dir), [], "no record written when never fresh-idle");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: fresh-idle clean store → fires", () => {
  const dir = tmp();
  try {
    const out = decideReplyAutoWake({
      dir,
      sessionId: SID,
      replyTo: "req-a",
      activity: { status: "idle", ageMs: 30_000 },
      nowMs: NOW,
    });
    assert.deepEqual(out, { fire: true });
    // A dedupe record (d-) and a rate record (r-) were persisted.
    const names = readdirSync(dir).sort();
    assert.equal(names.filter((n) => n.startsWith("d-")).length, 1, "dedupe record written");
    assert.equal(names.filter((n) => n.startsWith("r-")).length, 1, "rate record written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: one-wake dedupe — same (session_id, reply_to) does not re-fire", () => {
  const dir = tmp();
  try {
    const fresh: ActivitySnapshot = { status: "idle", ageMs: 30_000 };
    const first = decideReplyAutoWake({ dir, sessionId: SID, replyTo: "req-a", activity: fresh, nowMs: NOW });
    assert.deepEqual(first, { fire: true });
    // Same reply_to, well after the rate window so dedupe (not rate) is the reason.
    const second = decideReplyAutoWake({
      dir,
      sessionId: SID,
      replyTo: "req-a",
      activity: fresh,
      nowMs: NOW + MIN_INTERVAL_MS + 5_000,
    });
    assert.deepEqual(second, { fire: false, status: "skipped_deduped" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: per-target rate limit — a distinct reply too soon is suppressed, then allowed", () => {
  const dir = tmp();
  try {
    const fresh: ActivitySnapshot = { status: "idle", ageMs: 30_000 };
    const first = decideReplyAutoWake({ dir, sessionId: SID, replyTo: "req-a", activity: fresh, nowMs: NOW });
    assert.deepEqual(first, { fire: true });

    // Different reply_to, inside the min-interval → rate limited.
    const tooSoon = decideReplyAutoWake({
      dir,
      sessionId: SID,
      replyTo: "req-b",
      activity: fresh,
      nowMs: NOW + Math.floor(MIN_INTERVAL_MS / 2),
    });
    assert.deepEqual(tooSoon, { fire: false, status: "skipped_rate_limited" });

    // Same different reply_to, now past the min-interval → fires.
    const later = decideReplyAutoWake({
      dir,
      sessionId: SID,
      replyTo: "req-b",
      activity: fresh,
      nowMs: NOW + MIN_INTERVAL_MS + 1_000,
    });
    assert.deepEqual(later, { fire: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: a different target is not rate-limited by another target's wake", () => {
  const dir = tmp();
  try {
    const fresh: ActivitySnapshot = { status: "idle", ageMs: 30_000 };
    const a = decideReplyAutoWake({ dir, sessionId: SID, replyTo: "req-a", activity: fresh, nowMs: NOW });
    assert.deepEqual(a, { fire: true });
    const other = decideReplyAutoWake({
      dir,
      sessionId: "99999999-8888-7777-6666-555555555555",
      replyTo: "req-a",
      activity: fresh,
      nowMs: NOW + 100, // immediately after — different session_id keys
    });
    assert.deepEqual(other, { fire: true }, "rate limit is per-target, not global");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decide: dedupe record is reclaimed after the TTL horizon", () => {
  const dir = tmp();
  try {
    const fresh: ActivitySnapshot = { status: "idle", ageMs: 30_000 };
    const first = decideReplyAutoWake({ dir, sessionId: SID, replyTo: "req-a", activity: fresh, nowMs: NOW });
    assert.deepEqual(first, { fire: true });
    // Past the dedupe TTL: the stale record is GC'd / reclaimed, so the same
    // reply_to may wake again.
    const afterTtl = decideReplyAutoWake({
      dir,
      sessionId: SID,
      replyTo: "req-a",
      activity: fresh,
      nowMs: NOW + DEDUPE_TTL_MS + 60_000,
    });
    assert.deepEqual(afterTtl, { fire: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- low-level primitives ----------------------------------------------------

test("claimWake: atomic — first caller wins, a concurrent duplicate loses", () => {
  const dir = tmp();
  try {
    assert.equal(claimWake(dir, SID, "req-a", NOW), true, "first claim wins");
    assert.equal(claimWake(dir, SID, "req-a", NOW), false, "second claim (same key) loses");
    assert.equal(claimWake(dir, SID, "req-b", NOW), true, "distinct reply_to is its own slot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gcAutowake: removes records older than the TTL, keeps fresh ones", () => {
  const dir = tmp();
  try {
    claimWake(dir, SID, "old", NOW);
    claimWake(dir, "22222222-3333-4444-5555-666666666666", "new", NOW + DEDUPE_TTL_MS + 1_000);
    // Sweep at a time where "old" is past TTL but "new" is not.
    gcAutowake(dir, NOW + DEDUPE_TTL_MS + 2_000);
    const names = readdirSync(dir);
    // "old" dedupe + its rate record gone; "new" dedupe + rate record remain.
    assert.equal(names.length, 2, `expected only the fresh pair, got ${JSON.stringify(names)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gcAutowake: missing dir is a no-op", () => {
  assert.doesNotThrow(() => gcAutowake(join(tmpdir(), "oxtail-autowake-does-not-exist-xyz"), NOW));
});

test("decide: a broken store (dir path is a file) degrades to skipped_store_error, never throws", () => {
  const base = tmp();
  try {
    // Make the autowake "dir" actually a FILE so the store's mkdir/open throws —
    // simulating a corrupt or unwritable ~/.oxtail/autowake. send_message has
    // already enqueued the reply by this point, so the decision MUST NOT throw.
    const brokenDir = join(base, "autowake-as-file");
    writeFileSync(brokenDir, "not a directory");
    let out: AutoWakeOutcome | undefined;
    assert.doesNotThrow(() => {
      out = decideReplyAutoWake({
        dir: brokenDir,
        sessionId: SID,
        replyTo: "req-a",
        activity: { status: "idle", ageMs: 30_000 },
        nowMs: NOW,
      });
    });
    assert.deepEqual(out, { fire: false, status: "skipped_store_error" });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

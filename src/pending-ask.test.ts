import { strict as assert } from "node:assert";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PENDING_ASK_TTL_MS,
  consumePendingAsk,
  gcPendingAsk,
  hasPendingAsk,
  recordPendingAsk,
} from "./pending-ask.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oxtail-pendingask-"));
}

const SID = "11111111-2222-3333-4444-555555555555";
const REQ = "abc123def456";
const NOW = 1_900_000_000_000; // fixed injected clock

// --- record / has ------------------------------------------------------------

test("recordPendingAsk: writes a record that hasPendingAsk then sees", () => {
  const dir = tmp();
  try {
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW), false, "absent before record");
    assert.equal(recordPendingAsk(dir, SID, REQ, NOW), true, "record succeeds");
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW), true, "present after record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordPendingAsk: duplicate is a no-op that keeps the original mtime (TTL not reset)", () => {
  const dir = tmp();
  try {
    assert.equal(recordPendingAsk(dir, SID, REQ, NOW), true);
    // A later duplicate must NOT bump the clock — TTL counts from the first record.
    assert.equal(recordPendingAsk(dir, SID, REQ, NOW + 1000), true, "dup still returns true");
    // Just before TTL from the ORIGINAL: still live.
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW + PENDING_ASK_TTL_MS - 1), true);
    // At TTL from the original: expired (proves the dup didn't reset mtime).
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW + PENDING_ASK_TTL_MS), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasPendingAsk: false once the record ages past the TTL", () => {
  const dir = tmp();
  try {
    recordPendingAsk(dir, SID, REQ, NOW);
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW + PENDING_ASK_TTL_MS - 1), true);
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW + PENDING_ASK_TTL_MS + 1), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- consume (single-winner) -------------------------------------------------

test("consumePendingAsk: first caller wins, a concurrent/duplicate second loses", () => {
  const dir = tmp();
  try {
    recordPendingAsk(dir, SID, REQ, NOW);
    assert.equal(consumePendingAsk(dir, SID, REQ), true, "first consume wins");
    assert.equal(consumePendingAsk(dir, SID, REQ), false, "second consume (already gone) loses");
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW), false, "no record remains");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consumePendingAsk: returns false when nothing was ever recorded", () => {
  const dir = tmp();
  try {
    assert.equal(consumePendingAsk(dir, SID, REQ), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consumePendingAsk: with nowMs within TTL → true (consumes + would wake)", () => {
  const dir = tmp();
  try {
    recordPendingAsk(dir, SID, REQ, NOW);
    assert.equal(consumePendingAsk(dir, SID, REQ, NOW + PENDING_ASK_TTL_MS - 1), true);
    assert.equal(hasPendingAsk(dir, SID, REQ, NOW), false, "record removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consumePendingAsk: an OVER-TTL record is removed (cleanup) but returns false (no wake)", () => {
  const dir = tmp();
  try {
    recordPendingAsk(dir, SID, REQ, NOW);
    // Past the TTL: honor the contract — deliver durably, do NOT fire the wake,
    // but still clean up the stale record.
    assert.equal(consumePendingAsk(dir, SID, REQ, NOW + PENDING_ASK_TTL_MS + 1), false);
    assert.equal(readdirSync(dir).filter((n) => n[0] === "p").length, 0, "stale record cleaned up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("record/consume isolate distinct (session, request) pairs", () => {
  const dir = tmp();
  const SID2 = "99999999-8888-7777-6666-555555555555";
  try {
    recordPendingAsk(dir, SID, REQ, NOW);
    recordPendingAsk(dir, SID, "other-req", NOW);
    recordPendingAsk(dir, SID2, REQ, NOW);
    assert.equal(consumePendingAsk(dir, SID, REQ), true);
    // The other two pairs are untouched.
    assert.equal(hasPendingAsk(dir, SID, "other-req", NOW), true);
    assert.equal(hasPendingAsk(dir, SID2, REQ, NOW), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- identity guards ---------------------------------------------------------

test("empty session_id or request_id is never recorded/consumed", () => {
  const dir = tmp();
  try {
    assert.equal(recordPendingAsk(dir, "", REQ, NOW), false);
    assert.equal(recordPendingAsk(dir, null, REQ, NOW), false);
    assert.equal(recordPendingAsk(dir, SID, "", NOW), false);
    assert.equal(consumePendingAsk(dir, "", REQ), false);
    assert.equal(consumePendingAsk(dir, SID, ""), false);
    assert.equal(hasPendingAsk(dir, "", REQ, NOW), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- store-error degradation (never throw) -----------------------------------

test("a broken store (dir path is a file) degrades to false, never throws", () => {
  const root = tmp();
  try {
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "x");
    // recordPendingAsk under a path whose parent is a file: mkdirSync/openSync
    // fail → degrade to false, no throw.
    assert.equal(recordPendingAsk(join(filePath, "sub"), SID, REQ, NOW), false);
    assert.equal(hasPendingAsk(join(filePath, "sub"), SID, REQ, NOW), false);
    assert.equal(consumePendingAsk(join(filePath, "sub"), SID, REQ), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- gc ----------------------------------------------------------------------

test("gcPendingAsk: removes records older than the TTL, keeps fresh ones", () => {
  const dir = tmp();
  try {
    recordPendingAsk(dir, SID, "old", NOW);
    recordPendingAsk(dir, SID, "new", NOW + PENDING_ASK_TTL_MS + 1_000);
    // Sweep where "old" is past TTL but "new" is not.
    gcPendingAsk(dir, NOW + PENDING_ASK_TTL_MS + 2_000);
    const names = readdirSync(dir).filter((n) => n[0] === "p");
    assert.equal(names.length, 1, `expected only the fresh record, got ${JSON.stringify(names)}`);
    assert.equal(hasPendingAsk(dir, SID, "old", NOW + PENDING_ASK_TTL_MS + 2_000), false);
    assert.equal(hasPendingAsk(dir, SID, "new", NOW + PENDING_ASK_TTL_MS + 2_000), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gcPendingAsk: missing dir is a no-op (no throw)", () => {
  const dir = join(tmp(), "never-created");
  // Does not throw.
  gcPendingAsk(dir, NOW);
  assert.ok(true);
});

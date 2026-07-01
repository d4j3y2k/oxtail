import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  PENDING_WAKE_TTL_MS,
  bumpAttempt,
  consumePendingWake,
  gcPendingWake,
  listPendingWakesForRecipient,
  recordPendingWake,
} from "./pending-wake.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oxtail-pendingwake-"));
}

const SID = "11111111-2222-3333-4444-555555555555";
const MSG = "abcdef0123456789";
const SENDER = "99999999-8888-7777-6666-555555555555";
const NOW = 1_900_000_000_000; // fixed injected clock

function one(dir: string, sid: string, now: number) {
  return listPendingWakesForRecipient(dir, sid, now);
}

// --- record / list -----------------------------------------------------------

test("recordPendingWake: writes a record that listPendingWakesForRecipient sees", () => {
  const dir = tmp();
  try {
    assert.equal(one(dir, SID, NOW).length, 0, "absent before record");
    assert.equal(recordPendingWake(dir, SID, MSG, SENDER, NOW), true, "record succeeds");
    const recs = one(dir, SID, NOW);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].messageId, MSG);
    assert.equal(recs[0].senderSessionId, SENDER);
    assert.equal(recs[0].attempts, 0, "starts at 0 attempts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listPendingWakesForRecipient: only returns records addressed to that recipient", () => {
  const dir = tmp();
  const OTHER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  try {
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    recordPendingWake(dir, OTHER, "1111111111111111", SENDER, NOW);
    assert.equal(one(dir, SID, NOW).length, 1, "mine only");
    assert.equal(one(dir, OTHER, NOW).length, 1, "theirs only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordPendingWake: duplicate keeps original mtime AND attempts (no reset)", () => {
  const dir = tmp();
  try {
    assert.equal(recordPendingWake(dir, SID, MSG, SENDER, NOW), true);
    bumpAttempt(dir, SID, MSG, NOW); // attempts → 1
    assert.equal(recordPendingWake(dir, SID, MSG, SENDER, NOW + 1000), true, "dup returns true");
    const recs = one(dir, SID, NOW + 1000);
    assert.equal(recs[0].attempts, 1, "dup did NOT reset attempts");
    // Just before TTL from the ORIGINAL: still live; at TTL: gone (dup didn't reset mtime).
    assert.equal(one(dir, SID, NOW + PENDING_WAKE_TTL_MS - 1).length, 1);
    assert.equal(one(dir, SID, NOW + PENDING_WAKE_TTL_MS).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listPendingWakesForRecipient: drops records past the TTL", () => {
  const dir = tmp();
  try {
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    assert.equal(one(dir, SID, NOW + PENDING_WAKE_TTL_MS - 1).length, 1);
    assert.equal(one(dir, SID, NOW + PENDING_WAKE_TTL_MS + 1).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- bumpAttempt -------------------------------------------------------------

test("bumpAttempt: increments attempts and stamps lastAttemptAt WITHOUT extending TTL", () => {
  const dir = tmp();
  try {
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    bumpAttempt(dir, SID, MSG, NOW + 5_000);
    bumpAttempt(dir, SID, MSG, NOW + 10_000);
    assert.equal(one(dir, SID, NOW + 10_000)[0].attempts, 2, "two bumps → attempts 2");
    // TTL still measured from the ORIGINAL record time, not the bumps.
    assert.equal(one(dir, SID, NOW + PENDING_WAKE_TTL_MS - 1).length, 1, "still live pre-TTL");
    assert.equal(one(dir, SID, NOW + PENDING_WAKE_TTL_MS).length, 0, "expired at TTL (bump didn't extend)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bumpAttempt: missing record is a no-op (never throws)", () => {
  const dir = tmp();
  try {
    bumpAttempt(dir, SID, MSG, NOW); // nothing recorded
    assert.equal(one(dir, SID, NOW).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- consume (single-winner) -------------------------------------------------

test("consumePendingWake: first caller wins, a concurrent/duplicate second loses", () => {
  const dir = tmp();
  try {
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    assert.equal(consumePendingWake(dir, SID, MSG), true, "first consume wins");
    assert.equal(consumePendingWake(dir, SID, MSG), false, "second consume (gone) loses");
    assert.equal(one(dir, SID, NOW).length, 0, "no record remains");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- identity guards ---------------------------------------------------------

test("empty recipient or message id is never recorded/consumed", () => {
  const dir = tmp();
  try {
    assert.equal(recordPendingWake(dir, "", MSG, SENDER, NOW), false);
    assert.equal(recordPendingWake(dir, null, MSG, SENDER, NOW), false);
    assert.equal(recordPendingWake(dir, SID, "", SENDER, NOW), false);
    assert.equal(consumePendingWake(dir, "", MSG), false);
    assert.equal(consumePendingWake(dir, SID, ""), false);
    assert.equal(one(dir, "", NOW).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("null senderSessionId is stored as null (unclaimed/operator sender)", () => {
  const dir = tmp();
  try {
    recordPendingWake(dir, SID, MSG, null, NOW);
    assert.equal(one(dir, SID, NOW)[0].senderSessionId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- store-error degradation (never throw) -----------------------------------

test("a broken store (dir path is a file) degrades to empty/false, never throws", () => {
  const root = tmp();
  try {
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "x");
    const bad = join(filePath, "sub");
    assert.equal(recordPendingWake(bad, SID, MSG, SENDER, NOW), false);
    assert.equal(one(bad, SID, NOW).length, 0);
    assert.equal(consumePendingWake(bad, SID, MSG), false);
    bumpAttempt(bad, SID, MSG, NOW); // no throw
    assert.ok(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- gc ----------------------------------------------------------------------

test("gcPendingWake: removes records older than TTL, keeps fresh ones", () => {
  const dir = tmp();
  try {
    recordPendingWake(dir, SID, "old0000000000000", SENDER, NOW);
    recordPendingWake(dir, SID, "new0000000000000", SENDER, NOW + PENDING_WAKE_TTL_MS + 1_000);
    gcPendingWake(dir, NOW + PENDING_WAKE_TTL_MS + 2_000);
    const names = readdirSync(dir).filter((n) => n[0] === "w");
    assert.equal(names.length, 1, `expected only the fresh record, got ${JSON.stringify(names)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gcPendingWake: missing dir is a no-op (no throw)", () => {
  const dir = join(tmp(), "never-created");
  gcPendingWake(dir, NOW);
  assert.ok(true);
});

test("listPendingWakesForRecipient: a crash-orphaned bumpAttempt temp is NOT a phantom record", () => {
  const dir = tmp();
  try {
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    // Simulate a SIGKILL between writeFileSync(tmp) and renameSync: an orphaned temp
    // that is a COMPLETE, valid record body and whose name starts with "w".
    mkdirSync(dir, { recursive: true });
    const realName = readdirSync(dir).find((n) => /^w-[0-9a-f]{32}$/.test(n))!;
    const orphan = join(dir, `${realName}.tmp.99999.deadbeef`);
    writeFileSync(
      orphan,
      JSON.stringify({ recipientSessionId: SID, messageId: MSG, senderSessionId: SENDER, sentAt: NOW, attempts: 0, lastAttemptAt: null }),
    );
    // The orphan must NOT be listed as a second record for the same message.
    assert.equal(one(dir, SID, NOW).length, 1, "orphaned temp is not a phantom record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

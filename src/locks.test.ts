import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireDirLock, clearStaleLock, releaseDirLock } from "./locks.js";

const STALE_MS = 30_000;

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-locks-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A lock dir aged `ageMs` in the past. An owner token is written first (so the
// dir-mtime backdate that follows reflects the holder's last touch, not the file
// write). Pass owner=null for a legacy/foreign owner-less lock.
function makeLock(dir: string, ageMs: number, owner: string | null): string {
  const lock = join(dir, "x.lock");
  mkdirSync(lock, { mode: 0o700 });
  if (owner !== null) writeFileSync(`${lock}.owner`, owner);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(lock, t, t);
  return lock;
}

test("locks: acquire writes an owner token; release removes the lock", () => {
  withTmp((dir) => {
    const lock = join(dir, "x.lock");
    const token = acquireDirLock(lock, STALE_MS, "t", {});
    assert.ok(token.length > 0, "a token is returned");
    assert.equal(readFileSync(`${lock}.owner`, "utf8"), token, "owner file holds the token");
    releaseDirLock(lock, token);
    assert.equal(existsSync(lock), false, "owner-matched release removes the lock");
  });
});

// Stall-resume protection: a holder whose lock was stolen (owner now differs)
// must NOT remove the successor's fresh lock on release.
test("locks: release does not remove a lock owned by someone else", () => {
  withTmp((dir) => {
    const lock = join(dir, "x.lock");
    const myToken = acquireDirLock(lock, STALE_MS, "t", {});
    // Simulate a successor having stolen + reacquired the lock.
    writeFileSync(`${lock}.owner`, "successor.token");
    releaseDirLock(lock, myToken);
    assert.equal(existsSync(lock), true, "successor's lock left intact");
    assert.equal(readFileSync(`${lock}.owner`, "utf8"), "successor.token");
  });
});

test("locks: release with an empty token LEAVES the lock (cannot prove ownership)", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 0, null);
    releaseDirLock(lock, "");
    // An empty token reaches release only via a lockTokens Map miss; removing
    // here would stomp whatever lock currently exists. Leave it (H3) — a leaked
    // lock self-heals via clearStaleLock once stale.
    assert.equal(existsSync(lock), true);
  });
});

// Strict release: an absent owner is NOT provably ours, so release LEAVES it
// (a successor mid-acquire has no owner sidecar yet; removing would stomp its
// fresh lock). A genuinely leaked lock ages into a stale lock and is reclaimed
// by clearStaleLock instead.
test("locks: release leaves a lock with an absent owner file (avoids stomping a successor)", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 0, null); // no owner file
    releaseDirLock(lock, "my.token");
    assert.equal(existsSync(lock), true, "absent-owner lock is left, not removed");
  });
});

test("locks: clearStaleLock leaves a fresh lock untouched", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 0, "holder.token");
    assert.equal(clearStaleLock(lock, STALE_MS, "t", {}), false);
    assert.equal(existsSync(lock), true, "fresh lock not cleared");
    assert.equal(existsSync(`${lock}.steal`), false, "no steal marker for a fresh lock");
  });
});

test("locks: clearStaleLock clears a stale lock and leaves no steal residue", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 60_000, "dead.holder");
    assert.equal(clearStaleLock(lock, STALE_MS, "t", {}), true);
    assert.equal(existsSync(lock), false, "stale lock removed");
    assert.equal(existsSync(`${lock}.steal`), false, "steal marker dropped");
  });
});

test("locks: clearStaleLock clears a stale legacy (owner-less) lock", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 60_000, null);
    assert.equal(clearStaleLock(lock, STALE_MS, "t", {}), true);
    assert.equal(existsSync(lock), false);
  });
});

// Core single-winner property: while another clearer holds a FRESH steal marker,
// we back off and do not remove the lock.
test("locks: clearStaleLock backs off when another clearer holds the steal marker", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 60_000, "dead.holder");
    mkdirSync(`${lock}.steal`, { mode: 0o700 }); // a fresh marker held by another clearer
    assert.equal(clearStaleLock(lock, STALE_MS, "t", {}), false, "must not clear under a held marker");
    assert.equal(existsSync(lock), true, "lock left for the marker holder");
    assert.equal(existsSync(`${lock}.steal`), true, "fresh marker untouched");
  });
});

test("locks: acquireDirLock reclaims a stale lock and proceeds", () => {
  withTmp((dir) => {
    const lock = makeLock(dir, 60_000, "dead.holder");
    const before = Date.now();
    const token = acquireDirLock(lock, STALE_MS, "t", {});
    assert.ok(Date.now() - before < 1000, "stale reclaim is near-instant");
    assert.equal(readFileSync(`${lock}.owner`, "utf8"), token, "new owner written after reclaim");
    releaseDirLock(lock, token);
    assert.equal(existsSync(lock), false);
  });
});

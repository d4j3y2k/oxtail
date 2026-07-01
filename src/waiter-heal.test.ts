import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RegistryEntry } from "./registry.js";
import type { ResolveErr, ResolveOk } from "./resolve-target.js";
import type { WakeStatus } from "./wake.js";
import {
  listLivePendingAsks,
  recordPendingAsk,
} from "./pending-ask.js";
import { runWaiterHealTick, type WaiterHealDeps } from "./waiter-heal.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "oxtail-waiterheal-"));
}

const OWNER = "11111111-2222-3333-4444-555555555555"; // A, the waiter
const TARGET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; // B, the awaited peer
const REQ = "abc123def456";
const MSGID = "beefcafe01020304";
const NOW = 1_900_000_000_000;
const GRACE_MS = 4 * 60 * 1000;

function entryFor(sid: string | null): RegistryEntry {
  return {
    client: { session_id: sid, type: "claude-code" },
    server_pid: 4242,
    started_at: 1000,
  } as unknown as RegistryEntry;
}

function bEntry(): RegistryEntry {
  return {
    client: { session_id: TARGET, type: "codex" },
    server_pid: 5150,
    started_at: 900,
  } as unknown as RegistryEntry;
}

const OK: ResolveOk = { ok: true, entry: bEntry() };
const GONE: ResolveErr = { ok: false, error: "target-not-found" };

// Build a deps bundle with an in-memory throttle (so within-tick per-target
// coalescing is exercised) + a wake spy. Overridable per test.
function mkDeps(
  dir: string,
  over: Partial<WaiterHealDeps> & { wakeStatus?: WakeStatus } = {},
): { deps: WaiterHealDeps; wakeCalls: RegistryEntry[]; throttle: Map<string, number> } {
  const throttle = new Map<string, number>();
  const wakeCalls: RegistryEntry[] = [];
  const wakeStatus = over.wakeStatus ?? "fired_unconfirmed";
  const deps: WaiterHealDeps = {
    nowMs: over.nowMs ?? NOW,
    dir,
    graceMs: over.graceMs ?? GRACE_MS,
    cap: over.cap ?? 3,
    hasReceipt: over.hasReceipt ?? (() => false),
    ledgerReplyTargets: over.ledgerReplyTargets ?? (() => []),
    resolve: over.resolve ?? (() => OK),
    wake:
      over.wake ??
      (async (peer) => {
        wakeCalls.push(peer);
        return wakeStatus;
      }),
    wokeRecently:
      over.wokeRecently ?? ((t, now) => (throttle.has(t) ? now - throttle.get(t)! < 90_000 : false)),
    stampWoke: over.stampWoke ?? ((t, now) => throttle.set(t, now)),
  };
  return { deps, wakeCalls, throttle };
}

function seed(dir: string, at: number, over: { target?: string | null; messageId?: string } = {}): void {
  recordPendingAsk(dir, OWNER, REQ, at, {
    target: over.target === undefined ? TARGET : over.target,
    messageId: over.messageId === undefined ? MSGID : over.messageId,
    ownerEpoch: 1000,
  });
}

// --- fire path ---------------------------------------------------------------

test("pre-receipt, past grace, under cap → re-pokes the target once + bumps attempt", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000); // old enough to clear grace
    const { deps, wakeCalls } = mkDeps(dir);
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.fired, 1, "one re-poke landed");
    assert.equal(wakeCalls.length, 1);
    assert.equal(wakeCalls[0].client.session_id, TARGET, "poked B's pane");
    const rec = listLivePendingAsks(dir, NOW).find((x) => x.requestId === REQ);
    assert.equal(rec!.attempts, 1, "attempt bumped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("too fresh (younger than grace) → no re-poke (self-heal / original wake goes first)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - 1000); // 1s old — inside the grace window
    const { deps, wakeCalls } = mkDeps(dir);
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.fired, 0);
    assert.equal(wakeCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attempts at cap → gaveUp, no re-poke (surfaced to operator, not poked forever)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir, { cap: 2 });
    // Drive attempts up to the cap via successful fires, then one more tick.
    await runWaiterHealTick(entryFor(OWNER), { ...deps, wokeRecently: () => false }); // attempt 1
    await runWaiterHealTick(entryFor(OWNER), { ...deps, wokeRecently: () => false }); // attempt 2 == cap
    const before = wakeCalls.length;
    const r = await runWaiterHealTick(entryFor(OWNER), { ...deps, wokeRecently: () => false });
    assert.equal(r.gaveUp, 1, "record at cap is counted as gaveUp");
    assert.equal(r.fired, 0, "no fire at cap");
    assert.equal(wakeCalls.length, before, "no additional wake once capped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-target throttle suppresses a re-poke (single-winner / don't hammer B)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir, { wokeRecently: () => true }); // already woken recently
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.fired, 0);
    assert.equal(wakeCalls.length, 0, "throttled → no keystroke");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two expectations to the SAME target → one re-poke this tick (coalesced)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000); // REQ → TARGET
    recordPendingAsk(dir, OWNER, "req2", NOW - GRACE_MS - 1000, {
      target: TARGET,
      messageId: "cafe0000",
      ownerEpoch: 1000,
    });
    const { deps, wakeCalls } = mkDeps(dir); // in-memory throttle reflects the stamp within the tick
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(wakeCalls.length, 1, "one poke drains B's whole mailbox — not two");
    assert.equal(r.fired, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- STOP conditions ---------------------------------------------------------

test("answered (a correlated reply is in A's ledger) → consume, no re-poke", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir, { ledgerReplyTargets: () => [REQ] });
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.consumed, 1, "expectation consumed");
    assert.equal(wakeCalls.length, 0, "no re-poke for a satisfied expectation");
    assert.equal(listLivePendingAsks(dir, NOW).length, 0, "record removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("post-receipt, no reply → STOP poking (B has it; can't tell working vs dropped)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir, { hasReceipt: () => true });
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.fired, 0);
    assert.equal(wakeCalls.length, 0, "no keystroke once B has it in context");
    assert.equal(listLivePendingAsks(dir, NOW).length, 1, "record kept (a late reply still consumes it)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("target unresolvable (dead / pid-reused / gone) → targetGone, no re-poke of a corpse", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir, { resolve: () => GONE });
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.targetGone, 1);
    assert.equal(wakeCalls.length, 0, "never send-keys into an unverified/dead pane");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a provably-did-nothing wake (skipped_busy) does NOT burn the attempt budget", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps } = mkDeps(dir, { wakeStatus: "skipped_busy" });
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.fired, 0, "skipped_busy is not a real fire");
    const rec = listLivePendingAsks(dir, NOW).find((x) => x.requestId === REQ);
    assert.equal(rec!.attempts, 0, "attempt NOT bumped when nothing landed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- identity / adoption -----------------------------------------------------

test("waiter restart re-adopts its own orphaned expectation (same session_id, new incarnation)", async () => {
  const dir = tmp();
  try {
    // Record written by a PRIOR incarnation (ownerEpoch 500), owner session_id unchanged.
    recordPendingAsk(dir, OWNER, REQ, NOW - GRACE_MS - 1000, {
      target: TARGET,
      messageId: MSGID,
      ownerEpoch: 500,
    });
    // New incarnation: same session_id, newer started_at.
    const restarted = { ...entryFor(OWNER), started_at: 2000 } as RegistryEntry;
    const { deps, wakeCalls } = mkDeps(dir);
    const r = await runWaiterHealTick(restarted, deps);
    assert.equal(r.fired, 1, "the restarted owner adopts + re-pokes its own orphan");
    assert.equal(wakeCalls[0].client.session_id, TARGET);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- shape / config guards ---------------------------------------------------

test("a legacy bare pending-ask (no target/messageId) is never re-poked", async () => {
  const dir = tmp();
  try {
    recordPendingAsk(dir, OWNER, REQ, NOW - GRACE_MS - 1000); // 4-arg legacy shape
    const { deps, wakeCalls } = mkDeps(dir);
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.reason, "no_records", "no re-pokeable (target+messageId) records");
    assert.equal(wakeCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unclaimed owner → no-op (no expectations to own)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir);
    const r = await runWaiterHealTick(entryFor(null), deps);
    assert.equal(r.reason, "unclaimed");
    assert.equal(wakeCalls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill-switch (OXTAIL_SELF_WAKE=off) disables re-pokes entirely", async () => {
  const dir = tmp();
  const prev = process.env.OXTAIL_SELF_WAKE;
  process.env.OXTAIL_SELF_WAKE = "off";
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps, wakeCalls } = mkDeps(dir);
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.reason, "disabled");
    assert.equal(wakeCalls.length, 0);
  } finally {
    process.env.OXTAIL_SELF_WAKE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wake that throws is swallowed (never crashes the bare tick)", async () => {
  const dir = tmp();
  try {
    seed(dir, NOW - GRACE_MS - 1000);
    const { deps } = mkDeps(dir, {
      wake: async () => {
        throw new Error("send-keys blew up");
      },
    });
    const r = await runWaiterHealTick(entryFor(OWNER), deps);
    assert.equal(r.fired, 0, "no fire counted");
    // attempt not bumped, record intact
    assert.equal(listLivePendingAsks(dir, NOW).find((x) => x.requestId === REQ)!.attempts, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

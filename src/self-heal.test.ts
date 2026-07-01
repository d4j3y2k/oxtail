import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RegistryEntry } from "./registry.js";
import type { WakeStatus } from "./wake.js";
import {
  decideSelfHeal,
  recordWakeIntent,
  runSelfHealTick,
  selfWakeKillSwitchOff,
} from "./self-heal.js";
import {
  bumpAttempt,
  defaultPendingWakeDir,
  listPendingWakesForRecipient,
  recordPendingWake,
  selfWokeRecently,
  stampSelfWoke,
} from "./pending-wake.js";

// Real-HOME isolation so the throttle (~/.oxtail/self-wake) and default registry
// dir (~/.oxtail/pending-wake) resolve under a temp dir (homedir() reads $HOME).
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-selfheal-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// Async variant: MUST await fn before restoring HOME / rmSync — a sync `finally`
// would tear down the temp home while the awaited body is still suspended at its
// first await (the mid-test dir-delete bug).
async function withHomeAsync<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-selfheal-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

const SID = "11111111-2222-3333-4444-555555555555";
const MSG = "abcdef0123456789";
const MSG2 = "0123456789abcdef";
const SENDER = "99999999-8888-7777-6666-555555555555";
const NOW = 1_900_000_000_000;

function entryFor(sid: string | null): RegistryEntry {
  return { client: { session_id: sid, type: "claude-code" }, server_pid: 4242 } as unknown as RegistryEntry;
}

const IDLE = { status: "idle", ageMs: 5_000 };

// --- decideSelfHeal (pure gate matrix) ---------------------------------------

test("decideSelfHeal: idle + claimed + throttle-elapsed + fresh marker → act", () => {
  assert.deepEqual(
    decideSelfHeal({ killSwitchOff: false, claimed: true, throttleElapsed: true, activity: IDLE }),
    { act: true, reason: "self_heal" },
  );
});

test("decideSelfHeal: gates in priority order", () => {
  const base = { killSwitchOff: false, claimed: true, throttleElapsed: true, activity: IDLE };
  assert.equal(decideSelfHeal({ ...base, killSwitchOff: true }).reason, "disabled");
  assert.equal(decideSelfHeal({ ...base, claimed: false }).reason, "unclaimed");
  assert.equal(decideSelfHeal({ ...base, throttleElapsed: false }).reason, "throttled");
  assert.equal(decideSelfHeal({ ...base, activity: null }).reason, "no_marker"); // hookless codex
  assert.equal(decideSelfHeal({ ...base, activity: { status: "busy", ageMs: 1000 } }).reason, "not_idle");
  assert.equal(decideSelfHeal({ ...base, activity: { status: "idle", ageMs: -5 } }).reason, "skew");
});

// --- selfWakeKillSwitchOff ---------------------------------------------------

test("selfWakeKillSwitchOff: any casing of off", () => {
  assert.equal(selfWakeKillSwitchOff({ OXTAIL_SELF_WAKE: "off" }), true);
  assert.equal(selfWakeKillSwitchOff({ OXTAIL_SELF_WAKE: "OFF" }), true);
  assert.equal(selfWakeKillSwitchOff({ OXTAIL_SELF_WAKE: " Off " }), true);
  assert.equal(selfWakeKillSwitchOff({}), false);
  assert.equal(selfWakeKillSwitchOff({ OXTAIL_SELF_WAKE: "on" }), false);
});

// --- recordWakeIntent (only the not-confidently-delivered statuses) ----------

test("recordWakeIntent: records only undelivered wake statuses", () =>
  withHome(() => {
    const dir = defaultPendingWakeDir();
    const record = (id: string, s: WakeStatus | undefined) =>
      recordWakeIntent(SID, id, SENDER, s, NOW);

    record("1000000000000000", "fired"); // confident → skip
    record("2000000000000000", undefined); // plain FYI send → skip
    record("3000000000000000", "skipped_busy"); // hook delivers → skip
    record("4000000000000000", "disabled"); // kill-switch → skip
    record("5000000000000000", "fired_unconfirmed"); // open loop → RECORD
    record("6000000000000000", "skipped_no_fresh_idle"); // missed → RECORD
    record("7000000000000000", "skipped_no_target"); // missed → RECORD

    const ids = listPendingWakesForRecipient(dir, SID, NOW).map((r) => r.messageId).sort();
    assert.deepEqual(ids, ["5000000000000000", "6000000000000000", "7000000000000000"]);
  }));

// --- runSelfHealTick (integration) -------------------------------------------

type TickOpts = Partial<Parameters<typeof runSelfHealTick>[1]>;
function tick(entry: RegistryEntry, wakeCalls: { n: number }, opts: TickOpts = {}) {
  return runSelfHealTick(entry, {
    nowMs: NOW + 30_000, // 30s after the default record time → past the 15s grace
    readActivity: () => IDLE,
    hasReceipt: () => false,
    wake: async () => {
      wakeCalls.n++;
      return "fired" as WakeStatus;
    },
    ...opts,
  });
}

test("runSelfHealTick: undelivered + idle + past grace → one self-wake, record bumped", () =>
  withHomeAsync(async () => {
    const dir = defaultPendingWakeDir();
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls);
    assert.equal(r.fired, true);
    assert.equal(calls.n, 1, "exactly one wake");
    assert.equal(listPendingWakesForRecipient(dir, SID, NOW + 30_000)[0].attempts, 1);
  }));

test("runSelfHealTick: receipt present → consume, no wake", () =>
  withHomeAsync(async () => {
    const dir = defaultPendingWakeDir();
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls, { hasReceipt: () => true });
    assert.equal(r.fired, false);
    assert.equal(calls.n, 0, "no wake — already delivered");
    assert.equal(listPendingWakesForRecipient(dir, SID, NOW + 30_000).length, 0, "record consumed");
  }));

test("runSelfHealTick: two undelivered records → ONE wake, both bumped (one drain reads all)", () =>
  withHomeAsync(async () => {
    const dir = defaultPendingWakeDir();
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    recordPendingWake(dir, SID, MSG2, SENDER, NOW);
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls);
    assert.equal(r.fired, true);
    assert.equal(calls.n, 1, "single wake for the whole mailbox");
    const recs = listPendingWakesForRecipient(dir, SID, NOW + 30_000);
    assert.deepEqual(recs.map((x) => x.attempts).sort(), [1, 1]);
  }));

test("runSelfHealTick: a wake that did NOT fire (skipped_no_target) does not burn an attempt or claim fired", () =>
  withHomeAsync(async () => {
    const dir = defaultPendingWakeDir();
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls, {
      wake: async () => {
        calls.n++;
        return "skipped_no_target" as WakeStatus;
      },
    });
    assert.equal(r.fired, false, "honest: nothing landed");
    assert.equal(r.reason, "skipped_no_target");
    assert.equal(calls.n, 1, "the wake fn was called");
    // Attempt cap must NOT be spent on a no-op wake — the record retries next window.
    assert.equal(listPendingWakesForRecipient(dir, SID, NOW + 30_000)[0].attempts, 0);
  }));

test("runSelfHealTick: OXTAIL_AUTOWAKE=off also disables it", () =>
  withHomeAsync(async () => {
    recordPendingWake(defaultPendingWakeDir(), SID, MSG, SENDER, NOW);
    const prev = process.env.OXTAIL_AUTOWAKE;
    process.env.OXTAIL_AUTOWAKE = "off";
    try {
      const calls = { n: 0 };
      const r = await tick(entryFor(SID), calls);
      assert.equal(r.fired, false);
      assert.equal(r.reason, "disabled");
      assert.equal(calls.n, 0);
    } finally {
      if (prev === undefined) delete process.env.OXTAIL_AUTOWAKE;
      else process.env.OXTAIL_AUTOWAKE = prev;
    }
  }));

test("runSelfHealTick: not idle (busy) → no wake", () =>
  withHomeAsync(async () => {
    recordPendingWake(defaultPendingWakeDir(), SID, MSG, SENDER, NOW);
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls, { readActivity: () => ({ status: "busy", ageMs: 500 }) });
    assert.equal(r.fired, false);
    assert.equal(r.reason, "not_idle");
    assert.equal(calls.n, 0);
  }));

test("runSelfHealTick: hookless recipient (null marker) → skip", () =>
  withHomeAsync(async () => {
    recordPendingWake(defaultPendingWakeDir(), SID, MSG, SENDER, NOW);
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls, { readActivity: () => null });
    assert.equal(r.fired, false);
    assert.equal(r.reason, "no_marker");
  }));

test("runSelfHealTick: attempts at cap → nothing eligible, no wake", () =>
  withHomeAsync(async () => {
    const dir = defaultPendingWakeDir();
    recordPendingWake(dir, SID, MSG, SENDER, NOW);
    bumpAttempt(dir, SID, MSG, NOW);
    bumpAttempt(dir, SID, MSG, NOW);
    bumpAttempt(dir, SID, MSG, NOW); // attempts = 3 = cap
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls, { cap: 3 });
    assert.equal(r.fired, false);
    assert.equal(r.reason, "nothing_eligible");
    assert.equal(calls.n, 0);
  }));

test("runSelfHealTick: record younger than the grace window is not touched", () =>
  withHomeAsync(async () => {
    recordPendingWake(defaultPendingWakeDir(), SID, MSG, SENDER, NOW);
    const calls = { n: 0 };
    // tick at the SAME instant → record age 0 < 15s grace
    const r = await tick(entryFor(SID), calls, { nowMs: NOW });
    assert.equal(r.fired, false);
    assert.equal(r.reason, "nothing_eligible");
    assert.equal(calls.n, 0);
  }));

test("runSelfHealTick: throttled (recent self-wake) → no wake", () =>
  withHomeAsync(async () => {
    recordPendingWake(defaultPendingWakeDir(), SID, MSG, SENDER, NOW);
    stampSelfWoke(SID, NOW + 30_000); // a self-wake just fired
    const calls = { n: 0 };
    const r = await tick(entryFor(SID), calls, { throttleMs: 60_000 });
    assert.equal(r.fired, false);
    assert.equal(r.reason, "throttled");
    assert.equal(calls.n, 0);
  }));

test("runSelfHealTick: unclaimed self (no session_id) → skip", () =>
  withHomeAsync(async () => {
    const calls = { n: 0 };
    const r = await tick(entryFor(null), calls);
    assert.equal(r.fired, false);
    assert.equal(r.reason, "unclaimed");
  }));

test("runSelfHealTick: OXTAIL_SELF_WAKE=off disables it", () =>
  withHomeAsync(async () => {
    recordPendingWake(defaultPendingWakeDir(), SID, MSG, SENDER, NOW);
    const prev = process.env.OXTAIL_SELF_WAKE;
    process.env.OXTAIL_SELF_WAKE = "off";
    try {
      const calls = { n: 0 };
      const r = await tick(entryFor(SID), calls);
      assert.equal(r.fired, false);
      assert.equal(r.reason, "disabled");
      assert.equal(calls.n, 0);
    } finally {
      if (prev === undefined) delete process.env.OXTAIL_SELF_WAKE;
      else process.env.OXTAIL_SELF_WAKE = prev;
    }
  }));

// --- throttle helpers --------------------------------------------------------

test("selfWokeRecently / stampSelfWoke: persistent per-session throttle window", () =>
  withHome(() => {
    assert.equal(selfWokeRecently(SID, NOW, 60_000), false, "no stamp yet");
    stampSelfWoke(SID, NOW);
    assert.equal(selfWokeRecently(SID, NOW + 30_000, 60_000), true, "within window");
    assert.equal(selfWokeRecently(SID, NOW + 60_000, 60_000), false, "window elapsed");
    assert.equal(selfWokeRecently(null, NOW, 60_000), false, "unclaimed never throttled");
  }));

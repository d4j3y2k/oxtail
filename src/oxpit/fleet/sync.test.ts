import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnsureWindowResult } from "./ensure-window.js";
import type { PaneInfo } from "./ownership.js";
import { computeSyncPlan, renderSyncPlan, syncFleet } from "./sync.js";
import type { FleetSpec, FleetWindowSpec } from "./types.js";

const FID = "fleet-abcd1234";

// ── computeSyncPlan / renderSyncPlan (pure partition) ────────────────────────

const pane = (o: { pane: string; windowName: string; managedBy: string | null }): PaneInfo => ({
  session: "s",
  windowIndex: 0,
  panePid: 100,
  currentCommand: "bash",
  ...o,
});

const spec: FleetSpec = {
  name: "fleet",
  windows: [
    { name: "main", agent: "claude" },
    { name: "max", agent: "claude" },
    { name: "test", agent: "claude" }, // a NEW window with no pane yet
  ],
};

test("computeSyncPlan: ADDs spec windows that have no managed pane; KEEPs the matched ones", () => {
  const panes = [pane({ pane: "%1", windowName: "main", managedBy: FID }), pane({ pane: "%2", windowName: "max", managedBy: FID })];
  const p = computeSyncPlan(spec, FID, panes);
  assert.deepEqual(p.add.map((w) => w.name), ["test"], "the spec window with no pane → ADD");
  assert.deepEqual(p.keep.map((k) => k.window.name), ["main", "max"], "matched windows → KEEP (no-op)");
  assert.equal(p.remove.length, 0);
  assert.equal(p.survivors.length, 0);
});

test("computeSyncPlan: DELETEs a managed window removed from the spec (RESET would LEAVE it)", () => {
  const specNoMax: FleetSpec = { name: "fleet", windows: [{ name: "main", agent: "claude" }] };
  const panes = [pane({ pane: "%1", windowName: "main", managedBy: FID }), pane({ pane: "%2", windowName: "max", managedBy: FID })];
  const p = computeSyncPlan(specNoMax, FID, panes);
  assert.deepEqual(p.keep.map((k) => k.window.name), ["main"]);
  assert.deepEqual(p.remove.map((r) => r.windowName), ["max"], "ours + spec-removed → DELETE (the subtractive half)");
  assert.equal(p.add.length, 0);
});

test("computeSyncPlan: SURVIVORS — unmanaged + foreign-marked panes are never add/keep/remove", () => {
  const panes = [
    pane({ pane: "%1", windowName: "main", managedBy: FID }),
    pane({ pane: "%2", windowName: "editor", managedBy: null }), // a human split
    pane({ pane: "%3", windowName: "other", managedBy: "fleet-OTHER999" }), // another fleet
  ];
  const p = computeSyncPlan(spec, FID, panes);
  assert.deepEqual(p.survivors.map((s) => s.pane).sort(), ["%2", "%3"], "unmanaged + foreign → survivors");
  assert.ok(!p.remove.some((r) => r.pane === "%2" || r.pane === "%3"), "NEVER delete a pane we don't own");
  assert.deepEqual(p.keep.map((k) => k.pane.pane), ["%1"]);
});

test("computeSyncPlan: a brand-new session (no panes) is all-ADD (= SPAWN)", () => {
  const p = computeSyncPlan(spec, FID, []);
  assert.deepEqual(p.add.map((w) => w.name), ["main", "max", "test"]);
  assert.equal(p.keep.length, 0);
  assert.equal(p.remove.length, 0);
  assert.equal(p.survivors.length, 0);
});

test("renderSyncPlan: shows the full partition with the destructive DELETE called out", () => {
  const panes = [
    pane({ pane: "%1", windowName: "main", managedBy: FID }),
    pane({ pane: "%2", windowName: "max", managedBy: FID }), // spec-removed → delete
    pane({ pane: "%3", windowName: "editor", managedBy: null }), // survivor
  ];
  const specNoMax: FleetSpec = { name: "fleet", windows: [{ name: "main", agent: "claude" }, { name: "test", agent: "claude" }] };
  const out = renderSyncPlan(specNoMax, FID, "mysession", computeSyncPlan(specNoMax, FID, panes));
  assert.match(out, /\+ ADD.*1/s);
  assert.match(out, /test/);
  assert.match(out, /- DELETE.*1/s);
  assert.match(out, /"max"/);
  assert.match(out, /UNTOUCHED.*editor/s);
});

// ── syncFleet orchestration (injected seams, no real tmux) ───────────────────

const row = (o: Partial<PaneInfo> & { pane: string; windowName: string }): PaneInfo => ({
  session: "oxtail",
  windowIndex: 0,
  panePid: 1000,
  currentCommand: "claude",
  managedBy: FID,
  ...o,
});

// Fake tmux for syncFleet: list-panes returns the live set in tmux's REAL octal-escaped
// -F form (\037, so listPanesWithMarkers' normalize is exercised); new-window -P -F
// mints a fresh pane id. `ensure` + `kill` are injected and record into `seq` so the
// ADD→DELETE ordering and confirm-fidelity are assertable.
function fakeSync(panes: PaneInfo[]) {
  const seq: string[] = [];
  const live = panes.map((p) => ({ ...p }));
  let newPaneSeq = 200;
  const run = (args: string[]): string => {
    if (args[0] === "list-panes") {
      return `${live
        .map((p) => [p.pane, p.session, p.windowIndex, p.windowName, p.panePid, p.currentCommand, p.managedBy ?? ""].join("\\037"))
        .join("\n")}\n`;
    }
    if (args[0] === "new-window") {
      const id = `%${newPaneSeq++}`;
      seq.push(`create:${id}`);
      return `${id}\n`;
    }
    return "";
  };
  const ensure = async (o: { target: string; window: FleetWindowSpec; fleetId: string; cwd: string }): Promise<EnsureWindowResult> => {
    seq.push(`ensure:${o.window.name}@${o.target}`);
    return { window: o.window.name, occupancy: "empty-shell", action: "launched", ok: true, sessionId: `sid-${o.window.name}` };
  };
  const kill = (p: string): { ok: true; fleetId: string } | { ok: false; reason: string } => {
    seq.push(`kill:${p}`);
    return { ok: true, fleetId: FID };
  };
  return { run, ensure, kill, seq };
}

function withRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-sync-"));
  const prior = process.env.HOME;
  process.env.HOME = dir;
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      process.env.HOME = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test("syncFleet: converges — ADD new, KEEP healthy, DELETE spec-removed; ADD runs BEFORE DELETE", async () => {
  await withRepo(async (repoRoot) => {
    // live: main(ours) + max(ours). spec: main + test (test is new; max dropped).
    const fx = fakeSync([row({ pane: "%1", windowName: "main" }), row({ pane: "%2", windowName: "max" })]);
    const specAddDel: FleetSpec = { name: "oxtail", windows: [{ name: "main", agent: "claude" }, { name: "test", agent: "claude" }] };
    const res = await syncFleet(specAddDel, repoRoot, "oxtail", { dryRun: false, run: fx.run, ensure: fx.ensure, kill: fx.kill });
    assert.ok(res.ok, `sync ok: ${res.error}`);
    assert.deepEqual(res.added.map((a) => a.window), ["test"], "test ADDed");
    assert.deepEqual(res.kept.map((k) => k.window), ["main"], "main KEPT");
    assert.deepEqual(res.removed.map((r) => r.window), ["max"], "max DELETEd (spec-removed)");
    const addIdx = fx.seq.findIndex((s) => s.startsWith("ensure:test"));
    const delIdx = fx.seq.findIndex((s) => s === "kill:%2");
    assert.ok(addIdx >= 0 && delIdx >= 0 && addIdx < delIdx, `ADD must precede DELETE (seq: ${fx.seq.join(",")})`);
  });
});

test("syncFleet: KEEP ensures the EXISTING pane (no new window for a healthy match)", async () => {
  await withRepo(async (repoRoot) => {
    const fx = fakeSync([row({ pane: "%1", windowName: "main" })]);
    const res = await syncFleet({ name: "oxtail", windows: [{ name: "main", agent: "claude" }] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: fx.ensure,
      kill: fx.kill,
    });
    assert.ok(res.ok);
    assert.ok(fx.seq.includes("ensure:main@%1"), "main ensured on its existing pane %1");
    assert.ok(!fx.seq.some((s) => s.startsWith("create:")), "no new window for a healthy match");
    assert.equal(res.removed.length, 0);
  });
});

test("syncFleet confirm-fidelity: a DELETE that appeared since the preview is NOT killed unseen", async () => {
  await withRepo(async (repoRoot) => {
    // spec keeps only main → max(%2) and codex(%3) are both removes; operator confirmed
    // only %2, so %3 (appeared since) must be surfaced, not killed.
    const fx = fakeSync([
      row({ pane: "%1", windowName: "main" }),
      row({ pane: "%2", windowName: "max" }),
      row({ pane: "%3", windowName: "codex", currentCommand: "node" }),
    ]);
    const res = await syncFleet({ name: "oxtail", windows: [{ name: "main", agent: "claude" }] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: fx.ensure,
      kill: fx.kill,
      confirmedRemove: ["%2"],
      confirmedAdd: [],
    });
    assert.ok(fx.seq.includes("kill:%2"), "confirmed max IS killed");
    assert.ok(!fx.seq.includes("kill:%3"), "unconfirmed codex is NOT killed unseen");
    assert.deepEqual(res.unconfirmed?.remove, ["%3"], "the appeared delete-target is surfaced for a re-run");
    assert.equal(res.removed.length, 1, "only the confirmed delete acted on");
  });
});

test("syncFleet dry-run (default): renders the plan, mutates nothing", async () => {
  const fx = fakeSync([row({ pane: "%1", windowName: "main" }), row({ pane: "%2", windowName: "max" })]);
  let rendered = "";
  const res = await syncFleet({ name: "oxtail", windows: [{ name: "main", agent: "claude" }, { name: "test", agent: "claude" }] }, "/tmp", "oxtail", {
    run: fx.run,
    ensure: fx.ensure as never,
    kill: fx.kill,
    log: (m) => {
      rendered = m;
    },
  });
  assert.equal(res.dryRun, true);
  assert.equal(fx.seq.length, 0, "no ensure / create / kill in a dry-run");
  assert.match(rendered, /\+ ADD.*test/s);
  assert.match(rendered, /- DELETE.*max/s);
});

test("syncFleet: refuses an unmanaged session (no fleet to converge) — points at SPAWN", async () => {
  const fx = fakeSync([row({ pane: "%1", windowName: "main", managedBy: null })]); // nothing of ours
  const res = await syncFleet({ name: "oxtail", windows: [{ name: "main", agent: "claude" }] }, "/tmp", "oxtail", { run: fx.run });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /no oxpit-managed fleet|use SPAWN/i);
});

test("syncFleet: a FAILED add SKIPS the delete (don't tear down a degraded fleet) — codex MEDIUM", async () => {
  await withRepo(async (repoRoot) => {
    // spec swaps max→test: ADD test (which FAILS to launch), DELETE max. max must survive.
    const fx = fakeSync([row({ pane: "%1", windowName: "main" }), row({ pane: "%2", windowName: "max" })]);
    const failingEnsure = async (o: { target: string; window: FleetWindowSpec; fleetId: string; cwd: string }): Promise<EnsureWindowResult> => {
      fx.seq.push(`ensure:${o.window.name}@${o.target}`);
      const ok = o.window.name !== "test"; // the new "test" add fails
      return {
        window: o.window.name,
        occupancy: ok ? "empty-shell" : "unknown",
        action: ok ? "launched" : "aborted",
        ok,
        sessionId: ok ? `sid-${o.window.name}` : null,
        reason: ok ? undefined : "launch failed",
      };
    };
    const res = await syncFleet({ name: "oxtail", windows: [{ name: "main", agent: "claude" }, { name: "test", agent: "claude" }] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: failingEnsure,
      kill: fx.kill,
    });
    assert.equal(res.ok, false, "a failed ADD makes the sync not-ok");
    assert.ok(!fx.seq.includes("kill:%2"), "max is NOT deleted while its replacement failed to launch");
    assert.ok(
      res.removed.some((r) => r.window === "max" && !r.ok && /skipped|degraded/i.test(r.reason ?? "")),
      "the delete is recorded as skipped (degraded fleet)",
    );
  });
});

test("syncFleet: a STALE preview fleetId (≠ the session's live fleet) is refused — codex MEDIUM", async () => {
  await withRepo(async (repoRoot) => {
    const fx = fakeSync([row({ pane: "%1", windowName: "main" })]); // the session's LIVE fleet is FID
    const res = await syncFleet({ name: "oxtail", windows: [{ name: "main", agent: "claude" }] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: fx.ensure,
      kill: fx.kill,
      fleetId: "fleet-STALE0000", // a preview id that no longer matches the live session
    });
    assert.equal(res.ok, false, "a stale preview fleet identity is refused");
    assert.match(res.error ?? "", /changed since the preview|re-open the SYNC preview/i);
    assert.equal(fx.seq.length, 0, "nothing mutated when the fleet identity is stale");
  });
});

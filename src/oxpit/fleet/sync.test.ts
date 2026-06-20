import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PaneInfo } from "./ownership.js";
import { computeSyncPlan, renderSyncPlan } from "./sync.js";
import type { FleetSpec } from "./types.js";

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
const FID = "fleet-abcd1234";

test("computeSyncPlan: ADDs spec windows that have no managed pane; KEEPs the matched ones", () => {
  const panes = [
    pane({ pane: "%1", windowName: "main", managedBy: FID }),
    pane({ pane: "%2", windowName: "max", managedBy: FID }),
    // no "test" pane yet
  ];
  const p = computeSyncPlan(spec, FID, panes);
  assert.deepEqual(p.add.map((w) => w.name), ["test"], "the spec window with no pane → ADD");
  assert.deepEqual(p.keep.map((k) => k.window.name), ["main", "max"], "matched windows → KEEP (no-op)");
  assert.equal(p.remove.length, 0);
  assert.equal(p.survivors.length, 0);
});

test("computeSyncPlan: DELETEs a managed window removed from the spec (RESET would LEAVE it)", () => {
  const specNoMax: FleetSpec = { name: "fleet", windows: [{ name: "main", agent: "claude" }] };
  const panes = [
    pane({ pane: "%1", windowName: "main", managedBy: FID }),
    pane({ pane: "%2", windowName: "max", managedBy: FID }), // ours, but no longer in the spec
  ];
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

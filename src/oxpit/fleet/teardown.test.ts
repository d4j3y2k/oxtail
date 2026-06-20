import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PaneInfo } from "./ownership.js";
import { computeTeardownPlan } from "./teardown.js";
import type { FleetSpec } from "./types.js";

const spec: FleetSpec = {
  name: "oxtail",
  windows: [
    { name: "main", agent: "claude", model: "opus[1m]", effort: "xhigh", role: "captain" },
    { name: "max", agent: "claude", model: "opus[1m]", effort: "max" },
    { name: "codex", agent: "codex" },
  ],
};

function pane(p: Partial<PaneInfo> & { pane: string }): PaneInfo {
  return {
    session: "oxtail",
    windowIndex: 0,
    windowName: "main",
    panePid: 1000,
    currentCommand: "claude",
    managedBy: null,
    ...p,
  };
}

test("only OUR-marked panes matching a spec window become targets", () => {
  const fleetId = "oxtail-abcd1234";
  const panes: PaneInfo[] = [
    pane({ pane: "%1", windowName: "main", managedBy: fleetId }),
    pane({ pane: "%2", windowName: "max", managedBy: fleetId }),
    pane({ pane: "%3", windowName: "codex", currentCommand: "node", managedBy: fleetId }),
  ];
  const plan = computeTeardownPlan(spec, fleetId, panes);
  assert.equal(plan.targets.length, 3);
  assert.equal(plan.missing.length, 0);
  assert.equal(plan.strayManaged.length, 0);
  assert.deepEqual(
    plan.targets.map((t) => t.pane.pane).sort(),
    ["%1", "%2", "%3"],
  );
});

test("UNMARKED panes are NEVER targets (the fail-safe) even if names match", () => {
  const fleetId = "oxtail-abcd1234";
  const panes: PaneInfo[] = [
    pane({ pane: "%1", windowName: "main", managedBy: fleetId }),
    // A human's editor split in the same session, same window name — unmarked.
    pane({ pane: "%9", windowName: "main", currentCommand: "nvim", managedBy: null }),
    // A pane marked by a DIFFERENT fleet — also never ours.
    pane({ pane: "%8", windowName: "max", managedBy: "oxtail-99999999" }),
  ];
  const plan = computeTeardownPlan(spec, fleetId, panes);
  assert.deepEqual(
    plan.targets.map((t) => t.pane.pane),
    ["%1"],
    "only the marked main pane; the unmarked nvim + foreign-fleet panes excluded",
  );
  // max + codex have no pane of OURS → fresh launch
  assert.deepEqual(plan.missing.map((w) => w.name).sort(), ["codex", "max"]);
});

test("our-marked pane with no matching spec window is STRAY, not killed", () => {
  const fleetId = "oxtail-abcd1234";
  const panes: PaneInfo[] = [
    pane({ pane: "%1", windowName: "main", managedBy: fleetId }),
    pane({ pane: "%7", windowName: "renamed-by-hand", managedBy: fleetId }),
  ];
  const plan = computeTeardownPlan(spec, fleetId, panes);
  assert.deepEqual(plan.targets.map((t) => t.pane.pane), ["%1"]);
  assert.deepEqual(plan.strayManaged.map((p) => p.pane), ["%7"]);
});

test("empty fleet (nothing spawned yet) → all windows missing, no targets", () => {
  const plan = computeTeardownPlan(spec, "oxtail-abcd1234", []);
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.missing.length, 3);
  assert.equal(plan.strayManaged.length, 0);
});

test("a duplicate-named managed pane is not double-claimed by one window", () => {
  const fleetId = "oxtail-abcd1234";
  const panes: PaneInfo[] = [
    pane({ pane: "%1", windowName: "main", managedBy: fleetId }),
    pane({ pane: "%5", windowName: "main", managedBy: fleetId }),
  ];
  const plan = computeTeardownPlan(spec, fleetId, panes);
  // one "main" window claims exactly one pane; the other becomes stray.
  assert.equal(plan.targets.filter((t) => t.window.name === "main").length, 1);
  assert.equal(plan.strayManaged.length, 1);
});

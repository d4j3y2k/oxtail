import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyOccupancy,
  ensureWindow,
  isShellCommand,
  type EnsureWindowDeps,
  type OccupancyProbe,
} from "./ensure-window.js";
import type { RecipeResult } from "./recipes.js";
import type { FleetWindowSpec } from "./types.js";

const FLEET = "oxtail-abcd1234";
const main: FleetWindowSpec = { name: "main", agent: "claude", model: "opus-4.8", role: "captain" };

function probe(over: Partial<OccupancyProbe>): OccupancyProbe {
  return { currentCommand: "zsh", panePid: 1234, managedBy: null, ...over };
}

// ── classifyOccupancy (pure level probe) ───────────────────────────────────────

test("isShellCommand: shells (incl. login -zsh), not agents", () => {
  assert.ok(isShellCommand("zsh"));
  assert.ok(isShellCommand("-zsh"));
  assert.ok(isShellCommand("bash"));
  assert.ok(!isShellCommand("node")); // codex presents as node
  assert.ok(!isShellCommand("2.1.183")); // claude presents as its version string
  assert.ok(!isShellCommand("claude"));
});

test("a bare shell is empty-shell (launchable)", () => {
  assert.equal(classifyOccupancy(probe({ currentCommand: "zsh" }), FLEET), "empty-shell");
});

test("a non-shell pane carrying OUR marker is healthy-right-type (NO-OP)", () => {
  // pane_current_command is a version string / node — type comes from the marker
  assert.equal(
    classifyOccupancy(probe({ currentCommand: "2.1.183", managedBy: FLEET }), FLEET),
    "healthy-right-type",
  );
  assert.equal(
    classifyOccupancy(probe({ currentCommand: "node", managedBy: FLEET }), FLEET),
    "healthy-right-type",
  );
});

test("a non-shell pane we did NOT mark is wrong-type (never launch on top)", () => {
  assert.equal(classifyOccupancy(probe({ currentCommand: "node", managedBy: null }), FLEET), "wrong-type");
  assert.equal(
    classifyOccupancy(probe({ currentCommand: "vim", managedBy: "oxtail-99999999" }), FLEET),
    "wrong-type",
  );
});

test("a missing/dead pane is unknown (abstain, never launch blind)", () => {
  assert.equal(classifyOccupancy(null, FLEET), "unknown");
  assert.equal(classifyOccupancy(probe({ panePid: 0 }), FLEET), "unknown");
});

// ── ensureWindow dispatch (injected seams, no tmux) ────────────────────────────

function deps(over: Partial<EnsureWindowDeps> = {}): EnsureWindowDeps {
  return {
    probe: () => probe({ currentCommand: "zsh" }),
    launch: async (): Promise<RecipeResult> => ({ ok: true, sessionId: "sid-new" }),
    mark: () => {},
    capture: () => "PANE DUMP",
    ...over,
  };
}

test("empty-shell → launches, marks the pane, reports the bound session", async () => {
  let marked: [string, string] | null = null;
  const res = await ensureWindow(
    { target: "%5", window: main, fleetId: FLEET, cwd: "/repo" },
    deps({ mark: (p, f) => (marked = [p, f]) }),
  );
  assert.equal(res.action, "launched");
  assert.equal(res.ok, true);
  assert.equal(res.sessionId, "sid-new");
  assert.deepEqual(marked, ["%5", FLEET]);
});

test("healthy-right-type → NO-OP, never calls launch or mark", async () => {
  let launched = false;
  let marked = false;
  const res = await ensureWindow(
    { target: "%5", window: main, fleetId: FLEET, cwd: "/repo" },
    deps({
      probe: () => probe({ currentCommand: "node", managedBy: FLEET }),
      launch: async () => {
        launched = true;
        return { ok: true, sessionId: "x" };
      },
      mark: () => {
        marked = true;
      },
    }),
  );
  assert.equal(res.action, "noop");
  assert.equal(res.ok, true);
  assert.equal(launched, false);
  assert.equal(marked, false);
});

test("wrong-type → aborts loudly, never launches", async () => {
  let launched = false;
  const res = await ensureWindow(
    { target: "%5", window: main, fleetId: FLEET, cwd: "/repo" },
    deps({
      probe: () => probe({ currentCommand: "node", managedBy: null }),
      launch: async () => {
        launched = true;
        return { ok: true, sessionId: "x" };
      },
    }),
  );
  assert.equal(res.action, "aborted");
  assert.equal(res.ok, false);
  assert.equal(launched, false);
  assert.match(res.reason ?? "", /not ours to relaunch/);
});

test("unknown (pane gone) → aborts without launching", async () => {
  const res = await ensureWindow(
    { target: "%5", window: main, fleetId: FLEET, cwd: "/repo" },
    deps({ probe: () => null }),
  );
  assert.equal(res.action, "aborted");
  assert.match(res.reason ?? "", /refusing to launch blind/);
});

test("launch failure → aborts with the recipe reason + a pane dump, does NOT mark", async () => {
  let marked = false;
  const res = await ensureWindow(
    { target: "%5", window: main, fleetId: FLEET, cwd: "/repo" },
    deps({
      launch: async () => ({ ok: false, failed: { op: "waitExternal", artifact: "claude" }, reason: "drop never bound to pane", sessionId: null }),
      mark: () => {
        marked = true;
      },
    }),
  );
  assert.equal(res.action, "aborted");
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /drop never bound to pane/);
  assert.equal(res.paneDump, "PANE DUMP");
  assert.equal(marked, false);
});

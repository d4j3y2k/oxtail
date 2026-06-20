import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyOccupancy,
  ensureWindow,
  isClaimPaneBound,
  isShellCommand,
  type EnsureWindowDeps,
  type OccupancyProbe,
} from "./ensure-window.js";
import type { RegistryEntry } from "../../registry.js";
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

test("A3: a THROWING mark → launched-but-UNMANAGED (not a failure masquerade)", async () => {
  const res = await ensureWindow(
    { target: "%5", window: main, fleetId: FLEET, cwd: "/repo" },
    deps({
      mark: () => {
        throw new Error("tmux set-option exit 1");
      },
    }),
  );
  assert.equal(res.action, "launched");
  assert.equal(res.ok, true); // the launch SUCCEEDED — don't mask it as a failure
  assert.equal(res.sessionId, "sid-new");
  assert.match(res.reason ?? "", /UNMANAGED/);
});

// ── isClaimPaneBound (the pane-bound claim, codex BLOCK #2 / max A1) ────────────

function entry(over: Partial<RegistryEntry> & { server_pid: number }): RegistryEntry {
  return {
    started_at: 1,
    client: { type: "claude-code", session_id: "sid", transcript_path: null, session_id_source: "env", cwd: "/repo" },
    tmux_pane: "%5",
    tmux_session: "s",
    state: null,
    ...over,
  } as RegistryEntry;
}

test("claim binds only when type + cwd match AND server_pid resolves to OUR pane", () => {
  const e = entry({ server_pid: 100 });
  assert.ok(
    isClaimPaneBound("sid", { target: "%5", agent: "claude", cwd: "/repo" }, {
      readAll: () => [e],
      resolvePane: (pid) => (pid === 100 ? "%5" : null),
    }),
  );
});

test("claim does NOT bind when the entry's pid resolves to a DIFFERENT pane", () => {
  const e = entry({ server_pid: 100 });
  assert.ok(
    !isClaimPaneBound("sid", { target: "%5", agent: "claude", cwd: "/repo" }, {
      readAll: () => [e],
      resolvePane: () => "%9", // some other pane (or a dead/passive entry)
    }),
  );
});

test("claim does NOT bind on a wrong client type or wrong cwd (same sid)", () => {
  const wrongType = entry({ server_pid: 100, client: { type: "codex", session_id: "sid", transcript_path: null, session_id_source: "env", cwd: "/repo" } });
  const wrongCwd = entry({ server_pid: 101, client: { type: "claude-code", session_id: "sid", transcript_path: null, session_id_source: "env", cwd: "/elsewhere" } });
  const deps2 = { readAll: () => [wrongType, wrongCwd], resolvePane: () => "%5" };
  assert.ok(!isClaimPaneBound("sid", { target: "%5", agent: "claude", cwd: "/repo" }, deps2));
});

test("claim does NOT bind a STALE entry whose pid was recycled (proc_sig mismatch)", () => {
  // codex round-2: pid 100 now resolves to OUR pane, but it's an unrelated
  // recycled process — its live start-time sig differs from the dead entry's.
  const stale = entry({ server_pid: 100, proc_sig: "Mon Jan  1 00:00:00 2020" });
  assert.ok(
    !isClaimPaneBound("sid", { target: "%5", agent: "claude", cwd: "/repo" }, {
      readAll: () => [stale],
      resolvePane: () => "%5",
      resolveSig: () => "Fri Jun 19 22:00:00 2026",
    }),
  );
});

test("claim binds when proc_sig matches the live process under our pane", () => {
  const live = entry({ server_pid: 100, proc_sig: "Fri Jun 19 22:00:00 2026" });
  assert.ok(
    isClaimPaneBound("sid", { target: "%5", agent: "claude", cwd: "/repo" }, {
      readAll: () => [live],
      resolvePane: () => "%5",
      resolveSig: () => "Fri Jun 19 22:00:00 2026",
    }),
  );
});

test("claim fails closed on an entry with no cwd (malformed/passive)", () => {
  const noCwd = entry({ server_pid: 100, client: { type: "claude-code", session_id: "sid", transcript_path: null, session_id_source: "env", cwd: "" } });
  assert.ok(
    !isClaimPaneBound("sid", { target: "%5", agent: "claude", cwd: "/repo" }, {
      readAll: () => [noCwd],
      resolvePane: () => "%5",
    }),
  );
});

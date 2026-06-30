import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dockPaneCommand,
  invokedViaOxtail,
  runCockpitDock,
  shouldSpawn,
  type CockpitOptions,
} from "./cockpit.js";
import type { FleetSpec } from "./types.js";

const SPEC: FleetSpec = {
  name: "proj",
  windows: [
    { name: "main", agent: "claude", model: "opus[1m]", effort: "xhigh", remoteControl: true },
    { name: "max", agent: "claude", model: "opus[1m]", effort: "max", remoteControl: true },
    { name: "codex", agent: "codex", model: "gpt-5.5" },
  ],
};

// ── dockPaneCommand / invokedViaOxtail ──────────────────────────────────────────
test("dockPaneCommand: oxpit-bin re-invokes node <bin> --dock", () => {
  const cmd = dockPaneCommand({ execPath: "/usr/bin/node", binPath: "/x/oxpit-bin.js", viaOxtail: false });
  assert.equal(cmd, "'/usr/bin/node' '/x/oxpit-bin.js' --dock");
});

test("dockPaneCommand: oxtail server re-inserts the `oxpit` subcommand", () => {
  const cmd = dockPaneCommand({ execPath: "/usr/bin/node", binPath: "/x/server.js", viaOxtail: true });
  assert.equal(cmd, "'/usr/bin/node' '/x/server.js' oxpit --dock");
});

test("dockPaneCommand: shell-quotes paths with spaces / quotes", () => {
  const cmd = dockPaneCommand({ execPath: "/a b/node", binPath: "/c'd/oxpit-bin.js", viaOxtail: false });
  assert.equal(cmd, "'/a b/node' '/c'\\''d/oxpit-bin.js' --dock");
});

test("invokedViaOxtail: server.js → true, oxpit-bin.js → false", () => {
  assert.equal(invokedViaOxtail("/x/server.js"), true);
  assert.equal(invokedViaOxtail("/x/oxpit-bin.js"), false);
  assert.equal(invokedViaOxtail(undefined), false);
});

test("shouldSpawn: explicit flag wins; else auto from `configured`", () => {
  assert.equal(shouldSpawn({ spawn: true, configured: false }), true);
  assert.equal(shouldSpawn({ spawn: false, configured: true }), false);
  assert.equal(shouldSpawn({ configured: true }), true);
  assert.equal(shouldSpawn({ configured: false }), false);
});

// ── runCockpitDock executor (injected tmux recorder) ────────────────────────────
type Rec = { run: (args: string[]) => string; calls: string[][] };
function recorder(opts: { dock?: boolean; firstPane?: string } = {}): Rec {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "list-windows") return "main\nmax\ncodex";
    if (args[0] === "list-panes") {
      const f = args[args.indexOf("-F") + 1] ?? "";
      if (f.includes("@oxpit_dock")) return opts.dock ? "%1=1" : "%1=";
      return opts.firstPane ?? "%1";
    }
    if (args[0] === "split-window") return "%9";
    return "";
  };
  return { run, calls };
}

const find = (calls: string[][], verb: string) => calls.find((c) => c[0] === verb);

function baseOpts(over: Partial<CockpitOptions> = {}): CockpitOptions {
  return {
    run: recorder().run,
    execPath: "/n",
    binPath: "/x/oxpit-bin.js",
    viaOxtail: false,
    sessionExistsFn: () => false,
    attachFn: () => {},
    ...over,
  };
}

test("runCockpitDock: dry-run plans, mutates nothing", async () => {
  const rec = recorder();
  const r = await runCockpitDock(SPEC, "/repo", baseOpts({ run: rec.run, dryRun: true, inTmux: false }));
  assert.equal(r.dryRun, true);
  assert.equal(r.ok, true);
  // No mutating tmux verbs.
  assert.ok(!find(rec.calls, "split-window"), "no split on dry-run");
  assert.ok(!find(rec.calls, "new-session"), "no session creation on dry-run");
});

test("runCockpitDock: fresh + configured spawns the fleet, welds dock, bare-attaches", async () => {
  const rec = recorder();
  const live = new Set<string>();
  let attached: string | null = null;
  const r = await runCockpitDock(SPEC, "/repo", baseOpts({
    run: rec.run,
    inTmux: false,
    spawn: true,
    dockRows: 9,
    sessionExistsFn: (_run, name) => live.has(name),
    spawnFleetFn: async (_spec, _root, o) => {
      live.add(o!.sessionName!);
      return { fleetId: "f1", sessionName: o!.sessionName!, dryRun: false, plan: [], results: [], ok: true };
    },
    attachFn: (s) => { attached = s; },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.spawned, true);
  assert.equal(r.dockAdded, true);
  assert.equal(r.attachMode, "attach");
  const split = find(rec.calls, "split-window")!;
  assert.ok(split.includes("-d") && split.includes("-l") && split.includes("9"), "split is detached + sized");
  assert.equal(split[split.length - 1], "'/n' '/x/oxpit-bin.js' --dock", "dock pane runs the renderer");
  assert.ok(find(rec.calls, "set-option")?.includes("@oxpit_dock"), "dock pane marked");
  assert.equal(attached, "proj", "attached to the cockpit session");
  assert.ok(!find(rec.calls, "switch-client"), "no switch-client in a bare terminal");
});

test("runCockpitDock: in-tmux switches the client instead of attaching", async () => {
  const rec = recorder();
  let attachCalled = false;
  const r = await runCockpitDock(SPEC, "/repo", baseOpts({
    run: rec.run,
    inTmux: true,
    spawn: false, // layout-only → new-session shell
    sessionExistsFn: () => false,
    attachFn: () => { attachCalled = true; },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.attachMode, "switch");
  assert.ok(find(rec.calls, "new-session"), "created a bare working session");
  assert.ok(find(rec.calls, "switch-client"), "moved the current client");
  assert.equal(attachCalled, false, "did not block-attach inside tmux");
});

test("runCockpitDock: welds a dock into EVERY window (omnipresent HUD) + pins each height", async () => {
  const rec = recorder(); // list-windows → main / max / codex (3 windows)
  const live = new Set<string>();
  await runCockpitDock(SPEC, "/repo", baseOpts({
    run: rec.run,
    inTmux: true,
    spawn: true,
    sessionExistsFn: (_run, name) => live.has(name),
    spawnFleetFn: async (_s, _r, o) => {
      live.add(o!.sessionName!);
      return { fleetId: "f", sessionName: o!.sessionName!, dryRun: false, plan: [], results: [], ok: true };
    },
  }));
  const splits = rec.calls.filter((c) => c[0] === "split-window");
  assert.equal(splits.length, 3, "one dock split per window — the cockpit is omnipresent");
  const marks = rec.calls.filter((c) => c[0] === "set-option" && c.includes("@oxpit_dock"));
  assert.equal(marks.length, 3, "each dock marked");
  const resizes = rec.calls.filter((c) => c[0] === "resize-pane");
  assert.equal(resizes.length, 3, "each dock pinned to height after switch-client");
});

test("runCockpitDock: existing session + dock present → idempotent (no re-spawn, no second strip)", async () => {
  const rec = recorder({ dock: true });
  let spawnCalled = false;
  const r = await runCockpitDock(SPEC, "/repo", baseOpts({
    run: rec.run,
    inTmux: true,
    sessionExistsFn: () => true,
    spawnFleetFn: async (_s, _r, o) => { spawnCalled = true; return { fleetId: "f", sessionName: o!.sessionName!, dryRun: false, plan: [], results: [], ok: true }; },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.sessionExisted, true);
  assert.equal(r.dockAdded, false, "dock already present → not added again");
  assert.equal(spawnCalled, false, "existing session is never re-spawned");
  assert.ok(!find(rec.calls, "split-window"), "no second dock strip");
  assert.ok(find(rec.calls, "switch-client"), "still attaches you to it");
});

test("runCockpitDock: a THROWING spawn (FleetBusy lock) → clean error, never a crash", async () => {
  const rec = recorder();
  const r = await runCockpitDock(SPEC, "/repo", baseOpts({
    run: rec.run,
    inTmux: false,
    spawn: true,
    sessionExistsFn: () => false,
    spawnFleetFn: async () => {
      throw new Error("another oxpit fleet operation is already in progress for /repo");
    },
  }));
  assert.equal(r.ok, false, "throw is caught, not propagated");
  assert.match(r.error ?? "", /already in progress/);
  assert.match(r.error ?? "", /re-run/, "includes a retry hint");
  assert.ok(!find(rec.calls, "split-window"), "no dock split after a failed spawn");
});

test("runCockpitDock: aborts if the fleet spawn fails to create the session", async () => {
  const rec = recorder();
  const r = await runCockpitDock(SPEC, "/repo", baseOpts({
    run: rec.run,
    inTmux: false,
    spawn: true,
    sessionExistsFn: () => false, // never becomes true → spawn "failed"
    spawnFleetFn: async (_s, _r, o) => ({ fleetId: "f", sessionName: o!.sessionName!, dryRun: false, plan: [], results: [], ok: false, error: "boom" }),
  }));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /did not create session/);
  assert.ok(!find(rec.calls, "split-window"), "no dock split after a failed spawn");
});

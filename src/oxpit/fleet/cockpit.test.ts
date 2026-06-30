import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dockPaneCommand,
  flipKeyEnabled,
  invokedViaOxtail,
  resolveFlipKey,
  rootBinding,
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
function recorder(opts: { dock?: boolean; firstPane?: string; rootKeys?: string } = {}): Rec {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "list-windows") return "main\nmax\ncodex";
    if (args[0] === "list-panes") {
      const f = args[args.indexOf("-F") + 1] ?? "";
      if (f.includes("@oxpit_dock")) return opts.dock ? "%1=1" : "%1=";
      return opts.firstPane ?? "%1";
    }
    if (args[0] === "list-keys") return opts.rootKeys ?? ""; // flip-key clobber probe
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
  assert.ok(
    rec.calls.some((c) => c[0] === "set-option" && c.includes("@oxpit_dock")),
    "dock pane marked", // filter, not first — @oxpit_cockpit is now set earlier in the loop
  );
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

// ── the agent↔dock FLIP KEY (C-]) ───────────────────────────────────────────────
test("flipKeyEnabled: on by default, off only via OXTAIL_OXPIT_FLIP=off", () => {
  assert.equal(flipKeyEnabled({}), true);
  assert.equal(flipKeyEnabled({ OXTAIL_OXPIT_FLIP: "off" }), false);
  assert.equal(flipKeyEnabled({ OXTAIL_OXPIT_FLIP: "on" }), true, "any non-'off' value is on");
});

const OURS_BINDING = "bind-key -T root C-] if-shell @oxpit_cockpit @oxpit_dock select-pane\n";

test("rootBinding: classifies unbound / ours / foreign / unreadable", () => {
  const ours = () => "bind-key -T root C-b send-prefix\n" + OURS_BINDING;
  assert.equal(rootBinding(ours, "C-]").state, "ours");
  assert.equal(rootBinding(ours, "C-x").state, "unbound", "an unbound key");
  assert.equal(rootBinding(() => "bind-key -T root C-] copy-mode\n", "C-]").state, "foreign");
  const thrower = () => {
    throw new Error("no server running");
  };
  assert.equal(rootBinding(thrower, "C-]").state, "unreadable", "a failed list-keys fails closed");
});

test("rootBinding: a foreign binding with flags BEFORE -T root is still detected (no clobber)", () => {
  // tmux 3.5a lists `bind-key -T root -r C-] copy-mode` as `bind-key -r -T root C-] copy-mode`
  // — the -r flag precedes -T root. An anchored regex misses it and then clobbers the binding.
  const run = () => "bind-key -r -T root C-]                    copy-mode\n";
  assert.equal(rootBinding(run, "C-]").state, "foreign", "flag-order-insensitive match");
});

test("resolveFlipKey: ON+unbound installs and reports available", () => {
  const calls: string[][] = [];
  const run = (a: string[]) => (calls.push(a), ""); // empty list-keys = unbound
  assert.equal(resolveFlipKey(run, true), true);
  assert.ok(calls.some((c) => c[0] === "bind-key"), "installed the binding");
});

test("resolveFlipKey: ON+foreign warns, never binds, reports unavailable", () => {
  const calls: string[][] = [];
  const warns: string[] = [];
  const run = (a: string[]) => (calls.push(a), a[0] === "list-keys" ? "bind-key -r -T root C-] copy-mode\n" : "");
  assert.equal(resolveFlipKey(run, true, (m) => warns.push(m)), false);
  assert.ok(!calls.some((c) => c[0] === "bind-key"), "never clobbers a foreign binding");
  assert.ok(warns.some((w) => /already bound/.test(w)));
});

test("resolveFlipKey: ON+unreadable fails closed (no bind, unavailable, warns)", () => {
  const calls: string[][] = [];
  const warns: string[] = [];
  const run = (a: string[]) => {
    calls.push(a);
    if (a[0] === "list-keys") throw new Error("can't read");
    return "";
  };
  assert.equal(resolveFlipKey(run, true, (m) => warns.push(m)), false);
  assert.ok(!calls.some((c) => c[0] === "bind-key"), "fail-closed: no install on an unreadable probe");
  assert.ok(warns.some((w) => /couldn't read/.test(w)));
});

test("resolveFlipKey: OFF is a real kill switch — unbinds OURS, leaves a foreign binding alone", () => {
  const oursCalls: string[][] = [];
  const oursRun = (a: string[]) => (oursCalls.push(a), a[0] === "list-keys" ? OURS_BINDING : "");
  assert.equal(resolveFlipKey(oursRun, false), false);
  assert.ok(oursCalls.some((c) => c[0] === "unbind-key" && c.includes("C-]")), "removes our own binding");

  const fgnCalls: string[][] = [];
  const fgnRun = (a: string[]) => (fgnCalls.push(a), a[0] === "list-keys" ? "bind-key -T root C-] copy-mode\n" : "");
  resolveFlipKey(fgnRun, false);
  assert.ok(!fgnCalls.some((c) => c[0] === "unbind-key"), "never unbinds a foreign binding");
});

// Spawn the fleet so the weld runs the full window loop + the flip-key resolve.
function spawnedOpts(rec: Rec, over: Partial<CockpitOptions> = {}): CockpitOptions {
  const live = new Set<string>();
  return baseOpts({
    run: rec.run,
    inTmux: true,
    spawn: true,
    sessionExistsFn: (_r, n) => live.has(n),
    spawnFleetFn: async (_s, _r, o) => {
      live.add(o!.sessionName!);
      return { fleetId: "f", sessionName: o!.sessionName!, dryRun: false, plan: [], results: [], ok: true };
    },
    ...over,
  });
}
// SET (`@oxpit_cockpit 1`) vs UNSET (`-u @oxpit_cockpit`) window-option calls.
const setMark = (rec: Rec) =>
  rec.calls.filter((c) => c[0] === "set-option" && c.includes("@oxpit_cockpit") && !c.includes("-u"));
const unsetMark = (rec: Rec) =>
  rec.calls.filter((c) => c[0] === "set-option" && c.includes("@oxpit_cockpit") && c.includes("-u"));

test("runCockpitDock: installs the flip key once + SETs @oxpit_cockpit on every window", async () => {
  const rec = recorder();
  await runCockpitDock(SPEC, "/repo", spawnedOpts(rec));
  assert.equal(setMark(rec).length, 3, "every window marked (set -w @oxpit_cockpit 1)");
  assert.equal(unsetMark(rec).length, 0, "no unsets when the flip key is available");
  const binds = rec.calls.filter((c) => c[0] === "bind-key");
  assert.equal(binds.length, 1, "flip key bound exactly once, outside the loop");
  assert.deepEqual(
    binds[0],
    [
      "bind-key", "-n", "C-]",
      "if-shell", "-F", "#{@oxpit_cockpit}",
      'if-shell -F "#{@oxpit_dock}" "select-pane -U" "select-pane -D"',
      "send-keys C-]",
    ],
    "the brace-free dock-aware toggle argv (-U/-D; {top}/{bottom} mis-parse as command blocks)",
  );
});

test("runCockpitDock: FOREIGN C-] (even with -r) → no bind, warn, marks UNSET so the hint can't lie", async () => {
  const rec = recorder({ rootKeys: "bind-key -r -T root C-] copy-mode\n" });
  const warnings: string[] = [];
  await runCockpitDock(SPEC, "/repo", spawnedOpts(rec, { log: (m) => warnings.push(m) }));
  assert.ok(!rec.calls.some((c) => c[0] === "bind-key"), "never overwrites a foreign C-]");
  assert.equal(setMark(rec).length, 0, "no windows marked (the flip key isn't ours)");
  assert.equal(unsetMark(rec).length, 3, "stale marks actively cleared (hint tracks reality)");
  assert.ok(warnings.some((w) => /already bound/.test(w)), "warns about the skip");
});

test("runCockpitDock: re-installing OUR own C-] binding is idempotent (re-binds, marks set, no warn)", async () => {
  const rec = recorder({ rootKeys: OURS_BINDING });
  const warnings: string[] = [];
  await runCockpitDock(SPEC, "/repo", spawnedOpts(rec, { log: (m) => warnings.push(m) }));
  assert.equal(rec.calls.filter((c) => c[0] === "bind-key").length, 1, "re-binds our own");
  assert.equal(setMark(rec).length, 3, "windows marked (flip available)");
  assert.ok(!warnings.some((w) => /already bound/.test(w)), "no foreign-clobber warning for our own");
});

test("runCockpitDock: OXTAIL_OXPIT_FLIP=off → no bind, marks UNSET, unbinds our prior binding", async () => {
  const prev = process.env.OXTAIL_OXPIT_FLIP;
  process.env.OXTAIL_OXPIT_FLIP = "off";
  try {
    const rec = recorder({ rootKeys: OURS_BINDING }); // a cockpit previously welded with flip on
    await runCockpitDock(SPEC, "/repo", spawnedOpts(rec));
    assert.ok(!rec.calls.some((c) => c[0] === "bind-key"), "doesn't install when off");
    assert.ok(
      rec.calls.some((c) => c[0] === "unbind-key" && c.includes("C-]")),
      "removes the prior binding (a real kill switch, not just install-time)",
    );
    assert.equal(setMark(rec).length, 0, "no windows marked when off");
    assert.equal(unsetMark(rec).length, 3, "clears the stale @oxpit_cockpit marks");
    assert.equal(rec.calls.filter((c) => c[0] === "split-window").length, 3, "docks still welded (flip is orthogonal)");
  } finally {
    if (prev === undefined) delete process.env.OXTAIL_OXPIT_FLIP;
    else process.env.OXTAIL_OXPIT_FLIP = prev;
  }
});

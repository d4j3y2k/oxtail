import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnsureWindowResult } from "./ensure-window.js";
import { fleetLockPath } from "./lock.js";
import type { PaneInfo } from "./ownership.js";
import { discoverFleetId, resetFleet } from "./reset.js";
import type { FleetSpec, FleetWindowSpec } from "./types.js";

const spec: FleetSpec = {
  name: "oxtail",
  windows: [
    { name: "main", agent: "claude", model: "opus-4.8", effort: "xhigh", role: "captain" },
    { name: "max", agent: "claude", model: "opus-4.8", effort: "max" },
    { name: "codex", agent: "codex", model: "gpt-5.5" },
  ],
};

const FLEET = "oxtail-abcd1234";

function row(p: Partial<PaneInfo> & { pane: string }): PaneInfo {
  return {
    session: "oxtail",
    windowIndex: 0,
    windowName: "main",
    panePid: 1000,
    currentCommand: "claude",
    managedBy: FLEET,
    ...p,
  };
}

// Fake tmux. list-panes returns the live pane set in tmux's REAL octal-escaped -F
// form (\037) — teardownTarget re-probes via listPanesWithMarkers, so the TOCTOU is
// exercised through the SAME read path as the plan. `drift` mutates the live panes at
// a given list-panes call # (to simulate an operator changing a pane between plan and
// mutation). new-window -P -F returns a fresh pane id; respawn-pane is a no-op. A
// shared `seq` records teardown vs relaunch ORDER (relaunch pushes in the injected
// ensure) so quiesce-first is assertable.
function fakeTmux(
  panes: PaneInfo[],
  opts: { driftAtCall?: number; drift?: (live: PaneInfo[]) => void } = {},
) {
  const seq: string[] = [];
  const live = panes.map((p) => ({ ...p }));
  let listCalls = 0;
  let newPaneSeq = 100;
  const run = (args: string[]): string => {
    if (args[0] === "respawn-pane") seq.push(`teardown:${args[args.indexOf("-t") + 1]}`);
    if (args[0] === "list-panes") {
      listCalls += 1;
      if (opts.driftAtCall === listCalls && opts.drift) opts.drift(live);
      return (
        live
          .map((p) =>
            [p.pane, p.session, p.windowIndex, p.windowName, p.panePid, p.currentCommand, p.managedBy ?? ""].join(
              "\\037",
            ),
          )
          .join("\n") + "\n"
      );
    }
    if (args[0] === "new-window") return `%${newPaneSeq++}\n`;
    return "";
  };
  const ensure = async (o: { target: string; window: FleetWindowSpec; fleetId: string; cwd: string }) => {
    seq.push(`relaunch:${o.window.name}@${o.target}`);
    return {
      window: o.window.name,
      occupancy: "empty-shell",
      action: "launched",
      ok: true,
      sessionId: `sid-${o.window.name}`,
    } satisfies EnsureWindowResult;
  };
  return { run, ensure, seq };
}

function withRepo<T>(fn: (repoRoot: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-reset-"));
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

// ── fleetId discovery ───────────────────────────────────────────────────────────

test("discoverFleetId: 0 markers → nothing to reset; 1 → ok; >1 → ambiguous refusal", () => {
  const none = fakeTmux([row({ pane: "%1", managedBy: null, currentCommand: "zsh" })]);
  const r0 = discoverFleetId("oxtail", none.run);
  assert.equal(r0.ok, false);
  if (!r0.ok) assert.match(r0.reason, /nothing to RESET/);

  const one = fakeTmux([row({ pane: "%1", windowName: "main" })]);
  const r1 = discoverFleetId("oxtail", one.run);
  assert.equal(r1.ok, true);
  if (r1.ok) assert.equal(r1.fleetId, FLEET);

  const two = fakeTmux([
    row({ pane: "%1", windowName: "main", managedBy: FLEET }),
    row({ pane: "%2", windowName: "max", managedBy: "oxtail-99999999" }),
  ]);
  const r2 = discoverFleetId("oxtail", two.run);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.match(r2.reason, /multiple fleetIds/);
});

// ── dry-run ──────────────────────────────────────────────────────────────────────

test("DRY-RUN (the default) mutates NOTHING — no respawn-pane, no new-window", async () => {
  await withRepo(async (repoRoot) => {
    const seen: string[][] = [];
    const fx = fakeTmux([
      row({ pane: "%1", windowName: "main" }),
      row({ pane: "%2", windowName: "max", currentCommand: "claude" }),
      row({ pane: "%3", windowName: "codex", currentCommand: "node" }),
    ]);
    const run = (args: string[]) => {
      seen.push(args);
      return fx.run(args);
    };
    const res = await resetFleet(spec, repoRoot, "oxtail", { run }); // dryRun defaults true
    assert.equal(res.dryRun, true);
    assert.equal(res.ok, true);
    assert.equal(res.fleetId, FLEET);
    assert.equal(res.plan?.targets.length, 3);
    assert.ok(!seen.some((c) => c[0] === "respawn-pane"), "dry-run must not respawn");
    assert.ok(!seen.some((c) => c[0] === "new-window"), "dry-run must not create windows");
  });
});

test("the DRY-RUN preview reads state OUTSIDE the lock (a read-only preview takes no lock)", async () => {
  await withRepo(async (repoRoot) => {
    const fx = fakeTmux([row({ pane: "%1", windowName: "main" })]);
    let heldDuringRead = true;
    const run = (args: string[]) => {
      if (args[0] === "list-panes") heldDuringRead = existsSync(fleetLockPath(repoRoot));
      return fx.run(args);
    };
    await resetFleet({ ...spec, windows: [spec.windows[0]] }, repoRoot, "oxtail", { run });
    assert.equal(heldDuringRead, false, "dry-run preview must not hold the fleet lock");
  });
});

// ── live reset ─────────────────────────────────────────────────────────────────────

test("live RESET: teardown ALL targets BEFORE any relaunch (quiesce-first), then relaunch sequentially", async () => {
  await withRepo(async (repoRoot) => {
    const fx = fakeTmux([
      row({ pane: "%1", windowName: "main" }),
      row({ pane: "%2", windowName: "max", currentCommand: "claude" }),
      row({ pane: "%3", windowName: "codex", currentCommand: "node" }),
    ]);
    const res = await resetFleet(spec, repoRoot, "oxtail", { dryRun: false, run: fx.run, ensure: fx.ensure });
    assert.equal(res.ok, true);
    assert.deepEqual(res.teardowns.map((t) => t.action), ["reset", "reset", "reset"]);
    assert.equal(res.relaunches.length, 3);
    const lastTeardown = fx.seq.findLastIndex((s) => s.startsWith("teardown:"));
    const firstRelaunch = fx.seq.findIndex((s) => s.startsWith("relaunch:"));
    assert.ok(lastTeardown < firstRelaunch, `all teardowns must precede all relaunches: ${fx.seq.join(", ")}`);
    assert.deepEqual(
      fx.seq.filter((s) => s.startsWith("relaunch:")),
      ["relaunch:main@%1", "relaunch:max@%2", "relaunch:codex@%3"],
    );
  });
});

test("the MUTATING plan is computed INSIDE the fleet lock (no stale-plan-outside-lock race)", async () => {
  await withRepo(async (repoRoot) => {
    // codex P6: a plan computed before the lock goes stale while a concurrent RESET
    // mutates. Every state read on the mutating path must hold the lock — asserted by
    // the lock dir being present at each list-panes (discovery, plan, TOCTOU re-probe).
    const fx = fakeTmux([row({ pane: "%1", windowName: "main" })]);
    const lockHeldDuringReads: boolean[] = [];
    const run = (args: string[]) => {
      if (args[0] === "list-panes") lockHeldDuringReads.push(existsSync(fleetLockPath(repoRoot)));
      return fx.run(args);
    };
    await resetFleet({ ...spec, windows: [spec.windows[0]] }, repoRoot, "oxtail", {
      dryRun: false,
      run,
      ensure: fx.ensure,
    });
    assert.ok(lockHeldDuringReads.length > 0, "state was read");
    assert.ok(lockHeldDuringReads.every((held) => held), "every plan-state read must hold the fleet lock");
  });
});

test("NEVER kill-session — RESET is strictly per-pane respawn", async () => {
  await withRepo(async (repoRoot) => {
    const seen: string[][] = [];
    const fx = fakeTmux([row({ pane: "%1", windowName: "main" })]);
    const run = (args: string[]) => {
      seen.push(args);
      return fx.run(args);
    };
    await resetFleet({ ...spec, windows: [spec.windows[0]] }, repoRoot, "oxtail", {
      dryRun: false,
      run,
      ensure: fx.ensure,
    });
    assert.ok(!seen.some((c) => c[0] === "kill-session"), "kill-session is hard-banned");
    assert.ok(seen.some((c) => c[0] === "respawn-pane"), "per-pane respawn is used");
  });
});

// ── TOCTOU (full spec-target re-check) ───────────────────────────────────────────

test("TOCTOU: a target whose WINDOW was renamed since the plan is SKIPPED (spec-target drift, codex)", async () => {
  await withRepo(async (repoRoot) => {
    // %2 is a plan target, but its window is renamed before its teardown re-probe
    // (list-panes call #4: discover=1, plan=2, td%1=3, td%2=4). Marker still ours, but
    // the spec-target no longer matches → must skip, NOT relaunch-on-top.
    const fx = fakeTmux(
      [row({ pane: "%1", windowName: "main" }), row({ pane: "%2", windowName: "max", currentCommand: "claude" })],
      {
        driftAtCall: 4,
        drift: (live) => {
          const m = live.find((p) => p.pane === "%2");
          if (m) m.windowName = "renamed-by-hand";
        },
      },
    );
    const res = await resetFleet({ ...spec, windows: [spec.windows[0], spec.windows[1]] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: fx.ensure,
    });
    const maxT = res.teardowns.find((t) => t.pane === "%2");
    assert.equal(maxT?.action, "skipped");
    assert.match(maxT?.reason ?? "", /drifted/);
    assert.ok(!fx.seq.includes("teardown:%2"), "the renamed pane is never respawned");
    assert.ok(!fx.seq.some((s) => s.startsWith("relaunch:max")), "and never relaunched onto");
    assert.equal(res.ok, false, "a skipped target makes the overall reset not-ok");
    assert.ok(fx.seq.includes("teardown:%1"), "the unchanged main pane still resets");
  });
});

test("TOCTOU: a target whose MARKER flipped to a foreign fleet since the plan is SKIPPED", async () => {
  await withRepo(async (repoRoot) => {
    const fx = fakeTmux(
      [row({ pane: "%1", windowName: "main" }), row({ pane: "%2", windowName: "max", currentCommand: "claude" })],
      {
        driftAtCall: 4,
        drift: (live) => {
          const m = live.find((p) => p.pane === "%2");
          if (m) m.managedBy = "someone-else-7777";
        },
      },
    );
    const res = await resetFleet({ ...spec, windows: [spec.windows[0], spec.windows[1]] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: fx.ensure,
    });
    assert.equal(res.teardowns.find((t) => t.pane === "%2")?.action, "skipped");
    assert.ok(!fx.seq.includes("teardown:%2"), "a now-foreign pane is never respawned");
  });
});

// ── missing windows ─────────────────────────────────────────────────────────────────

test("missing windows (no managed pane) are CREATED fresh (new-window -P -F) and launched", async () => {
  await withRepo(async (repoRoot) => {
    const fx = fakeTmux([row({ pane: "%1", windowName: "main" })]);
    const created: string[] = [];
    const run = (args: string[]) => {
      if (args[0] === "new-window") created.push(args[args.indexOf("-n") + 1]);
      return fx.run(args);
    };
    const res = await resetFleet(spec, repoRoot, "oxtail", { dryRun: false, run, ensure: fx.ensure });
    assert.equal(res.plan?.missing.map((w) => w.name).sort().join(","), "codex,max");
    assert.deepEqual(created.sort(), ["codex", "max"], "missing windows created by name");
    assert.deepEqual(res.relaunches.map((r) => r.window).sort(), ["codex", "main", "max"]);
    assert.ok(res.ok);
  });
});

test("resetFleet errors (no mutation) when the session has nothing of ours", async () => {
  await withRepo(async (repoRoot) => {
    const seen: string[][] = [];
    const fx = fakeTmux([row({ pane: "%1", managedBy: null, currentCommand: "zsh" })]);
    const run = (args: string[]) => {
      seen.push(args);
      return fx.run(args);
    };
    const res = await resetFleet(spec, repoRoot, "oxtail", { dryRun: false, run, ensure: fx.ensure });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /nothing to RESET/);
    assert.ok(!seen.some((c) => c[0] === "respawn-pane"), "no teardown when nothing is ours");
  });
});

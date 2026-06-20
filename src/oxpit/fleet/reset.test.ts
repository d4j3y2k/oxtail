import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnsureWindowResult } from "./ensure-window.js";
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

// Fake tmux: list-panes returns rows in tmux's REAL octal-escaped -F form (\037);
// show-options returns the per-pane marker (mutable via markerOverride, for TOCTOU
// sim); new-window -P -F returns a fresh pane id; respawn-pane is a no-op. A shared
// `seq` records teardown vs relaunch ORDER (relaunch pushes happen in the injected
// ensure) so we can assert quiesce-first.
function fakeTmux(panes: PaneInfo[], markerOverride: Record<string, string> = {}) {
  const seq: string[] = [];
  const markers: Record<string, string> = {};
  for (const p of panes) if (p.managedBy) markers[p.pane] = p.managedBy;
  Object.assign(markers, markerOverride);
  let newPaneSeq = 100;
  const run = (args: string[]): string => {
    if (args[0] === "respawn-pane") seq.push(`teardown:${args[args.indexOf("-t") + 1]}`);
    if (args[0] === "list-panes") {
      return (
        panes
          .map((p) =>
            [p.pane, p.session, p.windowIndex, p.windowName, p.panePid, p.currentCommand, p.managedBy ?? ""].join(
              "\\037",
            ),
          )
          .join("\n") + "\n"
      );
    }
    if (args[0] === "show-options") return (markers[args[args.indexOf("-t") + 1]] ?? "") + "\n";
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
    // QUIESCE-FIRST: every teardown precedes every relaunch in the shared sequence.
    const lastTeardown = fx.seq.findLastIndex((s) => s.startsWith("teardown:"));
    const firstRelaunch = fx.seq.findIndex((s) => s.startsWith("relaunch:"));
    assert.ok(lastTeardown < firstRelaunch, `all teardowns must precede all relaunches: ${fx.seq.join(", ")}`);
    // Relaunch lands on the SAME (torn-down, marker-preserved) panes.
    assert.deepEqual(
      fx.seq.filter((s) => s.startsWith("relaunch:")),
      ["relaunch:main@%1", "relaunch:max@%2", "relaunch:codex@%3"],
    );
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

test("TOCTOU: a target whose marker changed since the plan is SKIPPED — not torn down, not relaunched", async () => {
  await withRepo(async (repoRoot) => {
    // %2 was a plan target (managedBy=FLEET in the listing) but its live marker
    // flipped (operator re-pointed it) before the mutation → must be left untouched.
    const fx = fakeTmux(
      [
        row({ pane: "%1", windowName: "main" }),
        row({ pane: "%2", windowName: "max", currentCommand: "claude" }),
      ],
      { "%2": "someone-else-7777" },
    );
    const res = await resetFleet({ ...spec, windows: [spec.windows[0], spec.windows[1]] }, repoRoot, "oxtail", {
      dryRun: false,
      run: fx.run,
      ensure: fx.ensure,
    });
    const max = res.teardowns.find((t) => t.pane === "%2");
    assert.equal(max?.action, "skipped");
    assert.match(max?.reason ?? "", /TOCTOU/);
    assert.ok(!fx.seq.includes("teardown:%2"), "the changed pane is never respawned");
    assert.ok(!fx.seq.some((s) => s.startsWith("relaunch:max")), "and never relaunched");
    assert.equal(res.ok, false, "a skipped target makes the overall reset not-ok");
    // The untouched-marker pane %1 still resets normally.
    assert.ok(fx.seq.includes("teardown:%1"));
  });
});

test("missing windows (no managed pane) are CREATED fresh (new-window -P -F) and launched", async () => {
  await withRepo(async (repoRoot) => {
    // Only main exists/marked; max + codex are missing → fresh windows.
    const fx = fakeTmux([row({ pane: "%1", windowName: "main" })]);
    const created: string[] = [];
    const run = (args: string[]) => {
      if (args[0] === "new-window") created.push(args[args.indexOf("-n") + 1]);
      return fx.run(args);
    };
    const res = await resetFleet(spec, repoRoot, "oxtail", { dryRun: false, run, ensure: fx.ensure });
    assert.equal(res.plan?.missing.map((w) => w.name).sort().join(","), "codex,max");
    assert.deepEqual(created.sort(), ["codex", "max"], "missing windows created by name via new-window");
    // All three relaunched: the torn-down main + the two created windows.
    assert.deepEqual(
      res.relaunches.map((r) => r.window).sort(),
      ["codex", "main", "max"],
    );
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

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureWindow, type EnsureWindowResult, type LaunchCtx } from "./ensure-window.js";
import {
  listPanesWithMarkers,
  markPaneManaged,
  markersInSession,
  mintFleetId,
  readPaneMarker,
} from "./ownership.js";
import type { Recipe } from "./recipes.js";
import { spawnFleet } from "./spawn.js";
import type { FleetSpec } from "./types.js";

// Opt-in real-tmux integration for the SPAWN orchestration (P5). Gated on
// OXTAIL_TMUX_TESTS=1 because it spawns real tmux sessions (slow, environment-
// dependent), skipped in normal CI. It exercises the new tmux-touching code —
// session/window/pane creation, sequential ensure, the @oxpit_managed marker,
// and refuse-to-clobber — against a REAL tmux server WITHOUT launching billable
// agents: a trivial injected `ensure` stands in for the agent launch (the launch
// → readiness → claim seam is covered by the unit suite + the P2/P2.5 live
// spikes). Run manually: `OXTAIL_TMUX_TESTS=1 npm test`.
const skip = process.env.OXTAIL_TMUX_TESTS !== "1";

function tmuxOk(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function tmuxRaw(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function windowNames(session: string): string[] {
  // `=name` forces an EXACT session match (tmux targets otherwise prefix/fnmatch).
  return tmuxRaw(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"])
    .split("\n")
    .filter(Boolean);
}

function killSession(name: string): void {
  try {
    tmuxRaw(["kill-session", "-t", `=${name}`]);
  } catch {
    // already gone
  }
}

// A temp dir doubling as repoRoot (where windows are created) and HOME (so the
// fleet lock lands in an isolated ~/.oxtail, never the live fleet's). The real
// tmux ops are HOME-independent (they reach the same server via its socket).
function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-spawn-tmux-"));
  const priorHome = process.env.HOME;
  process.env.HOME = dir;
  return (async () => {
    try {
      await fn(dir);
    } finally {
      process.env.HOME = priorHome;
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const spec: FleetSpec = {
  name: "oxspike",
  windows: [
    { name: "main", agent: "claude", model: "opus-4.8", effort: "xhigh", role: "captain" },
    { name: "max", agent: "claude", model: "opus-4.8", effort: "max" },
    { name: "codex", agent: "codex", model: "gpt-5.5" },
  ],
};

test(
  "spawn-tmux: creates a real session + windows, ensures each in order, tags every pane managed",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-spawn-test-${process.pid}-${Date.now()}`;
    await withTempRepo(async (repoRoot) => {
      const ensured: string[] = [];
      try {
        const res = await spawnFleet(spec, repoRoot, {
          dryRun: false,
          sessionName: session,
          // Stand in for the agent launch: the pane already exists (real tmux), so
          // we just record the call + tag the pane the way ensure_window would, and
          // report success. NO claude/codex process is started.
          ensure: async ({ target, window, fleetId }) => {
            ensured.push(`${window.name}@${target}`);
            markPaneManaged(target, fleetId); // real `tmux set-option -p`
            return {
              window: window.name,
              occupancy: "empty-shell",
              action: "launched",
              ok: true,
              sessionId: `sid-${window.name}`,
            } satisfies EnsureWindowResult;
          },
        });

        assert.equal(res.ok, true, `spawn should succeed: ${res.error}`);
        assert.equal(res.dryRun, false);
        assert.equal(res.sessionName, session);

        // The session is real and carries exactly the spec's windows, in order.
        assert.deepEqual(windowNames(session), ["main", "max", "codex"]);

        // ensure ran once per window, in spec order, on each window's pane.
        assert.deepEqual(ensured.map((e) => e.split("@")[0]), ["main", "max", "codex"]);

        // Every pane oxpit created carries THIS fleet's marker (the additive-safety
        // basis: teardown only ever targets panes bearing the fleetId).
        assert.deepEqual(markersInSession(session), [res.fleetId]);
        const panes = listPanesWithMarkers().filter((p) => p.session === session);
        assert.equal(panes.length, 3, "three managed panes");
        for (const p of panes) assert.equal(p.managedBy, res.fleetId);
      } finally {
        killSession(session);
      }
    });
  },
);

test(
  "spawn-tmux: REFUSES to spawn on top of a real existing session (no clobber, no tagging)",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-spawn-clobber-${process.pid}-${Date.now()}`;
    await withTempRepo(async (repoRoot) => {
      try {
        // A pre-existing session — a human's, say — that oxpit does NOT own.
        tmuxRaw(["new-session", "-d", "-s", session, "-n", "human-work", "bash --noprofile --norc"]);
        const before = windowNames(session);

        let ensureCalls = 0;
        const res = await spawnFleet(spec, repoRoot, {
          dryRun: false,
          sessionName: session,
          ensure: async ({ window }) => {
            ensureCalls++;
            return {
              window: window.name,
              occupancy: "empty-shell",
              action: "launched",
              ok: true,
              sessionId: "x",
            } satisfies EnsureWindowResult;
          },
        });

        assert.equal(res.ok, false, "must refuse to spawn on top of an existing session");
        assert.match(res.error ?? "", /already exists — refusing to spawn on top of it/);
        assert.equal(ensureCalls, 0, "no window ensured on a refusal");

        // The pre-existing session is untouched — same windows, and we never tagged
        // anything in a session we don't own.
        assert.deepEqual(windowNames(session), before, "existing session unchanged");
        assert.deepEqual(markersInSession(session), [], "no marker laid on an unowned session");
      } finally {
        killSession(session);
      }
    });
  },
);

test(
  "spawn-tmux: REAL ensureWindow probe->classify->decide against live panes (agent-exec stubbed)",
  { skip: skip || !tmuxOk() },
  async () => {
    // max's P5 Q2: spawnFleet tests inject the WHOLE ensure, so the consuming path
    // (probePane -> classifyOccupancy -> dispatch) had ZERO live coverage — exactly
    // where the 0x1F bug lived. Run the REAL ensureWindow against real panes,
    // stubbing ONLY the agent-exec leaf (`launch`), across the 3 classify decisions.
    // `sleep` stands in for a non-shell process so no billable agent runs (the
    // classify path only reads pane_current_command + the marker).
    const session = `oxtail-ensure-test-${process.pid}-${Date.now()}`;
    await withTempRepo(async (repoRoot) => {
      const fleetId = mintFleetId("oxspike");
      const foreignId = mintFleetId("other");
      const launched: string[] = [];
      const stubLaunch = async (_recipe: Recipe, ctx: LaunchCtx) => {
        launched.push(ctx.window.name);
        return { ok: true as const, sessionId: `stub-${ctx.window.name}` };
      };
      const win = (name: string) => ({ name, agent: "claude" as const, model: "opus-4.8" });
      const pane = (w: string) =>
        tmuxRaw(["list-panes", "-t", `=${session}:${w}`, "-F", "#{pane_id}"]).trim();
      try {
        tmuxRaw(["new-session", "-d", "-s", session, "-n", "empty", "bash --noprofile --norc"]);
        tmuxRaw(["new-window", "-t", `=${session}`, "-n", "ours", "sleep 100000"]);
        tmuxRaw(["new-window", "-t", `=${session}`, "-n", "foreign", "sleep 100000"]);
        const [emptyPane, oursPane, foreignPane] = [pane("empty"), pane("ours"), pane("foreign")];
        markPaneManaged(oursPane, fleetId);
        markPaneManaged(foreignPane, foreignId);

        // (a) fresh shell, no marker → empty-shell → LAUNCH (stub) → tagged ours.
        const a = await ensureWindow(
          { target: emptyPane, window: win("empty"), fleetId, cwd: repoRoot },
          { launch: stubLaunch },
        );
        assert.equal(a.occupancy, "empty-shell", `fresh shell → empty-shell, got ${a.occupancy}`);
        assert.equal(a.action, "launched");
        assert.equal(a.ok, true);
        assert.equal(readPaneMarker(emptyPane), fleetId, "launched pane tagged with our fleetId");

        // (b) non-shell marked OURS → healthy-right-type → idempotent NO-OP.
        const b = await ensureWindow(
          { target: oursPane, window: win("ours"), fleetId, cwd: repoRoot },
          { launch: stubLaunch },
        );
        assert.equal(b.occupancy, "healthy-right-type", `our marked pane → healthy, got ${b.occupancy}`);
        assert.equal(b.action, "noop");
        assert.equal(b.ok, true);

        // (c) non-shell marked FOREIGN → wrong-type → REFUSE (not ours to relaunch).
        const c = await ensureWindow(
          { target: foreignPane, window: win("foreign"), fleetId, cwd: repoRoot },
          { launch: stubLaunch },
        );
        assert.equal(c.occupancy, "wrong-type", `foreign-marked pane → wrong-type, got ${c.occupancy}`);
        assert.equal(c.action, "aborted");
        assert.equal(c.ok, false);
        assert.equal(readPaneMarker(foreignPane), foreignId, "foreign marker left untouched");

        // The stubbed agent-exec fired ONLY for the empty-shell window.
        assert.deepEqual(launched, ["empty"], "launch fired only on empty-shell");
      } finally {
        killSession(session);
      }
    });
  },
);

test(
  "spawn-tmux: an UNMARKED pane reads back null; mark round-trips (the additive-safety invariant)",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-spawn-unmarked-${process.pid}-${Date.now()}`;
    try {
      tmuxRaw(["new-session", "-d", "-s", session, "-n", "plain", "bash --noprofile --norc"]);
      const pane = tmuxRaw(["list-panes", "-t", `=${session}`, "-F", "#{pane_id}"])
        .split("\n")
        .filter(Boolean)[0];
      assert.ok(pane, "pane id resolved");

      // Never marked → no marker, no fleetId in the session: this is exactly what
      // keeps an unowned pane structurally off every teardown target set.
      assert.equal(readPaneMarker(pane), null);
      assert.deepEqual(markersInSession(session), []);

      // Mark it and confirm the round-trip (set-option -p / show-options -pqv).
      markPaneManaged(pane, "oxspike-deadbeef");
      assert.equal(readPaneMarker(pane), "oxspike-deadbeef");
      assert.deepEqual(markersInSession(session), ["oxspike-deadbeef"]);
    } finally {
      killSession(session);
    }
  },
);

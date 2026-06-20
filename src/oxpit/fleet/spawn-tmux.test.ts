import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnsureWindowResult } from "./ensure-window.js";
import {
  listPanesWithMarkers,
  markPaneManaged,
  markersInSession,
  readPaneMarker,
} from "./ownership.js";
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

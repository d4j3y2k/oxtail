// ensure_window — the one load-bearing primitive: bring a single tmux window to
// a configured, ready agent regardless of its current state, idempotently.
// SPAWN = new-session + ensure_window×N; RESET (P6) = teardown + ensure_window.
//
// IDEMPOTENCY via a non-destructive LEVEL PROBE FIRST (the plan's core crack):
// classify what currently occupies the window BEFORE doing anything, so a re-run
// on a healthy window is a true no-op instead of typing `claude\n` on top of a
// live agent. The probe is the structural guarantee against launch-on-top.
//
// WHY the probe is marker-based, not command-based: pane_current_command is NOT
// a reliable agent-type signal — a live Claude reports its version string
// (e.g. "2.1.183"), Codex reports "node", and an idle window reports the shell
// ("zsh"). So the only thing the command reliably tells us is shell-vs-not. Type
// + ownership come from oxpit's `@oxpit_managed` marker (set at our spawn,
// preserved across respawn -k): a non-shell pane carrying THIS fleet's marker is
// the agent we put there (its model/effort are in-TUI and intentionally NOT
// re-verified — config changes go through RESET/--force); a non-shell pane we
// did not mark is never ours to relaunch on top of.
//
// Dispatch (P2 — SPAWN; teardown of half-up/wrong-type deferred to RESET/P6):
//   empty-shell        → launch (run the recipe, then mark the pane managed)
//   healthy-right-type → NO-OP
//   wrong-type|half-up → abort loudly (don't touch what we didn't spawn)
//   unknown            → abstain loudly (never launch blind)
//
// The launch path reuses the validated keystroke layer (keystrokes.ts), the
// launch-artifact readiness watch (readiness.ts), the pane classifier
// (classify.ts), and the step-DSL executor (recipes.ts). Readiness + the claim
// check are EXTERNAL (filesystem artifact + oxtail registry), never pane text.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { capturePane, fireKeystrokes, waitForPaneLine } from "../../keystrokes.js";
import { readAllPassive } from "../../registry.js";
import { classifyPaneReadiness } from "./classify.js";
import { listPanesWithMarkers, markPaneManaged, type PaneInfo, type TmuxRun } from "./ownership.js";
import { awaitLaunchArtifact, snapshotBaseline } from "./readiness.js";
import {
  buildRecipe,
  clientTypeFor,
  executeRecipe,
  type Recipe,
  type RecipeEffects,
  type RecipeResult,
} from "./recipes.js";
import type { FleetWindowSpec, WindowOccupancy } from "./types.js";

const SHELL_COMMANDS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

// A login shell shows up as "-zsh"/"-bash"; strip the leading dash before the set
// check. Case-folded for safety.
export function isShellCommand(cmd: string): boolean {
  return SHELL_COMMANDS.has(cmd.replace(/^-/, "").toLowerCase());
}

export type OccupancyProbe = {
  currentCommand: string;
  panePid: number;
  managedBy: string | null;
};

// PURE level-probe classifier. See the file header for why type comes from the
// marker, not pane_current_command.
export function classifyOccupancy(probe: OccupancyProbe | null, fleetId: string): WindowOccupancy {
  if (!probe || !Number.isFinite(probe.panePid) || probe.panePid <= 0) return "unknown";
  if (isShellCommand(probe.currentCommand)) return "empty-shell";
  if (probe.managedBy === fleetId) return "healthy-right-type";
  return "wrong-type";
}

function defaultRun(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2000,
  });
}

// Single-pane probe: pull the target pane's row from the marker-aware listing.
export function probePaneInfo(target: string, run?: TmuxRun): PaneInfo | null {
  return listPanesWithMarkers(run).find((p) => p.pane === target) ?? null;
}

function defaultClaimResolver(sessionId: string): boolean {
  try {
    return readAllPassive().some((e) => e.client.session_id === sessionId);
  } catch {
    return false;
  }
}

export interface LaunchCtx {
  target: string;
  window: FleetWindowSpec;
  cwd: string;
}

export interface EnsureWindowDeps {
  run?: TmuxRun;
  now?: () => number;
  home?: string;
  readinessTimeoutMs?: number;
  // Seams (all overridable in tests so the dispatch is exercised without tmux):
  probe?: (pane: string) => OccupancyProbe | null;
  launch?: (recipe: Recipe, ctx: LaunchCtx) => Promise<RecipeResult>;
  mark?: (pane: string, fleetId: string) => void;
  claimResolver?: (sessionId: string) => boolean;
  capture?: (pane: string) => string;
  log?: (msg: string) => void;
}

export interface EnsureWindowResult {
  window: string;
  occupancy: WindowOccupancy;
  action: "launched" | "noop" | "aborted";
  ok: boolean;
  sessionId: string | null;
  reason?: string;
  paneDump?: string;
}

// Wire the real effects (tmux keystrokes + fs readiness + registry claim) and
// run the recipe. Baseline + launch instant are captured HERE, immediately
// before executeRecipe fires the launch keystroke, so the post-launch poll only
// adopts a genuinely new artifact.
async function defaultLaunch(ctx: LaunchCtx, deps: EnsureWindowDeps): Promise<RecipeResult> {
  const { target, window, cwd } = ctx;
  const run = deps.run ?? defaultRun;
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => Date.now());
  const clientType = clientTypeFor(window.agent);
  const claim = deps.claimResolver ?? defaultClaimResolver;
  const recipe = buildRecipe(window);
  const baseline = snapshotBaseline(window.agent, home);
  const launchInstantMs = now();
  const effects: RecipeEffects = {
    fireLiteral: (t) => fireKeystrokes(target, clientType, t),
    sendKey: async (k) => {
      run(["send-keys", "-t", target, k]);
    },
    confirmLine: (needle) => waitForPaneLine(target, needle).then((r) => r.ok),
    classify: () => classifyPaneReadiness(capturePane(target), clientType),
    waitExternal: async (artifact) => {
      const r = await awaitLaunchArtifact(artifact, {
        launchedPane: target,
        cwd,
        baseline,
        launchInstantMs,
        base: home,
        timeoutMs: deps.readinessTimeoutMs,
      });
      if (r.ok) return { ok: true, sessionId: r.sessionId };
      const extra = r.candidates.length
        ? ` [fresh-but-unbound: ${r.candidates.map((c) => c.sessionId).join(", ")}]`
        : "";
      return { ok: false, reason: `${r.reason}${extra}` };
    },
    claimCheck: (sid) => claim(sid),
    log: deps.log,
  };
  return executeRecipe(recipe, effects);
}

// Bring one window to a ready agent. Probe → classify → dispatch. On a launch
// failure, the pane buffer is dumped into the result for a loud abort.
export async function ensureWindow(
  opts: { target: string; window: FleetWindowSpec; fleetId: string; cwd: string },
  deps: EnsureWindowDeps = {},
): Promise<EnsureWindowResult> {
  const { target, window, fleetId, cwd } = opts;
  const probe = (deps.probe ?? ((p) => probePaneInfo(p, deps.run)))(target);
  const occupancy = classifyOccupancy(probe, fleetId);
  const head = { window: window.name, occupancy, sessionId: null as string | null };
  deps.log?.(`[ensure ${window.name}] probe → ${occupancy}`);

  switch (occupancy) {
    case "healthy-right-type":
      return {
        ...head,
        action: "noop",
        ok: true,
        reason: "already running this fleet's agent (marker present) — left untouched",
      };
    case "unknown":
      return {
        ...head,
        action: "aborted",
        ok: false,
        reason: `could not probe pane ${target} (gone, or no live pid) — refusing to launch blind`,
      };
    case "wrong-type":
    case "half-up":
      return {
        ...head,
        action: "aborted",
        ok: false,
        reason:
          `window occupied by an unmanaged process (${probe?.currentCommand ?? "?"}) — ` +
          `not ours to relaunch on top of. Use RESET/--force (P6) to reconfigure.`,
      };
    case "empty-shell": {
      const recipe = buildRecipe(window);
      const launch = deps.launch ?? ((_r, ctx) => defaultLaunch(ctx, deps));
      const res = await launch(recipe, { target, window, cwd });
      if (res.ok) {
        (deps.mark ?? ((p, f) => markPaneManaged(p, f, deps.run)))(target, fleetId);
        deps.log?.(`[ensure ${window.name}] launched, session ${res.sessionId}`);
        return { ...head, action: "launched", ok: true, sessionId: res.sessionId };
      }
      const dump = (deps.capture ?? capturePane)(target);
      return {
        ...head,
        action: "aborted",
        ok: false,
        sessionId: res.sessionId,
        reason: res.reason,
        paneDump: dump || undefined,
      };
    }
  }
}

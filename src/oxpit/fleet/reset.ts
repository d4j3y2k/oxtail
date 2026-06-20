// RESET — teardown an existing oxpit-spawned fleet back to clean shells, then
// relaunch (ensure_window). The DESTRUCTIVE half of the lifecycle (SPAWN is the
// greenfield half). Built on the pure, soaked computeTeardownPlan (teardown.ts):
// ONLY panes carrying THIS fleet's marker AND matching a spec window are ever
// touched — a human's editor/dev-server split is structurally never a target.
//
// SAFETY (design dual-reviewed — codex impl/safety + max arch):
//   • per-pane `respawn-pane -k` ONLY; `kill-session` is HARD-BANNED (it would
//     take out an unmanaged split). respawn-pane -k resets the pane to a fresh
//     shell in repoRoot AND preserves the @oxpit_managed marker (live-verified).
//   • each teardown is gated by an IMMEDIATE pane-id TOCTOU re-check (the operator
//     may have changed the fleet since the plan was computed).
//   • DRY-RUN DEFAULT; real teardown only on dryRun:false behind the menu's
//     deliberate confirm. Held under the per-repo fleet lock.
//   • two phases (max): QUIESCE the whole fleet (respawn-k every target straight
//     through — no readiness binding to race, and no old/new coexistence) THEN
//     relaunch SEQUENTIALLY (readiness binds one launch at a time).
//   • v1 is respawn-k-only; a single classifier-gated `/exit` graceful rung is a
//     ready fast-follow if live soak shows hard-kill disruption.

import { execFileSync } from "node:child_process";
import {
  ensureWindow as realEnsureWindow,
  type EnsureWindowDeps,
  type EnsureWindowResult,
} from "./ensure-window.js";
import { withFleetLock } from "./lock.js";
import {
  listPanesWithMarkers,
  markersInSession,
  readPaneMarker,
  type TmuxRun,
} from "./ownership.js";
import { computeTeardownPlan, renderTeardownPlan, type TeardownPlan } from "./teardown.js";
import type { FleetSpec } from "./types.js";

function defaultRun(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
}

export interface ResetOptions {
  dryRun?: boolean; // default TRUE — print the plan, mutate nothing
  run?: TmuxRun;
  fleetId?: string; // usually discovered from the session's markers
  ensure?: typeof realEnsureWindow; // injectable for tests
  ensureDeps?: EnsureWindowDeps;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface TeardownResult {
  pane: string;
  window: string;
  ok: boolean;
  action: "reset" | "skipped";
  reason?: string;
}

export interface ResetResult {
  fleetId: string | null;
  sessionName: string;
  dryRun: boolean;
  plan: TeardownPlan | null;
  teardowns: TeardownResult[];
  relaunches: EnsureWindowResult[];
  ok: boolean;
  error?: string;
}

// Discover the fleetId marked on a session. RESET needs exactly one (the normal
// case — one fleet per session). 0 ⇒ nothing of ours to reset; >1 ⇒ ambiguous,
// refuse rather than guess which fleet to tear down.
export function discoverFleetId(
  sessionName: string,
  run: TmuxRun = defaultRun,
): { ok: true; fleetId: string } | { ok: false; reason: string } {
  const ids = markersInSession(sessionName, run);
  if (ids.length === 0) {
    return { ok: false, reason: `no oxpit-managed panes in session "${sessionName}" — nothing to RESET` };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      reason: `session "${sessionName}" carries multiple fleetIds [${ids.join(", ")}] — refusing to guess which to RESET`,
    };
  }
  return { ok: true, fleetId: ids[0] };
}

function sessionPanes(run: TmuxRun, sessionName: string) {
  return listPanesWithMarkers(run).filter((p) => p.session === sessionName);
}

export function buildResetPlan(
  spec: FleetSpec,
  fleetId: string,
  sessionName: string,
  run: TmuxRun = defaultRun,
): TeardownPlan {
  return computeTeardownPlan(spec, fleetId, sessionPanes(run, sessionName));
}

// Human-readable dry-run / confirm-preview (no side effects). The menu colors this
// into the "scary red plan" so the operator sees EXACTLY which panes die.
export function renderResetPlan(
  spec: FleetSpec,
  fleetId: string,
  sessionName: string,
  plan: TeardownPlan,
): string {
  return [
    `RESET (dry-run): fleet "${spec.name}" in tmux session "${sessionName}" [${fleetId}]`,
    `  teardown = per-pane respawn-pane -k (NEVER kill-session) → ensure_window relaunch`,
    ...renderTeardownPlan(plan)
      .split("\n")
      .map((l) => `  ${l}`),
  ].join("\n");
}

// Reset ONE target pane to a clean shell. The DESTRUCTIVE primitive, gated by an
// IMMEDIATE pane-id TOCTOU re-check: the pane must STILL carry OUR fleetId marker
// (readPaneMarker returns null if the pane is gone, or a different value if the
// operator re-pointed it). respawn-pane -k kills the pane's process tree + restarts
// the shell in repoRoot, PRESERVING the marker (live-verified). Targets by PANE ID,
// never session:window — the id is the stable identity once mutation begins.
function teardownTarget(
  run: TmuxRun,
  pane: string,
  windowName: string,
  fleetId: string,
  repoRoot: string,
): TeardownResult {
  const marker = readPaneMarker(pane, run);
  if (marker !== fleetId) {
    return {
      pane,
      window: windowName,
      ok: false,
      action: "skipped",
      reason: `TOCTOU: marker is ${marker ? `"${marker}"` : "gone"} (≠ ${fleetId}) — pane changed since the plan; left untouched`,
    };
  }
  try {
    run(["respawn-pane", "-k", "-c", repoRoot, "-t", pane]);
    return { pane, window: windowName, ok: true, action: "reset" };
  } catch (e) {
    return { pane, window: windowName, ok: false, action: "skipped", reason: `respawn-pane failed: ${String(e)}` };
  }
}

// Create a missing window and return its pane id DIRECTLY (-P -F) — never resolve
// by session:windowName afterwards, which a dup/human same-name window would make
// a targeting footgun (codex P6). Started in repoRoot so the relaunch is in scope.
function createWindow(run: TmuxRun, sessionName: string, name: string, repoRoot: string): string | null {
  try {
    const out = run(["new-window", "-t", sessionName, "-n", name, "-c", repoRoot, "-P", "-F", "#{pane_id}"]);
    const id = out.split("\n").find((l) => l.trim());
    return id ? id.trim() : null;
  } catch {
    return null;
  }
}

function abortedRelaunch(window: string, reason: string): EnsureWindowResult {
  return { window, occupancy: "unknown", action: "aborted", ok: false, sessionId: null, reason };
}

// RESET an existing oxpit-spawned fleet. DRY-RUN DEFAULT. See the file header for
// the safety model. Returns per-pane teardown + per-window relaunch outcomes so the
// operator sees every result (no silent partial success).
export async function resetFleet(
  spec: FleetSpec,
  repoRoot: string,
  sessionName: string,
  opts: ResetOptions = {},
): Promise<ResetResult> {
  const dryRun = opts.dryRun ?? true;
  const run = opts.run ?? defaultRun;

  const disc = opts.fleetId
    ? ({ ok: true, fleetId: opts.fleetId } as const)
    : discoverFleetId(sessionName, run);
  if (!disc.ok) {
    return { fleetId: null, sessionName, dryRun, plan: null, teardowns: [], relaunches: [], ok: false, error: disc.reason };
  }
  const fleetId = disc.fleetId;
  const plan = computeTeardownPlan(spec, fleetId, sessionPanes(run, sessionName));

  if (dryRun) {
    opts.log?.(renderResetPlan(spec, fleetId, sessionName, plan));
    return { fleetId, sessionName, dryRun: true, plan, teardowns: [], relaunches: [], ok: true };
  }

  const ensure = opts.ensure ?? realEnsureWindow;
  const ensureDeps = (): EnsureWindowDeps => ({ run, now: opts.now, log: opts.log, ...opts.ensureDeps });
  return withFleetLock(repoRoot, async () => {
    // PHASE 1 — QUIESCE: respawn-k EVERY target straight through (no relaunch yet,
    // so no old/new coexistence), each preceded by its pane-id TOCTOU re-check. No
    // readiness binding here, so order/parallelism is irrelevant — do them all.
    const teardowns: TeardownResult[] = plan.targets.map(({ window, pane }) =>
      teardownTarget(run, pane.pane, window.name, fleetId, repoRoot),
    );

    // PHASE 2 — RELAUNCH, SEQUENTIALLY (readiness binds one launch at a time).
    // Torn-down targets are now marked shells → ensure_window relaunches them;
    // missing windows are created fresh (pane id captured at creation).
    const relaunches: EnsureWindowResult[] = [];
    for (const { window, pane } of plan.targets) {
      const td = teardowns.find((t) => t.pane === pane.pane);
      if (!td?.ok) {
        relaunches.push(abortedRelaunch(window.name, `relaunch skipped — teardown did not succeed (${td?.reason ?? "?"})`));
        continue;
      }
      relaunches.push(await ensure({ target: pane.pane, window, fleetId, cwd: repoRoot }, ensureDeps()));
    }
    for (const window of plan.missing) {
      const newPane = createWindow(run, sessionName, window.name, repoRoot);
      if (!newPane) {
        relaunches.push(abortedRelaunch(window.name, `could not create window ${sessionName}:${window.name}`));
        continue;
      }
      relaunches.push(await ensure({ target: newPane, window, fleetId, cwd: repoRoot }, ensureDeps()));
    }

    const ok = teardowns.every((t) => t.ok) && relaunches.every((r) => r.ok);
    return { fleetId, sessionName, dryRun: false, plan, teardowns, relaunches, ok };
  });
}

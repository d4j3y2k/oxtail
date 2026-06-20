// SPAWN — stand up a NEW tmux agent fleet from a spec. The greenfield half of
// the lifecycle (RESET, P6, is teardown + ensure_window): there is no destructive
// teardown here, only creation. SPAWN = mint a fleetId → create a detached tmux
// session with one window per spec entry → run ensure_window over each window
// SEQUENTIALLY (the readiness binding requires one launch at a time) → aggregate.
//
// Detached + non-disruptive: we never attach or switch-client (that UX belongs to
// the menu/P4) and never touch any OTHER session — `new-session -d` leaves the
// operator's current view alone. A --dry-run (the DEFAULT) prints the exact tmux
// commands + per-window recipe steps and mutates nothing, so the plan is fully
// reviewable before anything runs. Held under the per-repo fleet lock so two
// oxpit instances can't interleave session creation.

import { execFileSync } from "node:child_process";
import { ensureWindow as realEnsureWindow, type EnsureWindowDeps, type EnsureWindowResult } from "./ensure-window.js";
import { withFleetLock } from "./lock.js";
import { mintFleetId, type TmuxRun } from "./ownership.js";
import { buildRecipe, renderRecipe } from "./recipes.js";
import type { FleetSpec, FleetWindowSpec } from "./types.js";

function defaultRun(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
  });
}

// tmux target syntax uses ":" (session:window) and "." (window.pane), so a
// session name must carry neither; collapse anything unsafe to "-".
export function tmuxSessionName(base: string): string {
  return base.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) || "fleet";
}

export interface SpawnOptions {
  dryRun?: boolean; // default TRUE — print the plan, mutate nothing
  run?: TmuxRun;
  sessionName?: string; // defaults to a tmux-safe form of spec.name
  ensure?: typeof realEnsureWindow; // injectable for tests
  ensureDeps?: EnsureWindowDeps;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SpawnWindowPlan {
  window: FleetWindowSpec;
  paneTarget: string; // session:windowName at plan time (pane id resolved at run)
  recipe: string; // renderRecipe dry-run text
}

export interface SpawnResult {
  fleetId: string;
  sessionName: string;
  dryRun: boolean;
  plan: SpawnWindowPlan[];
  results: EnsureWindowResult[]; // empty on dry-run
  ok: boolean;
  error?: string;
}

// Build the read-only plan (no tmux calls): one entry per window with its
// rendered recipe. Used by --dry-run and the menu's confirm preview.
export function planSpawn(spec: FleetSpec, sessionName: string): SpawnWindowPlan[] {
  return spec.windows.map((window) => ({
    window,
    paneTarget: `${sessionName}:${window.name}`,
    recipe: renderRecipe(buildRecipe(window)),
  }));
}

export function renderSpawnPlan(spec: FleetSpec, fleetId: string, sessionName: string): string {
  const lines: string[] = [];
  lines.push(`SPAWN (dry-run): fleet "${spec.name}" → tmux session "${sessionName}" [${fleetId}]`);
  lines.push(`  tmux new-session -d -s ${sessionName} -n ${spec.windows[0]?.name ?? "?"} -c <repoRoot>`);
  for (const w of spec.windows.slice(1)) {
    lines.push(`  tmux new-window -t ${sessionName} -n ${w.name} -c <repoRoot>`);
  }
  lines.push(`  then, sequentially, ensure_window over each (tagging @oxpit_managed=${fleetId}):`);
  for (const p of planSpawn(spec, sessionName)) {
    lines.push(...renderRecipe(buildRecipe(p.window)).split("\n").map((l) => `    ${l}`));
  }
  return lines.join("\n");
}

// Resolve the active pane id of a freshly-created window.
function paneForWindow(run: TmuxRun, sessionName: string, windowName: string): string | null {
  try {
    const out = run(["list-panes", "-t", `${sessionName}:${windowName}`, "-F", "#{pane_id}"]);
    const first = out.split("\n").find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export async function spawnFleet(
  spec: FleetSpec,
  repoRoot: string,
  opts: SpawnOptions = {},
): Promise<SpawnResult> {
  const dryRun = opts.dryRun ?? true;
  const run = opts.run ?? defaultRun;
  const sessionName = opts.sessionName ?? tmuxSessionName(spec.name);
  const fleetId = mintFleetId(spec.name);
  const plan = planSpawn(spec, sessionName);

  if (dryRun) {
    opts.log?.(renderSpawnPlan(spec, fleetId, sessionName));
    return { fleetId, sessionName, dryRun: true, plan, results: [], ok: true };
  }

  const ensure = opts.ensure ?? realEnsureWindow;
  return withFleetLock(repoRoot, async () => {
    const results: EnsureWindowResult[] = [];
    try {
      // Create the session (first window) + the remaining windows up-front as
      // empty shells; the LAUNCHES below are what must stay sequential.
      run(["new-session", "-d", "-s", sessionName, "-n", spec.windows[0].name, "-c", repoRoot]);
      for (const w of spec.windows.slice(1)) {
        run(["new-window", "-t", sessionName, "-n", w.name, "-c", repoRoot]);
      }
    } catch (e) {
      return { fleetId, sessionName, dryRun: false, plan, results, ok: false, error: `session creation failed: ${String(e)}` };
    }

    for (const window of spec.windows) {
      const pane = paneForWindow(run, sessionName, window.name);
      if (!pane) {
        results.push({
          window: window.name,
          occupancy: "unknown",
          action: "aborted",
          ok: false,
          sessionId: null,
          reason: `could not resolve pane for ${sessionName}:${window.name}`,
        });
        continue; // keep going so the operator sees every window's outcome
      }
      const res = await ensure(
        { target: pane, window, fleetId, cwd: repoRoot },
        { run, now: opts.now, log: opts.log, ...opts.ensureDeps },
      );
      results.push(res);
    }
    return { fleetId, sessionName, dryRun: false, plan, results, ok: results.every((r) => r.ok) };
  });
}

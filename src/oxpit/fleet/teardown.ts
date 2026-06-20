// Teardown SET COMPUTATION — pure, read-only, side-effect-free. The scariest
// logic in the feature (which panes a RESET would destroy), built early (P1) so
// it can be soaked via dry-run all through the SPAWN phase before it is ever
// wired to a real kill in P6 (max's risk-ordering correction).
//
// SAFETY (additive allowlist, max's "subtractive is fail-dangerous" fix): the
// ONLY panes that become targets are those carrying THIS fleet's ownership
// marker AND matching a spec window. An unmarked pane (a human's editor or
// dev-server split in the same tmux session) is structurally never a target.
// A pane that carries our marker but matches no spec window (renamed/orphaned)
// is surfaced as `strayManaged` for the operator — never auto-killed. There is
// no path here that implies `kill-session`; teardown is strictly per listed pane.

import type { PaneInfo } from "./ownership.js";
import type { FleetSpec, FleetWindowSpec } from "./types.js";

export interface TeardownPlan {
  // panes we WILL teardown+respawn: this fleet's marker AND a spec-window match.
  targets: { window: FleetWindowSpec; pane: PaneInfo }[];
  // spec windows with no existing managed pane → a fresh launch (SPAWN path).
  missing: FleetWindowSpec[];
  // our-marked panes matching no spec window → surfaced, NOT killed.
  strayManaged: PaneInfo[];
}

export function computeTeardownPlan(
  spec: FleetSpec,
  fleetId: string,
  panes: PaneInfo[],
): TeardownPlan {
  const fleetPanes = panes.filter((p) => p.managedBy === fleetId);
  const targets: TeardownPlan["targets"] = [];
  const matched = new Set<string>();
  const missing: FleetWindowSpec[] = [];
  for (const w of spec.windows) {
    const pane = fleetPanes.find((p) => p.windowName === w.name && !matched.has(p.pane));
    if (pane) {
      targets.push({ window: w, pane });
      matched.add(pane.pane);
    } else {
      missing.push(w);
    }
  }
  const strayManaged = fleetPanes.filter((p) => !matched.has(p.pane));
  return { targets, missing, strayManaged };
}

// Human-readable dry-run rendering (no side effects). Used by SPAWN's soak and
// RESET's confirm gate so the operator sees EXACTLY what would be touched.
export function renderTeardownPlan(plan: TeardownPlan): string {
  const lines: string[] = [];
  // respawn-pane -k = reset-the-pane-IN-PLACE (kills its process tree, restarts the
  // shell, keeps the pane + its marker). NOT `kill-pane`, which DESTROYS the pane —
  // the wording matters because this line is what an operator reads before a destroy.
  lines.push(`teardown targets (respawn-pane -k, reset-in-place, per-pane only): ${plan.targets.length}`);
  for (const { window, pane } of plan.targets) {
    lines.push(
      `  ${pane.pane}  ${pane.session}:${pane.windowIndex} "${pane.windowName}" ` +
        `(${pane.currentCommand}, pid ${pane.panePid}) → ${window.agent} "${window.name}"`,
    );
  }
  if (plan.missing.length) {
    lines.push(`fresh launch (no managed pane present): ${plan.missing.length}`);
    for (const w of plan.missing) lines.push(`  + ${w.agent} "${w.name}"`);
  }
  if (plan.strayManaged.length) {
    lines.push(`STRAY managed panes (our marker, no spec window) — left untouched:`);
    for (const p of plan.strayManaged) {
      lines.push(`  ! ${p.pane} ${p.session}:${p.windowIndex} "${p.windowName}" (${p.currentCommand})`);
    }
  }
  return lines.join("\n");
}

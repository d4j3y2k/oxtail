// SYNC — converge a tmux session to its fleet spec (the THIRD lifecycle verb,
// alongside SPAWN/create-all and RESET/teardown-rebuild). The gentle one: it ADDs
// windows the spec gained, DELETEs windows the spec lost, and LEAVES healthy
// matching windows running untouched — so you can add a window to a live fleet, or
// drop one, without restarting the agents you're keeping.
//
// The partition is RESET's `computeTeardownPlan` re-labelled (same additive
// allowlist: only OUR fleetId-marked panes are ever candidates). The ONE semantic
// difference from RESET: a managed pane matching no spec window is RESET's
// `strayManaged` (surfaced, left alone) but SYNC's `remove` (DELETED — kill-window).
// That subtractive half is the whole point of "delete a window from a live fleet".

import type { PaneInfo } from "./ownership.js";
import { computeTeardownPlan } from "./teardown.js";
import type { FleetSpec, FleetWindowSpec } from "./types.js";

export interface SyncPlan {
  // spec windows with no managed pane yet → create the window + ensure_window (launch).
  add: FleetWindowSpec[];
  // spec windows WITH a managed pane → ensure_window (a healthy match is a NO-OP; a
  // dead/empty marked shell self-heals). Healthy agents are NOT restarted.
  keep: { window: FleetWindowSpec; pane: PaneInfo }[];
  // panes carrying OUR fleetId whose window is no longer in the spec → kill-window.
  remove: PaneInfo[];
  // panes NOT carrying our fleetId (unmanaged human splits / another fleet) → never
  // touched. Surfaced so the operator SEES the additive-allowlist guarantee.
  survivors: PaneInfo[];
}

// Pure, read-only, side-effect-free. `panes` is the session's panes (caller filters
// listPanesWithMarkers to the target session).
export function computeSyncPlan(spec: FleetSpec, fleetId: string, panes: PaneInfo[]): SyncPlan {
  const t = computeTeardownPlan(spec, fleetId, panes);
  return {
    add: t.missing, // spec windows with no managed pane
    keep: t.targets, // spec windows with a managed pane (ensure → no-op if healthy)
    remove: t.strayManaged, // OUR marker, no spec window → DELETE (RESET would leave these)
    survivors: panes.filter((p) => p.managedBy !== fleetId),
  };
}

// Human-readable converge preview (no side effects). The cockpit colors the DELETE
// section red and scales the confirm to risk: any `remove` → deliberate destructive
// confirm; purely-additive → a light confirm.
export function renderSyncPlan(spec: FleetSpec, fleetId: string, sessionName: string, plan: SyncPlan): string {
  const lines: string[] = [
    `SYNC (dry-run): converge tmux session "${sessionName}" → fleet "${spec.name}" [${fleetId}]`,
  ];
  if (plan.add.length) {
    lines.push(`  + ADD (no pane yet → fresh launch): ${plan.add.length}`);
    for (const w of plan.add) lines.push(`    + ${w.agent} "${w.name}"`);
  }
  if (plan.keep.length) {
    lines.push(`  ~ KEEP (healthy → left running, NOT restarted): ${plan.keep.length}`);
    for (const { window, pane } of plan.keep) {
      lines.push(`    ~ ${pane.pane} "${pane.windowName}" (${pane.currentCommand}) = ${window.agent} "${window.name}"`);
    }
  }
  if (plan.remove.length) {
    lines.push(`  - DELETE (ours, removed from the spec → kill-window): ${plan.remove.length}`);
    for (const p of plan.remove) {
      lines.push(`    - ${p.pane} ${p.session}:${p.windowIndex} "${p.windowName}" (${p.currentCommand}, pid ${p.panePid})`);
    }
  }
  if (plan.survivors.length) {
    lines.push(`  = UNTOUCHED (not ours — survive the sync): ${plan.survivors.length}`);
    for (const p of plan.survivors) {
      lines.push(`    = ${p.pane} ${p.session}:${p.windowIndex} "${p.windowName}" (${p.currentCommand})`);
    }
  }
  if (!plan.add.length && !plan.remove.length) {
    lines.push(`  (in sync — ${plan.keep.length} window(s) already match the spec; nothing to add or remove)`);
  }
  return lines.join("\n");
}

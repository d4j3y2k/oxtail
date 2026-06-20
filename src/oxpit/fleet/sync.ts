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

import { execFileSync } from "node:child_process";
import {
  ensureWindow as realEnsureWindow,
  type EnsureWindowDeps,
  type EnsureWindowResult,
} from "./ensure-window.js";
import { withFleetLock } from "./lock.js";
import {
  killManagedWindow,
  listPanesWithMarkers,
  markersInSession,
  type PaneInfo,
  type TmuxRun,
} from "./ownership.js";
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

function defaultRun(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
}

function sessionPanes(run: TmuxRun, sessionName: string): PaneInfo[] {
  return listPanesWithMarkers(run).filter((p) => p.session === sessionName);
}

// SYNC needs exactly one fleetId in the session. Mirrors reset's discoverFleetId but
// with SYNC-appropriate guidance: SYNC converges an EXISTING fleet — a new/unmanaged
// session is SPAWN's job (the cockpit routes new→SPAWN, existing-managed→SYNC).
function discoverFleetForSync(
  sessionName: string,
  run: TmuxRun,
): { ok: true; fleetId: string } | { ok: false; reason: string } {
  const ids = markersInSession(sessionName, run);
  if (ids.length === 0) {
    return {
      ok: false,
      reason: `no oxpit-managed fleet in session "${sessionName}" — SYNC converges an EXISTING fleet; use SPAWN to create one`,
    };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      reason: `session "${sessionName}" carries multiple fleetIds [${ids.join(", ")}] — refusing to guess which to sync`,
    };
  }
  return { ok: true, fleetId: ids[0] };
}

// Create a fresh window, return its pane id DIRECTLY (-P -F) — never resolve by
// session:windowName afterwards (a dup/human same-name window would be a targeting
// footgun). Mirrors reset.ts. Started in repoRoot so the launch is in scope.
function createWindow(run: TmuxRun, sessionName: string, name: string, repoRoot: string): string | null {
  try {
    const out = run(["new-window", "-t", sessionName, "-n", name, "-c", repoRoot, "-P", "-F", "#{pane_id}"]);
    const id = out.split("\n").find((l) => l.trim());
    return id ? id.trim() : null;
  } catch {
    return null;
  }
}

function abortedEnsure(window: string, reason: string): EnsureWindowResult {
  return { window, occupancy: "unknown", action: "aborted", ok: false, sessionId: null, reason };
}

export interface SyncOptions {
  dryRun?: boolean; // default TRUE — print the plan, mutate nothing
  run?: TmuxRun;
  fleetId?: string; // usually discovered from the session's markers
  // CONFIRM-FIDELITY: the pane-ids (remove) / window-names (add) the operator confirmed
  // from the dry-run preview. When set, the live run acts on ONLY their intersection
  // with its fresh-locked plan — so a window that became a DELETE target since the
  // preview is never killed UNSEEN. Unset (CLI direct) → act on the fresh plan.
  confirmedRemove?: string[];
  confirmedAdd?: string[];
  ensure?: typeof realEnsureWindow; // injectable for tests
  ensureDeps?: EnsureWindowDeps;
  kill?: (pane: string, expectedFleetId: string, run: TmuxRun) => ReturnType<typeof killManagedWindow>; // injectable for tests
  now?: () => number;
  log?: (msg: string) => void;
}

export interface SyncRemoval {
  pane: string;
  window: string;
  ok: boolean;
  reason?: string;
}

export interface SyncResult {
  fleetId: string | null;
  sessionName: string;
  dryRun: boolean;
  plan: SyncPlan | null;
  added: EnsureWindowResult[];
  kept: EnsureWindowResult[];
  removed: SyncRemoval[];
  survivors: PaneInfo[];
  // confirmed-but-not-acted: plan items that appeared since the preview and weren't in
  // the confirmed set — surfaced (NOT acted on) so a re-run can pick them up.
  unconfirmed?: { add: string[]; remove: string[] };
  ok: boolean;
  error?: string;
}

// Converge a session to its spec. DRY-RUN DEFAULT. Ordering is ADD → KEEP → DELETE:
// adding first means a removed window is never the session's last (so the kill's
// last-window guard only fires on a genuine "you emptied the spec"). KEEP runs
// ensure_window (no-op on a healthy match; self-heals a dead marked shell). DELETE is
// the destructive half — killManagedWindow's own guards (ownership / last-window /
// unmanaged-split) plus confirm-fidelity here are the safety net.
export async function syncFleet(
  spec: FleetSpec,
  repoRoot: string,
  sessionName: string,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const dryRun = opts.dryRun ?? true;
  const run = opts.run ?? defaultRun;
  const discover = () =>
    opts.fleetId ? ({ ok: true, fleetId: opts.fleetId } as const) : discoverFleetForSync(sessionName, run);
  const errResult = (dry: boolean, reason: string): SyncResult => ({
    fleetId: null,
    sessionName,
    dryRun: dry,
    plan: null,
    added: [],
    kept: [],
    removed: [],
    survivors: [],
    ok: false,
    error: reason,
  });

  // DRY-RUN preview: discover + plan OUTSIDE the lock (read-only, mutates nothing).
  if (dryRun) {
    const disc = discover();
    if (!disc.ok) return errResult(true, disc.reason);
    const plan = computeSyncPlan(spec, disc.fleetId, sessionPanes(run, sessionName));
    opts.log?.(renderSyncPlan(spec, disc.fleetId, sessionName, plan));
    return {
      fleetId: disc.fleetId,
      sessionName,
      dryRun: true,
      plan,
      added: [],
      kept: [],
      removed: [],
      survivors: plan.survivors,
      ok: true,
    };
  }

  // MUTATING path: acquire the lock FIRST, then discover + compute the plan INSIDE it
  // so the executed plan reflects the locked truth (mirrors resetFleet).
  const ensure = opts.ensure ?? realEnsureWindow;
  const kill = opts.kill ?? killManagedWindow;
  const ensureDeps = (): EnsureWindowDeps => ({ run, now: opts.now, log: opts.log, ...opts.ensureDeps });
  return withFleetLock(repoRoot, async () => {
    // ALWAYS live-discover the fleetId under the lock — never trust a cached/preview
    // fleetId as success (codex MEDIUM, mirrors resetFleet). When a preview fleetId was
    // supplied, REQUIRE the live one to still match, else abort: a session that became
    // another fleet / human-only since the preview must NOT be mutated.
    const live = discoverFleetForSync(sessionName, run);
    if (!live.ok) return errResult(false, live.reason);
    if (opts.fleetId && opts.fleetId !== live.fleetId) {
      return errResult(
        false,
        `fleet changed since the preview (now "${live.fleetId}", expected "${opts.fleetId}") — re-open the SYNC preview`,
      );
    }
    const fleetId = live.fleetId;
    let plan = computeSyncPlan(spec, fleetId, sessionPanes(run, sessionName));

    // CONFIRM-FIDELITY: act on ONLY the operator-confirmed add/remove sets ∩ the
    // fresh-locked plan; surface the appeared-since items so a re-run can pick them up.
    let unconfirmed: SyncResult["unconfirmed"];
    if (opts.confirmedRemove || opts.confirmedAdd) {
      unconfirmed = { add: [], remove: [] };
      if (opts.confirmedRemove) {
        const ok = new Set(opts.confirmedRemove);
        for (const p of plan.remove) if (!ok.has(p.pane)) unconfirmed.remove.push(p.pane);
        plan = { ...plan, remove: plan.remove.filter((p) => ok.has(p.pane)) };
      }
      if (opts.confirmedAdd) {
        const ok = new Set(opts.confirmedAdd);
        for (const w of plan.add) if (!ok.has(w.name)) unconfirmed.add.push(w.name);
        plan = { ...plan, add: plan.add.filter((w) => ok.has(w.name)) };
      }
    }

    const added: EnsureWindowResult[] = [];
    const kept: EnsureWindowResult[] = [];
    const removed: SyncRemoval[] = [];

    // ADD first (so a removed window is never the session's last). Sequential — the
    // readiness binding needs one launch at a time, like SPAWN.
    for (const window of plan.add) {
      const newPane = createWindow(run, sessionName, window.name, repoRoot);
      if (!newPane) {
        added.push(abortedEnsure(window.name, `could not create window ${sessionName}:${window.name}`));
        continue;
      }
      // sessionName forwarded so a remoteControl window's /rc registers under the REAL
      // session name, not the "<session>" placeholder (compile-sim HIGH; mirrors reset).
      added.push(await ensure({ target: newPane, window, fleetId, cwd: repoRoot, sessionName }, ensureDeps()));
    }
    // KEEP: ensure_window — a healthy match no-ops; a dead/empty marked shell relaunches.
    for (const { window, pane } of plan.keep) {
      kept.push(await ensure({ target: pane.pane, window, fleetId, cwd: repoRoot, sessionName }, ensureDeps()));
    }
    // DELETE last — but ONLY if every ADD + KEEP succeeded (codex MEDIUM): never tear
    // down a fleet member while a replacement is degraded (an ADD that failed to launch).
    // kill-window passes the live fleetId as the EXPECTED identity (codex HIGH) so a pane
    // re-marked since the plan is refused, not killed.
    const addKeepOk = added.every((a) => a.ok) && kept.every((k) => k.ok);
    // Re-probe live identity NOW — AFTER the ADD/KEEP awaits — and re-validate each
    // remove-target before its kill, mirroring resetFleet's teardownTarget (compile-sim
    // HIGH): the DELETE loop runs after seconds of launch round-trips, so an operator
    // rename during them could have turned a stray into a window the spec now WANTS. Kill
    // only if the pane STILL has the (session, windowName) that classified it a stray; a
    // drifted name (renamed-to-a-spec-window, a recycled pane-id, gone) is SKIPPED.
    const liveByPane = new Map(sessionPanes(run, sessionName).map((p) => [p.pane, p]));
    for (const p of plan.remove) {
      if (!addKeepOk) {
        removed.push({
          pane: p.pane,
          window: p.windowName,
          ok: false,
          reason: "skipped — an ADD or KEEP failed; not deleting while the fleet is degraded (fix the launch, then re-run)",
        });
        continue;
      }
      const live = liveByPane.get(p.pane);
      if (!live || live.windowName !== p.windowName || live.session !== p.session) {
        removed.push({
          pane: p.pane,
          window: p.windowName,
          ok: false,
          reason: `skipped — pane drifted since the plan (now ${live ? `${live.session}:"${live.windowName}"` : "gone"}, expected ${p.session}:"${p.windowName}") — not deleting a window that changed identity`,
        });
        continue;
      }
      const r = kill(p.pane, fleetId, run);
      removed.push(
        r.ok ? { pane: p.pane, window: p.windowName, ok: true } : { pane: p.pane, window: p.windowName, ok: false, reason: r.reason },
      );
    }

    const ok = added.every((a) => a.ok) && kept.every((k) => k.ok) && removed.every((r) => r.ok);
    return { fleetId, sessionName, dryRun: false, plan, added, kept, removed, survivors: plan.survivors, unconfirmed, ok };
  });
}

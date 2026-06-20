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
import { listPanesWithMarkers, markersInSession, type PaneInfo, type TmuxRun } from "./ownership.js";
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
  // CONFIRM-FIDELITY (max): the pane-ids / window-names the operator CONFIRMED from
  // the dry-run preview. When set, the live mutating run acts on ONLY the
  // intersection with its fresh-locked plan — so a pane that appeared AFTER the
  // confirm is never torn down UNSEEN. Unset (CLI direct) → act on the fresh plan.
  confirmedTargets?: string[]; // pane-ids confirmed for teardown
  confirmedMissing?: string[]; // window-names confirmed for fresh launch
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
  // The session's NON-fleet panes (unmarked human splits / foreign-marked) — never
  // touched. Surfaced so the operator SEES the additive-allowlist guarantee, not
  // just the panes that die (max).
  survivors: PaneInfo[];
  teardowns: TeardownResult[];
  relaunches: EnsureWindowResult[];
  // Fresh-locked-plan items the operator did NOT confirm (appeared since the
  // preview) — NOT acted on, surfaced so a re-run can pick them up (confirm-fidelity).
  unconfirmed?: { targets: string[]; missing: string[] };
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
  survivors: PaneInfo[] = [],
): string {
  const lines = [
    `RESET (dry-run): fleet "${spec.name}" in tmux session "${sessionName}" [${fleetId}]`,
    `  teardown = per-pane respawn-pane -k (NEVER kill-session) → ensure_window relaunch`,
    ...renderTeardownPlan(plan)
      .split("\n")
      .map((l) => `  ${l}`),
  ];
  // Show the FULL partition — what dies AND what survives — so the additive-allowlist
  // guarantee is something the operator SEES before the trigger, and a "why is my
  // editor in this session" surprise surfaces here, not after (max).
  if (survivors.length) {
    lines.push(`  UNTOUCHED (not ours — survive the reset): ${survivors.length}`);
    for (const p of survivors) {
      lines.push(`    = ${p.pane} ${p.session}:${p.windowIndex} "${p.windowName}" (${p.currentCommand})`);
    }
  }
  return lines.join("\n");
}

// Reset ONE target pane to a clean shell. The DESTRUCTIVE primitive, gated by an
// IMMEDIATE live re-probe of the FULL spec-target identity (codex P6): the pane must
// still EXIST, still carry OUR fleetId marker, still be in the intended SESSION, and
// still bear the spec WINDOW NAME. Marker alone is not the allowlist — "matches a
// spec window" is the other half, so an operator rename/move between plan and
// mutation must SKIP, not relaunch-on-top. Targets by PANE ID (the stable identity
// once mutation begins). respawn-pane -k -c repoRoot restarts the pane's original
// (default-shell) command, PRESERVING the marker (live-verified).
function teardownTarget(
  run: TmuxRun,
  paneId: string,
  expect: { session: string; windowName: string; fleetId: string },
  repoRoot: string,
): TeardownResult {
  const live = listPanesWithMarkers(run).find((p) => p.pane === paneId);
  if (!live) {
    return { pane: paneId, window: expect.windowName, ok: false, action: "skipped", reason: `TOCTOU: pane ${paneId} is gone — left untouched` };
  }
  if (live.managedBy !== expect.fleetId || live.session !== expect.session || live.windowName !== expect.windowName) {
    return {
      pane: paneId,
      window: expect.windowName,
      ok: false,
      action: "skipped",
      reason:
        `TOCTOU: pane drifted since the plan (now ${live.session}:"${live.windowName}" marker ` +
        `${live.managedBy ? `"${live.managedBy}"` : "none"}; expected ${expect.session}:"${expect.windowName}" ${expect.fleetId}) — left untouched`,
    };
  }
  try {
    run(["respawn-pane", "-k", "-c", repoRoot, "-t", paneId]);
    return { pane: paneId, window: expect.windowName, ok: true, action: "reset" };
  } catch (e) {
    return { pane: paneId, window: expect.windowName, ok: false, action: "skipped", reason: `respawn-pane failed: ${String(e)}` };
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
  const discover = () =>
    opts.fleetId ? ({ ok: true, fleetId: opts.fleetId } as const) : discoverFleetId(sessionName, run);
  const errResult = (dry: boolean, reason: string): ResetResult => ({
    fleetId: null, sessionName, dryRun: dry, plan: null, survivors: [], teardowns: [], relaunches: [], ok: false, error: reason,
  });
  // The session panes NOT carrying our fleetId — unmarked human splits + foreign —
  // are NEVER touched; surfaced so the operator sees the survivors, not just the dead.
  const survivorsOf = (panes: PaneInfo[], fleetId: string) => panes.filter((p) => p.managedBy !== fleetId);

  // DRY-RUN preview: discover + plan + survivors OUTSIDE the lock (read-only).
  if (dryRun) {
    const disc = discover();
    if (!disc.ok) return errResult(true, disc.reason);
    const panes = sessionPanes(run, sessionName);
    const plan = computeTeardownPlan(spec, disc.fleetId, panes);
    const survivors = survivorsOf(panes, disc.fleetId);
    opts.log?.(renderResetPlan(spec, disc.fleetId, sessionName, plan, survivors));
    return { fleetId: disc.fleetId, sessionName, dryRun: true, plan, survivors, teardowns: [], relaunches: [], ok: true };
  }

  // MUTATING path: acquire the lock FIRST, THEN discover + compute the plan INSIDE
  // it. A plan computed BEFORE the lock goes STALE while a concurrent RESET mutates
  // — e.g. both see `max` missing → the second creates a DUPLICATE window, or it
  // re-respawns a freshly-relaunched pane (codex P6). The lock must cover planning,
  // not just mutation.
  const ensure = opts.ensure ?? realEnsureWindow;
  const ensureDeps = (): EnsureWindowDeps => ({ run, now: opts.now, log: opts.log, ...opts.ensureDeps });
  return withFleetLock(repoRoot, async () => {
    // ALWAYS live-discover under the lock — never trust a cached/preview fleetId as
    // discovery success (codex P6): a session that went human-only / unowned since the
    // preview must behave like "nothing to RESET", NOT get our windows injected via
    // confirmedMissing. When a fleetId was provided (from the preview), REQUIRE the live
    // one to still match — confirm-fidelity for the fleet IDENTITY, not just its panes.
    const disc = discoverFleetId(sessionName, run);
    if (!disc.ok) return errResult(false, disc.reason);
    if (opts.fleetId && disc.fleetId !== opts.fleetId) {
      return errResult(
        false,
        `fleet changed since the preview (now "${disc.fleetId}", expected "${opts.fleetId}") — re-open the RESET preview`,
      );
    }
    const fleetId = disc.fleetId;
    const panes = sessionPanes(run, sessionName);
    let plan = computeTeardownPlan(spec, fleetId, panes);
    const survivors = survivorsOf(panes, fleetId);

    // CONFIRM-FIDELITY (max): when the menu passes the confirmed preview's pane-ids /
    // window-names, act on ONLY their intersection with the fresh-locked plan — so a
    // pane that appeared AFTER the confirm is never torn down UNSEEN. Surface the
    // appeared-but-unconfirmed items so a re-run can pick them up.
    let unconfirmed: ResetResult["unconfirmed"];
    if (opts.confirmedTargets || opts.confirmedMissing) {
      unconfirmed = { targets: [], missing: [] };
      if (opts.confirmedTargets) {
        const ok = new Set(opts.confirmedTargets);
        for (const t of plan.targets) if (!ok.has(t.pane.pane)) unconfirmed.targets.push(t.pane.pane);
        plan = { ...plan, targets: plan.targets.filter((t) => ok.has(t.pane.pane)) };
      }
      if (opts.confirmedMissing) {
        const ok = new Set(opts.confirmedMissing);
        for (const w of plan.missing) if (!ok.has(w.name)) unconfirmed.missing.push(w.name);
        plan = { ...plan, missing: plan.missing.filter((w) => ok.has(w.name)) };
      }
    }

    // PHASE 1 — QUIESCE: respawn-k EVERY target straight through (no relaunch yet,
    // so no old/new coexistence), each preceded by its live spec-target re-check. No
    // readiness binding here, so order/parallelism is irrelevant — do them all.
    const teardowns: TeardownResult[] = plan.targets.map(({ window, pane }) =>
      teardownTarget(run, pane.pane, { session: sessionName, windowName: window.name, fleetId }, repoRoot),
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
      relaunches.push(await ensure({ target: pane.pane, window, fleetId, cwd: repoRoot, sessionName }, ensureDeps()));
    }
    for (const window of plan.missing) {
      const newPane = createWindow(run, sessionName, window.name, repoRoot);
      if (!newPane) {
        relaunches.push(abortedRelaunch(window.name, `could not create window ${sessionName}:${window.name}`));
        continue;
      }
      relaunches.push(await ensure({ target: newPane, window, fleetId, cwd: repoRoot, sessionName }, ensureDeps()));
    }

    const ok = teardowns.every((t) => t.ok) && relaunches.every((r) => r.ok);
    return { fleetId, sessionName, dryRun: false, plan, survivors, teardowns, relaunches, unconfirmed, ok };
  });
}

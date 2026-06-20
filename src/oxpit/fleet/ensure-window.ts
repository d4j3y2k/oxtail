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
import { realpathSync } from "node:fs";
import { capturePane, fireKeystrokes, waitForPaneLine } from "../../keystrokes.js";
import {
  currentPaneForServerPid,
  processStartSig,
  readAllPassive,
  type RegistryEntry,
} from "../../registry.js";
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
import type { AgentKind, FleetWindowSpec, WindowOccupancy } from "./types.js";

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
//
// A2 (max, must-fix before P5 live SPAWN / RESET-P6): the shell check is BEFORE
// the marker, so a MARKED pane that transiently reads as a shell classifies as
// empty-shell → relaunch. That is CORRECT for a crashed-to-shell agent (we want
// to relaunch) but WRONG for a live agent momentarily foregrounding a shell-named
// child (we'd launch on top). It is not reachable on the P2 SPAWN path — fresh
// windows are unmarked, and a running claude/codex keeps the tty foreground so
// the command reads as a version-string/node, never a shell (matches the spike).
// But this is the reusable crux RESET runs over LIVE fleets: before then, the
// marked+shell case must consult pane-subtree liveness (currentPaneForServerPid/
// ancestry) — live agent ⇒ healthy-right-type, absent ⇒ empty-shell.
//
// marker semantics (max Q1): a marker means "this pane is OURS / occupied by what
// we spawned", NOT that the byte-identical model/effort is running (those are
// in-TUI and not re-verified — config changes go through RESET/--force). An
// operator hand-swap within the same pane keeps the marker (pane option), so we
// NO-OP — safe, by design.
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

function realpathish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// NOTE: claimCheck is intentionally pane-bound (isClaimPaneBound below), not a
// bare sid-presence scan — a coincidental same-cwd peer or a dead/passive entry
// can carry the same sid while pointing at a different pane (codex BLOCK #2).

export interface ClaimBindDeps {
  readAll?: () => RegistryEntry[];
  resolvePane?: (serverPid: number) => string | null;
  resolveSig?: (pid: number) => string;
}

// Is `sessionId` addressable AS the agent we just launched INTO `target`? Bare
// sid presence is not enough (codex P2 BLOCK #2): a coincidental same-cwd peer,
// or a dead/passive entry from readAllPassive(), can carry the same sid while
// pointing at a DIFFERENT pane. So we require a registry entry that (1) is the
// right client type, (2) records the same cwd (MANDATORY — a malformed entry
// with no cwd fails closed), (3) passes a pid-reuse guard, AND (4) whose live
// server_pid currently resolves (process-tree) to OUR launched pane.
//
// (3) closes codex's round-2 residual: currentPaneForServerPid proves a LIVE
// process with this pid sits under target, but NOT that the (possibly stale,
// passive) registry file still belongs to it. If that pid was recycled by an
// unrelated process that happens to live in our pane before the real MCP child
// rewrites <pid>.json, a dead entry would otherwise pass. The recorded proc_sig
// won't match the recycled process's live start-time sig — reject. Same defense
// as chooseVerifiedWakePane: only a POSITIVELY-different sig refuses; a transient
// empty ps reading falls through to the pane check.
export function isClaimPaneBound(
  sessionId: string,
  opts: { target: string; agent: AgentKind; cwd: string },
  deps: ClaimBindDeps = {},
): boolean {
  const readAll = deps.readAll ?? readAllPassive;
  const resolvePane = deps.resolvePane ?? currentPaneForServerPid;
  const resolveSig = deps.resolveSig ?? processStartSig;
  const wantType = clientTypeFor(opts.agent);
  let entries: RegistryEntry[];
  try {
    entries = readAll();
  } catch {
    return false;
  }
  const cwd = realpathish(opts.cwd);
  for (const e of entries) {
    if (e.client.session_id !== sessionId) continue;
    if (e.client.type !== wantType) continue;
    if (!e.client.cwd || realpathish(e.client.cwd) !== cwd) continue;
    if (e.proc_sig) {
      const liveSig = resolveSig(e.server_pid);
      if (liveSig && liveSig !== e.proc_sig) continue; // pid recycled — not our process
    }
    if (resolvePane(e.server_pid) === opts.target) return true;
  }
  return false;
}

function napMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

// Poll isClaimPaneBound until it holds or the budget elapses — registry adoption
// (the hook reading the SessionStart drop, or the cooperative Codex join) lands
// a beat after readiness, so a single shot would false-fail.
async function pollClaimPaneBound(
  sessionId: string,
  opts: { target: string; agent: AgentKind; cwd: string },
  budgetMs: number,
  now: () => number,
): Promise<boolean> {
  const start = now();
  for (;;) {
    if (isClaimPaneBound(sessionId, opts)) return true;
    if (now() - start >= budgetMs) return false;
    await napMs(300);
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
  claimTimeoutMs?: number;
  // Seams (all overridable in tests so the dispatch is exercised without tmux):
  probe?: (pane: string) => OccupancyProbe | null;
  launch?: (recipe: Recipe, ctx: LaunchCtx) => Promise<RecipeResult>;
  mark?: (pane: string, fleetId: string) => void;
  claimResolver?: (sessionId: string) => boolean | Promise<boolean>;
  capture?: (pane: string) => string;
  log?: (msg: string) => void;
}

// How long claimCheck waits for registry adoption before failing. Generous for
// the Codex cooperative-join round-trip (P3); Claude's hook adoption is faster.
const DEFAULT_CLAIM_TIMEOUT_MS = 10_000;

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
async function defaultLaunch(
  recipe: Recipe,
  ctx: LaunchCtx,
  deps: EnsureWindowDeps,
): Promise<RecipeResult> {
  const { target, window, cwd } = ctx;
  const run = deps.run ?? defaultRun;
  const home = deps.home ?? homedir();
  const now = deps.now ?? (() => Date.now());
  const clientType = clientTypeFor(window.agent);
  const claimTimeoutMs = deps.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS;
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
    // POLL for pane-bound adoption — registry adoption (Claude's hook reading the
    // SessionStart drop on a separate detection pass; Codex's cooperative join in
    // P3) lands LATER than waitExternal (which returns the instant the artifact
    // appears, the earliest signal). A single shot would false-abort a launch
    // that actually succeeded (max A1 + codex BLOCK #2).
    claimCheck: (sid) =>
      deps.claimResolver
        ? deps.claimResolver(sid)
        : pollClaimPaneBound(sid, { target, agent: window.agent, cwd }, claimTimeoutMs, now),
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
    // half-up is UNREACHABLE here in P2: classifyOccupancy emits only
    // unknown/empty-shell/healthy-right-type/wrong-type — a half-up agent is
    // never marked, so it collapses into wrong-type (correct). Real half-up
    // detection needs the pane classifier and lands with RESET/P6 teardown.
    case "wrong-type":
    case "half-up":
      return {
        ...head,
        action: "aborted",
        ok: false,
        reason:
          `window occupied by an unmanaged, non-shell process (${probe?.currentCommand ?? "?"}) — ` +
          `not ours to relaunch on top of. If this is a PARTIAL launch of ours that failed ` +
          `(left an unmarked agent), clear the pane (Ctrl-C / exit to a shell) and re-run; ` +
          `otherwise use RESET/--force (P6) to reconfigure.`,
      };
    case "empty-shell": {
      const recipe = buildRecipe(window);
      const launch = deps.launch ?? ((r, ctx) => defaultLaunch(r, ctx, deps));
      const res = await launch(recipe, { target, window, cwd });
      if (res.ok) {
        // Mark AFTER the launch is confirmed (marking before would make a stuck
        // half-up agent classify healthy → NO-OP). Guard the write: markPaneManaged
        // shells out and throws on a nonzero tmux exit — a throw here would mask a
        // SUCCESSFUL launch as a failure and strand the pane (max A3). On mark
        // failure the agent is up + addressable but UNMANAGED (P6 teardown won't
        // reclaim it) — surface that distinctly rather than abort.
        try {
          (deps.mark ?? ((p, f) => markPaneManaged(p, f, deps.run)))(target, fleetId);
        } catch (e) {
          deps.log?.(`[ensure ${window.name}] launched but mark failed: ${String(e)}`);
          return {
            ...head,
            action: "launched",
            ok: true,
            sessionId: res.sessionId,
            reason: `launched session ${res.sessionId} but FAILED to set the ownership marker — ` +
              `pane is live + addressable but UNMANAGED (RESET/P6 teardown will not reclaim it). ` +
              `Re-mark manually or RESET.`,
          };
        }
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

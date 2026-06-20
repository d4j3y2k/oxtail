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
// the agent we put there (its model/effort were set by launch-time argv flags
// and are intentionally NOT re-verified by the probe — config changes go through
// RESET/--force); a non-shell pane we did not mark is never ours to relaunch on
// top of.
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
  buildRcCommand,
  buildRecipe,
  buildSelfJoinInstruction,
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
  pane: string;
  currentCommand: string;
  panePid: number;
  managedBy: string | null;
};

// Is a LIVE oxtail-registered agent currently hosted under `pane`? Used to
// disambiguate the marked+shell case below. A dead agent's server_pid no longer
// resolves to any pane (currentPaneForServerPid walks live ps+tmux), so only a
// genuinely-live agent in this pane matches. Injectable for tests.
export function isAgentLiveInPane(
  pane: string,
  deps: { readAll?: () => RegistryEntry[]; resolvePane?: (serverPid: number) => string | null } = {},
): boolean {
  const readAll = deps.readAll ?? readAllPassive;
  const resolvePane = deps.resolvePane ?? currentPaneForServerPid;
  try {
    return readAll().some((e) => resolvePane(e.server_pid) === pane);
  } catch {
    return false;
  }
}

// PURE level-probe classifier. See the file header for why type comes from the
// marker, not pane_current_command.
//
// A2 (max): the marked+shell case is ambiguous from one sample — a crashed-to-
// shell agent (relaunch) vs a live agent transiently foregrounding a shell-named
// child (NO-OP). Resolve it with `agentLiveInPane` (pane-subtree liveness via the
// registry): a live agent ⇒ healthy-right-type, none ⇒ empty-shell. Without the
// predicate (pure default) marked+shell is treated as empty-shell, which is safe
// on the SPAWN path (fresh windows are unmarked) but ensureWindow ALWAYS supplies
// the predicate so the live-fleet RESET path is correct.
//
// marker semantics (max Q1): a marker means "this pane is OURS / occupied by what
// we spawned", NOT that the byte-identical model/effort is running (those are
// launch-time argv flags, not re-verified by the probe — config changes go
// through RESET/--force). An
// operator hand-swap within the same pane keeps the marker (pane option), so we
// NO-OP — safe, by design.
export function classifyOccupancy(
  probe: OccupancyProbe | null,
  fleetId: string,
  agentLiveInPane?: () => boolean,
): WindowOccupancy {
  if (!probe || !Number.isFinite(probe.panePid) || probe.panePid <= 0) return "unknown";
  if (isShellCommand(probe.currentCommand)) {
    if (probe.managedBy === fleetId && agentLiveInPane?.()) return "healthy-right-type";
    return "empty-shell";
  }
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
  // Codex self-join tuning (selfJoinClaim). settle = how long to wait before firing
  // when the classifier hasn't confirmed tui-ready (version-robust fallback);
  // maxSends = bounded re-sends if a keystroke missed; rolloutBudget = per-send wait
  // for the join-created rollout to appear.
  selfJoinSettleMs?: number;
  selfJoinMaxSends?: number;
  selfJoinRolloutBudgetMs?: number;
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

// The Codex self-join bring-up (selfJoinClaim effect). For a lazy-artifact client
// readiness is STIMULUS→PROOF, not a passive watch: the join turn is what both runs
// the claim AND creates the rollout we bind the id from. So this:
//   1. waits until the pane is acceptable to type into — the classifier is an
//      ACCELERATOR (tui-ready → fire immediately); otherwise it fires after a short
//      SETTLE (so a stale/broken classifier just costs a wait, never an abort — max);
//      busy → keep waiting (don't interleave a keystroke into a mid-turn Codex);
//      blocked-interstitial (trust/login) → abort loudly (retrying won't clear it),
//   2. fires the self-resolve join (echo $CODEX_THREAD_ID + claim_session),
//   3. polls for the rollout that the turn creates, bound to THIS pane — the
//      proof-of-accept (max's PROOF-1; claimCheck downstream is PROOF-2),
//   4. bounded RE-SEND if no rollout (the keystroke may have missed) — claim_session
//      is idempotent, so a double-send is harmless.
// classifyPaneReadiness runs against an injected capture() so the loop is unit-
// testable against canned pane buffers without real tmux.
//
// RESIDUAL version-coupling (max): tui-ready is a mere accelerator, but "busy"
// ("esc to interrupt") is still load-bearing — it's the guard that keeps a re-send
// from interleaving into a mid-turn Codex. It fails CLOSED: a busy FALSE-positive
// (a future re-skin whose indicator we misread as busy) would wait out readyWaitMs
// and abort+dump — never a keystroke-interleave; a busy false-negative self-corrects
// (the happy path is idle-on-send-1, and rollout-proof gates success). Far narrower
// than the old whole-gate string coupling. Watch-item: a busy-string fixture if the
// Codex chrome changes.
export interface CodexSelfJoinDeps {
  capture: () => string;
  fire: () => Promise<void>;
  bindRollout: (
    timeoutMs: number,
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  settleMs?: number;
  maxSends?: number;
  rolloutBudgetMs?: number;
  readyWaitMs?: number;
  pollMs?: number;
  log?: (m: string) => void;
}

export async function codexSelfJoin(
  d: CodexSelfJoinDeps,
): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string; dump?: string }> {
  const settleMs = d.settleMs ?? 2_000;
  const maxSends = d.maxSends ?? 3;
  const rolloutBudgetMs = d.rolloutBudgetMs ?? 15_000;
  const readyWaitMs = d.readyWaitMs ?? 30_000;
  const pollMs = d.pollMs ?? 400;
  const log = (m: string) => d.log?.(m);

  for (let send = 1; send <= maxSends; send++) {
    // Gate: wait for the pane to be acceptable to type into.
    const gateStart = d.now();
    for (;;) {
      const c = classifyPaneReadiness(d.capture(), "codex");
      if (c.readiness === "blocked-interstitial") {
        return {
          ok: false,
          reason: `Codex blocked on a startup prompt (${c.reason ?? "?"}) — cannot self-join`,
          dump: d.capture(),
        };
      }
      const elapsed = d.now() - gateStart;
      if (c.readiness === "tui-ready") {
        log(`codex ready (accelerated) — firing self-join (send ${send}/${maxSends})`);
        break;
      }
      // Version-robust fallback: once the settle has elapsed and the pane isn't busy,
      // fire even on unknown/shell-ready — a missed/early send self-corrects via the
      // rollout-proof + re-send below; a stale classifier never aborts the launch.
      if (c.readiness !== "busy" && elapsed >= settleMs) {
        log(`codex settle elapsed ("${c.readiness}") — firing self-join (send ${send}/${maxSends})`);
        break;
      }
      if (elapsed >= readyWaitMs) {
        return {
          ok: false,
          reason: `Codex never became ready to accept input within ${readyWaitMs}ms (stuck "${c.readiness}")`,
          dump: d.capture(),
        };
      }
      await d.sleep(pollMs);
    }

    await d.fire();
    const r = await d.bindRollout(rolloutBudgetMs);
    if (r.ok) {
      log(`codex self-join bound session ${r.sessionId} (proof-of-accept: rollout)`);
      return { ok: true, sessionId: r.sessionId };
    }
    log(`no rollout after send ${send}/${maxSends} (${r.reason}) — ${send < maxSends ? "re-sending" : "giving up"}`);
  }
  return {
    ok: false,
    reason: `Codex self-join produced no rollout after ${maxSends} sends — the agent did not accept the join turn`,
    dump: d.capture(),
  };
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
    // Codex-only self-join bring-up (Claude recipes never reach it). The join turn
    // creates the rollout we bind the id from; classifier accelerates but never gates
    // (artifact-proof + bounded re-send is the robustness). Confirmation truth is the
    // registry (claimCheck below), never pane text.
    selfJoinClaim: () =>
      codexSelfJoin({
        capture: () => capturePane(target),
        fire: () => fireKeystrokes(target, clientType, buildSelfJoinInstruction()),
        bindRollout: async (timeoutMs) => {
          const r = await awaitLaunchArtifact("codex", {
            launchedPane: target,
            cwd,
            baseline,
            launchInstantMs,
            base: home,
            timeoutMs,
          });
          return r.ok ? { ok: true, sessionId: r.sessionId } : { ok: false, reason: r.reason };
        },
        now,
        sleep: napMs,
        settleMs: deps.selfJoinSettleMs,
        maxSends: deps.selfJoinMaxSends,
        // Its OWN budget (codexSelfJoin default 15s), NOT readinessTimeoutMs (max): a
        // join-created rollout lands ~1-3s after submit, so 15s is comfortable margin
        // AND re-sends a genuine miss promptly — inheriting Claude's ~45s drop-wait
        // would just stall the re-send. Bigger is interleave-safe but needlessly slow.
        rolloutBudgetMs: deps.selfJoinRolloutBudgetMs,
        log: deps.log,
      }),
    // POLL for pane-bound adoption — registry adoption (Claude's hook reading the
    // SessionStart drop on a separate detection pass; Codex's cooperative join)
    // lands LATER than waitExternal (which returns the instant the artifact
    // appears, the earliest signal). A single shot would false-abort a launch
    // that actually succeeded (max A1 + codex BLOCK #2).
    claimCheck: (sid) =>
      deps.claimResolver
        ? deps.claimResolver(sid)
        : pollClaimPaneBound(sid, { target, agent: window.agent, cwd }, claimTimeoutMs, now),
    // Claude-only remote control (/rc) — type it into the now-ready TUI. The rcSession
    // is baked into the step by buildRecipe; best-effort per executeRecipe (a good
    // launch never fails on this).
    remoteControl: (rcSession) => fireKeystrokes(target, clientType, buildRcCommand(rcSession)),
    log: deps.log,
  };
  return executeRecipe(recipe, effects);
}

// Bring one window to a ready agent. Probe → classify → dispatch. On a launch
// failure, the pane buffer is dumped into the result for a loud abort.
export async function ensureWindow(
  // sessionName is the tmux session — needed to bake the remote-control name
  // (<session>-<window>) into the recipe. SPAWN/RESET always pass it.
  opts: { target: string; window: FleetWindowSpec; fleetId: string; cwd: string; sessionName?: string },
  deps: EnsureWindowDeps = {},
): Promise<EnsureWindowResult> {
  const { target, window, fleetId, cwd } = opts;
  const probe = (deps.probe ?? ((p) => probePaneInfo(p, deps.run)))(target);
  // Resolve the marked+shell ambiguity against live pane-subtree state (A2).
  const occupancy = classifyOccupancy(
    probe,
    fleetId,
    probe ? () => isAgentLiveInPane(probe.pane) : undefined,
  );
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
      const recipe = buildRecipe(window, { sessionName: opts.sessionName });
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

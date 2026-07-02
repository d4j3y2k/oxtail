// oxpit status engine — the passive, read-only data layer behind `oxtail status`
// and the `oxtail oxpit` TUI.
//
// DESIGN (consensus, main+max+codex):
//   - DON'T FORK TRUTH. oxpit is a VIEW. It consumes the SAME modules the hooks
//     and MCP tools use — registry.readAll / processStartSig, received.count-
//     OpenObligations, mailbox.parseMailboxRecords, the pending-ask store — so it
//     can never silently drift from the real semantics. No reimplemented parsing.
//   - PURE READER. Never drain a mailbox (drain truncates → would steal a peer's
//     mail), never take the owner-token lock (would contend with hook writers).
//     Reads are lock-free and tolerate a torn last JSONL line; mailbox dedup is by
//     message_id (a migrate-crash can leave the same id in two boxes).
//   - INFER-FIRST IS AUTHORITY. Liveness/work/waiting come from observed facts
//     (transcript mtime, proc_sig, obligation ledger, pending-ask registry).
//     state.purpose is a self-reported CAPTION only — surfaced, but cross-checked
//     against transcript mtime and never allowed to override observed facts (a
//     crashed agent's "busy" caption lies forever; the cold transcript does not).
//   - GLYPH + BADGE-SET, not one enum. An agent is simultaneously e.g. idle AND
//     open-work(2) AND waiting→codex. One liveness value + N independent badges.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientType } from "../clients.js";
import {
  isAlive,
  processStartSig,
  readAllPassive,
  resolveJumpablePids,
  sessionPidsForId,
  type RegistryEntry,
} from "../registry.js";
import {
  mailboxFilePath,
  mailboxSessionKey,
  parseMailboxRecords,
  type BoxId,
} from "../mailbox.js";
import {
  countOpenObligations,
  listLedgerReplyTargets,
  listLedgerRequestPairs,
} from "../received.js";
import { defaultPendingAskDir, listLivePendingAsks } from "../pending-ask.js";
import { inferProjectRoot, pathBelongsToProjectScope, safeRealpath } from "../scope.js";
import { panePresence, type PaneInfo } from "./jump.js";
import { agentKey, scanLatestTool, type AgentActivity } from "./activity.js";

function envPosInt(name: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

// Transcript mtime within this window ⇒ "active" (mid-turn output). Generous
// enough to ride out a long bash tool call without flapping to idle, tight enough
// that a finished agent reads idle within ~one window. Tunable; raw age is always
// shown alongside so the glyph is never the only signal (no binary-🟢 overpromise).
export const ACTIVE_WINDOW_S = envPosInt("OXTAIL_OXPIT_ACTIVE_S", 20);

// Clock-skew tolerance. A transcript mtime or pane time slightly in the future
// (sub-second jitter) is normal; beyond this it's real skew (NFS / container clock /
// NTP step-back). See ageOrSkew — a future timestamp must read as UNKNOWN, not age 0,
// or a long-stale agent would paint a false "active 🟢" (and suppress its ⚠stalled?).
const SKEW_TOLERANCE_S = 2;

// Seconds since `thenSec`, or null when `thenSec` is in the future beyond the skew
// tolerance. null = "freshness unknown": liveness then falls through to the other
// signals (it won't be classed active off a skewed timestamp), and the possibly-
// stalled check (which requires a non-null age) is skipped.
function ageOrSkew(nowSec: number, thenSec: number): number | null {
  const deltaS = nowSec - thenSec;
  if (deltaS < -SKEW_TOLERANCE_S) return null;
  return Math.max(0, deltaS);
}

// Caption-staleness gap: if the purpose was set this many seconds BEFORE the last
// transcript activity, the agent has done work since declaring it — gray the
// caption (it may be outdated). max's divergence-as-signal idea.
export const CAPTION_STALE_GAP_S = envPosInt("OXTAIL_OXPIT_CAPTION_STALE_S", 120);

// "Possibly stalled": declared a purpose but the transcript has been cold at least
// this long with no output since — said-busy + cold-transcript = MAYBE hung. Sized
// well above normal idle gaps (10 min) so a healthy agent waiting on the human
// isn't slandered as hung (max M1); shown as a soft hint, never a hard claim.
export const STALL_WINDOW_S = envPosInt("OXTAIL_OXPIT_STALL_S", 600);

// Separator for the (request_id, session_id) ledger-correlation key. A source-
// level escape, NOT a raw byte: a literal NUL in the .ts would make the file
// binary to grep/diff and invisible to review (compile-sim caught exactly that).
// A space is collision-safe: neither a hex request_id nor a UUID contains one.
const LEDGER_KEY_SEP = " ";

export type Liveness = "active" | "idle" | "dead";

export type LivenessReason =
  | "transcript_fresh"
  | "pane_fresh" // pane repainted within the active window (producing output / spinner)
  | "tool_running" // a tool call is in-flight while transcript & pane are otherwise quiet
  | "idle"
  | "no_transcript"
  | "exited" // server_pid no longer alive (clean exit / crash, not yet reaped)
  | "pid_reused"; // pid alive but proc_sig differs ⇒ recycled to another process

// Per-signal honesty: a count we fully read is "high"; if any box/ledger read was
// degraded (torn/contended/unreadable) we down-rank to "low" so the operator
// knows the number may undercount. Mirrors the "honest uncertainty" guardrail.
export type Confidence = "high" | "low";

export type WaitEdge = {
  // The peer this agent is blocked on (resolved by correlating the pending-ask
  // request_id against peers' received-ledgers). null = a live pending-ask exists
  // but we could not correlate its target (e.g. the target fully exited and was
  // reaped from the registry, so its ledger is no longer scannable).
  target_session_id: string | null;
  target_short_id: string | null;
  age_s: number;
  // target resolved to an agent that is itself ⚫dead — a wait that can never be
  // answered (max's "orphaned wait").
  orphaned: boolean;
  // part of a wait cycle (main→codex→main).
  in_cycle: boolean;
  // the cycle this edge belongs to has all members alive ⇒ a credible LIVE
  // deadlock; false ⇒ stale/possible cycle (don't render a hard DEADLOCK).
  cycle_all_live: boolean;
  // How many times the waiter's own server has RE-POKED the target (waiter-heal,
  // v0.32). 0 = a normal parked wait; >0 = the waiter has been actively nudging a
  // silent peer, so the operator sees this wait is being worked, not just aging.
  repoke_attempts: number;
};

export type FleetAgent = {
  session_id: string | null;
  short_id: string; // session_id[0..8] or "pid:<n>" when unclaimed
  // The agent's tmux window name (resolved from its pane), used as the human-facing
  // label when present. null when not in tmux / pane unresolved. Display only —
  // identity stays short_id/session_id.
  window_name: string | null;
  client_type: ClientType;
  server_pid: number;
  cwd: string;
  is_self: boolean;

  // Liveness (one glyph). Authority = transcript mtime + proc_sig.
  liveness: Liveness;
  liveness_reason: LivenessReason;
  transcript_age_s: number | null; // null = no transcript file resolved/found
  proc_sig: "ok" | "reused" | "unknown";
  // Seconds since the agent's tmux pane last produced OUTPUT (pty activity). DISPLAY
  // ONLY — it does NOT drive liveness. A repaint timestamp can't tell working from
  // idle: a docked window's dock pane repaints every second (bumping window-scoped
  // window_activity), and an idle client TUI keeps ticking its "Worked for Ns"
  // counter/spinner — both make this age perpetually ~0 even when the agent is idle.
  // pane_fresh is instead gated on a CONTENT signal (pane_busy — "esc to interrupt",
  // captured), so this age is only the ✻Ns marker shown behind an already-active glyph.
  // null = no pane / no tmux.
  pane_activity_age_s: number | null;
  // The raw ABSOLUTE pty-activity epoch (unix seconds) behind that age. Carried so
  // the TUI's capture change-detector compares stable epochs instead of round-tripping
  // through the clamped relative age (a skew-clamped age→0 would otherwise re-track
  // nowSec and capture every tick). null = no pane / no tmux activity time.
  pane_activity_at: number | null;

  // Self-reported caption (cross-checked, never authority).
  purpose: string | null;
  purpose_age_s: number | null;
  purpose_stale: boolean; // caption older than last activity ⇒ probably outdated
  possibly_stalled: boolean; // declared work but transcript cold ⇒ likely hung
  // Worklist signal (max's v1 cut): an idle agent that is NOT parked on a peer, NOT
  // maybe-hung, and HAS a transcript (a real session sitting at its prompt) is
  // "awaiting you" — your move. The COMPLEMENT of the wait-graph within idle-space, so
  // the cockpit answers "who needs me right now", not just "who's alive". "working" is
  // excluded by the active enum (transcript_fresh ∨ pane_fresh ∨ tool_running ⇒ active).
  // transcript_fresh + tool_running are pure READ-class derivations (fleet-complete, no
  // exec); pane_fresh needs the captured pane_busy signal, so an agent in a long tool-
  // less think reads idle (and may flag awaiting) until its pane is captured — accurate
  // wherever capture runs (fleet-wide in `oxtail status` + on the TUI's slow tick),
  // soft-and-self-healing where it hasn't yet. Far better than the old repaint-timestamp
  // pane_fresh, which read EVERY idle agent active and made this signal never fire.
  awaiting_human: boolean;

  // Transcript path (display/activity only; jump RE-RESOLVES identity separately).
  transcript_path: string | null;
  // Real-time read-class sub-state: the latest tool the agent invoked + whether
  // it's still running. Populated only when buildSnapshot's readActivity flag is
  // set (a bounded transcript-tail read); null otherwise / for dead agents.
  activity: AgentActivity | null;

  // Work badges (independent; can coexist).
  unread: number;
  unread_confidence: Confidence;
  open_work: number;
  waiting: WaitEdge | null;

  // tmux coordinates (cached snapshot values; jump RE-VALIDATES live, never trusts
  // these alone — pane ids are recycled when a pane dies).
  tmux_pane: string | null;
  tmux_session: string | null;
  // tmux window index — the fleet is ordered by (session, window_index) so the rows
  // stay fixed in the agent's tmux window order instead of re-sorting on state.
  window_index: number | null;
};

export type WaitCycle = {
  members: string[]; // short_ids in cycle order
  // Every member's pid is alive — a credible LIVE deadlock. When false the cycle
  // is built from stale/abandoned pending-ask records (one+ member exited or its
  // ask aged out) and must be shown as a "possible/stale" cycle, never a hard
  // DEADLOCK (max H1: a false deadlock in mission-control is a trust-killer).
  all_live: boolean;
};

export type FleetSnapshot = {
  schema_version: 1;
  project_root: string;
  generated_at: number; // unix seconds
  self_session_id: string | null;
  agents: FleetAgent[];
  // DETACHED background processes that registered a breadcrumb but own NO tmux pane —
  // MCP children / `codex exec` subprocesses oxpit can't jump/nudge/kill (a jump only
  // ever fails "couldn't verify a live pane"). Split OUT of `agents` so they don't
  // clutter the navigable fleet or get mis-counted as "awaiting you"; surfaced as a
  // footer count + still consulted for comms/wait-graph label resolution. Optional so
  // pre-existing FleetSnapshot literals (tests) keep compiling; readers default to [].
  background?: FleetAgent[];
  cycles: WaitCycle[];
  warnings: string[];
};

export type BuildSnapshotOptions = {
  projectRoot?: string;
  cwd?: string;
  selfSessionId?: string | null;
  nowMs?: number;
  activeWindowS?: number;
  // Run the per-agent proc_sig pid-reuse check (one `ps` per agent). Default true.
  // The TUI can disable it on fast fs-watch ticks and refresh it on a slow tick.
  checkProcSig?: boolean;
  // Read each agent's bounded transcript tail for the latest-tool sub-state badge
  // (FleetAgent.activity). Default FALSE — a read-class cost mirroring checkProcSig:
  // the TUI enables it on the slow tick + `oxtail status` enables it, but the 200ms
  // fast fs-debounce leaves it off so unrelated mailbox events stay cheap.
  readActivity?: boolean;
  // Correlate pending-ask request_ids against ledgers to resolve wait targets.
  // Default true; set false to skip the (cheap, bounded) ledger scan.
  resolveWaitTargets?: boolean;
  // Read every project's agents instead of scoping to projectRoot. Opt-in.
  allProjects?: boolean;
  // Source of registry entries. Defaults to the canonical readAll(); injectable
  // so tests can supply synthetic fleets without spawning live processes.
  readEntries?: () => RegistryEntry[];
  // Resolve pane_id → {window name, last pty-activity time} in one batched tmux
  // call (window label + the orthogonal pane-recent hint). Injectable for tests /
  // to disable (return new Map()).
  resolvePaneInfo?: () => Map<string, PaneInfo>;
  // agentKey → captured pane_busy ("esc to interrupt" present). Sources the pane_fresh
  // liveness reason for the keyed agents; agents not in the map fall through to the
  // read-class signals (transcript_fresh / tool_running / idle). Populated by the
  // caller from an EXEC-class capture-pane pass (fleet-wide in `oxtail status`, the
  // slow tick in the TUI); default empty ⇒ pane_fresh never fires (pure read path).
  paneBusy?: Map<string, boolean>;
  // Resolve which server pids currently own a live tmux pane (process-subtree
  // ancestry — the SAME signal `jump` uses). Drives the background/foreground split.
  // Defaults to the real batched resolver; injectable so tests can declare a fleet's
  // jumpable set without live tmux/ps. Set false in opts.classifyBackground to skip.
  resolveJumpablePids?: (serverPids: number[]) => Set<number>;
  // Disable the background-process split entirely (keep every entry in `agents`).
  // Default: classify when tmux pane info is available. A safety/escape hatch.
  classifyBackground?: boolean;
  // Liveness probe (process.kill(pid,0)). Defaults to the real registry isAlive;
  // injectable so tests can stand up a multi-pid fleet without live OS processes.
  isAlive?: (pid: number) => boolean;
  // Pending-ask map (requester session_id → live pending ask) that sources each
  // agent's wait-edge. Injectable so a test can stand up a WAITING agent without
  // writing the on-disk pending-ask registry (covers codex #4 — a waiting detached
  // process must stay foreground, not collapse into the background footer).
  pending?: Map<string, PendingAsk>;
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shortId(sessionId: string | null, pid: number): string {
  return sessionId ? sessionId.slice(0, 8) : `pid:${pid}`;
}

// Count undrained messages across a session's inbox boxes (session box + any
// current/prior/sibling pid boxes), deduped by message_id. Lock-free and
// non-destructive: reads the files, never truncates. Torn lines are skipped by
// parseMailboxRecords. confidence drops to "low" if any box read was degraded.
function countUnread(sessionId: string): { count: number; confidence: Confidence } {
  const boxes: BoxId[] = [];
  try {
    boxes.push(mailboxSessionKey(sessionId));
  } catch {
    // malformed id — session box uncountable; pid boxes may still exist
  }
  let degraded = false;
  try {
    for (const pid of sessionPidsForId(sessionId)) boxes.push(pid);
  } catch {
    degraded = true;
  }
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const box of boxes) {
    let path: string;
    try {
      path = mailboxFilePath(box);
    } catch {
      degraded = true;
      continue;
    }
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") degraded = true;
      continue; // ENOENT = no box = no mail; not degraded
    }
    // A torn/invalid line is silently dropped by parseMailboxRecords, which would
    // undercount while still reporting "high". Compare non-empty lines vs parsed
    // records and down-rank confidence on a mismatch — honest uncertainty.
    const nonEmpty = raw.split("\n").filter((l) => l.trim().length > 0).length;
    const records = parseMailboxRecords(raw);
    if (records.length < nonEmpty) degraded = true;
    for (const m of records) seenIds.add(m.id);
  }
  return { count: seenIds.size, confidence: degraded ? "low" : "high" };
}

type PendingAsk = { requestId: string; ageS: number; attempts: number };

// Read the pending-ask registry into a map: requester session_id → freshest live
// pending ask. A record is the durable note that an agent's ask_peer timed out and
// it is still awaiting a late reply — i.e. the agent is parked, awaiting a reply
// (NOT synchronously blocked). Consumes the canonical listLivePendingAsks reader
// (TTL-liveness lives in pending-ask.ts, not re-derived here).
function readPendingAsks(nowMs: number): Map<string, PendingAsk> {
  const out = new Map<string, PendingAsk & { mtimeMs: number }>();
  for (const rec of listLivePendingAsks(defaultPendingAskDir(), nowMs)) {
    const prior = out.get(rec.sessionId);
    if (!prior || rec.mtimeMs > prior.mtimeMs) {
      out.set(rec.sessionId, {
        requestId: rec.requestId,
        ageS: rec.ageS,
        attempts: rec.attempts,
        mtimeMs: rec.mtimeMs,
      });
    }
  }
  const result = new Map<string, PendingAsk>();
  for (const [sid, v] of out) result.set(sid, { requestId: v.requestId, ageS: v.ageS, attempts: v.attempts });
  return result;
}

// Index a peer's received-ledger as a set of "requestId<sep>fromSessionId" keys, so
// a waiter's (request_id, self) can be matched to the peer that received its ask.
// Consumes the canonical listLedgerRequestPairs reader (ledger parsing lives in
// received.ts, not re-implemented here).
function indexLedgerRequests(sessionId: string): Set<string> {
  const keys = new Set<string>();
  for (const { request_id, from_session_id } of listLedgerRequestPairs(sessionId)) {
    keys.add(`${request_id}${LEDGER_KEY_SEP}${from_session_id}`);
  }
  return keys;
}

// Resolve each waiting agent's target by correlating its pending-ask request_id
// against peers' ledgers (the ask landed in the target's received-ledger keyed by
// request_id + the waiter's session_id). Sets target + orphaned in place.
export function resolveWaitTargets(
  agents: FleetAgent[],
  pending: Map<string, PendingAsk>,
): void {
  const waiters = agents.filter((a) => a.waiting && a.session_id);
  if (waiters.length === 0) return;
  const ledgerIndex = new Map<string, Set<string>>();
  for (const a of agents) {
    if (a.session_id) ledgerIndex.set(a.session_id, indexLedgerRequests(a.session_id));
  }
  for (const w of waiters) {
    const pend = pending.get(w.session_id!);
    if (!pend) continue;
    const key = `${pend.requestId}${LEDGER_KEY_SEP}${w.session_id}`;
    for (const cand of agents) {
      if (!cand.session_id || cand.session_id === w.session_id) continue;
      if (ledgerIndex.get(cand.session_id)?.has(key)) {
        w.waiting!.target_session_id = cand.session_id;
        w.waiting!.target_short_id = cand.short_id;
        w.waiting!.orphaned = cand.liveness === "dead";
        break;
      }
    }
  }
}

// Detect deadlock cycles in the wait graph. Each agent waits on at most one peer
// (we take the freshest pending-ask), so this is a functional graph: walk each
// chain; a revisit within the current path is a cycle. Marks every member's
// waiting.in_cycle and returns the cycles (member short_ids).
export function detectWaitCycles(agents: FleetAgent[]): WaitCycle[] {
  const next = new Map<string, string>();
  const byId = new Map<string, FleetAgent>();
  for (const a of agents) if (a.session_id) byId.set(a.session_id, a);
  for (const a of agents) {
    if (a.session_id && a.waiting?.target_session_id) {
      next.set(a.session_id, a.waiting.target_session_id);
    }
  }
  const DONE = 2;
  const state = new Map<string, number>();
  const cycles: WaitCycle[] = [];
  for (const start of next.keys()) {
    if (state.get(start) === DONE) continue;
    const path: string[] = [];
    const pos = new Map<string, number>();
    let cur: string | undefined = start;
    while (cur !== undefined) {
      const seenAt = pos.get(cur);
      if (seenAt !== undefined) {
        const members = path.slice(seenAt);
        // A credible LIVE deadlock requires every member's pid alive; a cycle of
        // stale/abandoned pending-asks (a member exited / aged out) is shown as a
        // soft "possible" cycle, not a hard DEADLOCK (max H1 trust-killer).
        const allLive = members.every((sid) => {
          const ag = byId.get(sid);
          return ag != null && ag.liveness !== "dead";
        });
        cycles.push({
          members: members.map((sid) => byId.get(sid)?.short_id ?? sid.slice(0, 8)),
          all_live: allLive,
        });
        for (const sid of members) {
          const ag = byId.get(sid);
          if (ag?.waiting) {
            ag.waiting.in_cycle = true;
            ag.waiting.cycle_all_live = allLive;
          }
        }
        break;
      }
      if (state.get(cur) === DONE) break; // leads into already-explored chain
      pos.set(cur, path.length);
      path.push(cur);
      cur = next.get(cur);
    }
    for (const sid of path) state.set(sid, DONE);
  }
  return cycles;
}

type AgentCtx = {
  nowMs: number;
  nowSec: number;
  activeWindowS: number;
  selfSessionId: string | null;
  pending: Map<string, PendingAsk>;
  checkProcSig: boolean;
  readActivity: boolean;
  paneInfo: Map<string, PaneInfo>;
  // agentKey → true when the captured pane shows the client's "esc to interrupt"
  // marker (a turn in flight). Sources the pane_fresh liveness reason. Empty when no
  // pane capture ran this pass (the READ-class path); an absent key ⇒ not-busy.
  paneBusy: Map<string, boolean>;
  isAlive: (pid: number) => boolean;
};

function buildAgent(e: RegistryEntry, ctx: AgentCtx): FleetAgent {
  const sid = e.client.session_id;

  // Liveness authority #1: is the server_pid still a live process at all? A clean
  // exit / crash makes process.kill(pid,0) throw ESRCH — the agent is gone (until
  // some writer's readAll reaps its breadcrumb). Without this an exited agent
  // would fall through to transcript-mtime and read 🟡idle, and the headline
  // "orphaned wait — target dead" could never fire for a REAL dead target (max H2).
  const pidAlive = ctx.isAlive(e.server_pid);

  // proc_sig pid-reuse guard: a recycled pid (now an unrelated process) has a
  // different start-time signature than the one captured at register time. Only
  // meaningful when the pid IS alive; an empty live reading (transient ps failure)
  // is inconclusive → "unknown".
  let procSig: "ok" | "reused" | "unknown" = "unknown";
  if (pidAlive && ctx.checkProcSig && e.proc_sig) {
    const live = processStartSig(e.server_pid);
    if (live) procSig = live === e.proc_sig ? "ok" : "reused";
  }

  // Transcript mtime = liveness authority #2 (live vs idle). ageOrSkew returns null
  // for a future-dated mtime (clock skew) so it can't masquerade as fresh ⇒ active.
  let transcriptAgeS: number | null = null;
  if (e.client.transcript_path) {
    try {
      transcriptAgeS = ageOrSkew(
        ctx.nowSec,
        Math.floor(statSync(e.client.transcript_path).mtimeMs / 1000),
      );
    } catch {
      transcriptAgeS = null;
    }
  }

  // Pane-recent signal (pty output time). Clamp ≥0 and guard a non-finite/empty
  // reading — it's a wall-clock time_t that can be stale or garbage. DISPLAY-ONLY now
  // (the ✻Ns marker + the TUI's capture change-detector); it no longer drives liveness,
  // because a repaint timestamp can't distinguish working from idle (a docked dock pane
  // or a ticking "Worked for Ns" counter keeps it perpetually fresh). Liveness's
  // pane_fresh is gated on the CONTENT signal ctx.paneBusy instead (see below).
  const paneInfo = e.tmux_pane ? ctx.paneInfo.get(e.tmux_pane) : undefined;
  const paneActAt = paneInfo?.activity_at ?? null;
  const paneActivityAgeS =
    paneActAt != null && Number.isFinite(paneActAt) ? ageOrSkew(ctx.nowSec, paneActAt) : null;
  // CONTENT-verified "working right now": the captured pane shows the client's own
  // "esc to interrupt" marker (extractPaneActivity → pane_busy). Present ONLY while a
  // turn is in flight for both Claude Code and Codex; absent at the idle prompt even as
  // the clock keeps ticking. Undefined when this agent's pane wasn't captured this pass.
  const paneBusy = ctx.paneBusy.get(agentKey({ session_id: sid, server_pid: e.server_pid })) === true;

  // Liveness + the real-time tool sub-state are decided together: transcript mtime
  // alone LAGS during a long thinking/tool turn (David watched a clearly-working
  // agent read idle at 158s tx-age while its pane was 0s), so we fold in two more
  // live-work signals — a fresh pane repaint and a tool currently running. Any one
  // ⇒ active; the order of the active branches is display-only (freshest first).
  const transcriptPath = e.client.transcript_path ?? null;
  let liveness: Liveness;
  let reason: LivenessReason;
  let activity: AgentActivity | null = null;
  if (!pidAlive) {
    liveness = "dead";
    reason = "exited";
  } else if (procSig === "reused") {
    liveness = "dead";
    reason = "pid_reused";
  } else {
    // Alive ⇒ read the bounded transcript tail (gated by readActivity) for the tool
    // sub-state. Done ONLY for live agents: a dead agent's last tool_use often lacks
    // a result and would render a misleading "running" badge (the ⚫ glyph suffices).
    if (ctx.readActivity && transcriptPath) {
      try {
        activity = scanLatestTool(transcriptPath, e.client.type);
      } catch {
        activity = null; // tail read failed — leave the badge off
      }
    }
    if (transcriptAgeS !== null && transcriptAgeS <= ctx.activeWindowS) {
      liveness = "active";
      reason = "transcript_fresh";
    } else if (paneBusy && transcriptAgeS !== null && transcriptAgeS <= STALL_WINDOW_S) {
      // The captured pane shows "esc to interrupt" ⇒ a turn is in flight RIGHT NOW —
      // catches a long tool-less think while the transcript mtime lags (David watched a
      // clearly-working agent read idle at 158s tx-age). This REPLACES the old repaint-
      // timestamp pane_fresh, which fired for every idle agent (a docked dock pane / a
      // ticking "Worked for Ns" counter keeps window_activity perpetually fresh). Bounded
      // by STALL_WINDOW_S exactly like tool_running below: a wedged process leaves "esc
      // to interrupt" frozen in the pane buffer, so past the window it must hand off to
      // idle → possibly_stalled rather than read active forever off a stale glyph.
      liveness = "active";
      reason = "pane_fresh";
    } else if (
      activity?.tool_running &&
      transcriptAgeS !== null &&
      transcriptAgeS <= STALL_WINDOW_S
    ) {
      // A tool is in-flight while transcript & pane are both quiet (a silent long
      // call — sleeping bash, slow fetch) — still actively working, not idle. BOUNDED
      // by STALL_WINDOW_S (max review): an unbounded tool_running would read active
      // FOREVER for a hung/wedged tool (tx + pane cold, pid alive) and suppress the
      // idle-gated possibly_stalled signal indefinitely. The bound is deliberately
      // the SAME threshold as possibly_stalled, so a tool that's been cold past the
      // window hands off gaplessly: active(tool_running) → idle → possibly_stalled.
      liveness = "active";
      reason = "tool_running";
    } else if (transcriptAgeS === null) {
      liveness = "idle";
      reason = "no_transcript";
    } else {
      liveness = "idle";
      reason = "idle";
    }
  }

  const purpose = e.state?.purpose ?? null;
  const purposeAgeS =
    e.state?.updated_at != null ? Math.max(0, ctx.nowSec - e.state.updated_at) : null;

  // Caption cross-checks (divergence-as-signal).
  let purposeStale = false;
  let possiblyStalled = false;
  if (purpose && purposeAgeS !== null && transcriptAgeS !== null) {
    // Purpose set well BEFORE last activity ⇒ work happened since ⇒ caption outdated.
    purposeStale = purposeAgeS > transcriptAgeS + CAPTION_STALE_GAP_S;
    // Declared work but transcript cold with nothing produced since ⇒ MAYBE hung.
    // Deliberately conservative (max M1: don't cry hung on a healthy idle agent):
    // only when plainly idle (not dead), cold for a long window, no output since
    // the purpose was set, AND not legitimately parked awaiting a peer reply.
    possiblyStalled =
      liveness === "idle" &&
      transcriptAgeS > STALL_WINDOW_S &&
      purposeAgeS <= transcriptAgeS &&
      !(sid != null && ctx.pending.has(sid));
  }

  let unread = 0;
  let unreadConfidence: Confidence = "high";
  let openWork = 0;
  if (sid) {
    const u = countUnread(sid);
    unread = u.count;
    unreadConfidence = u.confidence;
    try {
      openWork = countOpenObligations(sid);
    } catch {
      // leave 0; ledger unreadable
    }
  }

  const pend = sid ? ctx.pending.get(sid) : undefined;
  const waiting: WaitEdge | null = pend
    ? {
        target_session_id: null,
        target_short_id: null,
        age_s: pend.ageS,
        orphaned: false,
        in_cycle: false,
        cycle_all_live: false,
        repoke_attempts: pend.attempts,
      }
    : null;

  // "Awaiting you" — computed OUTSIDE the purpose block ON PURPOSE: unlike
  // possibly_stalled it must NOT require a declared purpose (a no-purpose idle agent is
  // MORE awaiting-you, not less). reason !== "no_transcript" keeps a phantom/just-spawned
  // entry off the worklist; waiting === null excludes peer-waiters (the wait-graph's job,
  // surfacing them here would be a false positive that trains you to ignore the badge);
  // !possiblyStalled keeps the maybe-hung agents in their own ⚠ class (a different action).
  // !activity?.tool_running closes max's F1: a hung/unclosed tool with NO declared purpose
  // drops to idle past STALL_WINDOW_S with possibly_stalled=false (it needs a purpose), so
  // the row would otherwise show the in-flight tool badge `…` AND 🙋 at once — a visible
  // contradiction. This term fires ONLY there (idle + in-flight tool ⟹ tx>STALL_WINDOW_S,
  // since tool_running with a fresh tx is the ACTIVE branch). It's a no-op when readActivity
  // is off (activity null); both real surfaces — `status` + the TUI slow tick — run it on.
  const awaitingHuman =
    liveness === "idle" &&
    reason !== "no_transcript" &&
    waiting === null &&
    !possiblyStalled &&
    !activity?.tool_running;

  return {
    session_id: sid,
    short_id: shortId(sid, e.server_pid),
    window_name: paneInfo?.name ?? null,
    client_type: e.client.type,
    server_pid: e.server_pid,
    cwd: e.client.cwd,
    is_self: sid != null && sid === ctx.selfSessionId,
    liveness,
    liveness_reason: reason,
    transcript_age_s: transcriptAgeS,
    proc_sig: procSig,
    pane_activity_age_s: paneActivityAgeS,
    pane_activity_at: paneActAt != null && Number.isFinite(paneActAt) ? paneActAt : null,
    purpose,
    purpose_age_s: purposeAgeS,
    purpose_stale: purposeStale,
    possibly_stalled: possiblyStalled,
    awaiting_human: awaitingHuman,
    transcript_path: transcriptPath,
    activity,
    unread,
    unread_confidence: unreadConfidence,
    open_work: openWork,
    waiting,
    tmux_pane: e.tmux_pane,
    tmux_session: e.tmux_session,
    window_index: paneInfo?.window_index ?? null,
  };
}

// Sort by tmux WINDOW ORDER so the fleet list stays FIXED — the rows match the
// agent's window order in tmux (e.g. main, codex, max) and don't re-shuffle as
// liveness/work change (David). Agents with a tmux window come first, ordered by
// (session, window_index); pane-less agents fall to the end. short_id is the final
// tiebreak (two agents sharing a window, or no window info). Trouble is still
// surfaced — by the attention line, glyphs, and badges — just not by reordering.
function compareByWindow(a: FleetAgent, b: FleetAgent): number {
  // ⚫DEAD agents sink to the BOTTOM so live ones stay on top (David: dead breadcrumbs from
  // prior fleet restarts were burying the active session). Dead is TERMINAL, so this never
  // causes the live active↔idle re-shuffle the window-order sort below avoids — an agent
  // crosses this boundary once, when it dies. Kept (not hidden): a dead row still carries its
  // ✉stranded-mail / ⚑stranded-work signal — operator-ack-to-clear, never a silent TTL delete.
  const aDead = a.liveness === "dead";
  const bDead = b.liveness === "dead";
  if (aDead !== bDead) return aDead ? 1 : -1;
  const aHas = a.window_index != null;
  const bHas = b.window_index != null;
  if (aHas !== bHas) return aHas ? -1 : 1; // windowed agents before pane-less ones
  if (aHas && bHas) {
    const s = (a.tmux_session ?? "").localeCompare(b.tmux_session ?? "");
    if (s !== 0) return s;
    if (a.window_index !== b.window_index) return a.window_index! - b.window_index!;
  }
  return a.short_id.localeCompare(b.short_id);
}

// Build a full fleet snapshot. Pure w.r.t. the injected clock (nowMs) and reads
// the live ~/.oxtail state through the canonical modules. Never throws on a single
// bad agent — failures degrade into warnings.
export function buildSnapshot(opts: BuildSnapshotOptions = {}): FleetSnapshot {
  const nowMs = opts.nowMs ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  // process.cwd() THROWS (ENOENT) when the working directory has been deleted out
  // from under a long-lived cockpit — and this runs BEFORE the entries try/catch
  // below, so an unguarded throw here used to crash the first paint and wedge the
  // raw-mode terminal. Fall back to $HOME so the snapshot still builds (it'll just
  // find no project-scoped agents).
  let cwd: string;
  if (opts.cwd != null) {
    cwd = opts.cwd;
  } else {
    try {
      cwd = process.cwd();
    } catch {
      cwd = homedir();
    }
  }
  const projectRoot = safeRealpath(opts.projectRoot ?? inferProjectRoot(cwd));
  // Self-identity: mirror claim_session's env preference order so an oxpit launched
  // inside a Claude OR Codex pane marks its own row. (In a standalone terminal —
  // the cockpit's main use case — none of these are set and no row is self, which
  // is fine: the operator is an outside observer.)
  const selfSessionId =
    opts.selfSessionId !== undefined
      ? opts.selfSessionId
      : process.env.CLAUDE_CODE_SESSION_ID ??
        process.env.CODEX_THREAD_ID ??
        process.env.CODEX_COMPANION_SESSION_ID ??
        null;
  const activeWindowS = opts.activeWindowS ?? ACTIVE_WINDOW_S;
  const checkProcSig = opts.checkProcSig ?? true;
  const readActivity = opts.readActivity ?? false;
  const warnings: string[] = [];

  let entries: RegistryEntry[];
  try {
    // readAllPassive (not readAll): a VIEW must not reap/unlink dead entries, and
    // it must KEEP them so the cockpit can show ⚫dead + orphaned waits.
    entries = (opts.readEntries ?? readAllPassive)();
  } catch (e) {
    return {
      schema_version: 1,
      project_root: projectRoot,
      generated_at: nowSec,
      self_session_id: selfSessionId,
      agents: [],
      background: [],
      cycles: [],
      warnings: [`registry read failed: ${errMsg(e)}`],
    };
  }

  const inScope = opts.allProjects
    ? entries
    : entries.filter((e) => {
        try {
          return pathBelongsToProjectScope(e.client.cwd, projectRoot);
        } catch {
          return false;
        }
      });

  const pending = opts.pending ?? readPendingAsks(nowMs);
  // H1-KILLER (max's synergy): a pending-ask whose reply is observable in the
  // requester's OWN ledger (reply_to == its request_id) has been ANSWERED — so the
  // agent is NOT waiting, even though the pending-ask file lingers up to an hour.
  // Drop those, so the wait-graph trusts observed message evidence over the file.
  const answeredWaiters: string[] = [];
  for (const [sid, pa] of pending) {
    try {
      if (listLedgerReplyTargets(sid).includes(pa.requestId)) answeredWaiters.push(sid);
    } catch {
      // ledger unreadable — leave the wait in place (fail toward showing it)
    }
  }
  for (const sid of answeredWaiters) pending.delete(sid);
  let paneInfo: Map<string, PaneInfo>;
  try {
    paneInfo = (opts.resolvePaneInfo ?? panePresence)();
  } catch {
    paneInfo = new Map(); // tmux absent / failed — labels fall back to short_id
  }
  const ctx: AgentCtx = {
    nowMs,
    nowSec,
    activeWindowS,
    selfSessionId,
    pending,
    checkProcSig,
    readActivity,
    paneInfo,
    paneBusy: opts.paneBusy ?? new Map(),
    isAlive: opts.isAlive ?? isAlive,
  };

  const agents: FleetAgent[] = [];
  for (const e of inScope) {
    try {
      agents.push(buildAgent(e, ctx));
    } catch (err) {
      warnings.push(`agent ${e.server_pid} skipped: ${errMsg(err)}`);
    }
  }

  if (opts.resolveWaitTargets !== false) {
    try {
      resolveWaitTargets(agents, pending);
    } catch (err) {
      warnings.push(`wait-target resolution degraded: ${errMsg(err)}`);
    }
  }
  const cycles = detectWaitCycles(agents);

  agents.sort(compareByWindow);

  // Partition off DETACHED background processes — registered MCP children / `codex
  // exec` subprocesses that own no tmux pane, so jump/nudge/kill can't reach them
  // (these are the rows that fail "couldn't verify a live pane"). Collapsing them to a
  // footer keeps the navigable fleet clean and keeps them OFF the "awaiting you"
  // worklist (an un-jumpable idle row is not your move). Three guard rails so a REAL
  // fleet is NEVER hidden:
  //   • only when tmux pane info is actually present — otherwise we can't tell
  //     "detached" from "oxpit simply isn't in tmux", so we keep everyone;
  //   • dead agents stay foreground (⚫dead + orphaned-wait surfacing is intentional);
  //   • never collapse the WHOLE fleet — at least one jumpable foreground must remain,
  //     which covers a flaky ps/tmux read or a genuinely all-detached environment.
  let foreground = agents;
  let background: FleetAgent[] = [];
  const tmuxAvailable = paneInfo.size > 0;
  if (tmuxAvailable && opts.classifyBackground !== false) {
    let jumpable: Set<number> | null = null;
    try {
      jumpable = (opts.resolveJumpablePids ?? resolveJumpablePids)(agents.map((a) => a.server_pid));
    } catch (err) {
      warnings.push(`background classification skipped: ${errMsg(err)}`);
    }
    if (jumpable) {
      // A WAITING agent (a pending ask / obligation wait-edge) is NOT idle clutter:
      // its wait must stay on the wait-graph and in the --check trouble count —
      // especially an orphaned or deadlocked one — even when it is an un-jumpable
      // detached process (codex #4). So keep any waiter foreground; only collapse
      // genuinely-idle un-jumpable rows.
      const bg = agents.filter(
        (a) => a.liveness !== "dead" && !jumpable!.has(a.server_pid) && a.waiting == null,
      );
      // The split fires ONLY when there's a real jumpable/dead ANCHOR in the fleet.
      // A fleet where nothing is jumpable (oxpit not in tmux, or a resolver miss)
      // stays WHOLE — the "never collapse the entire fleet" guard. Crucially the
      // trigger keys on that anchor, NOT on the (now waiter-inclusive) foreground:
      // otherwise a lone waiter in a no-jumpable env would background every non-waiter
      // (the CI no-tmux repro that the original empty-fg guard happened to prevent).
      const anchored = agents.some((a) => a.liveness === "dead" || jumpable!.has(a.server_pid));
      if (anchored && bg.length > 0) {
        foreground = agents.filter(
          (a) => a.liveness === "dead" || jumpable!.has(a.server_pid) || a.waiting != null,
        );
        background = bg;
      }
    }
  }

  return {
    schema_version: 1,
    project_root: projectRoot,
    generated_at: nowSec,
    self_session_id: selfSessionId,
    agents: foreground,
    background,
    cycles,
    warnings,
  };
}

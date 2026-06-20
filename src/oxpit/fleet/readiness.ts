// Launch-artifact readiness watch — how the fleet executor learns that an agent
// it just launched has actually come up, and what its session identity is,
// WITHOUT scraping a confirmation string out of a TUI (a model can emit that
// string itself; external filesystem state cannot be spoofed by the agent).
//
// Both clients drop a launch-time artifact we can baseline-snapshot BEFORE the
// launch and poll-diff for a NEW entry afterwards:
//   • Claude → the SessionStart hook drop ~/.oxtail/session-starts/<file>
//     (written ~at session spin-up; carries session_id + cwd + the host Claude
//     pid `ppid` + that pid's start-time sig). Because the drop records the host
//     Claude process pid, we bind it EXACTLY to the pane we launched into:
//     drop.ppid must currently resolve (via process-tree ancestry) to OUR pane.
//   • Codex → the rollout file ~/.codex/sessions/<Y>/<M>/<D>/rollout-*-<uuid>.jsonl
//     (filename UUID = thread-id; first `session_meta` line carries cwd). The
//     rollout records NO process pid (verified against a live 0.141.0 rollout),
//     so Codex CANNOT be ppid-bound the way Claude is. Its binding is new-file
//     identity + cwd-match + an mtime floor, which is exact ENOUGH because the
//     executor launches sequentially under the fleet lock (one Codex into one
//     cwd at a time) — so a fresh post-launch rollout in our cwd is ours. Two
//     fresh matches ⇒ ambiguous ⇒ we abstain rather than guess.
//
// macOS FSEvents are lossy and coalescing, so polling is the source of truth;
// any fs.watch would only be an accelerator (not wired here — the launch path
// already polls). The poll loop is structured exactly like keystrokes.ts's
// waitForPaneLine (injectable now/sleep, returns on timeout, never blocks
// forever) and the pure selection core (selectBoundArtifact) is unit-tested with
// injected observations + a fake ppid→pane resolver.

import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { recentCodexDateDirs } from "../../detect/birthTimeMatchStrategy.js";
import { listHookDrops } from "../../detect/hookDropStrategy.js";
import { currentPaneForServerPid } from "../../registry.js";
import type { AgentKind } from "./types.js";

// A launch artifact observed on disk, normalized across the two clients.
export interface ArtifactObservation {
  sessionId: string; // Claude session_id | Codex thread-id
  cwd: string | null; // launch cwd recorded in the artifact (null if unreadable)
  bornAtMs: number; // Claude written_at*1000 | Codex file birthtime (ms)
  hostPpid: number | null; // Claude drop.ppid (host Claude pid) | null for Codex
  path: string; // artifact file path — diagnostics only
}

// written_at is whole-second (so a same-second artifact can read slightly BEFORE
// a ms-granular launch instant), plus a touch of clock skew. New-file identity
// (baseline diff) is the primary disambiguator; this floor only guards a stale
// drop that slipped in between snapshot and launch.
const MTIME_FLOOR_SKEW_MS = 2_000;

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function cwdMatches(artifactCwd: string | null, target: string): boolean {
  if (!artifactCwd) return false; // unreadable cwd → can't confirm it's ours
  return safeRealpath(artifactCwd) === safeRealpath(target);
}

function fileBirthMs(path: string): number {
  try {
    const s = statSync(path);
    return s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
  } catch {
    return 0;
  }
}

// Read the WHOLE first line of a file (until the first \n), capped for safety.
// Unlike the 4KB-capped reader in birthTimeMatchStrategy, this tolerates the
// large `session_meta` line current Codex writes (~13KB: it inlines the full
// base_instructions text), whose cwd would otherwise be unreachable past the
// cap. Scans for the 0x0A byte (unambiguous in UTF-8 — never a continuation
// byte) so a multi-byte char straddling a read boundary can't corrupt the line.
function readFirstFullLine(path: string, capBytes = 256 * 1024): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    let pos = 0;
    while (total < capBytes) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) {
        parts.push(Buffer.from(chunk.subarray(0, nl)));
        break;
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(parts).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

// Claude observations: map each SessionStart drop for the relevant cwd-agnostic
// set (cwd filtering happens in selectBoundArtifact). listHookDrops already
// prunes clearly-dead drops and tolerates a missing dir.
export function listClaudeArtifacts(
  base: string = homedir(),
  nowMs: number = Date.now(),
): ArtifactObservation[] {
  return listHookDrops(base, nowMs).map((d) => ({
    sessionId: d.payload.session_id,
    cwd: typeof d.payload.cwd === "string" ? d.payload.cwd : null,
    bornAtMs: Number.isFinite(d.written_at) ? d.written_at * 1000 : 0,
    hostPpid: Number.isFinite(d.ppid) ? d.ppid : null,
    path: "session-starts",
  }));
}

function codexObservation(dir: string, file: string): ArtifactObservation | null {
  const m = file.match(UUID_RE);
  const fromName = m ? m[1] : null;
  const path = join(dir, file);
  let cwd: string | null = null;
  let sessionId = fromName;
  const line = readFirstFullLine(path);
  if (line) {
    try {
      const obj = JSON.parse(line) as { payload?: { cwd?: unknown; id?: unknown } };
      const p = obj?.payload;
      if (p && typeof p.cwd === "string") cwd = p.cwd;
      if (p && typeof p.id === "string") sessionId = p.id;
    } catch {
      // fall back to the filename UUID as the thread-id
    }
  }
  if (!sessionId) return null;
  return { sessionId, cwd, bornAtMs: fileBirthMs(path), hostPpid: null, path };
}

// Codex observations: scan the recent rollout date dirs, read each rollout's
// first line for cwd + thread-id. No ppid is available (the rollout records
// none), so hostPpid stays null and binding falls to new-file + cwd + mtime.
export function listCodexArtifacts(base: string = homedir()): ArtifactObservation[] {
  const sessionsBase = join(base, ".codex", "sessions");
  const out: ArtifactObservation[] = [];
  for (const dir of recentCodexDateDirs(sessionsBase)) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      if (!f.includes("rollout-")) continue;
      const obs = codexObservation(dir, f);
      if (obs) out.push(obs);
    }
  }
  return out;
}

export function listArtifacts(kind: AgentKind, base: string = homedir()): ArtifactObservation[] {
  return kind === "claude" ? listClaudeArtifacts(base) : listCodexArtifacts(base);
}

// The set of artifact identities present RIGHT NOW — captured immediately before
// launch so the post-launch poll only ever adopts a genuinely new artifact.
export function snapshotBaseline(kind: AgentKind, base: string = homedir()): Set<string> {
  return new Set(listArtifacts(kind, base).map((o) => o.sessionId));
}

export interface SelectCtx {
  launchedPane: string; // the pane_id we launched the agent into
  cwd: string; // the repo cwd we expect the artifact to record
  baseline: Set<string>; // sessionIds present before launch
  launchInstantMs: number; // wall-clock at the moment we fired the launch
  resolvePaneForPpid: (ppid: number) => string | null; // prod: currentPaneForServerPid
}

export type SelectResult =
  | { status: "ready"; observation: ArtifactObservation }
  | { status: "pending"; fresh: ArtifactObservation[] }
  | { status: "ambiguous"; candidates: ArtifactObservation[] };

// PURE selection core. Given the current artifact observations and the launch
// context, decide whether exactly one NEW artifact is bound to our pane.
//   • fresh   = not in baseline ∧ cwd matches ∧ born at/after the launch floor
//   • bound   = Claude: fresh ∧ drop.ppid currently resolves to OUR pane;
//               Codex:  fresh (no ppid to bind — sequential-launch identity)
//   • 1 bound → ready; >1 bound → ambiguous (abstain); 0 → pending (keep polling)
export function selectBoundArtifact(
  kind: AgentKind,
  observations: ArtifactObservation[],
  ctx: SelectCtx,
): SelectResult {
  const fresh = observations.filter(
    (o) =>
      !ctx.baseline.has(o.sessionId) &&
      o.bornAtMs >= ctx.launchInstantMs - MTIME_FLOOR_SKEW_MS &&
      cwdMatches(o.cwd, ctx.cwd),
  );
  const bound =
    kind === "claude"
      ? fresh.filter(
          (o) => o.hostPpid != null && ctx.resolvePaneForPpid(o.hostPpid) === ctx.launchedPane,
        )
      : fresh;
  if (bound.length === 1) return { status: "ready", observation: bound[0] };
  if (bound.length > 1) return { status: "ambiguous", candidates: bound };
  return { status: "pending", fresh };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

export interface AwaitOpts {
  launchedPane: string;
  cwd: string;
  baseline: Set<string>;
  launchInstantMs: number;
  timeoutMs?: number;
  pollMs?: number;
  base?: string; // HOME override (tests)
  list?: (kind: AgentKind, base: string) => ArtifactObservation[];
  resolvePaneForPpid?: (ppid: number) => string | null;
  now?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

export type AwaitResult =
  | { ok: true; sessionId: string; observation: ArtifactObservation; waitedMs: number }
  | { ok: false; reason: string; waitedMs: number; candidates: ArtifactObservation[] };

// Poll listArtifacts → selectBoundArtifact until a bound artifact appears or the
// timeout elapses. An "ambiguous" result aborts immediately (more polling can't
// disambiguate two co-fresh artifacts); "pending" keeps polling. On timeout the
// last `fresh` set is returned so the caller can dump it into a loud abort.
export async function awaitLaunchArtifact(
  kind: AgentKind,
  opts: AwaitOpts,
): Promise<AwaitResult> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const pollMs = opts.pollMs ?? 300;
  const base = opts.base ?? homedir();
  const list = opts.list ?? listArtifacts;
  const resolvePaneForPpid = opts.resolvePaneForPpid ?? currentPaneForServerPid;
  const now = opts.now ?? (() => Date.now());
  const napFn = opts.sleepFn ?? sleep;
  const start = now();
  const ctx: SelectCtx = {
    launchedPane: opts.launchedPane,
    cwd: opts.cwd,
    baseline: opts.baseline,
    launchInstantMs: opts.launchInstantMs,
    resolvePaneForPpid,
  };
  let lastFresh: ArtifactObservation[] = [];
  for (;;) {
    const res = selectBoundArtifact(kind, list(kind, base), ctx);
    if (res.status === "ready") {
      return {
        ok: true,
        sessionId: res.observation.sessionId,
        observation: res.observation,
        waitedMs: now() - start,
      };
    }
    if (res.status === "ambiguous") {
      return {
        ok: false,
        reason:
          `${res.candidates.length} fresh ${kind} launch artifacts match this cwd since launch — ` +
          `cannot safely pick which is the one we launched (a concurrent same-cwd launch?). ` +
          `Aborting rather than binding the wrong identity.`,
        waitedMs: now() - start,
        candidates: res.candidates,
      };
    }
    lastFresh = res.fresh;
    if (now() - start >= timeoutMs) {
      return {
        ok: false,
        reason:
          `no ${kind} launch artifact bound to pane ${opts.launchedPane} within ${timeoutMs}ms ` +
          `(${kind === "claude" ? "SessionStart drop" : "rollout file"} never appeared, or never ` +
          `resolved to our pane). The agent may have failed to start, or hit a startup prompt.`,
        waitedMs: now() - start,
        candidates: lastFresh,
      };
    }
    await napFn(pollMs);
  }
}

// Sticky-claim store. A Codex MCP child restarts with session_id=null (its
// CODEX_THREAD_ID is stripped from the MCP subprocess env, same structural
// stripping as Claude Code's CLAUDE_CODE_SESSION_ID), so without help the agent
// must re-run `echo $CODEX_THREAD_ID` → claim_session after every restart.
//
// On claim we persist a small record keyed by client_type + cwd + the MCP
// server's ANCESTOR CHAIN (nearest-first, bounded, each ancestor tagged with a
// start-time signature). On a later startup, when env- and birth-time detection
// both fail, we recover the prior session_id by finding a record whose stored
// ancestor chain still shares a live process with the current child's chain —
// i.e. the same agent host is still running above us.
//
// Why the chain and not a single parent pid: the MCP server's immediate parent
// is often a transient launcher (npx/tsx/a shell) that is re-spawned per start,
// so process.ppid alone is not stable across a restart. The agent HOST, a few
// levels up, is. Matching on a shared (pid, signature) anywhere in the bounded
// chain finds that host through whatever launchers sit beneath it. The
// signature (process start time) means a reused pid can't masquerade as the
// original ancestor.
//
// Why not cwd alone: two agent sessions can share a project root, so a cwd-only
// key collides. Why not birth-time on restart: the transcript predates the
// restarted child's started_at, so the positive-delta birth-time rule abstains.
//
// Recovery is conservative but no longer requires "exactly one historical
// claim" for the cwd. Dogfooding leaves several old claims under one project,
// so recover the unique best live-ancestry match and abstain only on a true tie.
// Zero matches or tied best matches → null → the caller falls back to the
// explicit claim_session next_step rather than guessing.
//
// A live registry entry that already holds the recovered session_id is NOT a
// conflict: per the AGENTS.md invariant, session_id IS the agent identity, so a
// same-session_id sibling is the same agent's other MCP child (the documented
// dual-scope setup), not an impostor. Recovery proceeds alongside it;
// readAll()/dedupeBySessionId collapses the duplicates downstream.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ClientType } from "./clients.js";

// How far up the process tree to look for a shared host. Deep enough to clear
// launcher(s) between the host and the MCP server; if it also catches a shared
// terminal/login-shell, the scored recovery still abstains on true ties.
const ANCESTRY_DEPTH = 8;

// Records older than this with no live evidence are GC'd on the next write.
const CLAIM_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export type Ancestor = { pid: number; sig: string };

export type ClaimRecord = {
  schema_version: 1;
  client_type: ClientType;
  cwd: string;
  ancestors: Ancestor[];
  session_id: string;
  transcript_path: string | null;
  claimed_at: number;
  server_pid: number;
};

// Lazy so tests can swap HOME between cases; homedir() defers to $HOME on POSIX.
export function claimsDir(): string {
  return join(homedir(), ".oxtail", "claims");
}

function ensureClaimsDir(): void {
  const dir = claimsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// One `ps` call → pid -> { ppid, sig }, where sig is the process start time
// (lstart). lstart carries spaces, so it's everything after the first two
// columns. Empty map if ps is unavailable (recovery then simply abstains).
function snapshotProcs(): Map<number, { ppid: number; sig: string }> {
  const map = new Map<number, { ppid: number; sig: string }>();
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const line of out.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/\s+/);
      if (parts.length < 3) continue;
      const pid = Number(parts[0]);
      const ppid = Number(parts[1]);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
      map.set(pid, { ppid, sig: parts.slice(2).join(" ") });
    }
  } catch {
    // ps unavailable — leave map empty
  }
  return map;
}

// The MCP server's ancestor chain, nearest-first, bounded to ANCESTRY_DEPTH.
// Stops at pid <= 1 (init/launchd). Each ancestor carries a start-time sig.
export function resolveAncestors(
  startPpid: number = process.ppid,
  procs: Map<number, { ppid: number; sig: string }> = snapshotProcs(),
  depth: number = ANCESTRY_DEPTH,
): Ancestor[] {
  const out: Ancestor[] = [];
  let pid = startPpid;
  for (let i = 0; i < depth && pid > 1; i++) {
    const node = procs.get(pid);
    out.push({ pid, sig: node?.sig ?? "" });
    if (!node) break;
    pid = node.ppid;
  }
  return out;
}

// True if the chains share a live process — same pid AND start-time signature.
// An empty sig never matches (degraded ps output must not produce false hits).
function chainsOverlap(a: Ancestor[], b: Ancestor[]): boolean {
  for (const x of a) {
    if (!x.sig) continue;
    for (const y of b) {
      if (x.pid === y.pid && x.sig === y.sig) return true;
    }
  }
  return false;
}

type ClaimScore = {
  overlap_count: number;
  nearest_overlap_current: number;
  nearest_overlap_record: number;
  claimed_at: number;
};

function ancestorKey(a: Ancestor): string | null {
  return a.sig ? `${a.pid}\0${a.sig}` : null;
}

function scoreClaim(
  recordAncestors: Ancestor[],
  currentAncestors: Ancestor[],
  claimedAt: number,
): ClaimScore | null {
  const currentIndexByKey = new Map<string, number>();
  for (let i = 0; i < currentAncestors.length; i++) {
    const key = ancestorKey(currentAncestors[i]!);
    if (key && !currentIndexByKey.has(key)) currentIndexByKey.set(key, i);
  }

  let overlapCount = 0;
  let nearestCurrent = Number.POSITIVE_INFINITY;
  let nearestRecord = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  for (let i = 0; i < recordAncestors.length; i++) {
    const key = ancestorKey(recordAncestors[i]!);
    if (!key || seen.has(key)) continue;
    const currentIdx = currentIndexByKey.get(key);
    if (currentIdx === undefined) continue;
    seen.add(key);
    overlapCount++;
    nearestCurrent = Math.min(nearestCurrent, currentIdx);
    nearestRecord = Math.min(nearestRecord, i);
  }

  if (overlapCount === 0) return null;
  return {
    overlap_count: overlapCount,
    nearest_overlap_current: nearestCurrent,
    nearest_overlap_record: nearestRecord,
    claimed_at: claimedAt,
  };
}

function compareClaimScores(a: ClaimScore, b: ClaimScore): number {
  if (a.overlap_count !== b.overlap_count) return a.overlap_count - b.overlap_count;
  if (a.nearest_overlap_current !== b.nearest_overlap_current) {
    return b.nearest_overlap_current - a.nearest_overlap_current;
  }
  if (a.nearest_overlap_record !== b.nearest_overlap_record) {
    return b.nearest_overlap_record - a.nearest_overlap_record;
  }
  return a.claimed_at - b.claimed_at;
}

function claimKey(clientType: ClientType, cwd: string, sessionId: string): string {
  return createHash("sha256")
    .update(`${clientType} ${cwd} ${sessionId}`)
    .digest("hex")
    .slice(0, 32);
}

function claimPath(key: string): string {
  return join(claimsDir(), `${key}.json`);
}

export type WriteClaimInput = {
  client_type: ClientType;
  cwd: string;
  ancestors: Ancestor[];
  session_id: string;
  transcript_path: string | null;
  server_pid: number;
  claimed_at: number;
};

// Persist (or refresh) the sticky claim. Keyed by session, so re-claiming the
// same session overwrites in place while distinct sessions in one cwd coexist.
// Atomic temp+rename so a concurrent reader never sees a torn write.
export function writeClaim(input: WriteClaimInput): void {
  ensureClaimsDir();
  gcStaleClaims();
  const rec: ClaimRecord = {
    schema_version: 1,
    client_type: input.client_type,
    cwd: input.cwd,
    ancestors: input.ancestors,
    session_id: input.session_id,
    transcript_path: input.transcript_path,
    claimed_at: input.claimed_at,
    server_pid: input.server_pid,
  };
  const final = claimPath(claimKey(input.client_type, input.cwd, input.session_id));
  const tmp = `${final}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    renameSync(tmp, final);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
}

export type RecoverDeps = {
  // Defaults to existsSync; injectable for tests.
  transcriptExists?: (path: string) => boolean;
};

// Recover the previously-claimed session for this (client_type, cwd) whose
// stored ancestry still shares a live process with `ancestors`. Multiple old
// claims are ranked by live-ancestry specificity, then recency. A unique best
// match adopts; true ties return null (caller falls back to explicit claim).
export function recoverClaim(
  clientType: ClientType,
  cwd: string,
  ancestors: Ancestor[],
  deps: RecoverDeps = {},
): ClaimRecord | null {
  const exists = deps.transcriptExists ?? existsSync;
  const dir = claimsDir();
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }

  const matches: Array<{ rec: ClaimRecord; score: ClaimScore }> = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let rec: ClaimRecord;
    try {
      rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as ClaimRecord;
    } catch {
      continue;
    }
    if (rec.client_type !== clientType || rec.cwd !== cwd) continue;
    if (!rec.session_id || !rec.transcript_path) continue;
    if (!Number.isFinite(rec.claimed_at)) continue;
    if (!Array.isArray(rec.ancestors) || !chainsOverlap(rec.ancestors, ancestors)) continue;
    if (!exists(rec.transcript_path)) continue;
    const score = scoreClaim(rec.ancestors, ancestors, rec.claimed_at);
    if (!score) continue;
    matches.push({ rec, score });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => compareClaimScores(b.score, a.score));
  const best = matches[0]!;
  const second = matches[1];
  // Abstain on cross-session ambiguity. Two DISTINCT sessions that overlap the
  // live chain equally (same overlap_count) AND at the same live-chain depth
  // (same nearest_overlap_current) share liveness only at a common ancestor —
  // the shared terminal/login-shell. The remaining tiebreakers (record-side
  // depth, recency) do NOT correlate with which child actually restarted, so
  // adopting either would risk cross-session misrouting (H1) — the very
  // split-identity class this store exists to prevent. Return null so the caller
  // falls back to the explicit claim_session next_step. (This strictly subsumes
  // the old exact-tie check, which had equal overlap_count and nearest_current
  // by definition.) A same-session second-best routes to the same identity and
  // so can never split-route — defensive only, since the per-session claim key
  // means two records can't share a session_id.
  if (
    second &&
    best.rec.session_id !== second.rec.session_id &&
    best.score.overlap_count === second.score.overlap_count &&
    best.score.nearest_overlap_current === second.score.nearest_overlap_current
  ) {
    return null;
  }
  return best.rec;
}

// Drop records that are clearly dead: transcript gone, or older than the max
// age. Best-effort; never throws. A dead process pid alone is NOT grounds for
// removal — that's exactly the restart case recovery exists to serve.
export function gcStaleClaims(nowMs: number = Date.now()): void {
  const dir = claimsDir();
  if (!existsSync(dir)) return;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = join(dir, f);
    let rec: ClaimRecord;
    try {
      rec = JSON.parse(readFileSync(full, "utf8")) as ClaimRecord;
    } catch {
      continue;
    }
    const transcriptGone = !rec.transcript_path || !existsSync(rec.transcript_path);
    const tooOld = nowMs - rec.claimed_at * 1000 > CLAIM_MAX_AGE_MS;
    if (transcriptGone || tooOld) {
      try {
        unlinkSync(full);
      } catch {
        // already gone
      }
    }
  }
}

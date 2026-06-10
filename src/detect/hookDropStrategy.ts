// hook-drop detection strategy (v0.17): adopt the session_id from the drop
// file the SessionStart hook (assets/sessionstart.sh) wrote at session start.
//
// Why this exists: Claude Code strips CLAUDE_CODE_SESSION_ID from MCP children
// (env strategy structurally null) and birth-time fingerprinting must abstain
// whenever 2+ agents share a project. The SessionStart hook, however, RECEIVES
// the session id on stdin — so a hooked install can hand it to the server with
// no manual /oxtail-join ceremony.
//
// Disambiguation when several sessions share a cwd: each drop records the
// writing hook's $PPID (the Claude Code process) plus that pid's start-time
// signature. We resolve OUR OWN process ancestry (same machinery as the sticky
// claim store) and adopt the drop whose recorded host is an ancestor of this
// MCP server — i.e. the Claude process the drop came from is literally above
// us in the process tree. That is the strongest cheap signal available; pid
// reuse is defeated by the lstart signature.
//
// Conservative ladder:
//   1. exactly one ancestor-confirmed drop  → hit (high)
//   2. zero confirmed, exactly one cwd-match AND the drop is FRESH relative to
//      this server's started_at → hit (medium). The freshness gate closes the
//      wrong-adoption race: without it, a brand-new session whose own drop
//      hasn't been written yet would see only a STALE drop from a dead session
//      in the same cwd and adopt the wrong identity. A startup drop is written
//      within seconds of the MCP server spawning, so the gate costs nothing in
//      the common case; an old-but-live drop (MCP child restart mid-session)
//      is the ancestry path's job, and failing that the sticky-claim store's.
//   3. anything else → abstain with a reason (never guess between sessions)
//
// Drops from dead sessions age out: a drop whose recorded host pid no longer
// matches a live process AND is older than DROP_MAX_AGE_MS is pruned
// opportunistically on each scan (best-effort).

import { readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAncestors, type Ancestor } from "../claims.js";
import type { DetectContext, DetectStrategy, StrategyOutcome } from "./types.js";

const DROP_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// How much older than this server's started_at a drop may be and still qualify
// for the UNCONFIRMED sole-drop fallback. Generous for slow session spin-up,
// tight enough that yesterday's dead-session drop never qualifies. (A drop
// written AFTER started_at always qualifies — refreshes via resume/clear land
// there.)
const SOLE_DROP_FRESH_MS = 120_000;

export type HookDrop = {
  schema_version: 1;
  ppid: number;
  ppid_sig: string;
  written_at: number;
  payload: {
    session_id: string;
    cwd?: string;
    transcript_path?: string;
    source?: string;
  };
};

export function sessionStartsDir(base: string = homedir()): string {
  return join(base, ".oxtail", "session-starts");
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function parseDrop(raw: string): HookDrop | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const d = parsed as HookDrop;
  if (!d || typeof d !== "object") return null;
  if (d.schema_version !== 1) return null;
  if (!d.payload || typeof d.payload !== "object") return null;
  if (typeof d.payload.session_id !== "string" || !d.payload.session_id) return null;
  return d;
}

// Read every parseable drop, pruning clearly-dead ones (best-effort) as we go.
export function listHookDrops(base: string = homedir(), nowMs: number = Date.now()): HookDrop[] {
  const dir = sessionStartsDir(base);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: HookDrop[] = [];
  for (const f of files) {
    if (f.startsWith(".")) continue; // writer temp files
    const full = join(dir, f);
    let raw: string;
    try {
      raw = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const drop = parseDrop(raw);
    if (!drop) continue;
    if (
      Number.isFinite(drop.written_at) &&
      drop.written_at > 0 &&
      nowMs - drop.written_at * 1000 > DROP_MAX_AGE_MS
    ) {
      try {
        unlinkSync(full); // aged out — a live session would have refreshed it
      } catch {
        // best effort
      }
      continue;
    }
    out.push(drop);
  }
  return out;
}

function ancestorConfirmed(drop: HookDrop, ancestors: Ancestor[]): boolean {
  if (!drop.ppid_sig) return false; // empty sig never matches (degraded ps)
  return ancestors.some((a) => a.pid === drop.ppid && a.sig && a.sig === drop.ppid_sig);
}

// Pure core, injectable for tests; the exported strategy wires the defaults.
export function pickHookDrop(
  ctx: DetectContext,
  drops: HookDrop[],
  ancestors: Ancestor[],
): StrategyOutcome {
  const cwd = safeRealpath(ctx.cwd);
  const candidates = drops.filter(
    (d) => typeof d.payload.cwd === "string" && safeRealpath(d.payload.cwd) === cwd,
  );
  if (candidates.length === 0) {
    return {
      abstain: true,
      reason:
        "no SessionStart drop for this cwd — sessionstart.sh hook not installed, or it hasn't fired yet (retries scheduled).",
    };
  }
  const confirmed = candidates.filter((d) => ancestorConfirmed(d, ancestors));
  if (confirmed.length === 1) {
    return {
      session_id: confirmed[0].payload.session_id,
      source: "hook-drop",
      confidence: "high",
    };
  }
  if (confirmed.length > 1) {
    // Should be impossible (one Claude host above us writes one drop per sid);
    // defensive — never guess between identities.
    return {
      abstain: true,
      reason: `${confirmed.length} ancestor-confirmed drops for this cwd — ambiguous; call claim_session.`,
    };
  }
  if (candidates.length === 1) {
    const d = candidates[0];
    const freshEnough =
      Number.isFinite(d.written_at) &&
      d.written_at * 1000 >= ctx.started_at * 1000 - SOLE_DROP_FRESH_MS;
    if (freshEnough) {
      return {
        session_id: d.payload.session_id,
        source: "hook-drop",
        confidence: "medium",
      };
    }
    return {
      abstain: true,
      reason:
        "one SessionStart drop for this cwd, but it predates this server's start by >2min and " +
        "isn't ancestry-confirmed — likely a dead session's leftover; not adopting. " +
        "If this session is live, its own drop appears shortly (retries scheduled) or call claim_session.",
    };
  }
  return {
    abstain: true,
    structural: true,
    reason:
      `${candidates.length} SessionStart drops for this cwd and none ancestry-confirmed — ` +
      "multiple sessions share this project and the host process can't be matched; call claim_session.",
  };
}

export const hookDropStrategy: DetectStrategy = (ctx) => {
  if (ctx.type !== "claude-code") {
    return {
      abstain: true,
      structural: true,
      reason:
        ctx.type === "codex"
          ? "Codex CLI has no SessionStart hook surface — env/sticky-claim cover Codex."
          : "client type unknown — no SessionStart drop to match.",
    };
  }
  return pickHookDrop(ctx, listHookDrops(), resolveAncestors());
};

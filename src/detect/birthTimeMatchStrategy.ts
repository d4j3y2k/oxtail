import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFirstFullLine } from "./firstline.js";
import type { DetectStrategy, StrategyAbstention } from "./types.js";

const FIVE_MIN_MS = 5 * 60 * 1000;
// started_at is whole-second granularity (Math.floor(Date.now()/1000)*1000)
// while a transcript's birth_ms is real-millisecond, so a transcript
// legitimately created in the same second can land slightly BEFORE started_at
// (delta in [-1000, 0]). Allow one second of grace below zero so the unique
// candidate isn't dropped on pure rounding (M7).
const ONE_SECOND_MS = 1000;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export type Candidate = { session_id: string; birth_ms: number };

// Returns the unique post-start candidate inside the window, or null if there
// are zero or multiple. Multiple positive-delta candidates means another
// Claude Code is sharing this project; we can't safely guess which transcript
// belongs to us, so we fall through to register_my_session.
export function pickByDelta(
  candidates: Candidate[],
  startedAtMs: number,
  windowMs = FIVE_MIN_MS,
): Candidate | null {
  const ranked = candidates
    .map((c) => ({ ...c, delta: c.birth_ms - startedAtMs }))
    .filter((c) => c.delta > -ONE_SECOND_MS && c.delta <= windowMs);
  if (ranked.length !== 1) return null;
  return { session_id: ranked[0].session_id, birth_ms: ranked[0].birth_ms };
}

function fileBirthMs(path: string): number {
  try {
    const s = statSync(path);
    return s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs;
  } catch {
    return 0;
  }
}

function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function listClaudeCandidates(cwd: string, base = homedir()): Candidate[] {
  const dir = join(base, ".claude", "projects", encodeCwdForClaudeProjects(cwd));
  if (!existsSync(dir)) return [];
  const out: Candidate[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const session_id = f.slice(0, -".jsonl".length);
    out.push({ session_id, birth_ms: fileBirthMs(join(dir, f)) });
  }
  return out;
}

function firstLineCwd(path: string): string | null {
  // Read the FULL first line: current Codex rollouts inline base_instructions
  // (~13KB) into the session_meta line, so a small fixed cap would truncate it
  // and silently lose `payload.cwd` → zero candidates. Shared with the readiness
  // watch (detect/firstline.ts).
  const line = readFirstFullLine(path);
  if (!line) return null;
  try {
    const obj = JSON.parse(line);
    const c = obj?.payload?.cwd;
    return typeof c === "string" ? c : null;
  } catch {
    return null;
  }
}

export function listCodexCandidatesIn(dirs: string[], cwd: string): Candidate[] {
  const out: Candidate[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (!f.endsWith(".jsonl")) continue;
      const m = f.match(UUID_RE);
      if (!m) continue;
      const path = join(dir, f);
      const fileCwd = firstLineCwd(path);
      if (fileCwd !== cwd) continue;
      out.push({ session_id: m[1], birth_ms: fileBirthMs(path) });
    }
  }
  return out;
}

export function recentCodexDateDirs(base: string, days = 3): string[] {
  const out = new Set<string>();
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86_400_000);
    for (const utc of [true, false]) {
      const y = utc ? d.getUTCFullYear() : d.getFullYear();
      const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
      const day = utc ? d.getUTCDate() : d.getDate();
      out.add(
        join(
          base,
          String(y),
          String(m).padStart(2, "0"),
          String(day).padStart(2, "0"),
        ),
      );
    }
  }
  return Array.from(out);
}

export function listCodexCandidates(cwd: string, base = homedir()): Candidate[] {
  const sessionsBase = join(base, ".codex", "sessions");
  if (!existsSync(sessionsBase)) return [];
  return listCodexCandidatesIn(recentCodexDateDirs(sessionsBase), cwd);
}

function abstainReason(
  type: "claude-code" | "codex",
  candidates: Candidate[],
  startedAtMs: number,
): StrategyAbstention {
  if (candidates.length === 0) {
    const where =
      type === "claude-code" ? "~/.claude/projects/<encoded-cwd>" : "~/.codex/sessions/<recent>";
    return {
      abstain: true,
      reason: `no transcript files in ${where} for this cwd; agent may not have started a transcript yet.`,
    };
  }
  const ranked = candidates
    .map((c) => ({ ...c, delta: c.birth_ms - startedAtMs }))
    .filter((c) => c.delta > -ONE_SECOND_MS && c.delta <= FIVE_MIN_MS);
  if (ranked.length === 0) {
    return {
      abstain: true,
      reason: `${candidates.length} transcript(s) in dir but none post-date this MCP server's started_at; transcript hasn't been created yet (retries scheduled).`,
    };
  }
  return {
    abstain: true,
    structural: true,
    reason: `${ranked.length} post-start transcripts in 5min window — ambiguous (multiple agents in this project). Cannot safely guess which is ours; call register_my_session.`,
  };
}

export const birthTimeMatchStrategy: DetectStrategy = (ctx) => {
  if (ctx.type === "unknown") {
    return {
      abstain: true,
      reason: "client type unknown — no transcript directory to scan.",
    };
  }
  const startedAtMs = ctx.started_at * 1000;
  const candidates =
    ctx.type === "claude-code" ? listClaudeCandidates(ctx.cwd) : listCodexCandidates(ctx.cwd);
  const pick = pickByDelta(candidates, startedAtMs);
  if (pick) {
    return { session_id: pick.session_id, source: "birth-time", confidence: "medium" };
  }
  return abstainReason(ctx.type, candidates, startedAtMs);
};

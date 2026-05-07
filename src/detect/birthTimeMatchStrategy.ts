import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DetectStrategy } from "./types.js";

const FIVE_MIN_MS = 5 * 60 * 1000;
const AMBIGUITY_WINDOW_MS = 2 * 1000;
const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

export type Candidate = { session_id: string; birth_ms: number };

// Pure ranking logic — separated from IO so it can be unit tested directly.
export function pickByDelta(
  candidates: Candidate[],
  startedAtMs: number,
  windowMs = FIVE_MIN_MS,
  ambiguityWindowMs = AMBIGUITY_WINDOW_MS,
): Candidate | null {
  const ranked = candidates
    .map((c) => ({ ...c, delta: c.birth_ms - startedAtMs }))
    .filter((c) => c.delta > 0 && c.delta <= windowMs)
    .sort((a, b) => a.delta - b.delta);
  if (!ranked.length) return null;
  if (
    ranked.length >= 2 &&
    Math.abs(ranked[0].delta - ranked[1].delta) <= ambiguityWindowMs
  ) {
    return null;
  }
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

// Reads up to 4KB from the start of the file — enough to capture the first
// JSONL line without slurping multi-MB transcripts.
function readFirstLine(path: string, maxBytes = 4096): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    const text = buf.toString("utf8", 0, n);
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function firstLineCwd(path: string): string | null {
  const line = readFirstLine(path);
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

export const birthTimeMatchStrategy: DetectStrategy = (ctx) => {
  const startedAtMs = ctx.started_at * 1000;
  const candidates =
    ctx.type === "claude-code"
      ? listClaudeCandidates(ctx.cwd)
      : ctx.type === "codex"
        ? listCodexCandidates(ctx.cwd)
        : [];
  const pick = pickByDelta(candidates, startedAtMs);
  if (!pick) return null;
  return { session_id: pick.session_id, source: "birth-time", confidence: "medium" };
};

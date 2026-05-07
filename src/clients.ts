import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ClientType = "claude-code" | "codex" | "unknown";

export type ClientInfo = {
  type: ClientType;
  session_id: string | null;
  transcript_path: string | null;
  cwd: string;
};

function encodeCwdForClaudeProjects(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

function claudeTranscriptPath(sessionId: string, cwd: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    encodeCwdForClaudeProjects(cwd),
    `${sessionId}.jsonl`,
  );
}

// Codex stores transcripts at ~/.codex/sessions/<Y>/<M>/<D>/rollout-<iso>-<uuid>.jsonl
// where the UUID in the filename matches the session_id. We don't know which date
// dir to look in, so search the most recent few days in both UTC and local time.
function findCodexTranscriptPath(sessionId: string): string | null {
  const base = join(homedir(), ".codex", "sessions");
  if (!existsSync(base)) return null;
  const dirs = recentCodexDateDirs(base, 3);
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".jsonl") && f.includes(sessionId)) {
        return join(dir, f);
      }
    }
  }
  return null;
}

function recentCodexDateDirs(base: string, days: number): string[] {
  const out = new Set<string>();
  const now = Date.now();
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86_400_000);
    for (const utc of [true, false]) {
      const y = utc ? d.getUTCFullYear() : d.getFullYear();
      const m = (utc ? d.getUTCMonth() : d.getMonth()) + 1;
      const day = utc ? d.getUTCDate() : d.getDate();
      const yyyy = String(y);
      const mm = String(m).padStart(2, "0");
      const dd = String(day).padStart(2, "0");
      out.add(join(base, yyyy, mm, dd));
    }
  }
  return Array.from(out);
}

export function detectClient(env = process.env, cwd = process.cwd()): ClientInfo {
  if (env.CLAUDECODE === "1" && env.CLAUDE_CODE_SESSION_ID) {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    return {
      type: "claude-code",
      session_id: sessionId,
      transcript_path: claudeTranscriptPath(sessionId, cwd),
      cwd,
    };
  }

  if (env.CODEX_HOME || env.CODEX_COMPANION_SESSION_ID || env.CODEX_RUNTIME) {
    const sessionId = env.CODEX_COMPANION_SESSION_ID ?? null;
    return {
      type: "codex",
      session_id: sessionId,
      transcript_path: sessionId ? findCodexTranscriptPath(sessionId) : null,
      cwd,
    };
  }

  return { type: "unknown", session_id: null, transcript_path: null, cwd };
}

export type ClientInfoHeader = { name?: string; version?: string };

export function clientFromHandshake(
  info: ClientInfoHeader | undefined,
  env = process.env,
  cwd = process.cwd(),
): ClientInfo {
  const name = info?.name?.toLowerCase() ?? "";

  if (name.includes("claude")) {
    const sessionId = env.CLAUDE_CODE_SESSION_ID ?? null;
    return {
      type: "claude-code",
      session_id: sessionId,
      transcript_path: sessionId ? claudeTranscriptPath(sessionId, cwd) : null,
      cwd,
    };
  }

  if (name.includes("codex")) {
    const sessionId = env.CODEX_COMPANION_SESSION_ID ?? null;
    return {
      type: "codex",
      session_id: sessionId,
      transcript_path: sessionId ? findCodexTranscriptPath(sessionId) : null,
      cwd,
    };
  }

  return detectClient(env, cwd);
}

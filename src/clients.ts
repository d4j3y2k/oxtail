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

export function detectClient(env = process.env, cwd = process.cwd()): ClientInfo {
  if (env.CLAUDECODE === "1" && env.CLAUDE_CODE_SESSION_ID) {
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    const transcript = join(
      homedir(),
      ".claude",
      "projects",
      encodeCwdForClaudeProjects(cwd),
      `${sessionId}.jsonl`,
    );
    return {
      type: "claude-code",
      session_id: sessionId,
      transcript_path: transcript,
      cwd,
    };
  }

  if (env.CODEX_HOME || env.CODEX_SESSION_ID || env.CODEX_RUNTIME) {
    return {
      type: "codex",
      session_id: env.CODEX_SESSION_ID ?? null,
      transcript_path: null,
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
    const transcript_path = sessionId
      ? join(
          homedir(),
          ".claude",
          "projects",
          encodeCwdForClaudeProjects(cwd),
          `${sessionId}.jsonl`,
        )
      : null;
    return { type: "claude-code", session_id: sessionId, transcript_path, cwd };
  }

  if (name.includes("codex")) {
    return {
      type: "codex",
      session_id: env.CODEX_SESSION_ID ?? null,
      transcript_path: null,
      cwd,
    };
  }

  return detectClient(env, cwd);
}

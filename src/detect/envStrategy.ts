import type { DetectStrategy } from "./types.js";

export function codexSessionIdFromEnv(env: NodeJS.ProcessEnv): string | null {
  return env.CODEX_THREAD_ID || env.CODEX_COMPANION_SESSION_ID || null;
}

export const envStrategy: DetectStrategy = (ctx) => {
  if (ctx.type === "claude-code") {
    const id = ctx.env.CLAUDE_CODE_SESSION_ID;
    if (id) return { session_id: id, source: "env", confidence: "high" };
    return {
      abstain: true,
      structural: true,
      reason:
        "CLAUDE_CODE_SESSION_ID not in MCP env. Claude Code strips it from MCP children (verified across the full process tree); this is structural, not a bug. The var IS available inside Bash tool subshells.",
    };
  }
  if (ctx.type === "codex") {
    const id = codexSessionIdFromEnv(ctx.env);
    if (id) return { session_id: id, source: "env", confidence: "high" };
    return {
      abstain: true,
      reason: "CODEX_THREAD_ID is not in MCP env.",
    };
  }
  return {
    abstain: true,
    reason: "client type unknown — no env var configured for this client.",
  };
};

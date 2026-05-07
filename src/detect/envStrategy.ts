import type { DetectStrategy } from "./types.js";

export const envStrategy: DetectStrategy = (ctx) => {
  if (ctx.type === "claude-code") {
    const id = ctx.env.CLAUDE_CODE_SESSION_ID;
    if (id) return { session_id: id, source: "env", confidence: "high" };
  }
  if (ctx.type === "codex") {
    const id = ctx.env.CODEX_COMPANION_SESSION_ID;
    if (id) return { session_id: id, source: "env", confidence: "high" };
  }
  return null;
};

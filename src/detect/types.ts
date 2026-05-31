import type { ClientType } from "../clients.js";

export type DetectSource = "env" | "birth-time" | "self-register" | "sticky-claim";
export type Confidence = "high" | "medium";

export type SessionIdResult = {
  session_id: string;
  source: DetectSource;
  confidence: Confidence;
};

export type StrategyAbstention = {
  abstain: true;
  reason: string;
  // True when this abstention will never resolve via retry — e.g. Claude Code
  // strips CLAUDE_CODE_SESSION_ID from MCP env, or 2+ agents in the same
  // project make birth-time fingerprinting permanently ambiguous. Lets the
  // server skip late-redetect retries that would do real I/O for no payoff.
  structural?: boolean;
};

export type StrategyOutcome = SessionIdResult | StrategyAbstention;

export type DetectContext = {
  type: ClientType;
  cwd: string;
  started_at: number;
  env: NodeJS.ProcessEnv;
};

export type DetectStrategy = (ctx: DetectContext) => StrategyOutcome;

export function isAbstain(o: StrategyOutcome): o is StrategyAbstention {
  return "abstain" in o;
}

export function isHit(o: StrategyOutcome): o is SessionIdResult {
  return !isAbstain(o);
}

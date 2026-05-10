import { birthTimeMatchStrategy } from "./birthTimeMatchStrategy.js";
import { envStrategy } from "./envStrategy.js";
import {
  isHit,
  type DetectContext,
  type DetectStrategy,
  type SessionIdResult,
  type StrategyOutcome,
} from "./types.js";

export type {
  DetectContext,
  DetectStrategy,
  SessionIdResult,
  StrategyAbstention,
  StrategyOutcome,
} from "./types.js";
export { isAbstain, isHit } from "./types.js";
export { birthTimeMatchStrategy } from "./birthTimeMatchStrategy.js";
export { envStrategy } from "./envStrategy.js";

export function composeDetectors(strategies: DetectStrategy[]) {
  return (ctx: DetectContext): SessionIdResult | null => {
    for (const strategy of strategies) {
      const result = strategy(ctx);
      if (isHit(result)) return result;
    }
    return null;
  };
}

export const detectSessionId = composeDetectors([envStrategy, birthTimeMatchStrategy]);

const NAMED_STRATEGIES: Array<[string, DetectStrategy]> = [
  ["env", envStrategy],
  ["birth-time", birthTimeMatchStrategy],
];

export type NextStep = {
  tool: "register_my_session";
  instruction: string;
  bash_command: string;
};

export type DetectDiagnosis = {
  per_strategy: Record<string, StrategyOutcome>;
  winning: (SessionIdResult & { strategy: string }) | null;
  next_step: NextStep | null;
};

function nextStepFor(ctx: DetectContext): NextStep {
  const varName =
    ctx.type === "codex" ? "CODEX_THREAD_ID" : "CLAUDE_CODE_SESSION_ID";
  return {
    tool: "register_my_session",
    instruction: `Read your own session id from a Bash tool subshell, then call register_my_session({ session_id }).`,
    bash_command: `echo $${varName}`,
  };
}

// Runs every built-in strategy and reports each outcome. When no strategy
// resolved the session id, includes a `next_step` that points the caller at
// the register_my_session escape hatch with the exact bash command to run —
// so a fresh agent doesn't have to investigate why each strategy abstained.
export function diagnoseDetect(ctx: DetectContext): DetectDiagnosis {
  const per_strategy: Record<string, StrategyOutcome> = {};
  let winning: (SessionIdResult & { strategy: string }) | null = null;
  for (const [name, strat] of NAMED_STRATEGIES) {
    const result = strat(ctx);
    per_strategy[name] = result;
    if (isHit(result) && !winning) winning = { ...result, strategy: name };
  }
  return {
    per_strategy,
    winning,
    next_step: winning ? null : nextStepFor(ctx),
  };
}

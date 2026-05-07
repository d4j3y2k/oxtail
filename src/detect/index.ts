import { birthTimeMatchStrategy } from "./birthTimeMatchStrategy.js";
import { envStrategy } from "./envStrategy.js";
import type { DetectContext, DetectStrategy, SessionIdResult } from "./types.js";

export type { DetectContext, DetectStrategy, SessionIdResult } from "./types.js";
export { birthTimeMatchStrategy } from "./birthTimeMatchStrategy.js";
export { envStrategy } from "./envStrategy.js";

export function composeDetectors(strategies: DetectStrategy[]) {
  return (ctx: DetectContext): SessionIdResult | null => {
    for (const strategy of strategies) {
      const result = strategy(ctx);
      if (result) return result;
    }
    return null;
  };
}

export const detectSessionId = composeDetectors([envStrategy, birthTimeMatchStrategy]);

const NAMED_STRATEGIES: Array<[string, DetectStrategy]> = [
  ["env", envStrategy],
  ["birth-time", birthTimeMatchStrategy],
];

export type DetectDiagnosis = {
  per_strategy: Record<string, SessionIdResult | null>;
  winning: (SessionIdResult & { strategy: string }) | null;
};

// Runs every built-in strategy and reports each outcome — primarily for
// debugging via the `get_my_session` MCP tool.
export function diagnoseDetect(ctx: DetectContext): DetectDiagnosis {
  const per_strategy: Record<string, SessionIdResult | null> = {};
  let winning: (SessionIdResult & { strategy: string }) | null = null;
  for (const [name, strat] of NAMED_STRATEGIES) {
    const result = strat(ctx);
    per_strategy[name] = result;
    if (result && !winning) winning = { ...result, strategy: name };
  }
  return { per_strategy, winning };
}

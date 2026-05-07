import { envStrategy } from "./envStrategy.js";
import type { DetectContext, DetectStrategy, SessionIdResult } from "./types.js";

export type { DetectContext, DetectStrategy, SessionIdResult } from "./types.js";
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

// Default composer. Birth-time strategy is added in Phase 5.
export const detectSessionId = composeDetectors([envStrategy]);

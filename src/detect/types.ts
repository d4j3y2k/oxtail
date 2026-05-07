import type { ClientType } from "../clients.js";

export type DetectSource = "env" | "birth-time" | "self-register";
export type Confidence = "high" | "medium";

export type SessionIdResult = {
  session_id: string;
  source: DetectSource;
  confidence: Confidence;
};

export type DetectContext = {
  type: ClientType;
  cwd: string;
  started_at: number;
  env: NodeJS.ProcessEnv;
};

export type DetectStrategy = (ctx: DetectContext) => SessionIdResult | null;

import { existsSync, readFileSync } from "node:fs";

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
};

export type TranscriptResult = {
  messages: TranscriptMessage[];
  truncated: boolean;
  total_messages: number;
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function extractTextFromClaudeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; content?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

export function readClaudeTranscript(path: string, limit = 100): TranscriptResult {
  if (!existsSync(path)) {
    return { messages: [], truncated: false, total_messages: 0 };
  }
  const raw = readFileSync(path, "utf8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    const role = obj.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextFromClaudeContent(obj.message?.content);
    if (!text) continue;
    messages.push({ role, text, timestamp: obj.timestamp ?? null });
  }
  const safeLimit = clamp(limit, 1, 1000);
  const truncated = messages.length > safeLimit;
  const tail = truncated ? messages.slice(-safeLimit) : messages;
  return { messages: tail, truncated, total_messages: messages.length };
}

// Codex CLI injects two kinds of blocks into the first user message of a
// rollout that look identical to user input at the role/type level:
//   1. The AGENTS.md preamble, prefixed with the literal "# AGENTS.md
//      instructions for " and wrapped in <INSTRUCTIONS>...</INSTRUCTIONS>.
//   2. An <environment_context>...</environment_context> block.
// Both prefixes are emitted by Codex itself, not typed by the user, so we
// drop them at the block level — preserving any other blocks in the same
// message in the unlikely case a real user authored mixed content.
export function isCodexInjectedBlock(text: string): boolean {
  const t = text.trimStart();
  if (t.startsWith("# AGENTS.md instructions for ")) return true;
  const trimmed = text.trim();
  if (trimmed.startsWith("<environment_context>") && trimmed.endsWith("</environment_context>")) {
    return true;
  }
  return false;
}

function extractTextFromCodexContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
      if (isCodexInjectedBlock(b.text)) continue;
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

export function readCodexTranscript(path: string, limit = 100): TranscriptResult {
  if (!existsSync(path)) {
    return { messages: [], truncated: false, total_messages: 0 };
  }
  const raw = readFileSync(path, "utf8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let obj: {
      type?: string;
      timestamp?: string;
      payload?: { type?: string; role?: string; content?: unknown };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "response_item") continue;
    const p = obj.payload;
    if (!p || p.type !== "message") continue;
    const role = p.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractTextFromCodexContent(p.content);
    if (!text) continue;
    messages.push({ role, text, timestamp: obj.timestamp ?? null });
  }
  const safeLimit = clamp(limit, 1, 1000);
  const truncated = messages.length > safeLimit;
  const tail = truncated ? messages.slice(-safeLimit) : messages;
  return { messages: tail, truncated, total_messages: messages.length };
}

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

function extractTextFromCodexContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if ((b.type === "input_text" || b.type === "output_text") && typeof b.text === "string") {
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

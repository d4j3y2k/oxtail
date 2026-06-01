import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";

export type TranscriptMessage = {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
};

export type TranscriptResult = {
  messages: TranscriptMessage[];
  // `truncated` is the legacy "did you get everything?" flag — true when EITHER
  // the message-count cap (`limit`) dropped messages OR the byte budget
  // (`maxBytes`) shortened/dropped content. The two specific flags below let a
  // reader tell which kind of truncation happened (Codex review: agents need to
  // distinguish "fewer messages" from "shortened bodies").
  truncated: boolean;
  count_truncated: boolean;
  bytes_truncated: boolean;
  // Exact in the default full-scan path. In opt-in tail-scan mode it's exact
  // only when the reverse scan reached the start of file; otherwise it's null
  // (unknown — more messages exist above the returned window) and
  // total_messages_exact is false.
  total_messages: number | null;
  total_messages_exact: boolean;
};

export type ReadTranscriptOptions = {
  // Max number of messages to return (tail-preserving). Default DEFAULT_LIMIT.
  limit?: number;
  // Max total UTF-8 bytes of message TEXT to return, applied newest-first and
  // tail-preserving. Default DEFAULT_MAX_BYTES. This is the byte/token budget
  // that keeps a casual peer-read from blowing a context window.
  maxBytes?: number;
  // Timestamps are dropped (null) by default — most readers never use them and
  // a full ISO string per message is ~24 bytes of pure overhead. The field is
  // always PRESENT (shape stable); only its value is gated. Set true to keep.
  includeTimestamps?: boolean;
  // Opt-in: read the tail of the file by scanning chunks from the END rather
  // than parsing the whole transcript. Avoids full-file parse cost on large
  // transcripts. Trade-off: total_messages is exact only when the scan reaches
  // the start of file; otherwise null with total_messages_exact:false. Default
  // (false) keeps the exact full-scan behavior.
  tailScan?: boolean;
  // Bytes per reverse-read chunk (tail-scan only). Defaults to
  // DEFAULT_CHUNK_SIZE; mainly a knob for exercising the chunk-boundary path.
  chunkSize?: number;
};

// Defaults are deliberately conservative: a casual read returns at most ~20
// recent messages and ~24KB of text (~6k tokens). To pull a full transcript,
// callers explicitly raise `limit` (up to MAX_LIMIT) and `maxBytes` (up to
// MAX_MAX_BYTES) — an explicit override rather than an easy `full` footgun.
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 1000;
export const DEFAULT_MAX_BYTES = 24_000;
export const MIN_MAX_BYTES = 256;
export const MAX_MAX_BYTES = 1_000_000;
export const DEFAULT_CHUNK_SIZE = 65_536;
export const MIN_CHUNK_SIZE = 16;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Non-finite inputs (NaN/±Infinity) would slip past clamp() and produce nonsense
// (e.g. NaN budget → slice(NaN) returns everything, or zero with a bogus
// truncation flag). Coerce anything non-finite to the supplied default so the
// exported reader API is robust even when called directly (not just via zod).
// Per Codex Phase-B hardening note.
function finiteOr(n: number | undefined, fallback: number): number {
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

// Truncate `s` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multi-byte
// code point. Iterating the string yields whole code points, so we never emit a
// partial/garbled character at the boundary.
function truncateToBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  let out = "";
  let bytes = 0;
  for (const ch of s) {
    const cb = Buffer.byteLength(ch, "utf8");
    if (bytes + cb > maxBytes) break;
    out += ch;
    bytes += cb;
  }
  return out;
}

// Apply the byte budget to an already count-tailed, chronological message list.
// Walk newest→oldest so the MOST RECENT content is what survives the budget
// (tail-preserving). The oldest message that crosses the budget is head-
// truncated with a marker; everything older than it is dropped. Returns the
// kept messages back in chronological order.
function applyByteBudget(
  messages: TranscriptMessage[],
  maxBytes: number,
): { kept: TranscriptMessage[]; bytesTruncated: boolean } {
  let remaining = maxBytes;
  let bytesTruncated = false;
  const keptReversed: TranscriptMessage[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const tb = Buffer.byteLength(m.text, "utf8");
    if (tb <= remaining) {
      keptReversed.push(m);
      remaining -= tb;
      continue;
    }
    // This message overflows the remaining budget.
    if (remaining > 0) {
      const head = truncateToBytes(m.text, remaining);
      const droppedBytes = tb - Buffer.byteLength(head, "utf8");
      keptReversed.push({ ...m, text: `${head}…[+${droppedBytes}B truncated]` });
    }
    bytesTruncated = true;
    break; // older messages fall outside the budget
  }
  return { kept: keptReversed.reverse(), bytesTruncated };
}

// Shared finalize step for both readers: count-tail to `limit`, then apply the
// byte budget, then gate timestamps. Keeps the two truncation signals distinct.
function finalize(all: TranscriptMessage[], opts: ReadTranscriptOptions): TranscriptResult {
  const limit = clamp(Math.floor(finiteOr(opts.limit, DEFAULT_LIMIT)), 1, MAX_LIMIT);
  const maxBytes = clamp(
    Math.floor(finiteOr(opts.maxBytes, DEFAULT_MAX_BYTES)),
    MIN_MAX_BYTES,
    MAX_MAX_BYTES,
  );
  const includeTimestamps = opts.includeTimestamps ?? false;

  const total = all.length;
  const countTruncated = total > limit;
  const tail = countTruncated ? all.slice(-limit) : all.slice();

  const { kept, bytesTruncated } = applyByteBudget(tail, maxBytes);
  const messages = kept.map((m) => ({
    role: m.role,
    text: m.text,
    timestamp: includeTimestamps ? m.timestamp : null,
  }));

  return {
    messages,
    truncated: countTruncated || bytesTruncated,
    count_truncated: countTruncated,
    bytes_truncated: bytesTruncated,
    total_messages: total,
    total_messages_exact: true,
  };
}

const EMPTY_RESULT: TranscriptResult = {
  messages: [],
  truncated: false,
  count_truncated: false,
  bytes_truncated: false,
  total_messages: 0,
  total_messages_exact: true,
};

// Split a buffer on the newline byte (0x0A). Safe for UTF-8 because 0x0A never
// appears inside a multi-byte sequence (continuation/lead bytes are all ≥ 0x80).
// The trailing segment (after the last newline) is always included, possibly
// empty. Returned as views; callers copy the one they retain across reads.
function splitBufferByNewline(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      out.push(buf.subarray(start, i));
      start = i + 1;
    }
  }
  out.push(buf.subarray(start));
  return out;
}

// Reverse-tail reader: walk the file backward in chunks, decoding only complete
// lines, until we've collected `limit` messages or reached the start of file.
// `parseLine` is the same per-line→message logic the full-scan path uses, so the
// returned messages are byte-identical to a full scan; only the SCAN STRATEGY
// differs. UTF-8 safety: incomplete leftmost lines are carried as raw BYTES and
// only decoded once a newline to their left completes them (or BOF is reached),
// so a multi-byte char split across a chunk boundary is always reassembled
// before decoding.
function readTailScan(
  path: string,
  parseLine: (line: string) => TranscriptMessage | null,
  opts: ReadTranscriptOptions,
): TranscriptResult {
  const limit = clamp(Math.floor(finiteOr(opts.limit, DEFAULT_LIMIT)), 1, MAX_LIMIT);
  const maxBytes = clamp(
    Math.floor(finiteOr(opts.maxBytes, DEFAULT_MAX_BYTES)),
    MIN_MAX_BYTES,
    MAX_MAX_BYTES,
  );
  const includeTimestamps = opts.includeTimestamps ?? false;
  const chunkSize = Math.max(
    MIN_CHUNK_SIZE,
    Math.floor(finiteOr(opts.chunkSize, DEFAULT_CHUNK_SIZE)),
  );

  const newestFirst: TranscriptMessage[] = [];
  // `hitLimit` — we stopped because we collected `limit` messages, so MORE may
  // exist above the window. Exactness keys on this, NOT on reaching byte-offset
  // 0: a small file fits in one chunk, so we can read every byte yet still cap
  // out mid-chunk having skipped older messages. The total is exact only when we
  // never capped — i.e. we accounted for every message in the file.
  let hitLimit = false;
  const fd = openSync(path, "r");
  try {
    let pos = fstatSync(fd).size;
    let leftover = Buffer.alloc(0); // bytes of the not-yet-complete leftmost line
    while (pos > 0 && !hitLimit) {
      const readSize = Math.min(chunkSize, pos);
      pos -= readSize;
      const chunk = Buffer.allocUnsafe(readSize);
      readSync(fd, chunk, 0, readSize, pos);
      const buf = Buffer.concat([chunk, leftover]);
      const segments = splitBufferByNewline(buf);
      // segments[0] is the new leftmost partial (extends further left, unless we
      // reach BOF next); copy it so we don't retain the whole `buf`.
      leftover = Buffer.from(segments[0]);
      // segments[1..] are complete lines; process right→left so newest first.
      for (let i = segments.length - 1; i >= 1; i--) {
        const line = segments[i].toString("utf8");
        if (!line) continue;
        const m = parseLine(line);
        if (m) {
          newestFirst.push(m);
          if (newestFirst.length >= limit) {
            hitLimit = true;
            break;
          }
        }
      }
    }
    // Consumed the whole file without ever capping → the final leftover is the
    // file's first line; process it so the count is complete and exact.
    if (!hitLimit && pos === 0) {
      const line = leftover.toString("utf8");
      if (line) {
        const m = parseLine(line);
        if (m) newestFirst.push(m);
      }
    }
  } finally {
    closeSync(fd);
  }

  const exact = !hitLimit; // every message accounted for iff we never capped
  const chronological = newestFirst.slice().reverse();
  const { kept, bytesTruncated } = applyByteBudget(chronological, maxBytes);
  const messages = kept.map((m) => ({
    role: m.role,
    text: m.text,
    timestamp: includeTimestamps ? m.timestamp : null,
  }));
  return {
    messages,
    truncated: !exact || bytesTruncated,
    count_truncated: !exact,
    bytes_truncated: bytesTruncated,
    total_messages: exact ? newestFirst.length : null,
    total_messages_exact: exact,
  };
}

// A bare number is accepted as a legacy `{ limit }` for backward compat with
// older call sites/tests that passed a message count positionally.
function normalizeOptions(opts?: ReadTranscriptOptions | number): ReadTranscriptOptions {
  if (typeof opts === "number") return { limit: opts };
  return opts ?? {};
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

// Per-line parse for Claude transcripts. Returns null for any line that isn't a
// non-empty user/assistant message (malformed JSON, wrong type/role, empty
// text). Shared by the full-scan and tail-scan paths so they agree exactly.
function parseClaudeLine(line: string): TranscriptMessage | null {
  let obj: { type?: string; message?: { role?: string; content?: unknown }; timestamp?: string };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj.type !== "user" && obj.type !== "assistant") return null;
  const role = obj.message?.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = extractTextFromClaudeContent(obj.message?.content);
  if (!text) return null;
  return { role, text, timestamp: obj.timestamp ?? null };
}

export function readClaudeTranscript(
  path: string,
  opts?: ReadTranscriptOptions | number,
): TranscriptResult {
  const options = normalizeOptions(opts);
  if (!existsSync(path)) return EMPTY_RESULT;
  if (options.tailScan) return readTailScan(path, parseClaudeLine, options);
  const raw = readFileSync(path, "utf8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const m = parseClaudeLine(line);
    if (m) messages.push(m);
  }
  return finalize(messages, options);
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

// Per-line parse for Codex rollouts. Drops non-message response_items, wrong
// roles, injected AGENTS.md/environment_context blocks, and empty text. Shared
// by the full-scan and tail-scan paths.
function parseCodexLine(line: string): TranscriptMessage | null {
  let obj: {
    type?: string;
    timestamp?: string;
    payload?: { type?: string; role?: string; content?: unknown };
  };
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj.type !== "response_item") return null;
  const p = obj.payload;
  if (!p || p.type !== "message") return null;
  const role = p.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = extractTextFromCodexContent(p.content);
  if (!text) return null;
  return { role, text, timestamp: obj.timestamp ?? null };
}

export function readCodexTranscript(
  path: string,
  opts?: ReadTranscriptOptions | number,
): TranscriptResult {
  const options = normalizeOptions(opts);
  if (!existsSync(path)) return EMPTY_RESULT;
  if (options.tailScan) return readTailScan(path, parseCodexLine, options);
  const raw = readFileSync(path, "utf8");
  const messages: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const m = parseCodexLine(line);
    if (m) messages.push(m);
  }
  return finalize(messages, options);
}

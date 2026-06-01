import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCodexInjectedBlock, readClaudeTranscript, readCodexTranscript } from "./transcripts.js";

test("isCodexInjectedBlock: AGENTS.md preamble prefix", () => {
  assert.equal(
    isCodexInjectedBlock("# AGENTS.md instructions for /Users/foo/dev/bar\n\n<INSTRUCTIONS>...</INSTRUCTIONS>"),
    true,
  );
});

test("isCodexInjectedBlock: environment_context block", () => {
  assert.equal(
    isCodexInjectedBlock("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
    true,
  );
});

test("isCodexInjectedBlock: real user prose preserved even when it mentions tags", () => {
  assert.equal(
    isCodexInjectedBlock("can you check the <environment_context> tag handling in transcripts.ts"),
    false,
  );
});

test("isCodexInjectedBlock: empty / whitespace input", () => {
  assert.equal(isCodexInjectedBlock(""), false);
  assert.equal(isCodexInjectedBlock("   \n\t"), false);
});

function writeTempRollout(lines: object[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-transcripts-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readCodexTranscript: drops the AGENTS.md preamble message entirely", () => {
  const { path, cleanup } = writeTempRollout([
    {
      type: "response_item",
      timestamp: "2026-05-08T13:28:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>x</INSTRUCTIONS>" },
          { type: "input_text", text: "<environment_context><cwd>/repo</cwd></environment_context>" },
        ],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-08T13:29:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "real first user message" }],
      },
    },
  ]);
  try {
    const result = readCodexTranscript(path);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.text, "real first user message");
  } finally {
    cleanup();
  }
});

test("readCodexTranscript: in a mixed message, injected block is dropped but real prose survives", () => {
  const { path, cleanup } = writeTempRollout([
    {
      type: "response_item",
      timestamp: "2026-05-08T13:28:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<environment_context><cwd>/repo</cwd></environment_context>" },
          { type: "input_text", text: "actual question from the user" },
        ],
      },
    },
  ]);
  try {
    const result = readCodexTranscript(path);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.text, "actual question from the user");
  } finally {
    cleanup();
  }
});

test("readCodexTranscript: developer-role messages are still skipped", () => {
  const { path, cleanup } = writeTempRollout([
    {
      type: "response_item",
      timestamp: "2026-05-08T13:28:00.000Z",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions>...</permissions>" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-08T13:29:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    },
  ]);
  try {
    const result = readCodexTranscript(path);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0]!.role, "user");
    assert.equal(result.messages[0]!.text, "hi");
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase B — transcript payload caps (count budget, byte budget, timestamps)
// ────────────────────────────────────────────────────────────────────────────

function claudeLine(text: string, ts = "2026-05-08T13:28:00.000Z", role: "user" | "assistant" = "user") {
  return { type: role, message: { role, content: [{ type: "text", text }] }, timestamp: ts };
}

function writeRawLines(lines: string[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-transcripts-raw-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines.join("\n") + "\n");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("phase-b: under both budgets → nothing truncated, timestamps null by default", () => {
  const { path, cleanup } = writeTempRollout([claudeLine("alpha"), claudeLine("beta")]);
  try {
    const r = readClaudeTranscript(path);
    assert.equal(r.total_messages, 2);
    assert.equal(r.messages.length, 2);
    assert.equal(r.truncated, false);
    assert.equal(r.count_truncated, false);
    assert.equal(r.bytes_truncated, false);
    assert.equal(r.messages[0]!.timestamp, null, "timestamps dropped (null) by default");
    assert.equal(r.messages[1]!.text, "beta");
  } finally {
    cleanup();
  }
});

test("phase-b: count budget keeps the TAIL and sets count_truncated only", () => {
  const lines = Array.from({ length: 30 }, (_, i) => claudeLine(`msg ${i}`));
  const { path, cleanup } = writeTempRollout(lines);
  try {
    const r = readClaudeTranscript(path, { limit: 5 });
    assert.equal(r.total_messages, 30, "total reflects the true count, not the returned slice");
    assert.equal(r.messages.length, 5);
    assert.equal(r.count_truncated, true);
    assert.equal(r.bytes_truncated, false);
    assert.equal(r.truncated, true);
    assert.equal(r.messages[0]!.text, "msg 25", "tail-preserving: first returned is the 26th");
    assert.equal(r.messages[4]!.text, "msg 29", "last returned is the newest");
  } finally {
    cleanup();
  }
});

test("phase-b: byte budget truncates a long single message and sets bytes_truncated only", () => {
  const big = "x".repeat(5000);
  const { path, cleanup } = writeTempRollout([claudeLine(big)]);
  try {
    const r = readClaudeTranscript(path, { maxBytes: 1000 });
    assert.equal(r.total_messages, 1);
    assert.equal(r.messages.length, 1);
    assert.equal(r.count_truncated, false);
    assert.equal(r.bytes_truncated, true);
    assert.equal(r.truncated, true);
    const txt = r.messages[0]!.text;
    assert.ok(txt.startsWith("xxxx"), "keeps the head of the message");
    assert.match(txt, /…\[\+\d+B truncated\]$/, "carries an explicit truncation marker");
    // Body bytes bounded by the budget (marker is small meta overhead on top).
    assert.ok(
      Buffer.byteLength(txt, "utf8") <= 1000 + 40,
      `truncated body should be near the budget, got ${Buffer.byteLength(txt, "utf8")} bytes`,
    );
  } finally {
    cleanup();
  }
});

test("phase-b: byte budget is newest-first — drops the OLDEST, keeps newest intact", () => {
  const a = "a".repeat(100);
  const b = "b".repeat(100);
  const c = "c".repeat(100);
  const { path, cleanup } = writeTempRollout([claudeLine(a), claudeLine(b), claudeLine(c)]);
  try {
    // Budget 150: newest 'c' (100) fits; 'b' overflows the remaining 50 → head-
    // truncated; 'a' falls outside the budget and is dropped.
    const r = readClaudeTranscript(path, { maxBytes: 150 });
    assert.equal(r.total_messages, 3);
    assert.equal(r.count_truncated, false);
    assert.equal(r.bytes_truncated, true);
    assert.equal(r.messages[r.messages.length - 1]!.text, c, "newest message survives intact");
    assert.ok(!r.messages.some((m) => m.text === a), "oldest message dropped for budget");
    assert.ok(r.messages.some((m) => m.text.startsWith("bbbb")), "boundary message head-truncated");
  } finally {
    cleanup();
  }
});

test("phase-b: include_timestamps opt-in surfaces the ISO timestamp", () => {
  const { path, cleanup } = writeTempRollout([claudeLine("hello", "2026-05-08T13:28:00.000Z")]);
  try {
    const def = readClaudeTranscript(path);
    assert.equal(def.messages[0]!.timestamp, null, "default omits timestamp value");
    const withTs = readClaudeTranscript(path, { includeTimestamps: true });
    assert.equal(withTs.messages[0]!.timestamp, "2026-05-08T13:28:00.000Z");
  } finally {
    cleanup();
  }
});

test("phase-b: byte truncation never splits a multi-byte UTF-8 code point", () => {
  // 1000 emoji × 4 bytes each = 4000 bytes. A naive byte slice would split the
  // boundary emoji and yield U+FFFD; truncateToBytes must keep whole code points.
  const emoji = "😀".repeat(1000);
  const { path, cleanup } = writeTempRollout([claudeLine(emoji)]);
  try {
    // 1001 is deliberately NOT a multiple of 4: a correct boundary stops at 1000
    // bytes (250 whole emoji) rather than slicing a 4th byte off the 251st.
    const budget = 1001;
    const r = readClaudeTranscript(path, { maxBytes: budget });
    const txt = r.messages[0]!.text;
    assert.equal(r.bytes_truncated, true);
    assert.ok(!txt.includes("�"), "no replacement char — code point was not split");
    const head = txt.replace(/…\[\+\d+B truncated\]$/, "");
    const headBytes = Buffer.byteLength(head, "utf8");
    assert.equal(headBytes % 4, 0, "head is a whole number of 4-byte emoji");
    assert.ok(headBytes <= budget, `head respects the byte budget (${headBytes} <= ${budget})`);
    assert.equal(headBytes, 1000, "stopped at the last whole code point under the budget");
  } finally {
    cleanup();
  }
});

test("phase-b: malformed and blank JSONL lines are skipped, valid messages survive", () => {
  const { path, cleanup } = writeRawLines([
    JSON.stringify(claudeLine("first")),
    "{ this is not valid json",
    "",
    "   ",
    JSON.stringify(claudeLine("second")),
  ]);
  try {
    const r = readClaudeTranscript(path);
    assert.equal(r.total_messages, 2, "two valid messages, malformed/blank lines ignored");
    assert.deepEqual(r.messages.map((m) => m.text), ["first", "second"]);
    assert.equal(r.truncated, false);
  } finally {
    cleanup();
  }
});

test("phase-b: limit and max_bytes are clamped to safe bounds", () => {
  const lines = Array.from({ length: 50 }, (_, i) => claudeLine(`m${i}`));
  const { path, cleanup } = writeTempRollout(lines);
  try {
    // limit 0 clamps up to 1; a single most-recent message comes back.
    const lo = readClaudeTranscript(path, { limit: 0 });
    assert.equal(lo.messages.length, 1);
    assert.equal(lo.messages[0]!.text, "m49");
    // Absurdly high limit clamps to MAX_LIMIT (1000) — all 50 returned, no count cut.
    const hi = readClaudeTranscript(path, { limit: 10_000_000 });
    assert.equal(hi.messages.length, 50);
    assert.equal(hi.count_truncated, false);
  } finally {
    cleanup();
  }
});

test("phase-b: non-finite budgets (NaN/Infinity) fall back to defaults, not nonsense", () => {
  const lines = Array.from({ length: 50 }, (_, i) => claudeLine(`m${i}`));
  const { path, cleanup } = writeTempRollout(lines);
  try {
    // NaN limit must behave like the default (20), NOT slice(NaN)→everything.
    const nanLimit = readClaudeTranscript(path, { limit: NaN });
    assert.equal(nanLimit.messages.length, 20, "NaN limit falls back to DEFAULT_LIMIT");
    assert.equal(nanLimit.count_truncated, true);
    // NaN maxBytes must behave like the default budget, NOT drop everything.
    const nanBytes = readClaudeTranscript(path, { maxBytes: NaN });
    assert.equal(nanBytes.bytes_truncated, false, "NaN maxBytes falls back to a real budget");
    assert.ok(nanBytes.messages.length > 0, "NaN maxBytes must not zero out the result");
    // Infinity likewise coerces to the default.
    const infLimit = readClaudeTranscript(path, { limit: Infinity });
    assert.equal(infLimit.messages.length, 20, "Infinity limit falls back to DEFAULT_LIMIT");
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase E — opt-in reverse-tail reader (tail_scan)
// ────────────────────────────────────────────────────────────────────────────

test("phase-e: tail_scan equals full scan across many chunk sizes (boundary fuzz)", () => {
  // Mixed roles, varying widths, and emoji so chunk boundaries land mid-line and
  // mid-codepoint. The reverse scan must reproduce the full scan exactly.
  const lines = Array.from({ length: 25 }, (_, i) =>
    claudeLine(
      `line ${i} — ${"abc".repeat(i % 7)} 😀${i}`,
      "2026-01-01T00:00:00.000Z",
      i % 2 ? "assistant" : "user",
    ),
  );
  const { path, cleanup } = writeTempRollout(lines);
  try {
    const full = readClaudeTranscript(path, { limit: 1000, includeTimestamps: true });
    for (const chunkSize of [16, 17, 23, 64, 4096]) {
      const tail = readClaudeTranscript(path, {
        limit: 1000,
        includeTimestamps: true,
        tailScan: true,
        chunkSize,
      });
      assert.deepEqual(tail.messages, full.messages, `messages mismatch at chunkSize ${chunkSize}`);
      assert.equal(tail.total_messages, full.total_messages, `total mismatch at chunkSize ${chunkSize}`);
      assert.equal(tail.total_messages_exact, true, `should be exact at chunkSize ${chunkSize}`);
      assert.equal(tail.count_truncated, false);
    }
  } finally {
    cleanup();
  }
});

test("phase-e: tail_scan caps to the newest messages and qualifies the total", () => {
  const lines = Array.from({ length: 30 }, (_, i) => claudeLine(`msg ${i}`));
  const { path, cleanup } = writeTempRollout(lines);
  try {
    const tail = readClaudeTranscript(path, { limit: 3, tailScan: true, chunkSize: 16 });
    assert.equal(tail.messages.length, 3);
    assert.deepEqual(tail.messages.map((m) => m.text), ["msg 27", "msg 28", "msg 29"]);
    assert.equal(tail.count_truncated, true, "stopped at the cap → count_truncated");
    assert.equal(tail.total_messages, null, "total unknown when the scan stopped early");
    assert.equal(tail.total_messages_exact, false);
  } finally {
    cleanup();
  }
});

test("phase-e: tail_scan reassembles multi-byte chars accumulated across chunks", () => {
  const text = "hello 😀 world 🎉 multibyte ✅ end";
  const { path, cleanup } = writeTempRollout([claudeLine(text)]);
  try {
    const tail = readClaudeTranscript(path, { tailScan: true, chunkSize: 16 });
    assert.equal(tail.messages.length, 1);
    assert.equal(tail.messages[0]!.text, text, "multibyte text decoded intact across chunk reads");
    assert.ok(!tail.messages[0]!.text.includes("�"), "no replacement char");
  } finally {
    cleanup();
  }
});

test("phase-e: tail_scan skips malformed and blank lines like the full scan", () => {
  const { path, cleanup } = writeRawLines([
    JSON.stringify(claudeLine("first")),
    "{ this is not valid json",
    "",
    "   ",
    JSON.stringify(claudeLine("second")),
  ]);
  try {
    const tail = readClaudeTranscript(path, { limit: 100, tailScan: true, chunkSize: 16 });
    assert.deepEqual(tail.messages.map((m) => m.text), ["first", "second"]);
    assert.equal(tail.total_messages, 2);
    assert.equal(tail.total_messages_exact, true);
  } finally {
    cleanup();
  }
});

test("phase-e: tail_scan applies Codex injected-block filtering", () => {
  const { path, cleanup } = writeTempRollout([
    {
      type: "response_item",
      timestamp: "2026-05-08T13:28:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "# AGENTS.md instructions for /repo\n<INSTRUCTIONS>x</INSTRUCTIONS>" },
        ],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-08T13:29:00.000Z",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real codex message" }] },
    },
  ]);
  try {
    const tail = readCodexTranscript(path, { limit: 100, tailScan: true, chunkSize: 16 });
    assert.equal(tail.messages.length, 1, "injected AGENTS.md block dropped");
    assert.equal(tail.messages[0]!.text, "real codex message");
    assert.equal(tail.total_messages, 1);
  } finally {
    cleanup();
  }
});

test("phase-e: tail_scan honors the byte budget (long message head-truncated)", () => {
  const big = "y".repeat(5000);
  const { path, cleanup } = writeTempRollout([claudeLine(big)]);
  try {
    const tail = readClaudeTranscript(path, { tailScan: true, chunkSize: 64, maxBytes: 1000 });
    assert.equal(tail.messages.length, 1);
    assert.equal(tail.bytes_truncated, true);
    assert.ok(tail.messages[0]!.text.startsWith("yyyy"));
    assert.match(tail.messages[0]!.text, /…\[\+\d+B truncated\]$/);
  } finally {
    cleanup();
  }
});

test("phase-e: tail_scan handles a file with no trailing newline", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-e-notrail-"));
  const path = join(dir, "t.jsonl");
  // Note: NO trailing newline — the last line is bounded by EOF.
  writeFileSync(path, [JSON.stringify(claudeLine("alpha")), JSON.stringify(claudeLine("omega"))].join("\n"));
  try {
    const tail = readClaudeTranscript(path, { limit: 100, tailScan: true, chunkSize: 16 });
    assert.deepEqual(tail.messages.map((m) => m.text), ["alpha", "omega"]);
    assert.equal(tail.total_messages, 2);
    assert.equal(tail.total_messages_exact, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase-e: tail_scan on empty and missing files returns empty + exact", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-e-empty-"));
  const empty = join(dir, "empty.jsonl");
  writeFileSync(empty, "");
  try {
    const e = readClaudeTranscript(empty, { tailScan: true });
    assert.deepEqual(e.messages, []);
    assert.equal(e.total_messages, 0);
    assert.equal(e.total_messages_exact, true);
    const missing = readClaudeTranscript(join(dir, "does-not-exist.jsonl"), { tailScan: true });
    assert.deepEqual(missing.messages, []);
    assert.equal(missing.total_messages, 0);
    assert.equal(missing.total_messages_exact, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

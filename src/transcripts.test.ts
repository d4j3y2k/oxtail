import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isCodexInjectedBlock, readCodexTranscript } from "./transcripts.js";

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

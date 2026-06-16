import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentKey, normalizeTool, scanLatestTool } from "./activity.js";
import { scanTailLines } from "../transcripts.js";

// A stand-in for scanTailLines that feeds pre-authored lines NEWEST-FIRST (the
// order the real reverse reader delivers them), so the parser logic is unit-tested
// without touching the filesystem.
function fakeScan(linesNewestFirst: string[]): typeof scanTailLines {
  return ((_path: string, onLine: (l: string) => "stop" | "continue") => {
    for (const line of linesNewestFirst) {
      if (onLine(line) === "stop") return { reachedBOF: false };
    }
    return { reachedBOF: true };
  }) as typeof scanTailLines;
}

const cTool = (id: string, name: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] } });
const cResult = (id: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const cText = (t: string) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });

const xCall = (call_id: string, name: string, namespace?: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "function_call", name, call_id, ...(namespace ? { namespace } : {}) } });
const xOut = (call_id: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id } });
const xEvent = (t: string) => JSON.stringify({ type: "event_msg", payload: { type: t } });

test("scanLatestTool — Claude tool running (no result yet)", () => {
  const a = scanLatestTool("x", "claude-code", fakeScan([cTool("t1", "Bash")]));
  assert.deepEqual(a, { tool: "bash", tool_raw: "Bash", tool_running: true });
});

test("scanLatestTool — Claude tool done (result seen newer)", () => {
  // newest-first: the result is newer than the call.
  const a = scanLatestTool("x", "claude-code", fakeScan([cResult("t1"), cTool("t1", "Bash")]));
  assert.equal(a?.tool_running, false);
  assert.equal(a?.tool, "bash");
});

test("scanLatestTool — Claude oxtail MCP tool maps to oxtail", () => {
  const a = scanLatestTool("x", "claude-code", fakeScan([cTool("t2", "mcp__oxtail__ask_peer")]));
  assert.equal(a?.tool, "oxtail");
  assert.equal(a?.tool_raw, "mcp__oxtail__ask_peer");
});

test("scanLatestTool — Claude stops at the LATEST tool_use", () => {
  // Edit is newest (first in newest-first order); older Bash must be ignored.
  const a = scanLatestTool("x", "claude-code", fakeScan([cTool("t3", "Edit"), cResult("t0"), cTool("t0", "Bash")]));
  assert.equal(a?.tool, "edit");
  assert.equal(a?.tool_running, true);
});

test("scanLatestTool — no tool in tail ⇒ honest null (not idle)", () => {
  assert.equal(scanLatestTool("x", "claude-code", fakeScan([cText("hi"), cText("yo")])), null);
});

test("scanLatestTool — Codex function_call running, namespace ignored for bash", () => {
  const a = scanLatestTool("x", "codex", fakeScan([xCall("c1", "exec_command")]));
  assert.deepEqual(a, { tool: "bash", tool_raw: "exec_command", tool_running: true });
});

test("scanLatestTool — Codex preserves MCP namespace in tool_raw (codex #4)", () => {
  const a = scanLatestTool("x", "codex", fakeScan([xCall("c2", "read_my_messages", "mcp__oxtail")]));
  assert.equal(a?.tool, "oxtail");
  assert.equal(a?.tool_raw, "mcp__oxtail.read_my_messages");
});

test("scanLatestTool — Codex running/done by call_id, not adjacency (codex #3)", () => {
  // Chronological: callA c1, callB c2, outputB c2, outputA c1 → newest-first reversed.
  // Latest call is B and it IS done (output B exists), even though output A is newest.
  const newestFirst = [xOut("c1"), xOut("c2"), xCall("c2", "apply_patch"), xCall("c1", "exec_command")];
  const a = scanLatestTool("x", "codex", fakeScan(newestFirst));
  assert.equal(a?.tool, "edit"); // apply_patch (the latest call, B)
  assert.equal(a?.tool_running, false); // its call_id c2 has an output
});

test("scanLatestTool — Codex ignores event_msg lines", () => {
  const a = scanLatestTool("x", "codex", fakeScan([xEvent("token_count"), xEvent("agent_message"), xCall("c9", "exec_command")]));
  assert.equal(a?.tool, "bash");
  assert.equal(a?.tool_running, true);
});

test("scanLatestTool — torn/partial JSON lines are skipped", () => {
  const a = scanLatestTool("x", "claude-code", fakeScan(["{not json", cTool("t1", "Read")]));
  assert.equal(a?.tool, "read");
});

test("scanLatestTool — real reverse reader end-to-end (Claude)", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxpit-act-"));
  try {
    const path = join(dir, "t.jsonl");
    // chronological order (oldest→newest), as a real transcript is written.
    writeFileSync(path, [cText("start"), cTool("u1", "Grep"), cResult("u1"), cTool("u2", "Write")].join("\n") + "\n");
    const a = scanLatestTool(path, "claude-code");
    assert.equal(a?.tool, "edit"); // Write is the latest, still running (no result)
    assert.equal(a?.tool_running, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanLatestTool — unreadable file ⇒ null", () => {
  assert.equal(scanLatestTool("/no/such/file.jsonl", "claude-code"), null);
});

test("normalizeTool — family mapping", () => {
  assert.equal(normalizeTool("Bash"), "bash");
  assert.equal(normalizeTool("exec_command"), "bash");
  assert.equal(normalizeTool("Edit"), "edit");
  assert.equal(normalizeTool("MultiEdit"), "edit");
  assert.equal(normalizeTool("apply_patch"), "edit");
  assert.equal(normalizeTool("Write"), "edit");
  assert.equal(normalizeTool("Read"), "read");
  assert.equal(normalizeTool("Grep"), "search");
  assert.equal(normalizeTool("Glob"), "search");
  assert.equal(normalizeTool("WebFetch"), "web");
  assert.equal(normalizeTool("Task"), "task");
  assert.equal(normalizeTool("TodoWrite"), "plan"); // "write" must NOT win over plan
  assert.equal(normalizeTool("mcp__oxtail__send_message"), "oxtail");
  assert.equal(normalizeTool("read_session"), "oxtail"); // oxtail verb, not "read"
  assert.equal(normalizeTool("some_custom_thing"), "tool");
});

test("agentKey — session id else pid", () => {
  assert.equal(agentKey({ session_id: "abc", server_pid: 1 }), "abc");
  assert.equal(agentKey({ session_id: null, server_pid: 7 }), "pid:7");
});

// ── EXEC class: capture-pane activity ───────────────────────────────────────────
import { capturePaneActivity, extractPaneActivity } from "./activity.js";
import { sanitizeCaptured, displayWidth } from "./format.js";
import type { RegistryEntry } from "../registry.js";

const CLAUDE_ACTIVE = [
  "  ⎿  Waiting…",
  "✽ Gallivanting… (2m 2s · ↓ 7.4k tokens)",
  "──────────────────────────",
  "❯ ",
  "──────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt",
].join("\n");

const CLAUDE_IDLE = ["❯ ", "─────", "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"].join("\n");
const CODEX_ACTIVE = ["• Working (38s · esc to interrupt)", "› ghost", "  gpt-5.5 xhigh · ~/dev/oxtail"].join("\n");

test("extractPaneActivity — Claude active: spinner line + busy", () => {
  const r = extractPaneActivity(CLAUDE_ACTIVE.split("\n"), "claude-code");
  assert.equal(r.pane_busy, true);
  assert.ok(r.pane_tail?.startsWith("Gallivanting…"), `got: ${r.pane_tail}`);
  assert.ok(r.pane_tail?.includes("7.4k tokens"));
});

test("extractPaneActivity — Claude idle: no tail, not busy", () => {
  const r = extractPaneActivity(CLAUDE_IDLE.split("\n"), "claude-code");
  assert.equal(r.pane_tail, null);
  assert.equal(r.pane_busy, false);
});

test("extractPaneActivity — Codex working line", () => {
  const r = extractPaneActivity(CODEX_ACTIVE.split("\n"), "codex");
  assert.equal(r.pane_busy, true);
  assert.equal(r.pane_tail, "Working (38s · esc to interrupt)");
});

test("extractPaneActivity — busy but no extractable spinner ⇒ tail null, busy true", () => {
  const r = extractPaneActivity(["doing stuff · esc to interrupt"], "claude-code");
  assert.equal(r.pane_tail, null);
  assert.equal(r.pane_busy, true);
});

test("extractPaneActivity — hostile wide-Unicode/bidi line can't survive to wrap (codex #2)", () => {
  const hostile = ["Working (‮5s · 你好世界 · esc to interrupt)"];
  const r = extractPaneActivity(hostile, "codex");
  assert.ok(r.pane_tail, "still extracts the working line");
  assert.ok(!r.pane_tail!.includes("‮"), "bidi override stripped");
  assert.ok(!/[一-鿿]/.test(r.pane_tail!), "CJK dropped");
  // provably 1-column: displayWidth equals codepoint count after sanitize.
  assert.equal(displayWidth(r.pane_tail!), [...r.pane_tail!].length);
});

test("sanitizeCaptured — drops wide/bidi, keeps ASCII + allowlisted glyphs", () => {
  assert.equal(sanitizeCaptured("abc你好def"), "abcdef");
  assert.equal(sanitizeCaptured("x‮y"), "xy");
  assert.equal(sanitizeCaptured("✽ ok · done…"), "✽ ok · done…"); // allowlisted survive
  const wide = sanitizeCaptured("ＦＵＬＬ width");
  assert.equal(displayWidth(wide), [...wide].length); // 1-col guarantee
});

const fakeEntry = {} as RegistryEntry;

test("capturePaneActivity — stale/unverifiable pane captures NOTHING (codex #1)", () => {
  let ran = false;
  const r = capturePaneActivity(
    { session_id: "s1", server_pid: 1, client_type: "claude-code" },
    {
      resolveEntry: () => fakeEntry,
      verifyPane: () => null, // recycled / pid-reused → refuse
      runTmux: () => {
        ran = true;
        return "STRANGER PANE";
      },
    },
  );
  assert.equal(r, null, "must not capture an unverified pane");
  assert.equal(ran, false, "capture-pane must not even run for an unverified pane");
});

test("capturePaneActivity — verified pane is captured + extracted", () => {
  const r = capturePaneActivity(
    { session_id: "s1", server_pid: 1, client_type: "claude-code" },
    { resolveEntry: () => fakeEntry, verifyPane: () => "%5", runTmux: () => CLAUDE_ACTIVE },
  );
  assert.ok(r?.pane_tail?.startsWith("Gallivanting…"));
  assert.equal(r?.pane_busy, true);
});

test("capturePaneActivity — no fresh registry entry ⇒ null", () => {
  const r = capturePaneActivity(
    { session_id: "gone", server_pid: 9, client_type: "codex" },
    { resolveEntry: () => null, verifyPane: () => "%9", runTmux: () => CODEX_ACTIVE },
  );
  assert.equal(r, null);
});

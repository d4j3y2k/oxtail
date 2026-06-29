import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";

import { listToolsViaSpawn } from "../token-budget.js";
import { frequencyWeight, scenariosForTool, SCENARIOS } from "./scenarios.js";

const SERVER_ENTRY = resolve(import.meta.dirname, "..", "server.ts");
const TSX_BIN = resolve(import.meta.dirname, "..", "..", "node_modules", ".bin", "tsx");

test("every scenario is structurally complete with a non-empty rubric", () => {
  assert.ok(SCENARIOS.length >= 10, `expected a real bank, got ${SCENARIOS.length}`);
  for (const s of SCENARIOS) {
    for (const field of ["id", "distinction", "frequency", "incident", "situation", "correct", "commonWrong"] as const) {
      assert.ok(typeof s[field] === "string" && (s[field] as string).length > 0, `${s.id}: empty ${field}`);
    }
    assert.ok(Array.isArray(s.tools) && s.tools.length > 0, `${s.id}: no tools`);
    assert.ok(Array.isArray(s.rubric) && s.rubric.length >= 2, `${s.id}: rubric too thin`);
    assert.ok(["high", "medium", "low"].includes(s.frequency), `${s.id}: bad frequency`);
    // The correct action and the misuse must differ — a scenario with no wrong
    // answer can't measure anything.
    assert.notEqual(s.correct, s.commonWrong, `${s.id}: correct == commonWrong`);
  }
});

test("scenario ids are unique", () => {
  const ids = SCENARIOS.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate scenario id");
});

test("frequencyWeight + scenariosForTool behave", () => {
  assert.ok(frequencyWeight("high") > frequencyWeight("medium"));
  assert.ok(frequencyWeight("medium") > frequencyWeight("low"));
  const forSend = scenariosForTool("send_message");
  assert.ok(forSend.length > 0 && forSend.every((s) => s.tools.includes("send_message")));
  assert.equal(scenariosForTool("not_a_real_tool").length, 0);
});

// Anti-rot: every tool a scenario references must actually exist in the live
// toolset, so a renamed/removed verb can't leave a scenario silently pointing at
// nothing.
test("scenarios only reference real oxtail tools", async () => {
  const tools = await listToolsViaSpawn({ command: TSX_BIN, args: [SERVER_ENTRY], timeoutMs: 30_000 });
  const real = new Set(tools.map((t) => t.name));
  for (const s of SCENARIOS) {
    for (const tool of s.tools) {
      assert.ok(real.has(tool), `${s.id} references "${tool}" which is not a live oxtail tool`);
    }
  }
});

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  BUDGET_CEILING_CHARS,
  estTokens,
  formatBudget,
  listToolsViaSpawn,
  measureEnvelopes,
  measureResponses,
  measureToolSchemas,
  RESPONSE_SAMPLES,
  summarizeOxtailToolTraffic,
  type ToolDef,
} from "./token-budget.js";

// Extract a TS string-literal union (export type X = "a" | "b" | ...;) from
// source — the live source of truth for the protocol's enum vocabulary.
function unionMembers(src: string, typeName: string): Set<string> {
  const start = src.indexOf(`export type ${typeName} =`);
  assert.ok(start >= 0, `${typeName} not found`);
  // Strip line comments FIRST — a member's trailing `// ...; ...` comment
  // contains semicolons that would otherwise truncate the union at the wrong `;`.
  const tail = src
    .slice(start)
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  const block = tail.slice(0, tail.indexOf(";"));
  const members = new Set<string>();
  for (const m of block.matchAll(/"([a-z_]+)"/g)) members.add(m[1]);
  return members;
}

const SERVER_ENTRY = resolve(import.meta.dirname, "server.ts");
const TSX_BIN = resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

// ── pure: estTokens ──────────────────────────────────────────────────────────

test("estTokens divides by the documented proxy and rounds", () => {
  assert.equal(estTokens(0), 0);
  assert.equal(estTokens(37), 10);
  assert.equal(estTokens(3700), 1000);
});

// ── pure: measureToolSchemas ────────────────────────────────────────────────

test("measureToolSchemas measures, totals, and sorts heaviest-first", () => {
  const tools: ToolDef[] = [
    { name: "small", description: "hi", inputSchema: { type: "object" } },
    { name: "big", description: "x".repeat(500), inputSchema: { type: "object", properties: { a: { type: "string" } } } },
  ];
  const b = measureToolSchemas(tools);
  assert.equal(b.count, 2);
  assert.equal(b.tools[0].name, "big", "heaviest tool sorts first");
  // total is the sum of the full serialized tool entries
  const expected = tools.reduce((s, t) => s + JSON.stringify(t).length, 0);
  assert.equal(b.totalChars, expected);
  assert.equal(b.totalTokensEst, estTokens(expected));
  // descChars / schemaChars are isolated sub-measures
  assert.equal(b.tools[0].descChars, 500);
  assert.ok(b.tools[0].schemaChars > b.tools[1].schemaChars);
});

// ── pure: measureEnvelopes (renders the real hook-drain code) ────────────────

test("measureEnvelopes derives stable per-delivery overheads from live render", () => {
  const e = measureEnvelopes();
  // Fixed overhead is the preamble+header bytes around a single body. These are
  // the v5 envelope numbers; the band catches a regression without pinning the
  // exact wording.
  assert.ok(
    e.preToolUseOverheadChars > 350 && e.preToolUseOverheadChars < 460,
    `PreToolUse overhead drifted: ${e.preToolUseOverheadChars} chars`,
  );
  // Stop carries a slightly longer lead-in than PreToolUse.
  assert.ok(e.stopOverheadChars > e.preToolUseOverheadChars);
  // A second message in the batch is cheap (just its header line).
  assert.ok(
    e.perExtraMessageChars > 0 && e.perExtraMessageChars < 200,
    `per-extra-message drifted: ${e.perExtraMessageChars} chars`,
  );
  // The obligation steer only appears for action_required and is non-trivial.
  assert.ok(e.obligationSteerChars > 100, `obligation steer too small: ${e.obligationSteerChars}`);
});

// ── pure: response samples ───────────────────────────────────────────────────

test("measureResponses returns positive, ordered-by-definition samples", () => {
  const r = measureResponses();
  assert.ok(r.length >= 5);
  for (const m of r) {
    assert.ok(m.chars > 0 && m.tokensEst > 0, `${m.label} measured non-positive`);
  }
  // The empty poll is the cheapest response shape.
  const poll = r.find((m) => m.label.includes("count:0"));
  assert.ok(poll && poll.chars < 100, "count:0 poll should be tiny");
});

// Drift guard (codex review): a response sample must never teach an enum value
// the live protocol doesn't use. Cross-check each sample's wake_status /
// delivery_outlook against the real wake.ts unions, and correlation against its
// inline set. This is the test that would have caught the wake_status:"woken" /
// delivery_outlook:"will_see_on_next_turn" fabrication.
test("response samples use only real protocol enum values (no invented vocabulary)", () => {
  const wakeSrc = readFileSync(new URL("./wake.ts", import.meta.url), "utf8");
  const wakeStatuses = unionMembers(wakeSrc, "WakeStatus");
  const outlooks = unionMembers(wakeSrc, "DeliveryOutlook");
  assert.ok(wakeStatuses.size >= 10, `expected ≥10 WakeStatus members, got ${wakeStatuses.size}`);
  assert.ok(outlooks.size >= 2, `expected ≥2 DeliveryOutlook members, got ${outlooks.size}`);
  const correlations = new Set(["correlated", "uncorrelated", "none"]);
  for (const { label, payload } of RESPONSE_SAMPLES) {
    const p = payload as Record<string, unknown>;
    if (typeof p.wake_status === "string") {
      assert.ok(wakeStatuses.has(p.wake_status), `${label}: wake_status "${p.wake_status}" is not a real WakeStatus`);
    }
    if (typeof p.delivery_outlook === "string") {
      assert.ok(outlooks.has(p.delivery_outlook), `${label}: delivery_outlook "${p.delivery_outlook}" is not a real DeliveryOutlook`);
    }
    if (typeof p.correlation === "string") {
      assert.ok(correlations.has(p.correlation), `${label}: correlation "${p.correlation}" is not real`);
    }
    const reply = p.reply as Record<string, unknown> | null | undefined;
    if (reply && typeof reply.correlation === "string") {
      assert.ok(correlations.has(reply.correlation as string), `${label}: reply.correlation invalid`);
    }
  }
});

// ── pure: telemetry ──────────────────────────────────────────────────────────

test("summarizeOxtailToolTraffic links tool_use→tool_result and ignores non-oxtail", () => {
  const lines = [
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "u1", name: "mcp__oxtail__send_message", input: { target: "abc", body: "hello there" } },
          { type: "tool_use", id: "u2", name: "Read", input: { file_path: "/x" } }, // non-oxtail, ignored
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "u1", content: '{"schema_version":1,"ok":true}' },
          { type: "tool_result", tool_use_id: "u2", content: "file body" }, // non-oxtail, ignored
        ],
      },
    }),
    "not json — skipped",
    "",
  ];
  const s = summarizeOxtailToolTraffic(lines);
  assert.equal(s.totals.calls, 1, "only the oxtail call is counted");
  assert.ok(s.byTool["mcp__oxtail__send_message"]);
  assert.equal(s.byTool["mcp__oxtail__send_message"].calls, 1);
  assert.ok(s.totals.argChars > 0 && s.totals.resultChars > 0);
  assert.equal(s.outputTokensEst, estTokens(s.totals.argChars));
  assert.equal(s.inputTokensEst, estTokens(s.totals.resultChars));
  assert.ok(!s.byTool["Read"], "non-oxtail tools excluded");
});

test("summarizeOxtailToolTraffic tolerates string-array content and missing results", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: "plain string content" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "u9", name: "mcp__oxtail__ask_peer", input: {} }] } }),
    // no matching tool_result → counted as a call with 0 result bytes, no crash
  ];
  const s = summarizeOxtailToolTraffic(lines);
  assert.equal(s.totals.calls, 1);
  assert.equal(s.byTool["mcp__oxtail__ask_peer"].resultChars, 0);
});

// ── formatting smoke ─────────────────────────────────────────────────────────

test("formatBudget renders all sections and the ceiling status", () => {
  const schema = measureToolSchemas([{ name: "t", description: "d", inputSchema: {} }]);
  const out = formatBudget(schema, measureEnvelopes(), measureResponses());
  assert.match(out, /STANDING/);
  assert.match(out, /PER-DELIVERY/);
  assert.match(out, /PER-CALL/);
  assert.match(out, /QUIET TURN/);
  assert.match(out, /ceiling/);
});

// ── REGRESSION GUARD: the real schema budget must stay under the ceiling ──────
//
// Spawns the actual server (via tsx, like integration.test.ts), pulls the real
// tools/list, and enforces the bundle-size-style ceiling. If this fails, the
// standing per-session cost grew — either trim a description or bump
// BUDGET_CEILING_CHARS deliberately in the same change.

test("regression guard: standing tool-schema budget stays under ceiling", async () => {
  const home = mkdtempSync(join(tmpdir(), "oxtail-budget-test-"));
  try {
    const tools = await listToolsViaSpawn({
      command: TSX_BIN,
      args: [SERVER_ENTRY],
      timeoutMs: 30_000,
    });
    assert.ok(tools.length >= 10, `expected the full oxtail toolset, got ${tools.length}`);
    const b = measureToolSchemas(tools);
    assert.ok(
      b.totalChars <= BUDGET_CEILING_CHARS,
      `tool-schema budget ${b.totalChars} chars (~${b.totalTokensEst} tok) exceeds ceiling ` +
        `${BUDGET_CEILING_CHARS}. Every byte here is paid by every session. Trim a tool ` +
        `description or bump BUDGET_CEILING_CHARS deliberately.\n` +
        b.tools.map((t) => `  ${t.totalChars}\t${t.name}`).join("\n"),
    );
    // Sanity floor: catch an accidental near-empty descriptions regression that
    // would technically "pass" the ceiling but gut the misuse-prevention guidance.
    assert.ok(b.totalChars > 10_000, `schema budget implausibly small (${b.totalChars}) — descriptions lost?`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

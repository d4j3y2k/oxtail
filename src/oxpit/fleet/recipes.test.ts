import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { PaneClassification } from "./classify.js";
import {
  buildLaunchCommand,
  buildRecipe,
  clientTypeFor,
  executeRecipe,
  type Recipe,
  type RecipeEffects,
  type RecipeStep,
  renderRecipe,
  shellSingleQuote,
} from "./recipes.js";
import type { FleetWindowSpec } from "./types.js";

const main: FleetWindowSpec = {
  name: "main",
  agent: "claude",
  model: "opus-4.8",
  effort: "xhigh",
  role: "captain",
};
const codexWin: FleetWindowSpec = { name: "codex", agent: "codex", model: "gpt-5.5" };

test("clientTypeFor maps the AgentKind to oxtail's ClientType", () => {
  assert.equal(clientTypeFor("claude"), "claude-code");
  assert.equal(clientTypeFor("codex"), "codex");
});

test("buildLaunchCommand shell-quotes the spec model into --model", () => {
  assert.equal(buildLaunchCommand(main), "claude --model 'opus-4.8'");
  assert.equal(buildLaunchCommand(codexWin), "codex --model 'gpt-5.5'");
  assert.equal(buildLaunchCommand({ name: "x", agent: "claude" }), "claude");
});

test("buildLaunchCommand neutralizes shell metacharacters in a hostile spec model", () => {
  // A repo .oxtail/fleet.json must not be able to run a second command on SPAWN.
  const evil = buildLaunchCommand({ name: "x", agent: "codex", model: "gpt-5.5; touch /tmp/pwn" });
  assert.equal(evil, "codex --model 'gpt-5.5; touch /tmp/pwn'");
  // The metachars live INSIDE the single-quoted token — the shell sees one arg.
  assert.ok(!/;\s*touch/.test(evil.replace(/'[^']*'/g, "''")), "no bare ; survives outside quotes");
});

test("shellSingleQuote escapes embedded single quotes", () => {
  assert.equal(shellSingleQuote("o'clock"), `'o'\\''clock'`);
  assert.equal(shellSingleQuote("plain"), "'plain'");
});

test("buildRecipe emits the minimal validated SPAWN sequence", () => {
  const r = buildRecipe(main);
  assert.deepEqual(r.steps.map((s) => s.op), ["sendLiteral", "waitExternal", "claimCheck"]);
  assert.equal(r.steps[0].op === "sendLiteral" && r.steps[0].text, "claude --model 'opus-4.8'");
  assert.equal(r.steps[1].op === "waitExternal" && r.steps[1].artifact, "claude");
});

test("renderRecipe prints exact, reviewable dry-run steps", () => {
  const out = renderRecipe(buildRecipe(main));
  assert.match(out, /recipe: claude "main \(captain\)"/);
  assert.match(out, /launch: claude --model 'opus-4\.8'/);
  assert.match(out, /1\. sendLiteral "claude --model 'opus-4\.8'"/);
  assert.match(out, /2\. waitExternal claude/);
  assert.match(out, /3\. claimCheck/);
});

// ── executor ────────────────────────────────────────────────────────────────

function fx(over: Partial<RecipeEffects> = {}): { fx: RecipeEffects; sent: string[] } {
  const sent: string[] = [];
  const base: RecipeEffects = {
    fireLiteral: async (t) => {
      sent.push(t);
    },
    sendKey: async (k) => {
      sent.push(`<key:${k}>`);
    },
    confirmLine: async () => true,
    classify: (): PaneClassification => ({ readiness: "tui-ready" }),
    waitExternal: async () => ({ ok: true, sessionId: "sid-xyz" }),
    claimCheck: () => true,
  };
  return { fx: { ...base, ...over }, sent };
}

test("happy path: binds the session and confirms the claim", async () => {
  const { fx: effects, sent } = fx();
  const res = await executeRecipe(buildRecipe(main), effects);
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.sessionId, "sid-xyz");
  assert.deepEqual(sent, ["claude --model 'opus-4.8'"]);
});

test("waitExternal failure stops the recipe with that reason", async () => {
  const { fx: effects } = fx({
    waitExternal: async () => ({ ok: false, reason: "rollout never appeared" }),
  });
  const res = await executeRecipe(buildRecipe(codexWin), effects);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.failed.op, "waitExternal");
    assert.match(res.reason, /rollout never appeared/);
  }
});

test("claimCheck failure surfaces non-adoption (external truth, not pane text)", async () => {
  const { fx: effects } = fx({ claimCheck: () => false });
  const res = await executeRecipe(buildRecipe(main), effects);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.failed.op, "claimCheck");
    assert.match(res.reason, /not resolvable in the oxtail registry/);
  }
});

test("classifyPane gate aborts loudly on an unexpected pane state", async () => {
  const recipe: Recipe = {
    client: "claude",
    label: "main",
    launchCommand: "claude",
    steps: [{ op: "classifyPane", expect: ["tui-ready"] }],
  };
  const { fx: effects } = fx({
    classify: () => ({ readiness: "blocked-interstitial", reason: "trust-folder prompt" }),
  });
  const res = await executeRecipe(recipe, effects);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /blocked-interstitial" \(trust-folder prompt\), expected/);
});

test("sendLiteral with a confirm needle that never prints fails", async () => {
  const recipe: Recipe = {
    client: "claude",
    label: "main",
    launchCommand: "x",
    steps: [{ op: "sendLiteral", text: "setup ; echo NONCE", confirm: "NONCE" }],
  };
  const { fx: effects } = fx({ confirmLine: async () => false });
  const res = await executeRecipe(recipe, effects);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /confirm needle .* never printed/);
});

test("claimCheck before any waitExternal is a hard error (no session bound)", async () => {
  const recipe: Recipe = {
    client: "claude",
    label: "main",
    launchCommand: "x",
    steps: [{ op: "claimCheck" }],
  };
  const res = await executeRecipe(recipe, fx().fx);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /before waitExternal bound a session/);
});

test("an explicit abort step stops with its reason", async () => {
  const recipe: Recipe = {
    client: "codex",
    label: "codex",
    launchCommand: "codex",
    steps: [{ op: "abort", reason: "half-up pane — refusing to type on top" } as RecipeStep],
  };
  const res = await executeRecipe(recipe, fx().fx);
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /half-up pane/);
});

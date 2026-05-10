import { strict as assert } from "node:assert";
import { test } from "node:test";
import { envStrategy } from "./envStrategy.js";
import { isAbstain, isHit, type DetectContext } from "./types.js";

const ctxWith = (overrides: Partial<DetectContext>): DetectContext => ({
  type: "unknown",
  cwd: "/tmp/proj",
  started_at: 0,
  env: {},
  ...overrides,
});

test("envStrategy: claude-code with env var returns high-confidence env result", () => {
  const result = envStrategy(
    ctxWith({ type: "claude-code", env: { CLAUDE_CODE_SESSION_ID: "abc-123" } }),
  );
  assert.ok(isHit(result));
  assert.deepEqual(result, { session_id: "abc-123", source: "env", confidence: "high" });
});

test("envStrategy: claude-code without env var abstains with structural reason", () => {
  const result = envStrategy(ctxWith({ type: "claude-code", env: {} }));
  assert.ok(isAbstain(result));
  assert.match(result.reason, /CLAUDE_CODE_SESSION_ID/);
  assert.match(result.reason, /strips/i);
});

test("envStrategy: codex prefers CODEX_THREAD_ID", () => {
  const result = envStrategy(
    ctxWith({
      type: "codex",
      env: { CODEX_THREAD_ID: "thread-id", CODEX_COMPANION_SESSION_ID: "companion-id" },
    }),
  );
  assert.ok(isHit(result));
  assert.deepEqual(result, { session_id: "thread-id", source: "env", confidence: "high" });
});

test("envStrategy: codex falls back to CODEX_COMPANION_SESSION_ID, not CODEX_SESSION_ID", () => {
  const wrong = envStrategy(
    ctxWith({ type: "codex", env: { CODEX_SESSION_ID: "wrong-name" } }),
  );
  assert.ok(isAbstain(wrong), "must NOT detect from CODEX_SESSION_ID (wrong name)");

  const right = envStrategy(
    ctxWith({ type: "codex", env: { CODEX_COMPANION_SESSION_ID: "real-id" } }),
  );
  assert.ok(isHit(right));
  assert.deepEqual(right, { session_id: "real-id", source: "env", confidence: "high" });
});

test("envStrategy: unknown type abstains with type reason", () => {
  const result = envStrategy(
    ctxWith({
      type: "unknown",
      env: { CLAUDE_CODE_SESSION_ID: "x", CODEX_COMPANION_SESSION_ID: "y" },
    }),
  );
  assert.ok(isAbstain(result));
  assert.match(result.reason, /unknown/);
});

test("envStrategy: empty session_id is treated as missing", () => {
  const result = envStrategy(
    ctxWith({ type: "claude-code", env: { CLAUDE_CODE_SESSION_ID: "" } }),
  );
  assert.ok(isAbstain(result));
});

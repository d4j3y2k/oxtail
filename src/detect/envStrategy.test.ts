import { strict as assert } from "node:assert";
import { test } from "node:test";
import { envStrategy } from "./envStrategy.js";
import type { DetectContext } from "./types.js";

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
  assert.deepEqual(result, { session_id: "abc-123", source: "env", confidence: "high" });
});

test("envStrategy: claude-code without env var returns null", () => {
  const result = envStrategy(ctxWith({ type: "claude-code", env: {} }));
  assert.equal(result, null);
});

test("envStrategy: codex uses CODEX_COMPANION_SESSION_ID, not CODEX_SESSION_ID", () => {
  const wrong = envStrategy(
    ctxWith({ type: "codex", env: { CODEX_SESSION_ID: "wrong-name" } }),
  );
  assert.equal(wrong, null, "must NOT detect from CODEX_SESSION_ID (wrong name)");

  const right = envStrategy(
    ctxWith({ type: "codex", env: { CODEX_COMPANION_SESSION_ID: "real-id" } }),
  );
  assert.deepEqual(right, { session_id: "real-id", source: "env", confidence: "high" });
});

test("envStrategy: unknown type ignores env vars", () => {
  const result = envStrategy(
    ctxWith({
      type: "unknown",
      env: { CLAUDE_CODE_SESSION_ID: "x", CODEX_COMPANION_SESSION_ID: "y" },
    }),
  );
  assert.equal(result, null);
});

test("envStrategy: empty session_id is treated as missing", () => {
  const result = envStrategy(
    ctxWith({ type: "claude-code", env: { CLAUDE_CODE_SESSION_ID: "" } }),
  );
  assert.equal(result, null);
});

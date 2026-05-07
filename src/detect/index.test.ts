import { strict as assert } from "node:assert";
import { test } from "node:test";
import { composeDetectors } from "./index.js";
import type { DetectContext, DetectStrategy } from "./types.js";

const ctx: DetectContext = {
  type: "claude-code",
  cwd: "/tmp/proj",
  started_at: 0,
  env: {},
};

const always =
  (id: string, confidence: "high" | "medium" = "high"): DetectStrategy =>
  () => ({ session_id: id, source: "env", confidence });

const never: DetectStrategy = () => null;

test("composeDetectors: returns first non-null result", () => {
  const detect = composeDetectors([never, always("first"), always("second")]);
  const r = detect(ctx);
  assert.equal(r?.session_id, "first");
});

test("composeDetectors: returns null when all strategies return null", () => {
  const detect = composeDetectors([never, never]);
  assert.equal(detect(ctx), null);
});

test("composeDetectors: order matters — first hit wins", () => {
  const a = composeDetectors([always("A"), always("B")]);
  const b = composeDetectors([always("B"), always("A")]);
  assert.equal(a(ctx)?.session_id, "A");
  assert.equal(b(ctx)?.session_id, "B");
});

test("composeDetectors: empty strategy list returns null", () => {
  const detect = composeDetectors([]);
  assert.equal(detect(ctx), null);
});

test("composeDetectors: passes context through unchanged", () => {
  let captured: DetectContext | null = null;
  const capture: DetectStrategy = (c) => {
    captured = c;
    return null;
  };
  composeDetectors([capture])(ctx);
  assert.equal(captured, ctx);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { composeDetectors, diagnoseDetect } from "./index.js";
import type { DetectContext, DetectStrategy } from "./types.js";

const ctx: DetectContext = {
  type: "claude-code",
  cwd: "/definitely/not/a/real/project/9b3c",
  started_at: 0,
  env: {},
};

const always =
  (id: string, confidence: "high" | "medium" = "high"): DetectStrategy =>
  () => ({ session_id: id, source: "env", confidence });

const never: DetectStrategy = () => ({ abstain: true, reason: "test stub" });

test("composeDetectors: returns first hit", () => {
  const detect = composeDetectors([never, always("first"), always("second")]);
  const r = detect(ctx);
  assert.equal(r?.session_id, "first");
});

test("composeDetectors: returns null when all strategies abstain", () => {
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
    return { abstain: true, reason: "capture" };
  };
  composeDetectors([capture])(ctx);
  assert.equal(captured, ctx);
});

test("diagnoseDetect: when no strategy resolves, includes next_step with bash command", () => {
  const d = diagnoseDetect(ctx);
  assert.equal(d.winning, null);
  assert.ok(d.next_step);
  assert.equal(d.next_step!.tool, "register_my_session");
  assert.match(d.next_step!.bash_command, /CLAUDE_CODE_SESSION_ID/);
});

test("diagnoseDetect: codex next_step uses CODEX_THREAD_ID", () => {
  const d = diagnoseDetect({ ...ctx, type: "codex" });
  assert.ok(d.next_step);
  assert.match(d.next_step!.bash_command, /CODEX_THREAD_ID/);
});

test("diagnoseDetect: every strategy outcome has either session_id or a reason", () => {
  const d = diagnoseDetect(ctx);
  for (const [name, outcome] of Object.entries(d.per_strategy)) {
    if ("session_id" in outcome) {
      assert.ok(outcome.session_id, `${name}: hit must have session_id`);
    } else {
      assert.ok(outcome.reason && outcome.reason.length > 0, `${name}: abstain must have reason`);
    }
  }
});

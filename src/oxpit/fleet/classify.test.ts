import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyPaneReadiness } from "./classify.js";

test("busy: 'esc to interrupt' chrome wins over everything (both clients)", () => {
  assert.equal(
    classifyPaneReadiness("• Working (38s · esc to interrupt)", "codex").readiness,
    "busy",
  );
  assert.equal(
    classifyPaneReadiness("✻ Thinking… (esc to interrupt)", "claude-code").readiness,
    "busy",
  );
});

test("trust-folder interstitial is named", () => {
  const c = classifyPaneReadiness("Do you trust the files in this folder?\n  1. Yes\n  2. No", "claude-code");
  assert.equal(c.readiness, "blocked-interstitial");
  assert.match(c.reason ?? "", /trust-folder/);
});

test("login + update + model-picker interstitials are detected", () => {
  assert.equal(classifyPaneReadiness("Select login method:", "claude-code").readiness, "blocked-interstitial");
  assert.equal(classifyPaneReadiness("Update available — please update to continue", "codex").readiness, "blocked-interstitial");
  assert.equal(classifyPaneReadiness("Choose a model to continue", "claude-code").readiness, "blocked-interstitial");
});

test("tui-ready footer affordance (best-effort)", () => {
  assert.equal(
    classifyPaneReadiness("│ > │\n  ? for shortcuts", "claude-code").readiness,
    "tui-ready",
  );
});

test("shell-ready: a trailing prompt glyph on an otherwise quiet pane", () => {
  assert.equal(classifyPaneReadiness("davidkim@host oxtail % ", "claude-code").readiness, "shell-ready");
  assert.equal(classifyPaneReadiness("~/dev/oxtail ❯ ", "codex").readiness, "shell-ready");
});

test("unknown when nothing matches (executor treats as a gate failure)", () => {
  assert.equal(classifyPaneReadiness("some random mid-scroll output\nno prompt here", "claude-code").readiness, "unknown");
});

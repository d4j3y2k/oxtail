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

// ── false-ready negatives (codex AMEND #3) ─────────────────────────────────────

test("a percent-progress line is NOT shell-ready (100% ends in % but is no prompt)", () => {
  assert.equal(classifyPaneReadiness("Building... 100%", "claude-code").readiness, "unknown");
  assert.equal(classifyPaneReadiness("downloaded 42%", "codex").readiness, "unknown");
});

test("log text mentioning shortcuts/ctrl is NOT tui-ready", () => {
  assert.equal(
    classifyPaneReadiness("hint: press ctrl+c to copy the output", "claude-code").readiness,
    "unknown",
  );
  assert.equal(
    classifyPaneReadiness("see the docs for shortcuts and keybindings", "codex").readiness,
    "unknown",
  );
});

test("shortcut chrome in deep scrollback (not the bottom region) is NOT tui-ready", () => {
  // "? for shortcuts" buried 8+ lines up, with non-chrome at the bottom.
  const buf = ["? for shortcuts", ...Array(8).fill("build log line"), "compiling module x"].join("\n");
  assert.equal(classifyPaneReadiness(buf, "claude-code").readiness, "unknown");
});

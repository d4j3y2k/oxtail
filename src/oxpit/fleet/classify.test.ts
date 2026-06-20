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

// ── Codex STRUCTURAL ready signal (v0.141.0; replaces the dead "? for shortcuts"
//    string) — composer `›` + footer `<model> <effort> · <cwd>` as the LAST line ──

test("codex tui-ready: real v0.141.0 ready prompt (composer + footer-as-last-line)", () => {
  const ready = [
    "│ >_ OpenAI Codex (v0.141.0) │",
    "› Find and fix a bug in @filename",
    "  gpt-5.5 xhigh · ~/dev/oxtail",
  ].join("\n");
  assert.equal(classifyPaneReadiness(ready, "codex").readiness, "tui-ready");
  // absolute-path cwd + empty composer placeholder also reads ready
  const absReady = ["› ", "  gpt-5.5 xhigh · /Users/dev/oxtail"].join("\n");
  assert.equal(classifyPaneReadiness(absReady, "codex").readiness, "tui-ready");
});

test("codex: busy (mid-turn) wins over the ready chrome", () => {
  const busy = ["› Find and fix a bug in @filename", "  gpt-5.5 xhigh · ~/dev/oxtail", "• Working (esc to interrupt)"].join("\n");
  assert.equal(classifyPaneReadiness(busy, "codex").readiness, "busy");
});

test("codex: a STALE composer/footer above a shell prompt is NOT tui-ready (exited to shell)", () => {
  // The footer must be the LAST line; here the live bottom is a shell prompt, so the
  // scrollback composer/footer must NOT yield a false ready (max's false-positive).
  const stale = ["› old prompt from a previous codex", "  gpt-5.5 xhigh · ~/dev/oxtail", "davidkim@host oxtail % "].join("\n");
  assert.notEqual(classifyPaneReadiness(stale, "codex").readiness, "tui-ready");
});

test("codex: composer present but NO footer (mid-scroll) is NOT tui-ready", () => {
  const noFooter = ["› typing something", "  (some output, no model·cwd footer)"].join("\n");
  assert.notEqual(classifyPaneReadiness(noFooter, "codex").readiness, "tui-ready");
});

// Pane-state classifier for the fleet executor's keystroke layer. Maps a
// capture-pane buffer to a PaneReadiness so the recipe executor can gate a send
// (only type a chord into a TUI that is actually ready) and, more importantly,
// so a readiness TIMEOUT can be dumped with a reason ("blocked on the
// trust-folder prompt") instead of a bare "agent never came up".
//
// IMPORTANT — this is the deliberately brittle layer the plan flags for
// real-agent verification: the interstitial/TUI strings vary by client build,
// so the high-confidence signals (BUSY via "esc to interrupt"; the named
// interstitials) are load-bearing, while tui-ready/shell-ready are best-effort
// and fall back to "unknown" when unsure. The executor treats "unknown" as a
// gate failure (loud abort), which is the safe default. External artifact
// readiness (readiness.ts), NOT this text classifier, is the source of truth
// that an agent launched — this only colors HOW we wait and WHY we failed.

import type { ClientType } from "../../clients.js";
import type { PaneReadiness } from "./types.js";

export interface PaneClassification {
  readiness: PaneReadiness;
  reason?: string; // populated for blocked-interstitial (which prompt)
}

// Known startup interstitials, most specific first. Each varies by build — keep
// the patterns broad enough to catch rewordings but anchored on a distinctive
// phrase. Verified against real agents at the P2/P3 gate.
const INTERSTITIALS: { re: RegExp; reason: string }[] = [
  { re: /do you trust the (files|authors)|trust (this|the) (folder|directory|workspace)/i, reason: "trust-folder prompt" },
  { re: /select (a |an |the )?login|log ?in with|sign in to|authenticate|authorization required|api key/i, reason: "login/auth prompt" },
  { re: /update available|a new version|please update|upgrade to continue/i, reason: "update prompt" },
  { re: /select (a |an |the )?model|choose a model|model picker/i, reason: "model picker" },
  { re: /allow this|grant permission|permission to|\((y\/n|yes\/no)\)/i, reason: "permission prompt" },
];

function busy(lines: string[]): boolean {
  // Same robust core as oxpit/activity.ts: the agent chrome says it is actively
  // processing. Works for both clients ("· esc to interrupt").
  return lines.some((l) => /esc to interrupt/i.test(l));
}

// The bottom region of a pane is where live chrome (footer / prompt) sits; idle
// TUI/shell signals are checked ONLY here, not across the whole buffer, so a
// shortcut string or a `%` in historical scrollback can't false-positive
// (codex AMEND #3). Returns the last `n` non-empty lines, most-recent first.
function tailLines(lines: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i].trimEnd();
    if (l) out.push(l);
  }
  return out;
}

function tuiReady(lines: string[], clientType: ClientType): boolean {
  // Best-effort idle-TUI affordance, anchored on bottom-region chrome (so stale
  // scrollback can't false-positive). For CODEX this is an ACCELERATOR ONLY, never
  // a hard go/no-go: the Codex join's proof-of-accept is the rollout ARTIFACT, so a
  // miss here just falls back to settle+retry (max's robustness fix). That's
  // deliberate — the old codex string ("? for shortcuts | / for commands") was never
  // live-wired and broke on v0.141.0; betting SPAWN go/no-go on a per-version pane
  // string violates the "pane text is evidence, not truth" pillar.
  const tail = tailLines(lines, 8);
  if (clientType === "claude-code") return tail.some((l) => /\? for shortcuts/i.test(l));
  if (clientType === "codex") {
    // STRUCTURAL signal for a fresh, idle Codex composer (codex's spec, verified vs a
    // real v0.141.0 capture): require BOTH the focused composer prompt (a tail line
    // starting with the `›` glyph) AND the status footer (a `·`-class separator
    // followed by a cwd-ish path, e.g. "gpt-5.5 xhigh · ~/dev/oxtail"). The startup
    // box ("OpenAI Codex (vX)", "/model to change") is intentionally NOT used — it
    // survives in scrollback after state changes. busy (mid-turn) is rejected upstream
    // in classifyPaneReadiness, so this only fires for a genuinely idle composer.
    // The footer must be the BOTTOM-MOST line (tail[0] = last non-empty line). A live
    // idle Codex ends in its `<model> <effort> · <cwd>` footer; a Codex that EXITED
    // back to a shell has the shell prompt as the last line with only a STALE footer
    // in scrollback — so anchoring on the last line rejects that false-positive (max).
    // Conservative by design: as an accelerator, a missed-ready just falls back to
    // settle+retry, so we'd rather under-fire than fire the join into an exited pane.
    const hasFooterLast = /[·•∙⋅]\s.*(?:~\/|\/)/.test(tail[0] ?? "");
    const hasComposer = tail.slice(0, 5).some((l) => /^\s*›/.test(l));
    return hasComposer && hasFooterLast;
  }
  return false;
}

// A real shell prompt has the glyph at start-of-line or after whitespace
// (`host % `), so requiring a preceding boundary rejects a value that merely
// ends in one (`100%`, `done.`). Checked only on the last non-empty line.
const SHELL_PROMPT_TAIL = /(^|\s)[$%#❯›»]\s*$/;

function shellReady(lines: string[]): boolean {
  const tail = tailLines(lines, 1);
  return tail.length > 0 && SHELL_PROMPT_TAIL.test(tail[0]);
}

export function classifyPaneReadiness(buf: string, clientType: ClientType): PaneClassification {
  const lines = buf.split("\n");
  if (busy(lines)) return { readiness: "busy" };
  for (const { re, reason } of INTERSTITIALS) {
    if (lines.some((l) => re.test(l))) return { readiness: "blocked-interstitial", reason };
  }
  if (tuiReady(lines, clientType)) return { readiness: "tui-ready" };
  if (shellReady(lines)) return { readiness: "shell-ready" };
  return { readiness: "unknown" };
}

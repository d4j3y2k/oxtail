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

function tuiReady(lines: string[], clientType: ClientType): boolean {
  // Best-effort idle-TUI affordance. Claude footers carry "? for shortcuts";
  // Codex carries a "/ commands" / shortcuts hint. Neither is guaranteed across
  // builds, so a miss falls through to shell/unknown rather than a false ready.
  const hay = lines.join("\n");
  if (clientType === "claude-code") return /\? for shortcuts|\bfor shortcuts\b/i.test(hay);
  if (clientType === "codex") return /\bfor shortcuts\b|\/ commands|ctrl\+./i.test(hay);
  return false;
}

const SHELL_PROMPT_TAIL = /[$%#❯›»]\s*$/;

function shellReady(lines: string[]): boolean {
  // A shell that is sitting at a prompt: the last non-empty line ends in a
  // common prompt glyph. Conservative — used only as a weak positive.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trimEnd();
    if (!l) continue;
    return SHELL_PROMPT_TAIL.test(l);
  }
  return false;
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

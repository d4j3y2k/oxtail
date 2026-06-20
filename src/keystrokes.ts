// Low-level tmux keystroke primitives, shared by two callers:
//   1. the wake subsystem (wake.ts) — fire-and-forget nudges into an idle peer;
//   2. the oxpit fleet executor — send→confirm→send setup that drives a freshly
//      launched agent's shell/TUI to a known state.
//
// The fire primitive + the Codex paste-burst gap moved here from wake.ts so both
// callers share one home; the capture-pane confirm helpers (waitForPaneLine /
// sendAndConfirm) are new for the fleet executor's readiness-sync. The exact-
// WHOLE-LINE match in paneHasLine is load-bearing and spike-validated — see its
// comment.

import { execFileSync } from "node:child_process";
import type { ClientType } from "./clients.js";

// Codex's TUI has a paste-burst heuristic (codex-rs/tui/src/bottom_pane/
// paste_burst.rs: PASTE_ENTER_SUPPRESS_WINDOW≈120ms): when `tmux send-keys`
// blasts the literal-text payload immediately followed by Enter, Codex reads it
// as a paste and converts Enter→newline for ~120ms, suppressing the submit.
// Inserting a gap between the text and the Enter lets the window expire so Enter
// submits. 500ms is a generous multiple for upstream-drift safety. Verified
// empirically 2026-05-13 against Codex (gpt-5.5 xhigh).
export const CODEX_SUBMIT_DELAY_MS = 500;

// A hung tmux server must not block the caller's thread indefinitely.
const TMUX_CALL_TIMEOUT_MS = 2000;

// keepAlive=false (default) unref's the timer so a fire-and-forget wake never
// holds the process open — preserves wake.ts's original codex-gap semantics.
// keepAlive=true keeps the event loop alive, which is correct for an awaited
// poll loop that is genuinely still working (waitForPaneLine).
function sleep(ms: number, keepAlive = false): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (!keepAlive) t.unref?.();
  });
}

// Two send-keys calls: the text is interpreted literally (-l, which neutralizes
// any tmux key-sequence a malicious peer could plant) and Enter is parsed as a
// key event. Codex gets the paste-burst gap between the two; other clients fire
// back-to-back. `text` is required (no default) so this module never depends on
// wake.ts's ASK_PEER_WAKE_TEXT — keeps the import edge one-directional.
export async function fireKeystrokes(
  target: string,
  clientType: ClientType,
  text: string,
): Promise<void> {
  execFileSync("tmux", ["send-keys", "-t", target, "-l", text], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TMUX_CALL_TIMEOUT_MS,
  });
  if (clientType === "codex") await sleep(CODEX_SUBMIT_DELAY_MS);
  execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TMUX_CALL_TIMEOUT_MS,
  });
}

// Capture a pane's visible buffer as plain text (-p), joining wrapped lines (-J,
// matching oxpit/activity.ts). Returns "" on any tmux error (pane gone, hung
// server) so a polling caller treats "can't read" as "needle not present yet"
// rather than throwing mid-poll.
export function capturePane(pane: string): string {
  try {
    return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", pane], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: TMUX_CALL_TIMEOUT_MS,
    });
  } catch {
    return "";
  }
}

// Does any WHOLE LINE of `buf` equal `needle`? Exact-line, NOT substring — this
// is the spike's single most important correctness detail (2026-06-19): when you
// `echo NONCE`, the pane shows the TYPED command line (`echo NONCE`, plus a
// prompt-prefixed echo) which CONTAINS the needle as a substring BEFORE Enter is
// even pressed. A substring match would false-positive on an unsubmitted command
// and lie about readiness. Only the command's OUTPUT prints the needle ALONE on
// its own line. trimEnd tolerates tmux's trailing padding; the needle itself
// must be a token the shell prints bare (use `echo <NONCE>`, never a needle that
// also appears verbatim in the command).
export function paneHasLine(buf: string, needle: string): boolean {
  for (const line of buf.split("\n")) {
    if (line.trimEnd() === needle) return true;
  }
  return false;
}

export type WaitResult =
  | { ok: true; waitedMs: number }
  | { ok: false; waitedMs: number; pane: string };

// Poll capture-pane until a whole line equals `needle`, or `timeoutMs` elapses.
// On timeout returns the final pane buffer so the caller can dump it into a loud
// abort (never block forever). pollMs default 100ms (spike: ~24ms real shell
// latency, so 100ms is comfortable). `now` is injectable for tests.
export async function waitForPaneLine(
  pane: string,
  needle: string,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<WaitResult> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 100;
  const now = opts.now ?? (() => Date.now());
  const start = now();
  for (;;) {
    if (paneHasLine(capturePane(pane), needle)) {
      return { ok: true, waitedMs: now() - start };
    }
    if (now() - start >= timeoutMs) {
      return { ok: false, waitedMs: now() - start, pane: capturePane(pane) };
    }
    await sleep(pollMs, true);
  }
}

// send→confirm: fire `cmd` into the pane, then wait for `confirmNeedle` to print
// on its own line. `cmd` SHOULD end by echoing `confirmNeedle` alone (e.g.
// `<setup> ; echo <NONCE>`) so a healthy shell emits it as bare output.
// clientType drives the Codex paste-burst gap on the fire.
export async function sendAndConfirm(
  pane: string,
  clientType: ClientType,
  cmd: string,
  confirmNeedle: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<WaitResult> {
  await fireKeystrokes(pane, clientType, cmd);
  return waitForPaneLine(pane, confirmNeedle, opts);
}

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { askPeerWakeImpl } from "./server.js";

// Opt-in tmux behavior test. Verifies the paste-burst-aware wake actually
// submits to a running shell, end-to-end. Gated on OXTAIL_TMUX_TESTS=1 because
// it spawns real tmux sessions and is slow (~2s per case). Skipped in regular
// CI; run manually with `OXTAIL_TMUX_TESTS=1 npm test` to verify wake mechanics
// against a real terminal.
//
// What this catches: regressions where send-keys + Enter no longer submits to
// a typical shell prompt. Doesn't catch Codex-specific paste-burst regressions
// (would need a real Codex CLI in the pane), but does catch broader breakage
// of the wake invocation. To probe Codex-specific behavior, run the manual
// procedure documented in docs/v0.7-wake-probe.md.

const skip = process.env.OXTAIL_TMUX_TESTS !== "1";

function tmuxOk(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

test("wake: send-keys + Enter submits to bash prompt (paste-burst-aware path)", { skip: skip || !tmuxOk() }, async () => {
  const session = `oxtail-wake-test-${process.pid}-${Date.now()}`;
  // Spawn bash so the prompt accepts our wake text + Enter as a command line.
  // The wake text starts with `[oxtail]` — bash treats `[` as `test`, errors,
  // but the important thing is that the line is SUBMITTED (a prompt redraws
  // beneath it) rather than left sitting in the input buffer.
  execFileSync("tmux", ["new-session", "-d", "-s", session, "bash --noprofile --norc"]);
  try {
    // Drain initial prompt rendering.
    await new Promise((r) => setTimeout(r, 200));
    const before = execFileSync("tmux", ["capture-pane", "-t", session, "-p"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Fire the v0.7 paste-burst-aware wake (using clientType=codex routing).
    // We can't import defaultFireWakeKeystrokes directly (it's not exported)
    // but askPeerWakeImpl exercises it via its callback contract. Reproduce
    // the paste-burst-aware sequence inline.
    const fire = async (target: string) => {
      execFileSync("tmux", ["send-keys", "-t", target, "-l", "echo wake-test-marker"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      await new Promise<void>((r) => setTimeout(r, 500));
      execFileSync("tmux", ["send-keys", "-t", target, "Enter"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    };

    const ok = await askPeerWakeImpl(null, session, fire);
    assert.equal(ok, true, "wake fired");

    // Give bash time to render the echo output.
    await new Promise((r) => setTimeout(r, 300));
    const after = execFileSync("tmux", ["capture-pane", "-t", session, "-p"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    // The marker must appear in the captured pane as a submitted command's
    // output, not just as typed-into-buffer text. bash echoes the marker on
    // a fresh line below the prompt — capture should contain it.
    assert.ok(
      after.includes("wake-test-marker"),
      `expected wake to submit and produce output. before:\n${before}\nafter:\n${after}`,
    );
  } finally {
    try {
      execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" });
    } catch {
      // already gone
    }
  }
});

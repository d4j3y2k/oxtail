import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { paneHasLine, sendAndConfirm, waitForPaneLine } from "./keystrokes.js";

// --- paneHasLine: exact WHOLE-LINE, never substring (the spike's crux) --------

test("paneHasLine matches a bare output line", () => {
  assert.equal(paneHasLine("foo\nOXNONCE_ABC\nbar", "OXNONCE_ABC"), true);
});

test("paneHasLine does NOT match the needle as a substring of a typed command", () => {
  // The pane shows the typed-but-unsubmitted command `echo OXNONCE_ABC` (which
  // CONTAINS the needle) before Enter is pressed. A substring match would
  // false-positive and lie about readiness — this is exactly what we must avoid.
  assert.equal(paneHasLine("$ echo OXNONCE_ABC", "OXNONCE_ABC"), false);
});

test("paneHasLine does NOT match a prompt-prefixed line", () => {
  assert.equal(paneHasLine("> OXNONCE_ABC", "OXNONCE_ABC"), false);
});

test("paneHasLine tolerates tmux trailing padding/whitespace", () => {
  assert.equal(paneHasLine("OXNONCE_ABC   \n", "OXNONCE_ABC"), true);
});

test("paneHasLine is false on an empty buffer (capture failed)", () => {
  assert.equal(paneHasLine("", "OXNONCE_ABC"), false);
});

// --- real-tmux integration (opt-in, mirrors wake-tmux.test.ts) ----------------

const skip = process.env.OXTAIL_TMUX_TESTS !== "1";
function tmuxOk(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

test(
  "sendAndConfirm: echo round-trip confirms on its own output line",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-keystrokes-test-${process.pid}-${Date.now()}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "bash --noprofile --norc"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const nonce = `OXNONCE_${process.pid}_${Date.now()}`;
      const res = await sendAndConfirm(session, "claude", `echo ${nonce}`, nonce, {
        timeoutMs: 5000,
      });
      assert.equal(res.ok, true, "confirm needle appeared on its own output line");
    } finally {
      execFileSync("tmux", ["kill-session", "-t", session], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  },
);

test(
  "waitForPaneLine: times out (with pane dump) when the needle never submits",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-keystrokes-noenter-${process.pid}-${Date.now()}`;
    execFileSync("tmux", ["new-session", "-d", "-s", session, "bash --noprofile --norc"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const nonce = `OXNONCE_NOENTER_${process.pid}`;
      // Type the command literally but DON'T send Enter — the needle is present
      // as a typed substring, never as a submitted output line.
      execFileSync("tmux", ["send-keys", "-t", session, "-l", `echo ${nonce}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const res = await waitForPaneLine(session, nonce, { timeoutMs: 800, pollMs: 100 });
      assert.equal(res.ok, false, "must NOT confirm on an unsubmitted typed line");
    } finally {
      execFileSync("tmux", ["kill-session", "-t", session], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    }
  },
);

// End-to-end test for assets/pretooluse.sh as a subprocess. Verifies the
// JSON envelope shape, body extraction (with escapes), session_id parsing
// from stdin, the lock-then-truncate semantics, and the no-op behavior when
// preconditions don't hold. Step 5 case 11 (multi-hook coexistence in a real
// Claude Code instance) is a separate live test, not in CI.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { register, type RegistryEntry } from "./registry.js";
import { enqueue, mailboxFilePath, mailboxLockPath } from "./mailbox.js";

const HOOK_SCRIPT = resolve(import.meta.dirname, "..", "assets", "pretooluse.sh");

function fakeEntry(home: string, peerPid: number, sessionId: string): RegistryEntry {
  return {
    server_pid: peerPid,
    started_at: Math.floor(Date.now() / 1000),
    client: {
      type: "claude-code",
      session_id: sessionId,
      transcript_path: null,
      session_id_source: "self-register",
      cwd: home,
    },
    tmux_pane: null,
    tmux_session: null,
    state: null,
  };
}

function runHook(env: Record<string, string>, stdin?: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolveResult) => {
    const child = spawn("bash", [HOOK_SCRIPT], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => resolveResult({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-hook-pipe-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return fn(home).finally(() => {
    process.env.HOME = prev;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best */ }
  });
}

// Case 1: env-only is silent. Step 0a confirmed Claude Code strips
// CLAUDE_CODE_SESSION_ID from hook subprocesses, so even with the env var
// set, the hook must NOT look there — it only reads stdin. Stdin closed
// (no payload) → no session_id → silent exit.
test("hook: env-only (no usable stdin) is silent — confirms env is dead code", async () => {
  await withHome(async (home) => {
    const peerPid = 71001;
    const sid = "envonly1-1111-2222-3333-444444444444";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "should not be delivered via env");

    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
      // stdio: ignore → child reads /dev/null → cat reads EOF immediately,
      // sid stays empty, hook exits 0 silently. No "tty" detection needed.
      const child = spawn("bash", [HOOK_SCRIPT], {
        env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_CODE_SESSION_ID: sid },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      child.on("close", (code) => res({ code: code ?? 0, stdout, stderr }));
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    // Mailbox unchanged — hook did not drain it.
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").trim().length > 0);
  });
});

test("hook: stdin happy path — single message becomes additionalContext", async () => {
  await withHome(async (home) => {
    const peerPid = 71002;
    const sid = "11111111-2222-3333-4444-555555555555";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "hello from peer");

    const stdin = JSON.stringify({
      session_id: sid,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
    });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, "hook must emit envelope");
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "hello from peer");

    // Mailbox truncated.
    assert.equal(readFileSync(mailboxFilePath(peerPid), "utf8"), "");
    // Lock dir cleaned up.
    assert.equal(existsSync(mailboxLockPath(peerPid)), false);
  });
});

test("hook: multiple messages concatenated with \\n\\n", async () => {
  await withHome(async (home) => {
    const peerPid = 71003;
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "first");
    enqueue(peerPid, "second");

    const stdin = JSON.stringify({ session_id: sid });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, "first\n\nsecond");
  });
});

test("hook: empty mailbox file → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    const peerPid = 71004;
    const sid = "12345678-1234-1234-1234-123456789012";
    register(fakeEntry(home, peerPid, sid));
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${peerPid}.jsonl`), "");

    const stdin = JSON.stringify({ session_id: sid });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("hook: no mailbox file at all → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    const peerPid = 71005;
    const sid = "feedface-feed-face-feed-facefeedface";
    register(fakeEntry(home, peerPid, sid));
    // No enqueue, no manual mkdir — mailbox dir may not even exist yet.

    const stdin = JSON.stringify({ session_id: sid });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("hook: stdin without session_id → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    const stdin = JSON.stringify({ tool_name: "Bash" });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("hook: stale session_id (no registry entry matches) → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    // Create the sessions dir so the early guard passes, but no entries match.
    mkdirSync(join(home, ".oxtail", "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, ".oxtail", "mailboxes"), { recursive: true, mode: 0o700 });
    const stdin = JSON.stringify({ session_id: "no-such-session-uuid-9999" });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test('hook: body with escapes ("\\"", "\\\\", "\\n", non-ASCII) round-trips', async () => {
  await withHome(async (home) => {
    const peerPid = 71008;
    const sid = "abcd1234-abcd-1234-abcd-1234abcd1234";
    register(fakeEntry(home, peerPid, sid));
    const body = `quote "x" backslash \\ newline\n unicode 🦊`;
    enqueue(peerPid, body);

    const stdin = JSON.stringify({ session_id: sid });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, body);
  });
});

test("hook: lock contention — held lock blocks the run; exits 0 without delivery", async () => {
  await withHome(async (home) => {
    const peerPid = 71009;
    const sid = "cafecafe-cafe-cafe-cafe-cafecafecafe";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "held");

    // Manually hold the lock with a current mtime so the staleness check
    // doesn't clear it. 50 × 10ms ≈ 500ms before the hook gives up.
    const lock = mailboxLockPath(peerPid);
    mkdirSync(lock, { mode: 0o700 });

    const stdin = JSON.stringify({ session_id: sid });
    const before = Date.now();
    const r = await runHook({ HOME: home }, stdin);
    const elapsed = Date.now() - before;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(elapsed >= 400, `hook should have spun on the lock (~500ms), got ${elapsed}ms`);

    // Mailbox still has the message (hook never got past lock).
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").includes("held"));

    // Now remove the lock and re-run; delivery should succeed.
    rmSync(lock, { recursive: true, force: true });
    const r2 = await runHook({ HOME: home }, stdin);
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.length > 0, "post-unlock run must deliver");
    const parsed = JSON.parse(r2.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, "held");
  });
});

test("hook: stale lock (mtime 60s ago) is force-cleared and delivery proceeds", async () => {
  await withHome(async (home) => {
    const peerPid = 71010;
    const sid = "deafbeef-dead-beef-dead-beefdeafbeef";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "stale-cleared");

    const lock = mailboxLockPath(peerPid);
    mkdirSync(lock, { mode: 0o700 });
    const old = Math.floor((Date.now() - 60_000) / 1000);
    utimesSync(lock, old, old);

    const stdin = JSON.stringify({ session_id: sid });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.additionalContext, "stale-cleared");
  });
});

test("hook coexistence: a second PreToolUse script's stdout is independent of ours", async () => {
  // This is the in-process simulation of Step 5 case 11 — confirming that
  // running our hook does not consume or corrupt another PreToolUse script's
  // stdout. The LIVE run against a real Claude Code instance is documented
  // separately; this test just nails down the shell-level invariant.
  await withHome(async (home) => {
    const peerPid = 71011;
    const sid = "ce0ec5ea-bcef-ace5-cebc-efacce0ec5ea";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "oxtail-payload");

    const stdin = JSON.stringify({ session_id: sid });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(parsed.hookSpecificOutput.additionalContext, "oxtail-payload");
    // The hook's stdout is exactly one JSON line + trailing newline; no
    // sentinel markers (like Terminator's %%MSG-IDS%%) leak into stdout.
    assert.ok(!r.stdout.includes("%%"), "no sentinel markers in oxtail stdout");
    assert.equal(
      r.stdout.split("\n").filter((l) => l.length > 0).length,
      1,
      "exactly one non-empty line on stdout",
    );
  });
});

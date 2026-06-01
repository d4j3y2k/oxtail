// End-to-end test for assets/stop.sh as a subprocess. Verifies the
// decision:block envelope shape, body + reply-metadata extraction, session_id
// parsing from stdin, the stop_hook_active loop guard, lock-then-truncate
// semantics, and the no-op (allow-stop) behavior when preconditions don't hold.

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

const HOOK_SCRIPT = resolve(import.meta.dirname, "..", "assets", "stop.sh");

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
  const home = mkdtempSync(join(tmpdir(), "oxtail-stop-pipe-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return fn(home).finally(() => {
    process.env.HOME = prev;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best */ }
  });
}

test("stop: happy path — single message becomes a decision:block reason", async () => {
  await withHome(async (home) => {
    const peerPid = 72001;
    const sid = "11111111-2222-3333-4444-555555555555";
    const senderSid = "22222222-3333-4444-5555-666666666666";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "hello from peer", senderSid);

    const stdin = JSON.stringify({
      session_id: sid,
      hook_event_name: "Stop",
      stop_hook_active: false,
    });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, "hook must emit envelope");
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision, "block");
    const reason = parsed.reason;
    assert.ok(reason.includes("[oxtail] 1 new peer message(s) arrived"));
    assert.ok(reason.includes("respond before stopping"));
    assert.ok(reason.includes("message_id:"));
    assert.ok(reason.includes(`from_session_id: ${senderSid}`));
    assert.ok(reason.includes("body:\nhello from peer"));
    // Phase D: terse reply instruction; verbose pre-Phase-D sentence gone;
    // message_id + from_session_id retained.
    assert.ok(
      reason.includes("Reply to any that need it via mcp__oxtail__send_message"),
      "terse reply instruction present",
    );
    assert.ok(!reason.includes("using that UUID as target"), "verbose instruction removed");

    // Mailbox truncated.
    assert.equal(readFileSync(mailboxFilePath(peerPid), "utf8"), "");
    // Lock dir cleaned up.
    assert.equal(existsSync(mailboxLockPath(peerPid)), false);
  });
});

test("stop: multiple messages include reply metadata and bodies", async () => {
  await withHome(async (home) => {
    const peerPid = 72002;
    const sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "first", "11111111-1111-1111-1111-111111111111");
    enqueue(peerPid, "second", "22222222-2222-2222-2222-222222222222");

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision, "block");
    const reason = parsed.reason;
    assert.ok(reason.includes("[oxtail] 2 new peer message(s) arrived"));
    assert.ok(reason.includes("--- message 1 ---"));
    assert.ok(reason.includes("from_session_id: 11111111-1111-1111-1111-111111111111"));
    assert.ok(reason.includes("body:\nfirst"));
    assert.ok(reason.includes("--- message 2 ---"));
    assert.ok(reason.includes("from_session_id: 22222222-2222-2222-2222-222222222222"));
    assert.ok(reason.includes("body:\nsecond"));
  });
});

test("stop: stop_hook_active=true → exit 0, no block, mailbox preserved (loop guard)", async () => {
  await withHome(async (home) => {
    const peerPid = 72003;
    const sid = "12345678-1234-1234-1234-123456789012";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "waiting message", "33333333-3333-3333-3333-333333333333");

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: true });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "", "must not block on a re-entry");
    // Mailbox is NOT drained — the message survives for the next natural turn.
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").includes("waiting message"));
  });
});

test("stop: stop_hook_active with spaces ('\": true') is still honored", async () => {
  await withHome(async (home) => {
    const peerPid = 72004;
    const sid = "abababab-abab-abab-abab-abababababab";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "still waiting");

    // Hand-rolled JSON with whitespace around the colon and value.
    const stdin = `{"session_id": "${sid}", "stop_hook_active" :  true }`;
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").includes("still waiting"));
  });
});

test("stop: empty mailbox file → exit 0 (allow stop), empty stdout", async () => {
  await withHome(async (home) => {
    const peerPid = 72005;
    const sid = "feedface-feed-face-feed-facefeedface";
    register(fakeEntry(home, peerPid, sid));
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${peerPid}.jsonl`), "");

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("stop: no mailbox file at all → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    const peerPid = 72006;
    const sid = "cafef00d-cafe-f00d-cafe-f00dcafef00d";
    register(fakeEntry(home, peerPid, sid));

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("stop: stdin without session_id → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    const stdin = JSON.stringify({ hook_event_name: "Stop", stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("stop: stale session_id (no registry entry) → exit 0, empty stdout", async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, ".oxtail", "sessions"), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, ".oxtail", "mailboxes"), { recursive: true, mode: 0o700 });
    const stdin = JSON.stringify({ session_id: "no-such-session-uuid-9999", stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("stop: closed stdin (no payload) → exit 0 silently", async () => {
  await withHome(async (home) => {
    const peerPid = 72007;
    const sid = "0ff0ff0f-0ff0-ff0f-0ff0-ff0f0ff0ff0f";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "should not deliver without stdin");

    const r = await new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
      const child = spawn("bash", [HOOK_SCRIPT], {
        env: { PATH: process.env.PATH ?? "", HOME: home },
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
    // Mailbox untouched.
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").trim().length > 0);
  });
});

test('stop: body with escapes ("\\"", "\\\\", "\\n", non-ASCII) round-trips', async () => {
  await withHome(async (home) => {
    const peerPid = 72008;
    const sid = "abcd1234-abcd-1234-abcd-1234abcd1234";
    register(fakeEntry(home, peerPid, sid));
    const body = `quote "x" backslash \\ newline\n unicode 🦊`;
    enqueue(peerPid, body);

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision, "block");
    assert.ok(parsed.reason.includes(`body:\n${body}`));
  });
});

test("stop: lock contention — held lock blocks the run; exits 0 without delivery", async () => {
  await withHome(async (home) => {
    const peerPid = 72009;
    const sid = "cafecafe-cafe-cafe-cafe-cafecafecafe";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "held");

    const lock = mailboxLockPath(peerPid);
    mkdirSync(lock, { mode: 0o700 });

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const before = Date.now();
    const r = await runHook({ HOME: home }, stdin);
    const elapsed = Date.now() - before;
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.ok(elapsed >= 400, `hook should have spun on the lock (~500ms), got ${elapsed}ms`);
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").includes("held"));

    rmSync(lock, { recursive: true, force: true });
    const r2 = await runHook({ HOME: home }, stdin);
    assert.equal(r2.code, 0);
    assert.ok(r2.stdout.length > 0, "post-unlock run must deliver");
    const parsed = JSON.parse(r2.stdout);
    assert.equal(parsed.decision, "block");
    assert.ok(parsed.reason.includes("body:\nheld"));
  });
});

test("stop: all mailbox locks held → allow stop, preserve mailbox, mark idle", async () => {
  await withHome(async (home) => {
    const peerPid = 72023;
    const sid = "23232323-aaaa-bbbb-cccc-232323232323";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "held but should survive");

    const activityDir = join(home, ".oxtail", "activity");
    mkdirSync(activityDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(activityDir, sid), "busy");

    const lock = mailboxLockPath(peerPid);
    mkdirSync(lock, { mode: 0o700 });

    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: sid, stop_hook_active: false }));
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").includes("held but should survive"));
    assert.equal(activityStatus(home, sid), "idle");
  });
});

test("stop: stale lock (mtime 60s ago) is force-cleared and delivery proceeds", async () => {
  await withHome(async (home) => {
    const peerPid = 72010;
    const sid = "deafbeef-dead-beef-dead-beefdeafbeef";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "stale-cleared");

    const lock = mailboxLockPath(peerPid);
    mkdirSync(lock, { mode: 0o700 });
    const old = Math.floor((Date.now() - 60_000) / 1000);
    utimesSync(lock, old, old);

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision, "block");
    assert.ok(parsed.reason.includes("body:\nstale-cleared"));
  });
});

test("stop: stdout is exactly one JSON line, no sentinel leakage", async () => {
  await withHome(async (home) => {
    const peerPid = 72011;
    const sid = "ce0ec5ea-bcef-ace5-cebc-efacce0ec5ea";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "oxtail-payload");

    const stdin = JSON.stringify({ session_id: sid, stop_hook_active: false });
    const r = await runHook({ HOME: home }, stdin);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.decision, "block");
    assert.ok(parsed.reason.includes("body:\noxtail-payload"));
    assert.ok(!r.stdout.includes("%%"), "no sentinel markers in oxtail stdout");
    assert.equal(
      r.stdout.split("\n").filter((l) => l.length > 0).length,
      1,
      "exactly one non-empty line on stdout",
    );
  });
});

function activityStatus(home: string, key: string): string | null {
  try {
    return readFileSync(join(home, ".oxtail", "activity", key), "utf8").trim();
  } catch {
    return null;
  }
}

test("stop: marks the session idle on a real stop (empty mailbox)", async () => {
  await withHome(async (home) => {
    const peerPid = 72020;
    const sid = "20202020-2020-2020-2020-202020202020";
    register(fakeEntry(home, peerPid, sid));
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${peerPid}.jsonl`), "");

    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: sid, stop_hook_active: false }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(activityStatus(home, sid), "idle");
  });
});

test("stop: does NOT mark idle when delivering (the blocked turn continues)", async () => {
  await withHome(async (home) => {
    const peerPid = 72021;
    const sid = "21212121-2121-2121-2121-212121212121";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "deliver me", "33333333-3333-3333-3333-333333333333");

    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: sid, stop_hook_active: false }));
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).decision, "block");
    assert.equal(activityStatus(home, sid), null, "must not mark idle while blocking to deliver");
  });
});

test("stop: marks idle on a re-entry (stop_hook_active=true) even with messages waiting", async () => {
  await withHome(async (home) => {
    const peerPid = 72022;
    const sid = "22222222-aaaa-bbbb-cccc-222222222222";
    register(fakeEntry(home, peerPid, sid));
    enqueue(peerPid, "still queued");

    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: sid, stop_hook_active: true }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.equal(activityStatus(home, sid), "idle");
    // Loop guard preserved the mailbox (we did not deliver on the re-entry).
    assert.ok(readFileSync(mailboxFilePath(peerPid), "utf8").includes("still queued"));
  });
});

// End-to-end test for assets/userpromptsubmit.sh as a subprocess. Verifies it
// marks the session "busy" in ~/.oxtail/activity/<pid>, and is silent when it
// can't resolve a session.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { register, type RegistryEntry } from "./registry.js";

const HOOK_SCRIPT = resolve(import.meta.dirname, "..", "assets", "userpromptsubmit.sh");

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

function runHook(env: Record<string, string>, stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn("bash", [HOOK_SCRIPT], { env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => res({ code: code ?? 0, stdout, stderr }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-ups-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  return fn(home).finally(() => {
    process.env.HOME = prev;
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best */ }
  });
}

function activityStatus(home: string, pid: number): string | null {
  try {
    return readFileSync(join(home, ".oxtail", "activity", String(pid)), "utf8").trim();
  } catch {
    return null;
  }
}

test("userpromptsubmit: marks the session busy", async () => {
  await withHome(async (home) => {
    const peerPid = 73001;
    const sid = "73017301-7301-7301-7301-730173017301";
    register(fakeEntry(home, peerPid, sid));

    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: sid, hook_event_name: "UserPromptSubmit" }));
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(activityStatus(home, peerPid), "busy");
  });
});

test("userpromptsubmit: no session_id → exit 0, no activity written", async () => {
  await withHome(async (home) => {
    const r = await runHook({ HOME: home }, JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("userpromptsubmit: stale session (no registry entry) → exit 0, no activity written", async () => {
  await withHome(async (home) => {
    mkdirSync(join(home, ".oxtail", "sessions"), { recursive: true, mode: 0o700 });
    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: "no-such-uuid-7777" }));
    assert.equal(r.code, 0);
    assert.equal(activityStatus(home, 99999), null);
  });
});

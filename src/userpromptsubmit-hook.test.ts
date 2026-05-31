// End-to-end test for assets/userpromptsubmit.sh as a subprocess. It marks the
// session "busy" in ~/.oxtail/activity/<session_id>, straight from the hook
// payload (no registry/pid lookup), and is silent without a session_id.

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const HOOK_SCRIPT = resolve(import.meta.dirname, "..", "assets", "userpromptsubmit.sh");

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

function activityStatus(home: string, key: string): string | null {
  try {
    return readFileSync(join(home, ".oxtail", "activity", key), "utf8").trim();
  } catch {
    return null;
  }
}

test("userpromptsubmit: marks the session busy, keyed by session_id (no registry needed)", async () => {
  await withHome(async (home) => {
    const sid = "73017301-7301-7301-7301-730173017301";
    const r = await runHook({ HOME: home }, JSON.stringify({ session_id: sid, hook_event_name: "UserPromptSubmit" }));
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(activityStatus(home, sid), "busy");
  });
});

test("userpromptsubmit: no session_id → exit 0, nothing written", async () => {
  await withHome(async (home) => {
    const r = await runHook({ HOME: home }, JSON.stringify({ hook_event_name: "UserPromptSubmit" }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

test("userpromptsubmit: closed stdin → exit 0 silently", async () => {
  await withHome(async (home) => {
    const r = await new Promise<{ code: number }>((res) => {
      const child = spawn("bash", [HOOK_SCRIPT], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
      child.on("close", (code) => res({ code: code ?? 0 }));
    });
    assert.equal(r.code, 0);
  });
});

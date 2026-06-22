// Unit tests for the hook-drop (SessionStart auto-join) detection strategy,
// plus a subprocess pipeline test for assets/sessionstart.sh itself.

import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Ancestor } from "../claims.js";
import { isAbstain, isHit, type DetectContext } from "./types.js";
import { listHookDrops, pickHookDrop, sessionStartsDir, type HookDrop } from "./hookDropStrategy.js";

const HOOK_SCRIPT = resolve(import.meta.dirname, "..", "..", "assets", "sessionstart.sh");

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-drop-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  const cleanup = () => {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  let result: T;
  try {
    result = fn(home);
  } catch (err) {
    cleanup();
    throw err;
  }
  // Async callers (`await withHome(async ...)`) must keep HOME set and the temp
  // dir alive until their promise SETTLES. A `try/finally` would fire the instant
  // fn() returns its pending promise — deleting the dir mid-test, after which the
  // subprocess hook re-creates `$HOME/.oxtail/session-starts/` via `mkdir -p` and
  // that recreated tree is never cleaned up (the leak: ~1.5k dirs over the project).
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).finally(cleanup) as unknown as T;
  }
  cleanup();
  return result;
}

// started_at defaults to 60s ago: most tests exercise the post-grace state
// (the +30s late-redetect pass). Tests of the grace gate itself pass a fresh
// started_at explicitly.
function ctxFor(cwd: string, startedAgoSec = 60): DetectContext {
  return {
    type: "claude-code",
    cwd,
    started_at: Math.floor(Date.now() / 1000) - startedAgoSec,
    env: {},
  };
}

function drop(o: {
  sid: string;
  cwd: string;
  ppid?: number;
  sig?: string;
  written_at?: number;
}): HookDrop {
  return {
    schema_version: 1,
    ppid: o.ppid ?? 999_999,
    ppid_sig: o.sig ?? "",
    written_at: o.written_at ?? Math.floor(Date.now() / 1000),
    payload: { session_id: o.sid, cwd: o.cwd, source: "startup" },
  };
}

function writeDrop(home: string, d: HookDrop): void {
  const dir = sessionStartsDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safe = d.payload.session_id.replace(/[^A-Za-z0-9_-]/g, "_");
  writeFileSync(join(dir, safe), JSON.stringify(d), { mode: 0o600 });
}

test("hook-drop: single cwd-matching drop, no ancestry, post-grace → medium hit", () => {
  const d = drop({ sid: "aaaa-1", cwd: "/proj" });
  const out = pickHookDrop(ctxFor("/proj"), [d], []);
  assert.ok(isHit(out));
  assert.equal(out.session_id, "aaaa-1");
  assert.equal(out.source, "hook-drop");
  assert.equal(out.confidence, "medium");
});

test("hook-drop: t0/t30 regression — a fresh FOREIGN drop is not adopted inside the startup grace", () => {
  // Codex's PR #28 BLOCK shape: session A started 30s ago and wrote its drop;
  // session B (us) just started and B's own drop hasn't landed yet. B's first
  // detection sees exactly one fresh unconfirmed drop — A's. Without the grace
  // gate B would adopt A's identity, and monotonic identity never repairs it.
  const aDrop = drop({
    sid: "session-A",
    cwd: "/proj",
    written_at: Math.floor(Date.now() / 1000) - 30,
  });
  const justStarted = ctxFor("/proj", 0);
  const out = pickHookDrop(justStarted, [aDrop], []);
  assert.ok(isAbstain(out), "must not adopt during the grace window");
  assert.notEqual(out.structural, true, "retries must re-run this");
  assert.match(out.reason, /own drop to land/);

  // By the +30s retry B's drop has landed: two unconfirmed drops → abstain
  // (structural), never a guess between two live sessions.
  const bDrop = drop({ sid: "session-B", cwd: "/proj" });
  const later = ctxFor("/proj", 30);
  const out2 = pickHookDrop(later, [aDrop, bDrop], []);
  assert.ok(isAbstain(out2));
  assert.equal(out2.structural, true);

  // And if ancestry CAN identify B's host, B resolves correctly even with A's
  // drop present — the high path is unaffected by the grace.
  const bConfirmed = drop({
    sid: "session-B",
    cwd: "/proj",
    ppid: 6001,
    sig: "Tue Jun 9 21:00:00 2026",
  });
  const out3 = pickHookDrop(
    later,
    [aDrop, bConfirmed],
    [{ pid: 6001, sig: "Tue Jun 9 21:00:00 2026" }],
  );
  assert.ok(isHit(out3));
  assert.equal(out3.session_id, "session-B");
});

test("hook-drop: ancestor-confirmed drop wins among several sharing a cwd → high hit", () => {
  const mine = drop({ sid: "mine-1", cwd: "/proj", ppid: 4321, sig: "Mon Jun 9 10:00:00 2026" });
  const other = drop({ sid: "other-1", cwd: "/proj", ppid: 8765, sig: "Mon Jun 9 09:00:00 2026" });
  const ancestors: Ancestor[] = [
    { pid: 7777, sig: "launcher" },
    { pid: 4321, sig: "Mon Jun 9 10:00:00 2026" },
  ];
  const out = pickHookDrop(ctxFor("/proj"), [other, mine], ancestors);
  assert.ok(isHit(out));
  assert.equal(out.session_id, "mine-1");
  assert.equal(out.confidence, "high");
});

test("hook-drop: pid match with WRONG signature is not confirmed (pid reuse)", () => {
  const stale = drop({ sid: "stale-1", cwd: "/proj", ppid: 4321, sig: "Sun Jun 8 10:00:00 2026" });
  const fresh = drop({ sid: "fresh-1", cwd: "/proj", ppid: 4321, sig: "Mon Jun 9 10:00:00 2026" });
  const ancestors: Ancestor[] = [{ pid: 4321, sig: "Mon Jun 9 10:00:00 2026" }];
  const out = pickHookDrop(ctxFor("/proj"), [stale, fresh], ancestors);
  assert.ok(isHit(out));
  assert.equal(out.session_id, "fresh-1", "lstart signature defeats pid reuse");
});

test("hook-drop: a STALE sole drop (dead session's leftover) is NOT adopted", () => {
  // The wrong-adoption race: a new session whose own drop hasn't landed yet
  // must not adopt yesterday's dead-session drop just because it's alone.
  const stale = drop({
    sid: "dead-session-1",
    cwd: "/proj",
    written_at: Math.floor(Date.now() / 1000) - 3600, // an hour before our start
  });
  const out = pickHookDrop(ctxFor("/proj"), [stale], []);
  assert.ok(isAbstain(out));
  assert.notEqual(out.structural, true, "our own drop may still appear — retryable");
  assert.match(out.reason, /predates/);
});

test("hook-drop: an old drop IS adopted when ancestry confirms it (mid-session MCP restart)", () => {
  const old = drop({
    sid: "long-lived-1",
    cwd: "/proj",
    ppid: 5150,
    sig: "Mon Jun 9 08:00:00 2026",
    written_at: Math.floor(Date.now() / 1000) - 7200,
  });
  const ancestors: Ancestor[] = [{ pid: 5150, sig: "Mon Jun 9 08:00:00 2026" }];
  const out = pickHookDrop(ctxFor("/proj"), [old], ancestors);
  assert.ok(isHit(out));
  assert.equal(out.session_id, "long-lived-1");
  assert.equal(out.confidence, "high", "ancestry beats staleness — the host is provably above us");
});

test("hook-drop: multiple unconfirmed drops for one cwd → structural abstain (never guess)", () => {
  const a = drop({ sid: "a-1", cwd: "/proj" });
  const b = drop({ sid: "b-1", cwd: "/proj" });
  const out = pickHookDrop(ctxFor("/proj"), [a, b], []);
  assert.ok(isAbstain(out));
  assert.equal(out.structural, true);
  assert.match(out.reason, /ambiguous|none ancestry-confirmed/i);
});

test("hook-drop: drops for OTHER cwds are invisible; none for ours → retryable abstain", () => {
  const other = drop({ sid: "x-1", cwd: "/other-project" });
  const out = pickHookDrop(ctxFor("/proj"), [other], []);
  assert.ok(isAbstain(out));
  assert.notEqual(out.structural, true, "a drop may still appear — retries must continue");
});

test("hook-drop: listHookDrops skips malformed + writer-temp files, prunes aged drops", () => {
  withHome((home) => {
    const dir = sessionStartsDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeDrop(home, drop({ sid: "live-1", cwd: "/proj" }));
    writeFileSync(join(dir, "garbage"), "not json");
    writeFileSync(join(dir, ".tmpfile.123"), JSON.stringify(drop({ sid: "tmp", cwd: "/proj" })));
    // Aged out (35 days) — pruned on scan.
    writeDrop(home, drop({
      sid: "ancient-1",
      cwd: "/proj",
      written_at: Math.floor(Date.now() / 1000) - 35 * 24 * 3600,
    }));

    const drops = listHookDrops(home);
    assert.deepEqual(drops.map((d) => d.payload.session_id), ["live-1"]);
    const left = readdirSync(dir).sort();
    assert.ok(!left.includes("ancient-1"), "aged drop pruned");
    assert.ok(left.includes("garbage"), "malformed file skipped, not destroyed");
  });
});

test("hook-drop: a stale-hook drop with lstart's double-spaced sig (single-digit day) is normalized on read and still confirms", () => {
  withHome((home) => {
    // Real `ps -o lstart=` bytes for days 1-9 of the month: the day is padded
    // with a SECOND space ("Tue Jun  9 ..."). v9 sessionstart.sh recorded that
    // verbatim, while snapshotProcs() rebuilds ancestor sigs single-spaced from
    // a whitespace split — so without read-side normalization the exact match
    // in ancestorConfirmed never fired on ~9 of every 30 calendar days.
    const d = drop({ sid: "v9-sig-1", cwd: "/proj", ppid: 4321, sig: "Tue Jun  9 21:58:27 2026" });
    writeDrop(home, d);
    const drops = listHookDrops(home);
    assert.equal(drops.length, 1);
    assert.equal(
      drops[0].ppid_sig,
      "Tue Jun 9 21:58:27 2026",
      "internal space run collapsed to the snapshotProcs form",
    );
    const out = pickHookDrop(ctxFor("/proj"), drops, [
      { pid: 4321, sig: "Tue Jun 9 21:58:27 2026" },
    ]);
    assert.ok(isHit(out));
    assert.equal(out.confidence, "high", "ancestry confirmation survives a stale-hook drop");
  });
});

// ── assets/sessionstart.sh subprocess pipeline ──────────────────────────────

function runHook(env: Record<string, string>, stdin: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((res) => {
    const child = spawn("bash", [HOOK_SCRIPT], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (code) => res({ code: code ?? 0, stdout, stderr }));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

test("sessionstart.sh: writes the drop with ancestry, NEVER prints to stdout", async () => {
  await withHome(async (home) => {
    const sid = "d40p1234-1111-4222-8333-444455556666";
    const payload = JSON.stringify({
      session_id: sid,
      transcript_path: `${home}/.claude/projects/x/${sid}.jsonl`,
      cwd: "/Users/davidkim/dev/oxtail",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const r = await runHook({ HOME: home }, payload);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, "", "SessionStart stdout becomes model context — must be EMPTY");

    const raw = readFileSync(join(sessionStartsDir(home), sid), "utf8");
    const wrapper = JSON.parse(raw) as HookDrop;
    assert.equal(wrapper.schema_version, 1);
    assert.equal(wrapper.payload.session_id, sid);
    assert.equal(wrapper.payload.cwd, "/Users/davidkim/dev/oxtail");
    assert.equal(wrapper.payload.source, "startup");
    // The hook's $PPID is the spawning process — this test runner.
    assert.equal(wrapper.ppid, process.pid);
    assert.ok(wrapper.written_at > 0);
  });
});

test("sessionstart.sh: ppid_sig byte-matches the reader's snapshotProcs normalization", async () => {
  await withHome(async (home) => {
    const sid = "d40psig1-1111-4222-8333-444455556666";
    const payload = JSON.stringify({
      session_id: sid,
      cwd: "/p",
      hook_event_name: "SessionStart",
      source: "startup",
    });
    const r = await runHook({ HOME: home }, payload);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const wrapper = JSON.parse(readFileSync(join(sessionStartsDir(home), sid), "utf8")) as HookDrop;
    // The hook's $PPID is this test runner, so rebuild the reader-side sig for
    // OUR pid exactly the way claims.ts snapshotProcs() does (whitespace split,
    // single-space join) and require byte equality. Uses REAL ps output, so on
    // days 1-9 of the month this catches the lstart double-space regression the
    // hand-written fixtures missed.
    const ps = execFileSync("ps", ["-o", "lstart=", "-p", String(process.pid)], {
      encoding: "utf8",
    });
    const readerSig = ps.trim().split(/\s+/).join(" ");
    assert.equal(wrapper.ppid_sig, readerSig, "writer sig must equal the reader normalization");
    assert.ok(!wrapper.ppid_sig.includes("  "), "no internal double space survives");
  });
});

test("sessionstart.sh: re-fires (resume/clear) overwrite the same drop in place", async () => {
  await withHome(async (home) => {
    const sid = "d40p9999-1111-4222-8333-444455556666";
    const mk = (source: string) =>
      JSON.stringify({ session_id: sid, cwd: "/p", hook_event_name: "SessionStart", source });
    await runHook({ HOME: home }, mk("startup"));
    await runHook({ HOME: home }, mk("resume"));
    const files = readdirSync(sessionStartsDir(home)).filter((f) => !f.startsWith("."));
    assert.deepEqual(files, [sid], "one drop per session_id, refreshed in place");
    const wrapper = JSON.parse(readFileSync(join(sessionStartsDir(home), sid), "utf8")) as HookDrop;
    assert.equal(wrapper.payload.source, "resume");
  });
});

test("sessionstart.sh: whitespace around the session_id colon still parses (Codex hardening note)", async () => {
  await withHome(async (home) => {
    const sid = "d40pw444-1111-4222-8333-444455556666";
    const payload = `{ "session_id" :  "${sid}", "cwd": "/p", "source": "startup" }`;
    const r = await runHook({ HOME: home }, payload);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.equal(r.stdout, "");
    const wrapper = JSON.parse(readFileSync(join(sessionStartsDir(home), sid), "utf8")) as HookDrop;
    assert.equal(wrapper.payload.session_id, sid, "pretty-printed payload must not disable auto-join");
  });
});

test("sessionstart.sh: no session_id in payload → exit 0, nothing written", async () => {
  await withHome(async (home) => {
    const r = await runHook({ HOME: home }, JSON.stringify({ hook_event_name: "SessionStart" }));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
    assert.throws(() => readdirSync(sessionStartsDir(home)));
  });
});

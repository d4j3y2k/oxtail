import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  awaitLaunchArtifact,
  type ArtifactObservation,
  listClaudeArtifacts,
  listCodexArtifacts,
  selectBoundArtifact,
  snapshotBaseline,
  type SelectCtx,
} from "./readiness.js";

function withTempHome<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-readiness-"));
  const prior = process.env.HOME;
  process.env.HOME = dir;
  return (async () => {
    try {
      return await fn(dir);
    } finally {
      process.env.HOME = prior;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  })();
}

const CWD = "/Users/dev/proj";

function obs(p: Partial<ArtifactObservation> & { sessionId: string }): ArtifactObservation {
  return {
    cwd: CWD,
    bornAtMs: 10_000,
    hostPpid: null,
    path: "x",
    ...p,
  };
}

function ctx(over: Partial<SelectCtx> = {}): SelectCtx {
  return {
    launchedPane: "%5",
    cwd: CWD,
    baseline: new Set<string>(),
    launchInstantMs: 10_000,
    resolvePaneForPpid: () => "%5", // default: every ppid resolves to OUR pane
    ...over,
  };
}

// ── selectBoundArtifact (pure core) ────────────────────────────────────────────

test("codex: a single fresh same-cwd rollout binds with no ppid", () => {
  const res = selectBoundArtifact("codex", [obs({ sessionId: "thread-1" })], ctx());
  assert.equal(res.status, "ready");
  if (res.status === "ready") assert.equal(res.observation.sessionId, "thread-1");
});

test("claude: a fresh drop binds ONLY when its ppid resolves to our pane", () => {
  const drop = obs({ sessionId: "sid-1", hostPpid: 4242 });
  const bound = selectBoundArtifact("claude", [drop], ctx({ resolvePaneForPpid: () => "%5" }));
  assert.equal(bound.status, "ready");
  // same drop, but its host pid resolves to a DIFFERENT pane → not ours
  const other = selectBoundArtifact("claude", [drop], ctx({ resolvePaneForPpid: () => "%9" }));
  assert.equal(other.status, "pending");
});

test("claude: a drop with no ppid never binds (fail-closed)", () => {
  const res = selectBoundArtifact("claude", [obs({ sessionId: "sid-1", hostPpid: null })], ctx());
  assert.equal(res.status, "pending");
});

test("baseline artifacts are excluded (only NEW ones count)", () => {
  const res = selectBoundArtifact(
    "codex",
    [obs({ sessionId: "old" }), obs({ sessionId: "new" })],
    ctx({ baseline: new Set(["old"]) }),
  );
  assert.equal(res.status, "ready");
  if (res.status === "ready") assert.equal(res.observation.sessionId, "new");
});

test("a different cwd is not ours", () => {
  const res = selectBoundArtifact(
    "codex",
    [obs({ sessionId: "elsewhere", cwd: "/Users/dev/other" })],
    ctx(),
  );
  assert.equal(res.status, "pending");
});

test("an artifact born before the launch floor is rejected (stale leftover)", () => {
  const res = selectBoundArtifact(
    "codex",
    [obs({ sessionId: "stale", bornAtMs: 1_000 })],
    ctx({ launchInstantMs: 10_000 }),
  );
  assert.equal(res.status, "pending");
});

test("same-second artifact within the skew floor is accepted", () => {
  // born 1.5s before the ms-granular launch instant — inside MTIME_FLOOR_SKEW_MS
  const res = selectBoundArtifact(
    "codex",
    [obs({ sessionId: "edge", bornAtMs: 8_500 })],
    ctx({ launchInstantMs: 10_000 }),
  );
  assert.equal(res.status, "ready");
});

test("two co-fresh same-cwd artifacts are AMBIGUOUS, never guessed", () => {
  const res = selectBoundArtifact(
    "codex",
    [obs({ sessionId: "a" }), obs({ sessionId: "b" })],
    ctx(),
  );
  assert.equal(res.status, "ambiguous");
});

test("claude: two drops, only the pane-bound one wins (the other session's drop ignored)", () => {
  const mine = obs({ sessionId: "mine", hostPpid: 100 });
  const theirs = obs({ sessionId: "theirs", hostPpid: 200 });
  const res = selectBoundArtifact("claude", [mine, theirs], {
    ...ctx(),
    resolvePaneForPpid: (pid) => (pid === 100 ? "%5" : "%7"),
  });
  assert.equal(res.status, "ready");
  if (res.status === "ready") assert.equal(res.observation.sessionId, "mine");
});

// ── awaitLaunchArtifact (poll loop) ────────────────────────────────────────────

test("await: resolves once the artifact appears on a later poll", async () => {
  let calls = 0;
  const res = await awaitLaunchArtifact("codex", {
    launchedPane: "%5",
    cwd: CWD,
    baseline: new Set(),
    launchInstantMs: 0,
    now: () => calls * 1000, // advance virtual clock per poll
    sleepFn: async () => {},
    resolvePaneForPpid: () => "%5",
    list: () => {
      calls++;
      return calls >= 3 ? [obs({ sessionId: "late", bornAtMs: 1 })] : [];
    },
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.sessionId, "late");
});

test("await: ambiguity aborts immediately (does not wait out the timeout)", async () => {
  const res = await awaitLaunchArtifact("codex", {
    launchedPane: "%5",
    cwd: CWD,
    baseline: new Set(),
    launchInstantMs: 0,
    now: () => 0,
    sleepFn: async () => {},
    list: () => [obs({ sessionId: "a", bornAtMs: 1 }), obs({ sessionId: "b", bornAtMs: 1 })],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /cannot safely pick/);
});

test("await: times out with the fresh-but-unbound set for the abort dump", async () => {
  let t = 0;
  const res = await awaitLaunchArtifact("claude", {
    launchedPane: "%5",
    cwd: CWD,
    baseline: new Set(),
    launchInstantMs: 0,
    timeoutMs: 5,
    now: () => (t += 10), // first check t=10 ≥ 5 → immediate timeout after one scan
    sleepFn: async () => {},
    resolvePaneForPpid: () => "%9", // drop exists but resolves elsewhere → unbound
    list: () => [obs({ sessionId: "unbound", hostPpid: 1, bornAtMs: 1 })],
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.reason, /never appeared, or never/);
    assert.deepEqual(res.candidates.map((c) => c.sessionId), ["unbound"]);
  }
});

// ── on-disk readers (withTempHome) ─────────────────────────────────────────────

test("listClaudeArtifacts reads a real SessionStart drop shape", async () => {
  await withTempHome((home) => {
    const dir = join(home, ".oxtail", "session-starts");
    mkdirSync(dir, { recursive: true });
    const drop = {
      schema_version: 1,
      ppid: 54321,
      ppid_sig: "Fri Jun 19 22:00:00 2026",
      written_at: Math.floor(Date.now() / 1000),
      payload: { session_id: "claude-sid", cwd: CWD, source: "startup" },
    };
    writeFileSync(join(dir, "claude-sid"), JSON.stringify(drop));
    const got = listClaudeArtifacts(home);
    assert.equal(got.length, 1);
    assert.equal(got[0].sessionId, "claude-sid");
    assert.equal(got[0].hostPpid, 54321);
    assert.equal(got[0].cwd, CWD);
  });
});

test("listCodexArtifacts reads cwd+thread-id from a HUGE session_meta first line", async () => {
  await withTempHome((home) => {
    const d = new Date();
    const dir = join(
      home,
      ".codex",
      "sessions",
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    // Inline a ~40KB base_instructions blob to blow past any 4KB first-line cap.
    const huge = "x".repeat(40 * 1024);
    const meta = {
      timestamp: "2026-06-20T02:28:33.354Z",
      type: "session_meta",
      payload: {
        id: "019ee2db-8932-7c51-8d56-c9b69b5eb5c6",
        cwd: CWD,
        base_instructions: { text: huge },
      },
    };
    const second = { type: "event", payload: {} };
    const file = "rollout-2026-06-19T22-28-18-019ee2db-8932-7c51-8d56-c9b69b5eb5c6.jsonl";
    writeFileSync(join(dir, file), `${JSON.stringify(meta)}\n${JSON.stringify(second)}\n`);
    const got = listCodexArtifacts(home);
    assert.equal(got.length, 1);
    assert.equal(got[0].sessionId, "019ee2db-8932-7c51-8d56-c9b69b5eb5c6");
    assert.equal(got[0].cwd, CWD);
    assert.equal(got[0].hostPpid, null);
  });
});

test("snapshotBaseline captures present ids so the diff only sees new ones", async () => {
  await withTempHome((home) => {
    const dir = join(home, ".oxtail", "session-starts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pre"),
      JSON.stringify({
        schema_version: 1,
        ppid: 1,
        ppid_sig: "s",
        written_at: Math.floor(Date.now() / 1000),
        payload: { session_id: "pre-existing", cwd: CWD },
      }),
    );
    const base = snapshotBaseline("claude", home);
    assert.ok(base.has("pre-existing"));
  });
});

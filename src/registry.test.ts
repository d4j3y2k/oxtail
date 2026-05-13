import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dedupeBySessionId,
  findTmuxPaneByAncestry,
  readAll,
  register,
  type RegistryEntry,
} from "./registry.js";
import { joinSessionsWithRegistry, type Session } from "./server.js";

type TmuxRow = Omit<Session, "client_type" | "client_session_id" | "state">;

function makeTmuxRow(name: string): TmuxRow {
  return { name, path: "/tmp/proj", attached: true, created_at: 0, windows: 1 };
}

function makeEntry(opts: {
  pid: number;
  session_id: string;
  tmux_session: string;
}): RegistryEntry {
  return {
    server_pid: opts.pid,
    started_at: 0,
    client: {
      type: "claude-code",
      session_id: opts.session_id,
      transcript_path: null,
      session_id_source: "self-register",
      cwd: "/tmp/proj",
    },
    tmux_pane: null,
    tmux_session: opts.tmux_session,
    state: null,
  };
}

test("findTmuxPaneByAncestry: hits when start pid IS a pane_pid", () => {
  const panePids = new Map<number, string>([[100, "%1"]]);
  const ppids = new Map<number, number>();
  assert.equal(findTmuxPaneByAncestry(100, panePids, ppids), "%1");
});

test("findTmuxPaneByAncestry: walks ppid chain to a pane_pid ancestor", () => {
  // codex MCP child (4000) -> codex (3000) -> shell (2000=pane_pid) -> tmux server (1500)
  const panePids = new Map<number, string>([[2000, "%7"]]);
  const ppids = new Map<number, number>([
    [4000, 3000],
    [3000, 2000],
    [2000, 1500],
  ]);
  assert.equal(findTmuxPaneByAncestry(4000, panePids, ppids), "%7");
});

test("findTmuxPaneByAncestry: returns null when no ancestor is a pane_pid", () => {
  const panePids = new Map<number, string>([[9999, "%99"]]);
  const ppids = new Map<number, number>([
    [4000, 3000],
    [3000, 2000],
    [2000, 1],
  ]);
  assert.equal(findTmuxPaneByAncestry(4000, panePids, ppids), null);
});

test("findTmuxPaneByAncestry: returns null when tmux is not running (empty pane map)", () => {
  // Bail cheap when there are no panes — don't even consult ppid map.
  const panePids = new Map<number, string>();
  const ppids = new Map<number, number>([[4000, 3000]]);
  assert.equal(findTmuxPaneByAncestry(4000, panePids, ppids), null);
});

test("findTmuxPaneByAncestry: stops at pid 1 instead of looping", () => {
  // pid 1's ppid is itself on some kernels; our guard is `pid > 1`, so we stop.
  const panePids = new Map<number, string>([[42, "%42"]]);
  const ppids = new Map<number, number>([
    [100, 1],
    [1, 1],
  ]);
  assert.equal(findTmuxPaneByAncestry(100, panePids, ppids), null);
});

test("findTmuxPaneByAncestry: bounded iteration cap prevents infinite loops on cycles", () => {
  // Pathological ppid cycle: A -> B -> A. We must terminate.
  const panePids = new Map<number, string>([[999, "%999"]]);
  const ppids = new Map<number, number>([
    [100, 200],
    [200, 100],
  ]);
  assert.equal(findTmuxPaneByAncestry(100, panePids, ppids), null);
});

// v0.6 list_project_sessions multi-agent enumeration. When N agents share a
// tmux session, the response must emit N rows with distinct
// client_session_ids — the old "byTmux.set(name, e)" last-write-wins logic
// silently dropped peers and broke discovery for Terminator-style multi-window
// setups.
test("joinSessionsWithRegistry: two agents in one tmux session emit two rows", () => {
  const matched = [makeTmuxRow("shared-tmux")];
  const registry = [
    makeEntry({ pid: 100, session_id: "uuid-aaa", tmux_session: "shared-tmux" }),
    makeEntry({ pid: 200, session_id: "uuid-bbb", tmux_session: "shared-tmux" }),
  ];
  const result = joinSessionsWithRegistry(matched, registry);
  assert.equal(result.length, 2, "two registered agents → two rows");
  const ids = result.map((r) => r.client_session_id).sort();
  assert.deepEqual(ids, ["uuid-aaa", "uuid-bbb"]);
  // Both rows share the tmux fields.
  assert.equal(result[0].name, "shared-tmux");
  assert.equal(result[1].name, "shared-tmux");
});

test("joinSessionsWithRegistry: tmux session with no registry entry → one null-client row", () => {
  const matched = [makeTmuxRow("unclaimed")];
  const registry: RegistryEntry[] = [];
  const result = joinSessionsWithRegistry(matched, registry);
  assert.equal(result.length, 1);
  assert.equal(result[0].client_session_id, null);
  assert.equal(result[0].client_type, null);
  assert.equal(result[0].state, null);
  assert.equal(result[0].name, "unclaimed");
});

test("joinSessionsWithRegistry: mixed (one shared, one solo, one unclaimed) → 4 rows", () => {
  const matched = [
    makeTmuxRow("shared"),
    makeTmuxRow("solo"),
    makeTmuxRow("unclaimed"),
  ];
  const registry = [
    makeEntry({ pid: 1, session_id: "uuid-1", tmux_session: "shared" }),
    makeEntry({ pid: 2, session_id: "uuid-2", tmux_session: "shared" }),
    makeEntry({ pid: 3, session_id: "uuid-3", tmux_session: "solo" }),
    // No registry entry for "unclaimed".
  ];
  const result = joinSessionsWithRegistry(matched, registry);
  assert.equal(result.length, 4, "2 (shared) + 1 (solo) + 1 (unclaimed) = 4");
  const sharedRows = result.filter((r) => r.name === "shared");
  assert.equal(sharedRows.length, 2);
  const soloRows = result.filter((r) => r.name === "solo");
  assert.equal(soloRows.length, 1);
  assert.equal(soloRows[0].client_session_id, "uuid-3");
  const unclaimedRows = result.filter((r) => r.name === "unclaimed");
  assert.equal(unclaimedRows.length, 1);
  assert.equal(unclaimedRows[0].client_session_id, null);
});

test("joinSessionsWithRegistry: registry entries with tmux_session not in matched are ignored", () => {
  const matched = [makeTmuxRow("in-scope")];
  const registry = [
    makeEntry({ pid: 1, session_id: "uuid-1", tmux_session: "in-scope" }),
    makeEntry({ pid: 2, session_id: "uuid-2", tmux_session: "out-of-scope" }),
  ];
  const result = joinSessionsWithRegistry(matched, registry);
  assert.equal(result.length, 1, "out-of-scope registry entry doesn't conjure a row");
  assert.equal(result[0].client_session_id, "uuid-1");
});

// v0.6 wake-pane staleness retry. When tmux send-keys against the cached
// pane id errors (Terminator-style window churn invalidates the id),
// askPeerWake retries against the tmux session name. Without the retry the
// wake silently no-ops and ask_peer falls back to 45s polling.
import { askPeerWakeImpl } from "./server.js";

test("askPeerWakeImpl: retries against sessionName when pane send-keys fails", async () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
    if (target === "%stale") throw new Error("can't find pane");
  };
  const result = await askPeerWakeImpl("%stale", "my-session", fire);
  assert.equal(result, true, "retry against sessionName succeeded");
  assert.deepEqual(calls, ["%stale", "my-session"]);
});

test("askPeerWakeImpl: returns false when both pane and sessionName fail", async () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
    throw new Error("tmux dead");
  };
  const result = await askPeerWakeImpl("%stale", "my-session", fire);
  assert.equal(result, false);
  assert.deepEqual(calls, ["%stale", "my-session"], "both attempted");
});

test("askPeerWakeImpl: no retry when pane succeeds first try", async () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
  };
  const result = await askPeerWakeImpl("%good", "my-session", fire);
  assert.equal(result, true);
  assert.deepEqual(calls, ["%good"], "only the primary target");
});

test("askPeerWakeImpl: no retry when pane is null (sessionName was primary)", async () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
    throw new Error("tmux dead");
  };
  const result = await askPeerWakeImpl(null, "my-session", fire);
  assert.equal(result, false);
  assert.deepEqual(calls, ["my-session"], "no retry — sessionName was the only target");
});

test("askPeerWakeImpl: skips entirely when both pane and sessionName are null", async () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
  };
  const result = await askPeerWakeImpl(null, null, fire);
  assert.equal(result, false);
  assert.deepEqual(calls, [], "nothing fired");
});

// v0.7: async fire callback (paste-burst-aware wake awaits between keystrokes).
test("askPeerWakeImpl: awaits async fire callback", async () => {
  const calls: string[] = [];
  let resolveSecond: (() => void) | null = null;
  const fire = async (target: string) => {
    calls.push(`${target}:start`);
    await new Promise<void>((r) => {
      resolveSecond = r;
    });
    calls.push(`${target}:end`);
  };
  const promise = askPeerWakeImpl("%good", null, fire);
  // Let fire enter; it'll be stuck waiting on resolveSecond.
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ["%good:start"], "fire entered but not yet resolved");
  resolveSecond!();
  const result = await promise;
  assert.equal(result, true);
  assert.deepEqual(calls, ["%good:start", "%good:end"], "fire fully awaited before return");
});

// Registry dedupe by session_id. One Claude/Codex session can spawn multiple
// MCP server children when oxtail is configured in more than one MCP scope
// (e.g. user-level config + project `.mcp.json` both declare it). Each child
// registers separately with a distinct server_pid but identical session_id.
// Without dedupe, list_project_sessions emits duplicate rows and read_session
// UUID lookup bails ("not in project scope") because its
// `matched.length === 1` invariant breaks.

function makeRegistryEntry(opts: {
  pid: number;
  session_id: string | null;
  started_at: number;
  tmux_session?: string | null;
  transcript_path?: string | null;
}): RegistryEntry {
  return {
    server_pid: opts.pid,
    started_at: opts.started_at,
    client: {
      type: "claude-code",
      session_id: opts.session_id,
      transcript_path: opts.transcript_path ?? null,
      session_id_source: "self-register",
      cwd: "/tmp/proj",
    },
    tmux_pane: null,
    tmux_session: opts.tmux_session ?? "session",
    state: null,
  };
}

test("dedupeBySessionId: two entries same session_id collapse to freshest", () => {
  const older = makeRegistryEntry({ pid: 100, session_id: "uuid-a", started_at: 1000 });
  const newer = makeRegistryEntry({ pid: 200, session_id: "uuid-a", started_at: 2000 });
  const result = dedupeBySessionId([older, newer]);
  assert.equal(result.length, 1);
  assert.equal(result[0].server_pid, 200);
});

test("dedupeBySessionId: distinct session_ids are preserved", () => {
  const a = makeRegistryEntry({ pid: 1, session_id: "uuid-a", started_at: 1000 });
  const b = makeRegistryEntry({ pid: 2, session_id: "uuid-b", started_at: 1000 });
  const result = dedupeBySessionId([a, b]);
  assert.equal(result.length, 2);
  const ids = result.map((e) => e.client.session_id).sort();
  assert.deepEqual(ids, ["uuid-a", "uuid-b"]);
});

test("dedupeBySessionId: null session_id entries are not collapsed together", () => {
  // Two unclaimed peers (pre-claim Codex, etc.) should remain distinct —
  // collapsing them by their shared `null` identity would be wrong.
  const a = makeRegistryEntry({ pid: 1, session_id: null, started_at: 1000 });
  const b = makeRegistryEntry({ pid: 2, session_id: null, started_at: 2000 });
  const result = dedupeBySessionId([a, b]);
  assert.equal(result.length, 2);
});

test("dedupeBySessionId: freshest wins regardless of input order", () => {
  const newer = makeRegistryEntry({ pid: 200, session_id: "uuid-a", started_at: 2000 });
  const older = makeRegistryEntry({ pid: 100, session_id: "uuid-a", started_at: 1000 });
  const result = dedupeBySessionId([newer, older]);
  assert.equal(result.length, 1);
  assert.equal(result[0].server_pid, 200);
});

function withTempHome<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-test-"));
  const priorHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    return fn(dir);
  } finally {
    process.env.HOME = priorHome;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function deadPid(): number {
  // `true` exits immediately; spawnSync waits for it, so by the time we
  // read .pid the process has been reaped — isAlive() returns false.
  const r = spawnSync("true", [], { stdio: "ignore" });
  if (typeof r.pid !== "number") throw new Error("could not spawn helper");
  return r.pid;
}

test("readAll: collapses two live entries sharing a session_id", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    // Simulating two live MCP server children for one client session.
    // server_pid keys the file on disk; isAlive() needs real pids, so we
    // use this test process's pid and ppid — both real, both alive.
    const a = process.pid;
    const b = process.ppid;
    writeFileSync(
      join(dir, `${a}.json`),
      JSON.stringify(
        makeRegistryEntry({
          pid: a,
          session_id: "uuid-twin",
          started_at: 1000,
          transcript_path: "/tmp/older.jsonl",
        }),
      ),
    );
    writeFileSync(
      join(dir, `${b}.json`),
      JSON.stringify(
        makeRegistryEntry({
          pid: b,
          session_id: "uuid-twin",
          started_at: 2000,
          transcript_path: "/tmp/newer.jsonl",
        }),
      ),
    );
    const result = readAll();
    assert.equal(result.length, 1, "two twins → one row");
    assert.equal(result[0].client.session_id, "uuid-twin");
    assert.equal(result[0].started_at, 2000, "freshest wins");
    assert.equal(result[0].client.transcript_path, "/tmp/newer.jsonl");
  });
});

test("readAll: prunes dead-pid entries and keeps the live one", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    const alive = process.pid;
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(
        makeRegistryEntry({ pid: dead, session_id: "uuid-x", started_at: 9999 }),
      ),
    );
    writeFileSync(
      join(dir, `${alive}.json`),
      JSON.stringify(
        makeRegistryEntry({ pid: alive, session_id: "uuid-x", started_at: 1 }),
      ),
    );
    const result = readAll();
    // Dead pid is GC'd by readAll() before dedupe even runs. The alive
    // entry wins despite its lower started_at — readAll never sees the
    // dead one as a candidate.
    assert.equal(result.length, 1);
    assert.equal(result[0].server_pid, alive);
    // And the dead file is unlinked from disk.
    assert.ok(!existsSync(join(dir, `${dead}.json`)));
  });
});

test("register: GCs dead-pid sibling sharing our session_id", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(
        makeRegistryEntry({ pid: dead, session_id: "uuid-y", started_at: 1 }),
      ),
    );
    // Register a new entry under our (live) pid sharing the same session_id.
    register(
      makeRegistryEntry({ pid: process.pid, session_id: "uuid-y", started_at: 2 }),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "dead sibling unlinked, only live entry remains");
    assert.equal(files[0], `${process.pid}.json`);
  });
});

test("register: leaves live sibling alone (legitimate multi-scope case)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const liveSibling = process.ppid;
    writeFileSync(
      join(dir, `${liveSibling}.json`),
      JSON.stringify(
        makeRegistryEntry({ pid: liveSibling, session_id: "uuid-z", started_at: 1 }),
      ),
    );
    register(
      makeRegistryEntry({ pid: process.pid, session_id: "uuid-z", started_at: 2 }),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 2, "both files kept on disk; readAll dedupes downstream");
    // And readAll collapses them to one row.
    const result = readAll();
    assert.equal(result.length, 1);
    assert.equal(result[0].server_pid, process.pid, "freshest started_at wins");
  });
});

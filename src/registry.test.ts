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
  chooseVerifiedWakePane,
  dedupeBySessionId,
  filenamePid,
  findTmuxPaneByAncestry,
  isValidTmuxPane,
  isValidTmuxSession,
  parentLikelyDied,
  readAll,
  readEntryFile,
  register,
  resolveTmuxPane,
  sessionPidsForId,
  type RegistryEntry,
} from "./registry.js";
import * as mailbox from "./mailbox.js";
import { recordReceived, countOpenObligations } from "./received.js";
// IMPORTANT: import from list-shape.js, NOT server.js — importing server.js
// runs its top-level register() and turns the test process into a live oxtail
// agent against the real $HOME (real registry entry + orphan-mailbox GC).
import { joinSessionsWithRegistry, tailChars, toCompactList, type Session } from "./list-shape.js";

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
// wake silently no-ops and ask_peer falls back to default-timeout polling.
import { askPeerWakeImpl } from "./wake.js";

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

// --- #6: tmux target validation + verified-pane wake targeting ---------------

test("isValidTmuxPane: accepts %N pane ids, rejects everything else", () => {
  assert.equal(isValidTmuxPane("%0"), true);
  assert.equal(isValidTmuxPane("%42"), true);
  assert.equal(isValidTmuxPane("%1; rm -rf /"), false, "no command tails");
  assert.equal(isValidTmuxPane("1"), false, "missing %");
  assert.equal(isValidTmuxPane("%"), false, "needs digits");
  assert.equal(isValidTmuxPane("%1.2"), false, "no pane.window syntax");
  assert.equal(isValidTmuxPane("victim-session"), false);
});

test("isValidTmuxSession: accepts tmux name chars, rejects separators/specials", () => {
  assert.equal(isValidTmuxSession("oxtail"), true);
  assert.equal(isValidTmuxSession("oxtail-codex_2"), true);
  assert.equal(isValidTmuxSession("has space"), false);
  assert.equal(isValidTmuxSession("a:b"), false, "colon is a tmux target separator");
  assert.equal(isValidTmuxSession("a.b"), false, "dot is a tmux target separator");
  assert.equal(isValidTmuxSession("%1"), false);
  assert.equal(isValidTmuxSession(""), false);
});

test("resolveTmuxPane: trusts a well-formed TMUX_PANE, ignores a spoofed one", () => {
  assert.equal(resolveTmuxPane({ TMUX_PANE: "%7" }), "%7", "well-formed env pane is trusted");
  // A spoofed/malformed TMUX_PANE must NOT be returned verbatim; it falls through
  // to ancestry resolution (which, with no tmux panes available here, is null).
  assert.equal(
    resolveTmuxPane({ TMUX_PANE: "%1; tmux kill-server" }, 999999),
    null,
    "malformed env pane is not trusted",
  );
});

test("chooseVerifiedWakePane: only ever returns the process-tree-resolved pane, never the cached self-written value", () => {
  // A malicious peer self-writes a cached pane pointing at a victim. The verified
  // resolver (process tree) is the source of truth.
  const spoofed = { tmux_pane: "%999", server_pid: 4242 };

  // Resolver can't bind server_pid to any pane → refuse, do NOT leak the spoof.
  assert.equal(chooseVerifiedWakePane(spoofed, () => null), null);

  // Resolver finds the REAL pane hosting server_pid → use that, not the spoof.
  assert.equal(chooseVerifiedWakePane(spoofed, () => "%3"), "%3");

  // Peer never registered a pane → never fish for one (test-runner-pid safety).
  assert.equal(
    chooseVerifiedWakePane({ tmux_pane: null, server_pid: 4242 }, () => "%3"),
    null,
    "pane-less/session-only entries are never blind-fired",
  );

  // Resolver returns a malformed pane (tmux output anomaly) → refuse.
  assert.equal(chooseVerifiedWakePane(spoofed, () => "%3; evil"), null);
});

test("chooseVerifiedWakePane: refuses when the live pid's start signature differs (PID reuse, M3)", () => {
  // The entry recorded the server process's start-time signature. A pane
  // resolves, but the live pid now reports a DIFFERENT start time → the pid was
  // recycled for an unrelated process; refuse rather than type into a stranger's
  // pane.
  const peer = { tmux_pane: "%5", server_pid: 4242, proc_sig: "Mon Jan  1 00:00:00 2026" };
  assert.equal(
    chooseVerifiedWakePane(peer, () => "%9", () => "Tue Feb  2 11:11:11 2026"),
    null,
    "recycled pid (different start sig) is refused",
  );
  // Matching signature → proceed with the resolved pane.
  assert.equal(
    chooseVerifiedWakePane(peer, () => "%9", () => "Mon Jan  1 00:00:00 2026"),
    "%9",
    "same process (matching sig) wakes normally",
  );
  // Indeterminate signature ("" — transient ps failure) → fall through to pane
  // resolution rather than a false refusal.
  assert.equal(
    chooseVerifiedWakePane(peer, () => "%9", () => ""),
    "%9",
    "empty sig reading does not cause a false refusal",
  );
  // Entry without a recorded sig (older version) → skip the check (back-compat).
  assert.equal(
    chooseVerifiedWakePane({ tmux_pane: "%5", server_pid: 4242 }, () => "%9", () => "whatever"),
    "%9",
    "sig-less entry preserves prior behavior",
  );
});

// --- #6 (provenance): server_pid is also self-written, so a registry file's
// server_pid must match the pid in its filename. Otherwise a forged
// <ownPid>.json with server_pid:<victimPid> would make chooseVerifiedWakePane →
// currentPaneForServerPid resolve (and wake) the victim's pane.

test("filenamePid: parses <pid>.json, rejects anything else", () => {
  assert.equal(filenamePid("12345.json"), 12345);
  assert.equal(filenamePid("1.json"), 1);
  assert.equal(filenamePid("0.json"), null, "pid must be > 0");
  assert.equal(filenamePid("12a.json"), null);
  assert.equal(filenamePid("12345.json.bak"), null);
  assert.equal(filenamePid("foo.json"), null);
  assert.equal(filenamePid("12345"), null);
});

test("readEntryFile: rejects an entry whose server_pid != the filename pid", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    // Legit: filename pid matches server_pid.
    writeFileSync(
      join(dir, "111.json"),
      JSON.stringify(makeRegistryEntry({ pid: 111, session_id: "ok", started_at: 1 })),
    );
    // Forged: file named 222.json but the entry claims server_pid 111 (borrowing
    // 111's pane). makeRegistryEntry sets server_pid from `pid`.
    writeFileSync(
      join(dir, "222.json"),
      JSON.stringify(makeRegistryEntry({ pid: 111, session_id: "forged", started_at: 1 })),
    );
    assert.ok(readEntryFile(dir, "111.json"), "matching entry is accepted");
    assert.equal(readEntryFile(dir, "222.json"), null, "server_pid != filename pid is rejected");
    assert.equal(readEntryFile(dir, "notpid.json"), null, "non-<pid>.json is rejected");
  });
});

test("readAll / sessionPidsForId: a forged file borrowing another pid is unaddressable (the #6 server_pid redirect)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const real = process.pid; // alive, legit owner
    const other = process.ppid; // alive — stands in for a victim pane owner
    // Legit entry: filename matches server_pid.
    writeFileSync(
      join(dir, `${real}.json`),
      JSON.stringify(makeRegistryEntry({ pid: real, session_id: "uuid-legit", started_at: 1000 })),
    );
    // Forged entry: file named `${other}.json` but server_pid points at `real`
    // so currentPaneForServerPid(real) would resolve real's pane.
    writeFileSync(
      join(dir, `${other}.json`),
      JSON.stringify(makeRegistryEntry({ pid: real, session_id: "uuid-forged", started_at: 2000 })),
    );

    const all = readAll();
    assert.equal(all.length, 1, "only the legit entry survives");
    assert.equal(all[0].client.session_id, "uuid-legit");
    assert.deepEqual(sessionPidsForId("uuid-forged"), [], "forged session is not addressable");
    assert.deepEqual(sessionPidsForId("uuid-legit"), [real]);
  });
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

test("register: reaps a PRIOR incarnation's dead entry from a DIFFERENT session (cross-session ghost-row gap)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    // A previous fleet's agent (its own session_id), now exited with an empty
    // mailbox. gcDeadSiblings leaves it alone (different session_id) and an idle
    // fleet may never drive readAll() over it — so without this it lingers as a
    // ⚫dead·gone ghost row in the cockpit forever.
    const deadGhost = deadPid();
    writeFileSync(
      join(dir, `${deadGhost}.json`),
      JSON.stringify(makeRegistryEntry({ pid: deadGhost, session_id: "uuid-prior", started_at: 1 })),
    );
    // The restarted fleet registers a fresh, unrelated session.
    register(
      makeRegistryEntry({ pid: process.pid, session_id: "uuid-current", started_at: 2 }),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.deepEqual(
      files,
      [`${process.pid}.json`],
      "prior incarnation's empty dead breadcrumb reaped at register; only the live one remains",
    );
  });
});

test("register: does NOT reap a dead cross-session entry that still holds undrained mail (mail-safe)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const deadGhost = deadPid();
    writeFileSync(
      join(dir, `${deadGhost}.json`),
      JSON.stringify(makeRegistryEntry({ pid: deadGhost, session_id: "uuid-prior", started_at: 1 })),
    );
    mailbox.enqueue(deadGhost, "left for a now-dead peer"); // undrained mail
    register(
      makeRegistryEntry({ pid: process.pid, session_id: "uuid-current", started_at: 2 }),
    );
    assert.ok(
      existsSync(join(dir, `${deadGhost}.json`)),
      "a dead breadcrumb with pending mail is kept (reap-deferral) even cross-session — no deliverable mail dropped",
    );
  });
});

test("register: KEEPS a dead cross-session entry whose SESSION box holds mail (stranded ✉ preserved)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const deadGhost = deadPid();
    writeFileSync(
      join(dir, `${deadGhost}.json`),
      JSON.stringify(makeRegistryEntry({ pid: deadGhost, session_id: "uuid-stranded", started_at: 1 })),
    );
    // v0.17 mail lives in the SESSION box, not the pid box (which is empty here).
    // The pid-box-only keep-gate reaped this and erased the cockpit's stranded ✉
    // for the dead owner — the bug max+codex caught. It must be KEPT.
    mailbox.enqueue(mailbox.mailboxSessionKey("uuid-stranded"), "unread by a now-dead peer");
    register(
      makeRegistryEntry({ pid: process.pid, session_id: "uuid-current", started_at: 2 }),
    );
    assert.ok(
      existsSync(join(dir, `${deadGhost}.json`)),
      "session-box mail keeps the dead breadcrumb — stranded ✉ signal survives register",
    );
  });
});

test("register: KEEPS a dead cross-session entry with an OPEN OBLIGATION (stranded ⚑ preserved)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const deadGhost = deadPid();
    writeFileSync(
      join(dir, `${deadGhost}.json`),
      JSON.stringify(makeRegistryEntry({ pid: deadGhost, session_id: "uuid-owes", started_at: 1 })),
    );
    // A delegation the dead session never closed lives in its LEDGER (pid box empty).
    // Reaping would erase the cockpit's stranded ⚑ "work stranded on a dead owner".
    recordReceived("uuid-owes", mailbox.buildMessage("review this", "boss-sid", { action_required: true }));
    assert.equal(countOpenObligations("uuid-owes"), 1, "obligation is open before register");
    register(
      makeRegistryEntry({ pid: process.pid, session_id: "uuid-current", started_at: 2 }),
    );
    assert.ok(
      existsSync(join(dir, `${deadGhost}.json`)),
      "an open obligation keeps the dead breadcrumb — stranded ⚑ signal survives register",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// session_id union drain + reap-deferral + dead-sibling consolidation
// (fixes silent message loss on MCP-child pid rotation)
// ────────────────────────────────────────────────────────────────────────────

test("sessionPidsForId: returns all (live + dead) pids for a session, oldest-first", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    const live = process.pid;
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-s", started_at: 10 })),
    );
    writeFileSync(
      join(dir, `${live}.json`),
      JSON.stringify(makeRegistryEntry({ pid: live, session_id: "uuid-s", started_at: 20 })),
    );
    // Unrelated session must be excluded.
    writeFileSync(
      join(dir, `4242.json`),
      JSON.stringify(makeRegistryEntry({ pid: 4242, session_id: "uuid-other", started_at: 5 })),
    );
    assert.deepEqual(
      sessionPidsForId("uuid-s"),
      [dead, live],
      "oldest-first, no liveness filter, only matching session",
    );
    assert.deepEqual(sessionPidsForId("nope"), []);
  });
});

test("readAll: defers reaping a dead CLAIMED entry whose mailbox is non-empty", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-keep", started_at: 1 })),
    );
    mailbox.enqueue(dead, "stranded"); // undrained mail in the dead child's box

    const result = readAll();
    assert.equal(result.length, 0, "dead entry excluded from live[]");
    assert.ok(
      existsSync(join(dir, `${dead}.json`)),
      "registry file kept as a routing breadcrumb while mail is pending",
    );

    // Once the mail is drained, a later readAll reaps the file normally.
    mailbox.drain(dead);
    readAll();
    assert.ok(!existsSync(join(dir, `${dead}.json`)), "reaped after mailbox emptied");
  });
});

test("readAll: KEEPS a dead claimed entry with an OPEN OBLIGATION — the messaging path can't erase the stranded ⚑ (Finding 1)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-owes", started_at: 1 })),
    );
    // The obligation lives in the LEDGER; pid + session boxes are empty. The old
    // pid-box-only rule reaped this on the messaging path, erasing the stranded ⚑.
    recordReceived("uuid-owes", mailbox.buildMessage("review it", "boss", { action_required: true }));
    const result = readAll();
    assert.equal(result.length, 0, "dead entry excluded from live[]");
    assert.ok(
      existsSync(join(dir, `${dead}.json`)),
      "readAll keeps the breadcrumb — an open obligation is a stranded signal, not pure noise",
    );
  });
});

test("readAll: KEEPS a dead claimed entry with SESSION-box mail (Finding 1)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-stranded", started_at: 1 })),
    );
    // v0.17 mail in the SESSION box, pid box empty — the old rule reaped it here.
    mailbox.enqueue(mailbox.mailboxSessionKey("uuid-stranded"), "unread v0.17 mail");
    const result = readAll();
    assert.equal(result.length, 0, "dead entry excluded from live[]");
    assert.ok(
      existsSync(join(dir, `${dead}.json`)),
      "readAll keeps the breadcrumb — session-box mail is a stranded ✉, not pure noise",
    );
  });
});

test("readAll: reaps a dead entry with an empty mailbox immediately", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-empty", started_at: 1 })),
    );
    readAll();
    assert.ok(!existsSync(join(dir, `${dead}.json`)), "no pending mail → reaped");
  });
});

test("readAll: reaps a dead NULL-session entry even with pending mail (not addressable)", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: null, started_at: 1 })),
    );
    mailbox.enqueue(dead, "orphan");
    readAll();
    assert.ok(
      !existsSync(join(dir, `${dead}.json`)),
      "null-session dead entry is reaped regardless of mail — keeping it only grows ambiguity",
    );
  });
});

test("register: migrates a dead sibling's mailbox into the new entry before unlinking", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-mig", started_at: 1 })),
    );
    // A peer enqueued to the prior (now-dead) pid before we restarted.
    mailbox.enqueue(dead, "pre-restart", "peer-sender", { request_id: "rq" });

    // Restart: register a fresh live entry under our pid, same session_id.
    register(makeRegistryEntry({ pid: process.pid, session_id: "uuid-mig", started_at: 2 }));

    assert.ok(!existsSync(join(dir, `${dead}.json`)), "dead sibling unlinked after migration");
    // v0.17: a claimed live entry consolidates into its SESSION box — the
    // canonical inbox, immune to a further pid rotation — not its pid box.
    const mine = mailbox.drain(mailbox.mailboxSessionKey("uuid-mig"));
    assert.deepEqual(
      mine.map((m) => m.body),
      ["pre-restart"],
      "stranded message consolidated into the live entry — not silently lost",
    );
    assert.equal(mine[0].request_id, "rq");
    assert.equal(mine[0].from_session_id, "peer-sender");
  });
});

test("register: publishes the new breadcrumb before migrating; migrate failure keeps old breadcrumb + mail", () => {
  withTempHome((home) => {
    const dir = join(home, ".oxtail", "sessions");
    mkdirSync(dir, { recursive: true });
    const dead = deadPid();
    writeFileSync(
      join(dir, `${dead}.json`),
      JSON.stringify(makeRegistryEntry({ pid: dead, session_id: "uuid-pub", started_at: 1 })),
    );
    mailbox.enqueue(dead, "pending");
    // Force the migrate's dest append to fail by holding a fresh lock on the
    // live entry's SESSION box (the v0.17 consolidation target) so the migrate
    // times out and throws.
    const destLock = mailbox.mailboxLockPath(mailbox.mailboxSessionKey("uuid-pub"));
    mkdirSync(destLock, { recursive: true, mode: 0o700 });
    try {
      register(makeRegistryEntry({ pid: process.pid, session_id: "uuid-pub", started_at: 2 }));
    } finally {
      try {
        rmSync(destLock, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    // Publication-order invariant: our breadcrumb exists even though the
    // subsequent migration failed — so a crash there can't hide migrated mail.
    assert.ok(
      existsSync(join(dir, `${process.pid}.json`)),
      "new pid breadcrumb published before migration ran",
    );
    // Migration failed → old sibling breadcrumb + mail preserved, not orphaned.
    assert.ok(
      existsSync(join(dir, `${dead}.json`)),
      "old sibling breadcrumb kept when migration fails",
    );
    assert.deepEqual(
      mailbox.drain(dead).map((m) => m.body),
      ["pending"],
      "old mail preserved for retry",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Phase C — pane char cap (tailChars) + opt-in list de-dup (toCompactList)
// ────────────────────────────────────────────────────────────────────────────

test("phase-c: tailChars leaves short text untouched", () => {
  const r = tailChars("short pane output", 1000);
  assert.equal(r.truncated, false);
  assert.equal(r.text, "short pane output");
});

test("phase-c: tailChars keeps the TAIL (most recent output) with a marker", () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
  const r = tailChars(text, 50);
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith("…[pane truncated to last 50 chars]\n"), "marker prefix present");
  assert.ok(r.text.endsWith("line 99"), "tail-preserving: ends with the newest output");
  // Body after the marker line is exactly the budget worth of code points.
  const body = r.text.slice(r.text.indexOf("\n") + 1);
  assert.equal(Array.from(body).length, 50);
});

test("phase-c: tailChars never splits a surrogate pair at the boundary", () => {
  // 100 emoji, each a surrogate pair (2 UTF-16 code units). A naive slice by
  // .length could cut one in half; Array.from slices by code point.
  const text = "😀".repeat(100);
  const r = tailChars(text, 10);
  assert.equal(r.truncated, true);
  assert.ok(!r.text.includes("�"), "no replacement char from a split surrogate");
  const body = r.text.slice(r.text.indexOf("\n") + 1);
  assert.equal(Array.from(body).length, 10, "exactly 10 whole emoji kept");
});

function sessionRow(over: Partial<Session> & Pick<Session, "name" | "client_session_id">): Session {
  return {
    name: over.name,
    path: over.path ?? "/tmp/proj",
    attached: over.attached ?? true,
    created_at: over.created_at ?? 1,
    windows: over.windows ?? 2,
    client_type: over.client_type ?? "claude-code",
    client_session_id: over.client_session_id,
    state: over.state ?? null,
  };
}

test("phase-c: toCompactList groups co-located agents and hoists shared tmux fields", () => {
  const sessions: Session[] = [
    sessionRow({ name: "shared", client_session_id: "uuid-a" }),
    sessionRow({ name: "shared", client_session_id: "uuid-b", client_type: "codex", state: { purpose: "x", updated_at: 5 } }),
  ];
  const compact = toCompactList({
    schema_version: 1,
    project_root: "/tmp/proj",
    inferred: false,
    sessions,
    error: null,
  });

  assert.equal(compact.tmux_sessions.length, 1, "two agents collapse to one tmux group");
  const g = compact.tmux_sessions[0]!;
  assert.equal(g.name, "shared");
  assert.equal(g.path, "/tmp/proj");
  assert.equal(g.windows, 2);
  assert.equal(g.agents.length, 2);
  assert.deepEqual(g.agents.map((a) => a.client_session_id), ["uuid-a", "uuid-b"]);
  assert.equal(g.agents[1]!.state?.purpose, "x");
  // Envelope fields carried through.
  assert.equal(compact.schema_version, 1);
  assert.equal(compact.project_root, "/tmp/proj");
  assert.equal(compact.inferred, false);
  assert.equal(compact.error, null);
});

test("phase-c: toCompactList represents an unclaimed tmux session as a group with no agents", () => {
  const sessions: Session[] = [
    { name: "ghost", path: "/tmp/proj", attached: false, created_at: 9, windows: 1, client_type: null, client_session_id: null, state: null },
  ];
  const compact = toCompactList({ schema_version: 1, project_root: "/tmp/proj", inferred: true, sessions, error: null });
  assert.equal(compact.tmux_sessions.length, 1);
  assert.equal(compact.tmux_sessions[0]!.name, "ghost");
  assert.deepEqual(compact.tmux_sessions[0]!.agents, [], "no phantom null-agent");
});

test("phase-c: compact shape is smaller than the flat shape for multi-agent sessions", () => {
  // Four agents sharing one tmux session — the matrix oxtail targets. The flat
  // shape repeats name/path/attached/created_at/windows four times.
  const sessions: Session[] = Array.from({ length: 4 }, (_, i) =>
    sessionRow({ name: "matrix", client_session_id: `uuid-${i}`, path: "/tmp/some/long/project/path" }),
  );
  const flat = { schema_version: 1 as const, project_root: "/tmp/some/long/project/path", inferred: false, sessions, error: null };
  const compact = toCompactList(flat);
  const flatBytes = JSON.stringify(flat).length;
  const compactBytes = JSON.stringify(compact).length;
  assert.ok(
    compactBytes < flatBytes,
    `compact (${compactBytes}) must be smaller than flat (${flatBytes}) for 4 co-located agents`,
  );
});

// ── parentLikelyDied: orphan self-reap signal (MCP server whose host died) ───────
test("parentLikelyDied: reparenting to pid 1 from a real parent ⇒ host died", () => {
  assert.equal(parentLikelyDied(4242, 1), true, "had a real parent, now reparented to init");
});

test("parentLikelyDied: a live, unchanged parent ⇒ not orphaned", () => {
  assert.equal(parentLikelyDied(4242, 4242), false);
});

test("parentLikelyDied: reparenting to a Linux SUBREAPER (not pid 1) ⇒ host died (L3)", () => {
  // On a Linux session with a subreaper (e.g. `systemd --user`) an orphan reparents
  // to the subreaper's pid, NOT init — so keying on `=== 1` silently missed it and
  // the watchdog never reaped. A ppid that simply CHANGED from our startup parent is
  // the portable orphan signal.
  assert.equal(parentLikelyDied(4242, 50), true, "ppid changed to the subreaper ⇒ original host gone");
});

test("parentLikelyDied: started under pid 1 ⇒ no parent to lose, signal unusable", () => {
  // A server genuinely launched by init/launchd can't use reparenting as a death
  // tell — it must fall back to stdin EOF — so this never reports a (false) death.
  assert.equal(parentLikelyDied(1, 1), false);
});

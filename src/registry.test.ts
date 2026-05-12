import { test } from "node:test";
import assert from "node:assert/strict";

import { findTmuxPaneByAncestry, type RegistryEntry } from "./registry.js";
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

test("askPeerWakeImpl: retries against sessionName when pane send-keys fails", () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
    if (target === "%stale") throw new Error("can't find pane");
  };
  const result = askPeerWakeImpl("%stale", "my-session", fire);
  assert.equal(result, true, "retry against sessionName succeeded");
  assert.deepEqual(calls, ["%stale", "my-session"]);
});

test("askPeerWakeImpl: returns false when both pane and sessionName fail", () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
    throw new Error("tmux dead");
  };
  const result = askPeerWakeImpl("%stale", "my-session", fire);
  assert.equal(result, false);
  assert.deepEqual(calls, ["%stale", "my-session"], "both attempted");
});

test("askPeerWakeImpl: no retry when pane succeeds first try", () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
  };
  const result = askPeerWakeImpl("%good", "my-session", fire);
  assert.equal(result, true);
  assert.deepEqual(calls, ["%good"], "only the primary target");
});

test("askPeerWakeImpl: no retry when pane is null (sessionName was primary)", () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
    throw new Error("tmux dead");
  };
  const result = askPeerWakeImpl(null, "my-session", fire);
  assert.equal(result, false);
  assert.deepEqual(calls, ["my-session"], "no retry — sessionName was the only target");
});

test("askPeerWakeImpl: skips entirely when both pane and sessionName are null", () => {
  const calls: string[] = [];
  const fire = (target: string) => {
    calls.push(target);
  };
  const result = askPeerWakeImpl(null, null, fire);
  assert.equal(result, false);
  assert.deepEqual(calls, [], "nothing fired");
});

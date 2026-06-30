import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClientType } from "../clients.js";
import * as mailbox from "../mailbox.js";
import { recordReceived } from "../received.js";
import { defaultPendingAskDir, recordPendingAsk } from "../pending-ask.js";
import type { RegistryEntry } from "../registry.js";
import {
  buildSnapshot,
  detectWaitCycles,
  resolveWaitTargets,
  type FleetAgent,
} from "./snapshot.js";

// homedir() defers to $HOME on POSIX; all oxtail stores resolve their dirs lazily,
// so swapping HOME isolates the on-disk reads (mirrors received.test.ts).
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-oxpit-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);

let pidCounter = 90000;

function makeEntry(over: Partial<RegistryEntry> & { type?: ClientType } = {}): RegistryEntry {
  const n = pidCounter++;
  const sid =
    over.client?.session_id ?? `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  return {
    // Default to the live test-runner pid so the agent reads as alive (isAlive);
    // override with a not-alive pid to exercise the "exited" liveness path.
    server_pid: over.server_pid ?? process.pid,
    started_at: NOW_S - 1000,
    client: {
      type: over.type ?? "claude-code",
      session_id: sid,
      transcript_path: over.client?.transcript_path ?? null,
      session_id_source: "env",
      cwd: "/proj",
    },
    tmux_pane: "%1",
    tmux_session: "proj",
    state: over.state ?? null,
    ...over,
    client: {
      type: over.type ?? "claude-code",
      session_id: sid,
      transcript_path: over.client?.transcript_path ?? null,
      session_id_source: "env",
      cwd: over.client?.cwd ?? "/proj",
    },
  };
}

// Write a transcript file at a controlled mtime (seconds ago relative to NOW).
function writeTranscript(home: string, name: string, ageS: number): string {
  const path = join(home, name);
  writeFileSync(path, "{}\n");
  const mtime = NOW_S - ageS;
  utimesSync(path, mtime, mtime);
  return path;
}

function buildOne(entry: RegistryEntry): FleetAgent {
  const snap = buildSnapshot({
    readEntries: () => [entry],
    allProjects: true,
    nowMs: NOW_MS,
    checkProcSig: false,
    selfSessionId: null,
    resolvePaneInfo: () => new Map(), // hermetic — don't hit the real tmux
  });
  assert.equal(snap.agents.length, 1, "expected exactly one agent");
  return snap.agents[0];
}

test("ordering: ⚫dead agents sink below live ones (live keep window order)", () => {
  // Dead breadcrumbs from prior fleet restarts must not bury the live session (David).
  const ALIVE = 111111;
  const DEAD = 222222;
  const mk = (sid: string, pane: string, pid: number) =>
    makeEntry({ server_pid: pid, tmux_pane: pane, client: { session_id: sid } as never });
  const entries = [
    mk("a-main", "%0", ALIVE), // win 0, live
    mk("d-old1", "%1", DEAD), // win 1, dead — interleaved by window index
    mk("a-cdx", "%2", ALIVE), // win 2, live
    mk("d-old2", "%3", DEAD), // win 3, dead
  ];
  const paneInfo = new Map([
    ["%0", { name: "main", activity_at: null, window_index: 0 }],
    ["%1", { name: "old1", activity_at: null, window_index: 1 }],
    ["%2", { name: "cdx", activity_at: null, window_index: 2 }],
    ["%3", { name: "old2", activity_at: null, window_index: 3 }],
  ]);
  const snap = buildSnapshot({
    readEntries: () => entries,
    allProjects: true,
    nowMs: NOW_MS,
    checkProcSig: false,
    selfSessionId: null,
    isAlive: (pid) => pid === ALIVE, // only the ALIVE-pid agents are live
    resolvePaneInfo: () => paneInfo,
    classifyBackground: false, // keep everyone in `agents` (don't split off background)
  });
  const order = snap.agents.map((a) => a.short_id);
  const lastLive = Math.max(...snap.agents.flatMap((a, i) => (a.liveness !== "dead" ? [i] : [])));
  const firstDead = Math.min(...snap.agents.flatMap((a, i) => (a.liveness === "dead" ? [i] : [])));
  assert.ok(lastLive < firstDead, `all live before all dead — got ${order.join(", ")}`);
  // live retain window order (main@0 before cdx@2) despite the dead rows that sit between
  // them by window index — i.e. dead-to-bottom reordered them, not just a stable pass.
  assert.deepEqual(order.slice(0, 2), ["a-main", "a-cdx"], "live at top in window order");
  assert.deepEqual(order.slice(2), ["d-old1", "d-old2"], "dead at bottom in window order");
});

test("liveness: fresh transcript ⇒ active", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx-active.jsonl", 5);
    const a = buildOne(makeEntry({ client: { transcript_path: tx } as never }));
    assert.equal(a.liveness, "active");
    assert.equal(a.liveness_reason, "transcript_fresh");
    assert.equal(a.transcript_age_s, 5);
    assert.equal(a.awaiting_human, false); // active = working, never on the worklist
  });
});

test("liveness: old transcript ⇒ idle with raw age", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx-idle.jsonl", 600);
    const a = buildOne(makeEntry({ client: { transcript_path: tx } as never }));
    assert.equal(a.liveness, "idle");
    assert.equal(a.liveness_reason, "idle");
    assert.equal(a.transcript_age_s, 600);
    assert.equal(a.awaiting_human, true); // idle-at-prompt, not waiting/stalled = your move
  });
});

test("liveness: missing transcript ⇒ idle/no_transcript", () => {
  withHome(() => {
    const a = buildOne(makeEntry({ client: { transcript_path: "/nope/missing.jsonl" } as never }));
    assert.equal(a.liveness, "idle");
    assert.equal(a.liveness_reason, "no_transcript");
    assert.equal(a.transcript_age_s, null);
    assert.equal(a.awaiting_human, false); // no transcript ⇒ phantom/just-spawned, off the worklist
  });
});

// ── item-5: working-but-quiet-transcript agents must read ACTIVE ────────────────
// David watched a clearly-thinking agent read idle because transcript mtime lags
// during a long turn. A fresh pane repaint OR an in-flight tool now promotes it.

test("liveness: stale transcript but a fresh pane ⇒ active/pane_fresh (item-5)", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx-quiet.jsonl", 600); // transcript cold 10m
    const snap = buildSnapshot({
      readEntries: () => [makeEntry({ tmux_pane: "%1", client: { transcript_path: tx } as never })],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      // pane repainted 2s ago ⇒ the agent is producing output / spinning right now.
      resolvePaneInfo: () =>
        new Map([["%1", { name: "main", activity_at: NOW_S - 2, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.liveness, "active");
    assert.equal(a.liveness_reason, "pane_fresh");
    assert.equal(a.pane_activity_age_s, 2);
    assert.equal(a.transcript_age_s, 600); // raw transcript age still reported, unhidden
  });
});

test("liveness: stale transcript AND a stale pane ⇒ stays idle (negative control)", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx-quiet2.jsonl", 600);
    const snap = buildSnapshot({
      readEntries: () => [makeEntry({ tmux_pane: "%1", client: { transcript_path: tx } as never })],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      resolvePaneInfo: () =>
        new Map([["%1", { name: "main", activity_at: NOW_S - 120, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.liveness, "idle");
    assert.equal(a.liveness_reason, "idle");
    assert.equal(a.pane_activity_age_s, 120);
  });
});

test("liveness: stale transcript + stale pane but a tool in-flight ⇒ active/tool_running", () => {
  withHome((home) => {
    // A claude transcript whose last tool_use has no matching tool_result ⇒ running.
    const path = join(home, "tx-tool.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_1" }] } }) +
        "\n",
    );
    const mtime = NOW_S - 300; // cold 5m (a silent long bash: no transcript/pane motion)
    utimesSync(path, mtime, mtime);
    const snap = buildSnapshot({
      readEntries: () => [makeEntry({ tmux_pane: "%1", client: { transcript_path: path } as never })],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      readActivity: true, // tool sub-state is gated on this
      resolvePaneInfo: () =>
        new Map([["%1", { name: "main", activity_at: NOW_S - 300, window_index: 0 }]]), // pane also stale
    });
    const a = snap.agents[0];
    assert.equal(a.activity?.tool_running, true);
    assert.equal(a.liveness, "active");
    assert.equal(a.liveness_reason, "tool_running");
  });
});

test("liveness: Codex shape — newer running call wins over an interleaved completed one ⇒ active", () => {
  withHome((home) => {
    // Out-of-order: an OLDER shell call completed, a NEWER update_plan is in-flight.
    // scanLatestTool is call_id-based (not adjacency), so the reverse scan stops at
    // the latest function_call (B) and reports it running — the completed A is moot.
    const path = join(home, "tx-codex-run.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "A" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "A" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "update_plan", call_id: "B" } }),
      ].join("\n") + "\n",
    );
    const mtime = NOW_S - 300;
    utimesSync(path, mtime, mtime);
    const snap = buildSnapshot({
      readEntries: () => [
        makeEntry({ type: "codex", tmux_pane: "%1", client: { transcript_path: path } as never }),
      ],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      readActivity: true,
      resolvePaneInfo: () =>
        new Map([["%1", { name: "max", activity_at: NOW_S - 300, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.activity?.tool_running, true);
    assert.equal(a.liveness, "active");
    assert.equal(a.liveness_reason, "tool_running");
  });
});

test("liveness: Codex shape — a COMPLETED latest call does NOT false-active ⇒ stays idle", () => {
  withHome((home) => {
    const path = join(home, "tx-codex-done.jsonl");
    writeFileSync(
      path,
      [
        JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "shell", call_id: "A" } }),
        JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "A" } }),
      ].join("\n") + "\n",
    );
    const mtime = NOW_S - 300;
    utimesSync(path, mtime, mtime);
    const snap = buildSnapshot({
      readEntries: () => [
        makeEntry({ type: "codex", tmux_pane: "%1", client: { transcript_path: path } as never }),
      ],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      readActivity: true,
      resolvePaneInfo: () =>
        new Map([["%1", { name: "max", activity_at: NOW_S - 300, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.activity?.tool_running, false); // call A has its output ⇒ not running
    assert.equal(a.liveness, "idle"); // stale tx + stale pane + no running tool
  });
});

test("liveness: a tool_running past STALL_WINDOW_S reads HUNG ⇒ idle + possibly_stalled (max gate)", () => {
  withHome((home) => {
    // The tool is still in-flight, but tx AND pane have been cold past the stall
    // window — an unbounded tool_running would pin this active forever and suppress
    // possibly_stalled. The age-bound hands off: active(tool_running) → idle → stalled.
    const path = join(home, "tx-hung-tool.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_h" }] } }) +
        "\n",
    );
    const mtime = NOW_S - 700; // cold 700s > STALL_WINDOW_S (600)
    utimesSync(path, mtime, mtime);
    const snap = buildSnapshot({
      readEntries: () => [
        makeEntry({
          tmux_pane: "%1",
          client: { transcript_path: path } as never,
          state: { purpose: "running the build", updated_at: NOW_S - 695 },
        }),
      ],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      readActivity: true,
      resolvePaneInfo: () =>
        new Map([["%1", { name: "main", activity_at: NOW_S - 700, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.activity?.tool_running, true); // the tool IS still in-flight…
    assert.equal(a.liveness, "idle"); // …but past the window it reads hung, not active
    assert.equal(a.possibly_stalled, true); // and the idle-gated stall hint is freed
  });
});

test("awaiting_human: a hung tool with NO purpose stays OFF the worklist (max F1 — no badge contradiction)", () => {
  withHome((home) => {
    // Same hung-tool shape, but NO declared purpose: possibly_stalled needs a purpose so
    // it stays false and the row drops to idle/idle. Without the !tool_running guard it
    // would read awaiting_human=true and show the in-flight tool badge `…` AND 🙋 at once.
    const path = join(home, "tx-hung-nopurpose.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", id: "toolu_x" }] } }) +
        "\n",
    );
    const mtime = NOW_S - 700; // cold past STALL_WINDOW_S (600)
    utimesSync(path, mtime, mtime);
    const snap = buildSnapshot({
      readEntries: () => [
        makeEntry({ tmux_pane: "%1", client: { transcript_path: path } as never }), // no state/purpose
      ],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      readActivity: true,
      resolvePaneInfo: () =>
        new Map([["%1", { name: "main", activity_at: NOW_S - 700, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.activity?.tool_running, true); // tool still in-flight
    assert.equal(a.liveness, "idle");
    assert.equal(a.possibly_stalled, false); // no purpose ⇒ the stall hint can't fire…
    assert.equal(a.awaiting_human, false); // …so the F1 guard is what keeps it off the worklist
  });
});

test("liveness: a dead pid never reads activity, even with a fresh pane + in-flight tool", () => {
  withHome((home) => {
    const path = join(home, "tx-dead-tool.jsonl");
    writeFileSync(
      path,
      JSON.stringify({ message: { content: [{ type: "tool_use", name: "Bash", id: "x" }] } }) + "\n",
    );
    const snap = buildSnapshot({
      readEntries: () => [
        makeEntry({
          server_pid: 2_000_000_000, // never alive ⇒ dead/exited short-circuits first
          tmux_pane: "%1",
          client: { transcript_path: path } as never,
        }),
      ],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      readActivity: true,
      resolvePaneInfo: () =>
        new Map([["%1", { name: "main", activity_at: NOW_S - 1, window_index: 0 }]]),
    });
    const a = snap.agents[0];
    assert.equal(a.liveness, "dead");
    assert.equal(a.activity, null); // activity tail is NOT read for dead agents
  });
});

test("purpose: stale caption when set well before last activity", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx.jsonl", 5); // active 5s ago
    const a = buildOne(
      makeEntry({
        client: { transcript_path: tx } as never,
        state: { purpose: "old plan", updated_at: NOW_S - 1000 }, // declared 1000s ago
      }),
    );
    assert.equal(a.purpose, "old plan");
    assert.equal(a.purpose_stale, true, "purpose older than recent activity ⇒ stale");
  });
});

test("purpose: possibly_stalled when declared work but transcript cold past the window", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx.jsonl", 700); // cold ~12m, past STALL_WINDOW_S (600)
    const a = buildOne(
      makeEntry({
        client: { transcript_path: tx } as never,
        state: { purpose: "running tests", updated_at: NOW_S - 690 }, // declared ~when it went cold
      }),
    );
    assert.equal(a.liveness, "idle");
    assert.equal(a.possibly_stalled, true);
    assert.equal(a.awaiting_human, false); // maybe-hung is its OWN ⚠ class, not the worklist
  });
});

test("purpose: a healthy idle agent (cold < window) is NOT flagged stalled", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx.jsonl", 200); // idle 3m, well under the window
    const a = buildOne(
      makeEntry({
        client: { transcript_path: tx } as never,
        state: { purpose: "waiting for the human", updated_at: NOW_S - 190 },
      }),
    );
    assert.equal(a.liveness, "idle");
    assert.equal(a.possibly_stalled, false); // max M1: don't slander a normal idle agent
    assert.equal(a.awaiting_human, true); // healthy idle (even WITH a purpose) = awaiting you
  });
});

test("unread: counts session-box messages, tolerates a torn line", () => {
  withHome(() => {
    const sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const box = mailbox.mailboxSessionKey(sid);
    mailbox.enqueue(box, "msg one", "sender");
    mailbox.enqueue(box, "msg two", "sender");
    // Corrupt the file with a torn trailing line — must be skipped, not counted.
    appendFileSync(mailbox.mailboxFilePath(box), '{"schema_version":1,"id":"deadbeef');
    const a = buildOne(makeEntry({ client: { session_id: sid, transcript_path: null } as never }));
    assert.equal(a.unread, 2);
    // A torn line was skipped → the count may undercount → honest "low".
    assert.equal(a.unread_confidence, "low");
  });
});

test("liveness: a not-alive server_pid ⇒ dead/exited", () => {
  withHome(() => {
    // A pid that is essentially never a live process on a dev box.
    const a = buildOne(
      makeEntry({ server_pid: 2_000_000_000, client: { transcript_path: null } as never }),
    );
    assert.equal(a.liveness, "dead");
    assert.equal(a.liveness_reason, "exited");
  });
});

test("window_name: resolved from the agent's pane via the injected resolver", () => {
  withHome(() => {
    const snap = buildSnapshot({
      readEntries: () => [makeEntry({ tmux_pane: "%9", client: { transcript_path: null } as never })],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      resolvePaneInfo: () => new Map([["%9", { name: "max", activity_at: null }]]),
    });
    assert.equal(snap.agents.length, 1);
    assert.equal(snap.agents[0].window_name, "max");
  });
});

test("open_work: counts open obligations from the received ledger", () => {
  withHome(() => {
    const sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    recordReceived(sid, mailbox.buildMessage("do X", "boss", { action_required: true }));
    recordReceived(sid, mailbox.buildMessage("fyi", "peer")); // not an obligation
    const a = buildOne(makeEntry({ client: { session_id: sid, transcript_path: null } as never }));
    assert.equal(a.open_work, 1);
  });
});

// ── wait graph ──────────────────────────────────────────────────────────────

function fleetAgent(over: Partial<FleetAgent>): FleetAgent {
  return {
    session_id: over.session_id ?? null,
    short_id: over.short_id ?? "xxxxxxxx",
    window_name: null,
    client_type: "claude-code",
    server_pid: 1,
    cwd: "/proj",
    is_self: false,
    liveness: over.liveness ?? "idle",
    liveness_reason: "idle",
    transcript_age_s: 10,
    proc_sig: "ok",
    purpose: null,
    purpose_age_s: null,
    purpose_stale: false,
    possibly_stalled: false,
    awaiting_human: over.awaiting_human ?? false,
    unread: 0,
    unread_confidence: "high",
    open_work: 0,
    waiting: over.waiting ?? null,
    tmux_pane: "%1",
    tmux_session: "proj",
    ...over,
  };
}

function waitEdge() {
  return {
    target_session_id: null,
    target_short_id: null,
    age_s: 5,
    orphaned: false,
    in_cycle: false,
    cycle_all_live: false,
  };
}

test("resolveWaitTargets: correlates request_id to the receiving peer", () => {
  withHome(() => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001";
    const B = "bbbbbbbb-0000-0000-0000-000000000002";
    // The ask A sent landed in B's received ledger keyed by request_id + A.
    recordReceived(B, mailbox.buildMessage("please do", A, { request_id: "req-1" }));
    const agents = [
      fleetAgent({ session_id: A, short_id: "aaaa", waiting: waitEdge() }),
      fleetAgent({ session_id: B, short_id: "bbbb", liveness: "idle" }),
    ];
    resolveWaitTargets(agents, new Map([[A, { requestId: "req-1", ageS: 5 }]]));
    assert.equal(agents[0].waiting!.target_session_id, B);
    assert.equal(agents[0].waiting!.target_short_id, "bbbb");
    assert.equal(agents[0].waiting!.orphaned, false);
  });
});

test("resolveWaitTargets: marks orphaned when target is dead", () => {
  withHome(() => {
    const A = "aaaaaaaa-0000-0000-0000-000000000011";
    const B = "bbbbbbbb-0000-0000-0000-000000000012";
    recordReceived(B, mailbox.buildMessage("please do", A, { request_id: "req-2" }));
    const agents = [
      fleetAgent({ session_id: A, short_id: "aaaa", waiting: waitEdge() }),
      fleetAgent({ session_id: B, short_id: "bbbb", liveness: "dead" }),
    ];
    resolveWaitTargets(agents, new Map([[A, { requestId: "req-2", ageS: 5 }]]));
    assert.equal(agents[0].waiting!.target_session_id, B);
    assert.equal(agents[0].waiting!.orphaned, true);
  });
});

test("detectWaitCycles: finds a 2-node deadlock and marks members", () => {
  const A = fleetAgent({
    session_id: "m",
    short_id: "main",
    waiting: { ...waitEdge(), target_session_id: "c", target_short_id: "codex" },
  });
  const B = fleetAgent({
    session_id: "c",
    short_id: "codex",
    waiting: { ...waitEdge(), target_session_id: "m", target_short_id: "main" },
  });
  const cycles = detectWaitCycles([A, B]);
  assert.equal(cycles.length, 1);
  assert.deepEqual(new Set(cycles[0].members), new Set(["main", "codex"]));
  assert.equal(A.waiting!.in_cycle, true);
  assert.equal(B.waiting!.in_cycle, true);
});

test("detectWaitCycles: a dead member makes the cycle not-all-live (stale)", () => {
  const A = fleetAgent({
    session_id: "m",
    short_id: "main",
    liveness: "dead",
    waiting: { ...waitEdge(), target_session_id: "c", target_short_id: "codex" },
  });
  const B = fleetAgent({
    session_id: "c",
    short_id: "codex",
    waiting: { ...waitEdge(), target_session_id: "m", target_short_id: "main" },
  });
  const cycles = detectWaitCycles([A, B]);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0].all_live, false);
  assert.equal(B.waiting!.cycle_all_live, false);
});

test("detectWaitCycles: no cycle for a linear chain", () => {
  const A = fleetAgent({
    session_id: "a",
    short_id: "a",
    waiting: { ...waitEdge(), target_session_id: "b", target_short_id: "b" },
  });
  const B = fleetAgent({
    session_id: "b",
    short_id: "b",
    waiting: { ...waitEdge(), target_session_id: "c", target_short_id: "c" },
  });
  const C = fleetAgent({ session_id: "c", short_id: "c" });
  const cycles = detectWaitCycles([A, B, C]);
  assert.equal(cycles.length, 0);
  assert.equal(A.waiting!.in_cycle, false);
});

test("wait-graph: an ask with an observed reply is NOT a wait (H1 killer)", () => {
  withHome(() => {
    const W = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    recordPendingAsk(defaultPendingAskDir(), W, "askreq1", NOW_MS); // file says "waiting"
    // ...but the reply is observable in the requester's own ledger.
    recordReceived(W, mailbox.buildMessage("answer", "peer", { reply_to: "askreq1" }));
    const snap = buildSnapshot({
      readEntries: () => [makeEntry({ client: { session_id: W, transcript_path: null } as never })],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      resolvePaneInfo: () => new Map(),
    });
    assert.equal(snap.agents.length, 1);
    assert.equal(snap.agents[0].waiting, null, "an answered ask must not render as waiting");
  });
});

test("wait-graph: an ask with no observed reply still shows as waiting", () => {
  withHome(() => {
    const W = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    recordPendingAsk(defaultPendingAskDir(), W, "askreq2", NOW_MS);
    const snap = buildSnapshot({
      readEntries: () => [makeEntry({ client: { session_id: W, transcript_path: null } as never })],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      resolvePaneInfo: () => new Map(),
    });
    assert.equal(snap.agents.length, 1);
    assert.ok(snap.agents[0].waiting, "an unanswered ask shows as waiting");
  });
});

test("sort: fleet follows tmux WINDOW ORDER (fixed), not state/trouble/work", () => {
  withHome(() => {
    const A = "aaaaaaaa-0000-0000-0000-000000000001"; // window 1, MORE raw work
    const B = "bbbbbbbb-0000-0000-0000-000000000002"; // window 5, waiting (trouble)
    recordReceived(A, mailbox.buildMessage("do1", "boss", { action_required: true }));
    recordReceived(A, mailbox.buildMessage("do2", "boss", { action_required: true }));
    recordPendingAsk(defaultPendingAskDir(), B, "req-sort", NOW_MS);
    const snap = buildSnapshot({
      readEntries: () => [
        makeEntry({ tmux_pane: "%2", client: { session_id: A, transcript_path: null } as never }),
        makeEntry({ tmux_pane: "%5", client: { session_id: B, transcript_path: null } as never }),
      ],
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      // A is tmux window 1, B is window 5 — row order follows the window index, NOT
      // B's trouble nor A's higher work-count (David: keep the list fixed).
      resolvePaneInfo: () =>
        new Map([
          ["%2", { name: null, activity_at: null, window_index: 1 }],
          ["%5", { name: null, activity_at: null, window_index: 5 }],
        ]),
    });
    assert.equal(snap.agents.length, 2);
    assert.equal(snap.agents[0].session_id, A, "lower window index first (state-independent)");
    assert.equal(snap.agents[1].session_id, B, "higher window index second, despite its trouble");
    assert.equal(snap.agents[0].window_index, 1);
  });
});

test("buildSnapshot: empty registry ⇒ no agents, no throw", () => {
  withHome(() => {
    const snap = buildSnapshot({ readEntries: () => [], allProjects: true, nowMs: NOW_MS });
    assert.equal(snap.agents.length, 0);
    assert.equal(snap.cycles.length, 0);
  });
});

// ── background-process split: detached MCP children / `codex exec` subprocesses ──
// Reproduces the oxpit screenshot: 3 real tmux-window agents (main/max/codex) plus
// detached codex processes that own no tmux pane — the 019… (claimed, has transcript)
// and pid: (unclaimed, no transcript) rows whose jump fails "couldn't verify a live
// pane". Those must collapse into `background`: off the navigable list AND off the
// "awaiting you" worklist, while real windows and dead agents stay put.
const FG = { main: 5001, max: 5002, codex: 5003 };

function phantomFleet(home: string): {
  entries: RegistryEntry[];
  deps: Partial<Parameters<typeof buildSnapshot>[0]>;
} {
  const txMain = writeTranscript(home, "ph-main.jsonl", 5); // active
  const txMax = writeTranscript(home, "ph-max.jsonl", 900); // idle 15m
  const txCodex = writeTranscript(home, "ph-codex.jsonl", 480); // idle 8m
  const txDetached = writeTranscript(home, "ph-019.jsonl", 720); // detached, idle 12m

  const main = makeEntry({
    type: "claude-code",
    server_pid: FG.main,
    tmux_pane: "%1",
    client: { transcript_path: txMain } as never,
  });
  const max = makeEntry({
    type: "claude-code",
    server_pid: FG.max,
    tmux_pane: "%2",
    client: { transcript_path: txMax } as never,
  });
  const codex = makeEntry({
    type: "codex",
    server_pid: FG.codex,
    tmux_pane: "%3",
    client: { transcript_path: txCodex } as never,
  });
  // Detached codex WITH a claimed session + transcript → short_id "019eebb0". This is
  // THE false positive: idle-at-prompt with a transcript, so awaiting_human is true —
  // it would wrongly read "awaiting you" if left in the foreground.
  const bgClaimed = makeEntry({
    type: "codex",
    server_pid: 5101,
    tmux_pane: null,
    client: {
      session_id: "019eebb0-0000-0000-0000-000000000000",
      transcript_path: txDetached,
    } as never,
  });
  // Detached codex children, UNCLAIMED (no session) + no transcript → short_id "pid:<n>".
  const bgPid1 = makeEntry({ type: "codex", server_pid: 5102, tmux_pane: null });
  bgPid1.client.session_id = null;
  const bgPid2 = makeEntry({ type: "codex", server_pid: 5103, tmux_pane: null });
  bgPid2.client.session_id = null;

  return {
    entries: [main, max, codex, bgClaimed, bgPid1, bgPid2],
    deps: {
      allProjects: true,
      nowMs: NOW_MS,
      checkProcSig: false,
      selfSessionId: null,
      isAlive: () => true, // every process alive — the phantoms are LIVE, just detached
      resolveJumpablePids: () => new Set([FG.main, FG.max, FG.codex]),
      resolvePaneInfo: () =>
        new Map([
          ["%1", { name: "main", activity_at: NOW_S - 5, window_index: 0 }],
          ["%2", { name: "max", activity_at: NOW_S - 900, window_index: 1 }],
          ["%3", { name: "codex", activity_at: NOW_S - 480, window_index: 2 }],
        ]),
    },
  };
}

test("buildSnapshot: detached pane-less processes collapse into background (screenshot repro)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    const snap = buildSnapshot({ readEntries: () => entries, ...deps });

    // Foreground = only the 3 real tmux windows, in window order.
    assert.equal(snap.agents.length, 3);
    assert.deepEqual(
      snap.agents.map((a) => a.window_name),
      ["main", "max", "codex"],
    );

    // The detached processes are split out, not listed as navigable agents.
    const bg = snap.background ?? [];
    assert.equal(bg.length, 3);
    const bgIds = bg.map((a) => a.short_id).sort();
    assert.deepEqual(bgIds, ["019eebb0", "pid:5102", "pid:5103"]);
    assert.ok(bg.every((a) => a.liveness !== "dead"), "background processes are LIVE, just detached");

    // The bug: the claimed detached codex IS idle-at-prompt (awaiting_human), so it
    // WOULD have been a false "awaiting you" — but it's now in background.
    const claimed = bg.find((a) => a.short_id === "019eebb0")!;
    assert.equal(claimed.awaiting_human, true, "would have falsely read 'awaiting you' in the foreground");

    // Worklist now names only the REAL idle agents, never the phantom.
    const awaiting = snap.agents.filter((a) => a.awaiting_human).map((a) => a.window_name);
    assert.deepEqual(awaiting, ["max", "codex"]);
  });
});

test("buildSnapshot: a WAITING detached process stays FOREGROUND, not collapsed to background (codex #4)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    // The detached CLAIMED codex now has a live pending-ask → it is WAITING. A wait
    // (especially an orphaned/deadlocked one) must stay on the wait-graph + in
    // --check, so a waiter must NOT vanish into the background footer.
    const snap = buildSnapshot({
      readEntries: () => entries,
      ...deps,
      pending: new Map([["019eebb0-0000-0000-0000-000000000000", { requestId: "r1", ageS: 30 }]]),
    });
    const fgIds = snap.agents.map((a) => a.short_id);
    const bgIds = (snap.background ?? []).map((a) => a.short_id).sort();
    assert.ok(fgIds.includes("019eebb0"), "a waiting detached process stays foreground");
    const waiter = snap.agents.find((a) => a.short_id === "019eebb0")!;
    assert.ok(waiter.waiting, "its wait-edge is present so the wait-graph can render it");
    assert.equal(waiter.awaiting_human, false, "a waiter is not idle-at-prompt, so not on the worklist");
    // The truly-idle detached phantoms (no wait) still collapse — the fix is targeted.
    assert.deepEqual(bgIds, ["pid:5102", "pid:5103"]);
  });
});

test("buildSnapshot: no tmux pane info ⇒ no background split (can't tell detached from not-in-tmux)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    const snap = buildSnapshot({ readEntries: () => entries, ...deps, resolvePaneInfo: () => new Map() });
    assert.equal(snap.agents.length, 6, "tmux absent ⇒ keep everyone navigable");
    assert.equal((snap.background ?? []).length, 0);
  });
});

test("buildSnapshot: nothing jumpable ⇒ never collapse the WHOLE fleet (no empty table)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    const snap = buildSnapshot({ readEntries: () => entries, ...deps, resolveJumpablePids: () => new Set() });
    assert.equal(snap.agents.length, 6, "empty jumpable set ⇒ likely a misfire ⇒ keep all");
    assert.equal((snap.background ?? []).length, 0);
  });
});

test("buildSnapshot: nothing jumpable BUT one agent waiting ⇒ STILL no collapse (anchor gate, CI no-tmux repro)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    // One detached agent is WAITING. The old guard keyed on a non-empty foreground —
    // so when nothing is jumpable (process.pid isn't jumpable off-tmux, e.g. CI), a
    // lone waiter became the only "foreground" and collapsed every non-waiter. The
    // anchor gate requires a real jumpable/dead anchor before splitting, so the whole
    // fleet stays foreground — the waiter included.
    recordPendingAsk(defaultPendingAskDir(), "019eebb0-0000-0000-0000-000000000000", "req-anchor", NOW_MS);
    const snap = buildSnapshot({ readEntries: () => entries, ...deps, resolveJumpablePids: () => new Set() });
    assert.equal(snap.agents.length, 6, "no jumpable/dead anchor ⇒ whole fleet foreground, waiter and all");
    assert.equal((snap.background ?? []).length, 0, "a lone waiter must not trigger the collapse");
  });
});

test("buildSnapshot: a DEAD un-jumpable agent stays foreground (⚫dead + orphaned-wait visibility)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    const deadPid = 5101; // the claimed detached codex is now DEAD, not alive
    const snap = buildSnapshot({ readEntries: () => entries, ...deps, isAlive: (pid) => pid !== deadPid });
    const dead = snap.agents.find((a) => a.short_id === "019eebb0");
    assert.ok(dead, "dead detached agent stays in the navigable list, not collapsed");
    assert.equal(dead!.liveness, "dead");
    assert.equal((snap.background ?? []).length, 2, "the two LIVE unclaimed children still collapse");
  });
});

test("buildSnapshot: classifyBackground:false keeps every entry in agents (escape hatch)", () => {
  withHome((home) => {
    const { entries, deps } = phantomFleet(home);
    const snap = buildSnapshot({ readEntries: () => entries, ...deps, classifyBackground: false });
    assert.equal(snap.agents.length, 6);
    assert.equal((snap.background ?? []).length, 0);
  });
});

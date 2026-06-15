import { strict as assert } from "node:assert";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ClientType } from "../clients.js";
import * as mailbox from "../mailbox.js";
import { recordReceived } from "../received.js";
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
  });
  assert.equal(snap.agents.length, 1, "expected exactly one agent");
  return snap.agents[0];
}

test("liveness: fresh transcript ⇒ active", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx-active.jsonl", 5);
    const a = buildOne(makeEntry({ client: { transcript_path: tx } as never }));
    assert.equal(a.liveness, "active");
    assert.equal(a.liveness_reason, "transcript_fresh");
    assert.equal(a.transcript_age_s, 5);
  });
});

test("liveness: old transcript ⇒ idle with raw age", () => {
  withHome((home) => {
    const tx = writeTranscript(home, "tx-idle.jsonl", 600);
    const a = buildOne(makeEntry({ client: { transcript_path: tx } as never }));
    assert.equal(a.liveness, "idle");
    assert.equal(a.liveness_reason, "idle");
    assert.equal(a.transcript_age_s, 600);
  });
});

test("liveness: missing transcript ⇒ idle/no_transcript", () => {
  withHome(() => {
    const a = buildOne(makeEntry({ client: { transcript_path: "/nope/missing.jsonl" } as never }));
    assert.equal(a.liveness, "idle");
    assert.equal(a.liveness_reason, "no_transcript");
    assert.equal(a.transcript_age_s, null);
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

test("buildSnapshot: empty registry ⇒ no agents, no throw", () => {
  withHome(() => {
    const snap = buildSnapshot({ readEntries: () => [], allProjects: true, nowMs: NOW_MS });
    assert.equal(snap.agents.length, 0);
    assert.equal(snap.cycles.length, 0);
  });
});

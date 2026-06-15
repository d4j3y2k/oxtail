import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renderSnapshot } from "./render.js";
import type { FleetAgent, FleetSnapshot } from "./snapshot.js";

function agent(partial: Partial<FleetAgent>): FleetAgent {
  return {
    session_id: "11111111-1111-1111-1111-111111111111",
    short_id: "11111111",
    client_type: "claude-code",
    server_pid: 1234,
    cwd: "/proj",
    is_self: false,
    liveness: "idle",
    liveness_reason: "idle",
    transcript_age_s: 120,
    proc_sig: "ok",
    purpose: null,
    purpose_age_s: null,
    purpose_stale: false,
    possibly_stalled: false,
    unread: 0,
    unread_confidence: "high",
    open_work: 0,
    waiting: null,
    tmux_pane: "%1",
    tmux_session: "proj",
    ...partial,
  };
}

function snap(agents: FleetAgent[], extra: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    schema_version: 1,
    project_root: "/home/me/proj",
    generated_at: 1000,
    self_session_id: null,
    agents,
    cycles: [],
    warnings: [],
    ...extra,
  };
}

test("render: header counts agents and actives", () => {
  const out = renderSnapshot(
    snap([agent({ liveness: "active" }), agent({ short_id: "22222222", liveness: "idle" })]),
    { color: false },
  );
  assert.match(out, /2 agents \(1 active\)/);
  assert.match(out, /proj/); // project name shown
});

test("render: liveness glyphs + raw age", () => {
  const out = renderSnapshot(
    snap([
      agent({ short_id: "aaa", liveness: "active", transcript_age_s: 4 }),
      agent({ short_id: "bbb", liveness: "idle", transcript_age_s: 200 }),
      agent({ short_id: "ccc", liveness: "dead", liveness_reason: "pid_reused" }),
    ]),
    { color: false },
  );
  assert.match(out, /🟢/);
  assert.match(out, /🟡/);
  assert.match(out, /⚫/);
  assert.match(out, /active 4s/);
  assert.match(out, /idle 3m/);
  assert.match(out, /dead·reused/);
});

test("render: self marker and badges", () => {
  const out = renderSnapshot(
    snap([
      agent({ short_id: "self123", is_self: true, unread: 2, open_work: 3 }),
    ]),
    { color: false },
  );
  assert.match(out, /self123\*/); // self gets a *
  assert.match(out, /✉2/);
  assert.match(out, /⚑3/);
});

test("render: low-confidence unread gets a ?", () => {
  const out = renderSnapshot(
    snap([agent({ unread: 5, unread_confidence: "low" })]),
    { color: false },
  );
  assert.match(out, /✉5\?/);
});

test("render: waiting edge and purpose caption", () => {
  const out = renderSnapshot(
    snap([
      agent({
        short_id: "waiter",
        purpose: "doing a thing",
        waiting: {
          target_session_id: "x",
          target_short_id: "codex",
          age_s: 45,
          orphaned: false,
          in_cycle: false,
          cycle_all_live: false,
        },
      }),
    ]),
    { color: false },
  );
  assert.match(out, /⏳codex 45s/);
  assert.match(out, /doing a thing/);
  assert.match(out, /⏳ waiter awaiting reply from codex \(45s\)/); // wait-graph block
});

test("render: deadlock cycle headline", () => {
  const a = agent({
    short_id: "main",
    session_id: "m",
    waiting: { target_session_id: "c", target_short_id: "codex", age_s: 10, orphaned: false, in_cycle: true, cycle_all_live: true },
  });
  const b = agent({
    short_id: "codex",
    session_id: "c",
    waiting: { target_session_id: "m", target_short_id: "main", age_s: 12, orphaned: false, in_cycle: true, cycle_all_live: true },
  });
  const out = renderSnapshot(
    snap([a, b], { cycles: [{ members: ["main", "codex"], all_live: true }] }),
    { color: false },
  );
  assert.match(out, /⛔ DEADLOCK: main → codex → main/);
});

test("render: stale cycle is shown as 'possible', not a hard DEADLOCK", () => {
  const a = agent({
    short_id: "main",
    session_id: "m",
    waiting: { target_session_id: "c", target_short_id: "codex", age_s: 10, orphaned: false, in_cycle: true, cycle_all_live: false },
  });
  const b = agent({
    short_id: "codex",
    session_id: "c",
    liveness: "dead",
    waiting: { target_session_id: "m", target_short_id: "main", age_s: 12, orphaned: false, in_cycle: true, cycle_all_live: false },
  });
  const out = renderSnapshot(
    snap([a, b], { cycles: [{ members: ["main", "codex"], all_live: false }] }),
    { color: false },
  );
  assert.match(out, /possible wait cycle \(stale\)/);
  assert.ok(!/⛔ DEADLOCK/.test(out), "stale cycle must not render a hard DEADLOCK");
});

test("render: orphaned wait (target dead)", () => {
  const out = renderSnapshot(
    snap([
      agent({
        short_id: "waiter",
        waiting: { target_session_id: "d", target_short_id: "ghost", age_s: 99, orphaned: true, in_cycle: false, cycle_all_live: false },
      }),
    ]),
    { color: false },
  );
  assert.match(out, /target is dead/);
});

test("render: empty fleet", () => {
  const out = renderSnapshot(snap([]), { color: false });
  assert.match(out, /no agents registered/);
});

test("render: color codes only when enabled", () => {
  const plain = renderSnapshot(snap([agent({ liveness: "active" })]), { color: false });
  const colored = renderSnapshot(snap([agent({ liveness: "active" })]), { color: true });
  assert.ok(!plain.includes("\x1b["), "plain output has no ANSI codes");
  assert.ok(colored.includes("\x1b["), "colored output has ANSI codes");
});

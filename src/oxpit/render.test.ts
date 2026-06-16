import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attentionLine,
  commsBodyLines,
  computeAgentLabels,
  fleetTrouble,
  renderCommsLog,
  renderSnapshot,
} from "./render.js";
import type { FleetAgent, FleetSnapshot } from "./snapshot.js";
import type { CommsMessage } from "./comms.js";

function agent(partial: Partial<FleetAgent>): FleetAgent {
  return {
    session_id: "11111111-1111-1111-1111-111111111111",
    short_id: "11111111",
    window_name: null,
    client_type: "claude-code",
    server_pid: 1234,
    cwd: "/proj",
    is_self: false,
    liveness: "idle",
    liveness_reason: "idle",
    transcript_age_s: 120,
    proc_sig: "ok",
    pane_activity_age_s: null,
    pane_activity_at: null,
    purpose: null,
    purpose_age_s: null,
    purpose_stale: false,
    possibly_stalled: false,
    transcript_path: null,
    activity: null,
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

// ── comms-log ─────────────────────────────────────────────────────────────────

function msg(over: Partial<CommsMessage>): CommsMessage {
  return {
    message_id: "m1",
    from_session_id: "sa",
    to_session_id: "sb",
    body: "hello there",
    at: 1000,
    ...over,
  };
}
const COMMS_LABELS = new Map([
  ["sa", "main"],
  ["sb", "codex"],
]);

test("renderCommsLog: from→to via labels, relative age, body", () => {
  const out = renderCommsLog([msg({})], COMMS_LABELS, { color: false, nowSec: 1120 });
  assert.match(out, /main → codex/);
  assert.match(out, /2m/);
  assert.match(out, /hello there/);
});

test("renderCommsLog: lifecycle/ask/reply markers", () => {
  const base = { color: false, nowSec: 1000 };
  assert.match(renderCommsLog([msg({ action_required: true })], COMMS_LABELS, base), /⚑/);
  assert.match(
    renderCommsLog([msg({ action_required: true, closed: "done" })], COMMS_LABELS, base),
    /⚑✓/,
  );
  assert.match(
    renderCommsLog([msg({ action_required: true, closed: "blocked" })], COMMS_LABELS, base),
    /⚑✗/,
  );
  assert.match(renderCommsLog([msg({ request_id: "r1" })], COMMS_LABELS, base), /❓/);
  assert.match(renderCommsLog([msg({ reply_to: "r1" })], COMMS_LABELS, base), /↩/);
});

test("renderCommsLog: unresolved sender → short id", () => {
  const a = renderCommsLog([msg({ from_session_id: "unknownsession" })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
  });
  assert.match(a, /unknowns → codex/); // first 8 chars of an unattributable sender
});

test("renderCommsLog: null sender is 'operator' ONLY when origin says so, else 'unknown'", () => {
  const op = renderCommsLog([msg({ from_session_id: null, origin: "operator" })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
  });
  assert.match(op, /operator → codex/);
  const anon = renderCommsLog([msg({ from_session_id: null })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
  });
  assert.match(anon, /unknown → codex/);
  assert.ok(!/operator → codex/.test(anon), "null-from non-operator must NOT be labeled operator");
});

test("commsBodyLines: full mode word-wraps the whole body across lines", () => {
  const long = "word ".repeat(60).trim(); // ~300 chars
  const snippet = commsBodyLines([msg({ body: long })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
    width: 60,
  });
  const full = commsBodyLines([msg({ body: long })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
    width: 60,
    full: true,
  });
  assert.equal(snippet.length, 1, "snippet is a single line");
  assert.ok(full.length > snippet.length, "full wraps to multiple lines");
  assert.ok(full.every((l) => l.length <= 60), "no wrapped line exceeds width");
});

test("renderCommsLog: empty feed and tail-honesty header", () => {
  const out = renderCommsLog([], COMMS_LABELS, { color: false });
  assert.match(out, /no inter-agent messages/);
  assert.match(out, /not a full audit log/);
});

test("renderCommsLog: expand shows the full body, snippet truncates", () => {
  const long = "x".repeat(400);
  const collapsed = renderCommsLog([msg({ message_id: "big", body: long })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
    width: 80,
  });
  assert.ok(!collapsed.includes(long), "snippet is truncated");
  const expanded = renderCommsLog([msg({ message_id: "big", body: long })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
    width: 80,
    expandedId: "big",
  });
  assert.ok(expanded.replace(/\s/g, "").includes(long), "expanded contains the full body");
});

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

test("render: uses the tmux window name as the agent label", () => {
  const out = renderSnapshot(
    snap([agent({ short_id: "0f74e56a", window_name: "main", is_self: true })]),
    { color: false },
  );
  assert.match(out, /main\*/); // window name + self marker, not the hex id
  assert.ok(!/0f74e56a/.test(out), "hex id replaced by the window name");
});

test("render: disambiguates colliding window names with the short id", () => {
  const out = renderSnapshot(
    snap([
      agent({ short_id: "aaaaaaaa", session_id: "a", window_name: "node" }),
      agent({ short_id: "bbbbbbbb", session_id: "b", window_name: "node" }),
    ]),
    { color: false },
  );
  assert.match(out, /node·aaaa/);
  assert.match(out, /node·bbbb/);
});

test("render: falls back to short id when there is no window name", () => {
  const out = renderSnapshot(snap([agent({ short_id: "deadbeef", window_name: null })]), {
    color: false,
  });
  assert.match(out, /deadbeef/);
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

test("render: wait-graph and badge use window-name labels for both ends", () => {
  const target = agent({ short_id: "tc", session_id: "stc", window_name: "codex" });
  const waiter = agent({
    short_id: "w",
    session_id: "sw",
    window_name: "main",
    waiting: {
      target_session_id: "stc",
      target_short_id: "tc",
      age_s: 30,
      orphaned: false,
      in_cycle: false,
      cycle_all_live: false,
    },
  });
  const out = renderSnapshot(snap([waiter, target]), { color: false });
  assert.match(out, /main awaiting reply from codex/); // names, not short ids
  assert.ok(!/awaiting reply from tc\b/.test(out), "target shown by name, not short id");
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

// ── attention line / fleetTrouble ───────────────────────────────────────────────

const ID = (s: string) => s; // identity paint for plain-text assertions

test("attentionLine: healthy fleet renders a dim '✓ nominal' (not null/absent)", () => {
  const out = attentionLine(snap([agent({ liveness: "active" }), agent({ liveness: "idle" })]), ID);
  assert.ok(out && /✓ fleet nominal · 1 active/.test(out), "absence of alarms reads as 'checked & fine'");
});

test("attentionLine: empty fleet returns null (the 'no agents' line covers it)", () => {
  assert.equal(attentionLine(snap([]), ID), null);
});

test("attentionLine: live deadlock and orphaned wait are RED ⛔ classes", () => {
  const s = snap(
    [
      agent({
        short_id: "main",
        session_id: "m",
        waiting: { target_session_id: "c", target_short_id: "codex", age_s: 9, orphaned: false, in_cycle: true, cycle_all_live: true },
      }),
      agent({
        short_id: "lone",
        session_id: "l",
        waiting: { target_session_id: "d", target_short_id: "ghost", age_s: 9, orphaned: true, in_cycle: false, cycle_all_live: false },
      }),
    ],
    { cycles: [{ members: ["main", "codex"], all_live: true }] },
  );
  const out = attentionLine(s, ID)!;
  assert.match(out, /attention:/);
  assert.match(out, /1 live deadlock/);
  assert.match(out, /1 orphaned wait/);
});

test("attentionLine: open work on a DEAD owner is flagged as stranded", () => {
  const out = attentionLine(snap([agent({ liveness: "dead", open_work: 3 })]), ID)!;
  assert.match(out, /3 stranded \(dead owner\)/);
});

test("attentionLine: open work on a LIVE agent does NOT cry wolf (key refinement)", () => {
  // A working fleet always has open obligations on live agents — that is normal,
  // never an alert. Only dead-owner work is stranded.
  const out = attentionLine(snap([agent({ liveness: "active", open_work: 5 })]), ID)!;
  assert.match(out, /✓ fleet nominal/);
  assert.ok(!/stranded/.test(out) && !/attention/.test(out));
});

test("fleetTrouble: counts deadlocks/orphaned/stranded, ignores live open_work", () => {
  const t = fleetTrouble(
    snap(
      [
        agent({ short_id: "a", session_id: "a", liveness: "active", open_work: 4 }),
        agent({ short_id: "d", session_id: "d", liveness: "dead", open_work: 2 }),
        agent({ short_id: "s", session_id: "s", possibly_stalled: true }),
      ],
      { cycles: [{ members: ["a", "d"], all_live: false }] },
    ),
  );
  assert.equal(t.stranded, 2);
  assert.equal(t.strandedOwners, 1);
  assert.equal(t.staleCycles, 1);
  assert.equal(t.deadlocks, 0);
  assert.equal(t.stalled, 1);
});

test("render: selection highlights only the agent column (soft bg), color on", () => {
  const out = renderSnapshot(
    snap([agent({ short_id: "aaaa", session_id: "a" }), agent({ short_id: "bbbb", session_id: "b" })]),
    { color: true, selected: 1, width: 100 },
  );
  const rows = out.split("\n").filter((l) => l.includes("\x1b[48;5;238m"));
  assert.equal(rows.length, 1, "exactly one row carries the agent-column bg chip");
  assert.match(rows[0], /›/, "selected row carries the › marker");
  assert.ok(rows[0].includes("\x1b[4m"), "selected agent name is underlined");
  // it must NOT be a full-row reverse bar — the harsh look we backed out of
  assert.ok(!out.includes("\x1b[7m"), "no full-row reverse-video");
});

test("render: no-color selection uses the › marker only (no bg escapes)", () => {
  const out = renderSnapshot(snap([agent({ short_id: "aaaa", session_id: "a" })]), {
    color: false,
    selected: 0,
  });
  assert.match(out, /›/);
  assert.ok(!out.includes("\x1b[48;5;238m"), "no bg escapes in no-color mode");
});

function manyAgents(n: number, over: (i: number) => Partial<FleetAgent> = () => ({})): FleetAgent[] {
  return Array.from({ length: n }, (_, i) =>
    agent({ short_id: `a${i}`, session_id: `s${i}`, ...over(i) }),
  );
}

test("render: windows agent rows around the selection (top)", () => {
  const out = renderSnapshot(snap(manyAgents(10)), { color: false, maxAgentRows: 4, selected: 0 });
  assert.match(out, /a0\b/);
  assert.match(out, /a3\b/);
  assert.ok(!/a4\b/.test(out), "rows beyond the window are hidden");
  assert.match(out, /6 more below/);
  assert.ok(!/more above/.test(out));
});

test("render: window keeps the selected row visible (bottom)", () => {
  const out = renderSnapshot(snap(manyAgents(10)), { color: false, maxAgentRows: 4, selected: 9 });
  assert.match(out, /a9\b/);
  assert.match(out, /6 more above/);
  assert.ok(!/more below/.test(out));
});

test("render: no window markers when the fleet fits", () => {
  const out = renderSnapshot(snap(manyAgents(3)), { color: false, maxAgentRows: 10 });
  assert.ok(!/more (above|below)/.test(out));
});

test("render: wait-graph caps body lines with a summary", () => {
  const agents = manyAgents(6, () => ({
    waiting: {
      target_session_id: "t",
      target_short_id: "tgt",
      age_s: 5,
      orphaned: false,
      in_cycle: false,
      cycle_all_live: false,
    },
  }));
  const out = renderSnapshot(snap(agents), { color: false, maxWaitRows: 3 });
  assert.match(out, /⋯ 3 more waits/);
});

test("render: color codes only when enabled", () => {
  const plain = renderSnapshot(snap([agent({ liveness: "active" })]), { color: false });
  const colored = renderSnapshot(snap([agent({ liveness: "active" })]), { color: true });
  assert.ok(!plain.includes("\x1b["), "plain output has no ANSI codes");
  assert.ok(colored.includes("\x1b["), "colored output has ANSI codes");
});

// ── live tool-activity badge ────────────────────────────────────────────────────
test("activity badge: running tool renders glyph+label+ellipsis", () => {
  const out = renderSnapshot(
    snap([agent({ activity: { tool: "bash", tool_raw: "Bash", tool_running: true } })]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("⚙bash…"), `expected running bash badge, got:\n${out}`);
});

test("activity badge: completed tool drops the ellipsis", () => {
  const out = renderSnapshot(
    snap([agent({ activity: { tool: "oxtail", tool_raw: "mcp__oxtail__ask_peer", tool_running: false } })]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("↔oxtail"), `expected oxtail badge, got:\n${out}`);
  assert.ok(!out.includes("↔oxtail…"), "completed tool must not show the running ellipsis");
});

test("activity badge: unknown tool family shows shortened raw name", () => {
  const out = renderSnapshot(
    snap([agent({ activity: { tool: "tool", tool_raw: "mcp__foo__do_thing", tool_running: true } })]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("•thing…"), `expected shortened unknown-tool badge, got:\n${out}`);
});

test("activity badge: absent when no activity", () => {
  const out = renderSnapshot(snap([agent({ activity: null })]), { color: false, width: 120 });
  for (const g of ["⚙", "↔", "✎", "▤", "⌕", "↗", "⎇", "☰"]) {
    assert.ok(!out.includes(g), `unexpected tool glyph ${g} with no activity`);
  }
});

// ── orthogonal pane-recent (·✽) hint ────────────────────────────────────────────
test("pane-recent: idle agent with a fresh pane shows ✽age (item-5 fix)", () => {
  const out = renderSnapshot(
    snap([agent({ liveness: "idle", transcript_age_s: 200, pane_activity_age_s: 2 })]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("✽2s"), `expected pane-recent hint, got:\n${out}`);
  assert.match(out, /🟡/); // glyph stays idle — never promoted to active
});

test("pane-recent: stale pane (beyond active window) shows no hint", () => {
  const out = renderSnapshot(
    snap([agent({ liveness: "idle", transcript_age_s: 600, pane_activity_age_s: 120 })]),
    { color: false, width: 120 },
  );
  assert.ok(!out.includes("✽"), "a long-quiet pane must not show the hint");
});

test("pane-recent: active agent gets no ✽ hint (idle band only)", () => {
  const out = renderSnapshot(
    snap([agent({ liveness: "active", transcript_age_s: 3, pane_activity_age_s: 1 })]),
    { color: false, width: 120 },
  );
  assert.ok(!out.includes("✽"), "active rows already read live; no redundant hint");
});

// ── live pane-tail detail (beats purpose) ───────────────────────────────────────
test("render: live pane_tail beats the purpose caption", () => {
  const m = new Map([["sess1", { pane_tail: "Gallivanting… (2m)", pane_busy: true }]]);
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", purpose: "old declared purpose" })]),
    { color: false, width: 120, paneActivity: m },
  );
  assert.ok(out.includes("Gallivanting"), "shows the live pane tail");
  assert.ok(!out.includes("old declared purpose"), "observed pane line beats declared purpose");
});

test("render: pane_busy with no extractable tail shows working…", () => {
  const m = new Map([["sess1", { pane_tail: null, pane_busy: true }]]);
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", purpose: "p" })]),
    { color: false, width: 120, paneActivity: m },
  );
  assert.ok(out.includes("working…"), `expected working… got:\n${out}`);
});

test("render: purpose still shows when there is no pane capture", () => {
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", purpose: "declared thing" })]),
    { color: false, width: 120, paneActivity: new Map() },
  );
  assert.ok(out.includes("declared thing"));
});

// ── tool-activity overlay (immutable, max review) ───────────────────────────────
test("render: toolActivity overlay supplies a badge without the snapshot carrying one", () => {
  const overlay = new Map([["sess1", { tool: "bash" as const, tool_raw: "Bash", tool_running: true }]]);
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", activity: null })]), // snapshot has no activity (fast tick)
    { color: false, width: 120, toolActivity: overlay },
  );
  assert.ok(out.includes("⚙bash…"), `overlay badge expected, got:\n${out}`);
});

test("render: no overlay entry → falls back to the snapshot's own activity (status path)", () => {
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", activity: { tool: "bash", tool_raw: "Bash", tool_running: true } })]),
    { color: false, width: 120, toolActivity: new Map() }, // empty overlay
  );
  assert.ok(out.includes("⚙bash…"), "snapshot activity shows when the overlay has no entry");
});

test("render: overlay null entry on a fast tick (no snapshot activity) → no badge", () => {
  const overlay = new Map<string, null>([["sess1", null]]);
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", activity: null })]), // fast tick: snapshot read no activity
    { color: false, width: 120, toolActivity: overlay },
  );
  assert.ok(!out.includes("⚙bash"), "a null overlay over a null snapshot shows nothing");
});

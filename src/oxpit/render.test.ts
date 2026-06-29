import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  attentionLine,
  commsBodyLines,
  computeAgentLabels,
  fleetTrouble,
  renderCommsLog,
  renderDock,
  renderSnapshot,
  windowWithMarkers,
} from "./render.js";
import type { FleetAgent, FleetSnapshot } from "./snapshot.js";
import type { CommsMessage } from "./comms.js";

function agent(partial: Partial<FleetAgent>): FleetAgent {
  const a: FleetAgent = {
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
    awaiting_human: false,
    transcript_path: null,
    activity: null,
    unread: 0,
    unread_confidence: "high",
    open_work: 0,
    waiting: null,
    tmux_pane: "%1",
    tmux_session: "proj",
    window_index: 0,
    ...partial,
  };
  // Mirror buildAgent's derivation so render fixtures match real snapshots (an idle,
  // not-peer-waiting, not-stalled agent with a transcript IS awaiting-you) — unless a
  // test pins awaiting_human explicitly.
  if (partial.awaiting_human === undefined) {
    a.awaiting_human =
      a.liveness === "idle" &&
      a.liveness_reason !== "no_transcript" &&
      a.waiting === null &&
      !a.possibly_stalled &&
      !a.activity?.tool_running;
  }
  return a;
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
  assert.match(op, /operator ⇒ codex/); // operator = one-way ⇒ directive arrow
  const anon = renderCommsLog([msg({ from_session_id: null })], COMMS_LABELS, {
    color: false,
    nowSec: 1000,
  });
  assert.match(anon, /unknown → codex/); // a normal (two-way) message keeps →
  assert.ok(!/operator/.test(anon), "null-from non-operator must NOT be labeled operator");
});

test("commsBodyLines: operator directives use ⇒, agent messages use →", () => {
  const op = commsBodyLines([msg({ from_session_id: null, origin: "operator" })], COMMS_LABELS, { color: false });
  const peer = commsBodyLines([msg({})], COMMS_LABELS, { color: false });
  assert.ok(op[0].includes("⇒") && !op[0].includes("→"), "operator → one-way ⇒");
  assert.ok(peer[0].includes("→") && !peer[0].includes("⇒"), "agent↔agent → two-way →");
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

test("attentionLine: healthy fleet (active + a peer-waiter) renders a dim '✓ nominal'", () => {
  // Truly-nominal now means: no trouble AND nobody awaiting YOU. A peer-waiter is the
  // wait-graph's job, not the worklist (awaiting_human=false), so this still reads fine.
  const out = attentionLine(
    snap([
      agent({ liveness: "active" }),
      agent({
        liveness: "idle",
        waiting: { target_session_id: "x", target_short_id: "x", age_s: 5, orphaned: false, in_cycle: false, cycle_all_live: false },
      }),
    ]),
    ID,
  );
  assert.ok(out && /✓ fleet nominal · 1 active/.test(out), "absence of alarms + nobody awaiting reads as 'checked & fine'");
});

test("attentionLine: idle-at-prompt agents are the 🙋 worklist — NAMED, replacing nominal", () => {
  // The product step: an idle agent sitting at its prompt is "awaiting you". The line
  // names them (more actionable than a count for a small fleet) and replaces nominal —
  // you are not "nothing to see" when someone is blocked on your input.
  const out = attentionLine(
    snap([
      agent({ short_id: "aaaa1111", liveness: "active" }),
      agent({ short_id: "cccc2222", window_name: "codex", liveness: "idle" }),
      agent({ short_id: "mmmm3333", window_name: "max", liveness: "idle" }),
    ]),
    ID,
  )!;
  assert.match(out, /🙋 awaiting you: /);
  assert.ok(out.includes("codex") && out.includes("max"), `expected names, got: ${out}`);
  assert.ok(!/✓ fleet nominal/.test(out), "someone needs you ⇒ the worklist replaces nominal");
});

test("attentionLine: a peer-waiter is NOT on the worklist (complement of the wait-graph)", () => {
  // The disambiguation: parked-on-a-peer belongs to the wait-graph, never the 🙋 line.
  const out = attentionLine(
    snap([
      agent({ short_id: "aaaa1111", liveness: "active" }),
      agent({
        short_id: "wwww2222",
        window_name: "waiter",
        liveness: "idle",
        waiting: { target_session_id: "t", target_short_id: "t", age_s: 9, orphaned: false, in_cycle: false, cycle_all_live: false },
      }),
    ]),
    ID,
  )!;
  assert.ok(!/🙋/.test(out), "peer-waiters must not appear on the awaiting-you worklist");
});

test("attentionLine: worklist caps at 3 names with '+N more' (wait-graph idiom)", () => {
  const idle = (sid: string, name: string) => agent({ short_id: sid, window_name: name, liveness: "idle" });
  const out = attentionLine(
    snap([
      idle("aaaa0001", "a"),
      idle("bbbb0002", "b"),
      idle("cccc0003", "c"),
      idle("dddd0004", "d"),
      idle("eeee0005", "e"),
    ]),
    ID,
  )!;
  assert.match(out, /🙋 awaiting you: a, b, c \+2 more/);
});

test("computeAgentLabels: scrubs the ESC/C0/newline/bidi injection vector from window names (codex)", () => {
  // A tmux window name is arbitrary bytes — the label feeds the rows, wait-graph, comms,
  // and the prominent new 🙋 worklist, so it must never carry a terminal-control injection.
  const { byShortId } = computeAgentLabels([
    agent({ short_id: "scrub111", window_name: "a\x1b[31mb\nc\u202ed" }),
  ]);
  const label = byShortId.get("scrub111")!;
  // No ESC byte (⇒ the "[31m" remnant is inert text, not an active SGR), no C0, no bidi
  // override — the label cannot corrupt the operator's terminal. (\u escapes, never
  // literal invisibles — the project's NUL-separator lesson.)
  assert.ok(!/[\x00-\x1f\u202a-\u202e]/.test(label), `unsafe bytes survived: ${JSON.stringify(label)}`);
  assert.ok(label.includes("a") && label.includes("d"), "readable text is preserved");
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

test("fleetTrouble: counts dead-owner unread as strandedMail, ignores live unread", () => {
  const t = fleetTrouble(
    snap([
      // live unread is NORMAL (the agent will drain it) — must NOT count as stranded.
      agent({ short_id: "a", session_id: "a", liveness: "active", unread: 5 }),
      // two dead agents holding undrained mail = the silent-loss case the cockpit surfaces.
      agent({ short_id: "d", session_id: "d", liveness: "dead", unread: 1 }),
      agent({ short_id: "e", session_id: "e", liveness: "dead", unread: 3 }),
    ]),
  );
  assert.equal(t.strandedMail, 4, "sums unread across dead owners only");
  assert.equal(t.strandedMailOwners, 2);
});

test("attentionLine: dead-owner unread mail surfaces as a (yellow) stranded-mail segment", () => {
  const line = attentionLine(
    snap([agent({ short_id: "d", session_id: "d", liveness: "dead", unread: 2 })]),
    ID,
  );
  assert.ok(line && /✉ 2 stranded mail \(dead owner\)/.test(line), `got: ${line}`);
});

test("render: selection highlights only the agent column (soft bg), color on", () => {
  const out = renderSnapshot(
    snap([agent({ short_id: "aaaa", session_id: "a" }), agent({ short_id: "bbbb", session_id: "b" })]),
    { color: true, selected: 1, width: 100 },
  );
  const rows = out.split("\n").filter((l) => l.includes("\x1b[48;5;238m"));
  assert.equal(rows.length, 1, "exactly one row carries the agent-column bg chip");
  assert.match(rows[0], /›/, "selected row carries the › marker");
  assert.ok(!rows[0].includes("\x1b[4m"), "selected agent name is NOT underlined (David)");
  // the name is indented one space inside the chip (space-width indent, no jitter)
  assert.match(rows[0], /\x1b\[48;5;238m \w/, "name sits indented one space in the chip");
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
  assert.ok(out.includes("⇄oxtail"), `expected oxtail badge, got:\n${out}`);
  assert.ok(!out.includes("⇄oxtail…"), "completed tool must not show the running ellipsis");
});

test("activity badge: unknown tool family shows shortened raw name", () => {
  const out = renderSnapshot(
    snap([agent({ activity: { tool: "tool", tool_raw: "mcp__foo__do_thing", tool_running: true } })]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("∙thing…"), `expected shortened unknown-tool badge, got:\n${out}`);
});

test("activity badge: absent when no activity", () => {
  const out = renderSnapshot(snap([agent({ activity: null })]), { color: false, width: 120 });
  for (const g of ["⚙", "⇄", "✎", "▭", "⌕", "⇗", "⎇", "☰"]) {
    assert.ok(!out.includes(g), `unexpected tool glyph ${g} with no activity`);
  }
});

// ── pane_fresh: a fresh pane reads ACTIVE, ✻age behind the glyph ────────────────
test("pane_fresh: working-but-quiet-transcript agent reads active ✻age (item-5 fix)", () => {
  // David's case: transcript minutes stale mid-turn but the pane repainted just now.
  // snapshot.ts promotes it to active/pane_fresh; render shows the fresh PANE age.
  const out = renderSnapshot(
    snap([
      agent({
        liveness: "active",
        liveness_reason: "pane_fresh",
        transcript_age_s: 200,
        pane_activity_age_s: 2,
      }),
    ]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("active ✻2s"), `expected pane-fresh status, got:\n${out}`);
  assert.match(out, /🟢/); // promoted to the active glyph
  assert.ok(!out.includes("2m"), "must show the fresh pane age, not the stale 200s transcript");
});

// ── tool_running: a silent in-flight tool reads ACTIVE, ⧖tx-age behind the glyph ──
test("tool_running: a silent-tool agent reads active ⧖tx-age, distinct from transcript_fresh", () => {
  // A tool is in flight while transcript + pane are both quiet (a long bash / fetch).
  // snapshot.ts keeps it active/tool_running; render must mark it ⧖ so it's legible
  // from the status cell alone (not only via the badge cluster) and shows the tx age.
  const out = renderSnapshot(
    snap([
      agent({
        liveness: "active",
        liveness_reason: "tool_running",
        transcript_age_s: 45,
        pane_activity_age_s: 90,
      }),
    ]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("active ⧖45s"), `expected tool-running status, got:\n${out}`);
  assert.match(out, /🟢/); // still the active glyph
  assert.ok(!out.includes("active 45s"), "tool_running must carry the ⧖ marker, not read bare");
});

test("pane_fresh: a long-quiet idle agent shows no ✻ and stays idle", () => {
  const out = renderSnapshot(
    snap([agent({ liveness: "idle", transcript_age_s: 600, pane_activity_age_s: 120 })]),
    { color: false, width: 120 },
  );
  assert.ok(!out.includes("✻"), "a long-quiet pane must not show the hint");
  assert.match(out, /🟡/);
});

test("pane_fresh: a transcript_fresh active agent shows the transcript age, no ✽", () => {
  const out = renderSnapshot(
    snap([
      agent({
        liveness: "active",
        liveness_reason: "transcript_fresh",
        transcript_age_s: 3,
        pane_activity_age_s: 1,
      }),
    ]),
    { color: false, width: 120 },
  );
  assert.ok(out.includes("active 3s"), `expected transcript-fresh status, got:\n${out}`);
  assert.ok(!out.includes("✻"), "transcript-fresh rows read live directly; no ✻ suffix");
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

test("render: overlay explicit null NOW genuinely suppresses a snapshot badge (contract)", () => {
  // The resolver is has()-based, so an explicit-null overlay overrides — matching
  // the RenderOptions comment (codex/max LOW).
  const overlay = new Map<string, null>([["sess1", null]]);
  const out = renderSnapshot(
    snap([agent({ session_id: "sess1", activity: { tool: "bash", tool_raw: "Bash", tool_running: true } })]),
    { color: false, width: 120, toolActivity: overlay },
  );
  assert.ok(!out.includes("⚙bash"), "explicit-null overlay suppresses the snapshot badge");
});

test("renderCommsLog: scrubs ESC/bidi from an untrusted message body", () => {
  const hostile = "hi \x1b[31mRED\x1b[0m ‮evil there";
  const out = renderCommsLog([msg({ body: hostile })], COMMS_LABELS, { color: false, nowSec: 1000 });
  assert.ok(!out.includes("\x1b[31m"), "raw ESC sequence stripped from body");
  assert.ok(!out.includes("‮"), "bidi override stripped from body");
});

// ── background (detached) process collapse ──────────────────────────────────────

test("renderSnapshot: detached background processes collapse to a footer, off the table + worklist", () => {
  const main = agent({
    short_id: "aaaa1111",
    window_name: "main",
    liveness: "active",
    liveness_reason: "transcript_fresh",
    awaiting_human: false,
  });
  const max = agent({ short_id: "bbbb2222", window_name: "max" });
  const codex = agent({ short_id: "cccc3333", window_name: "codex", client_type: "codex" });
  // Detached: pane-less, not jumpable — what the cockpit collapses.
  const bgClaimed = agent({
    short_id: "019eebb0",
    window_name: null,
    client_type: "codex",
    tmux_pane: null,
    window_index: null,
  });
  const bgPid = agent({
    short_id: "pid:88827",
    window_name: null,
    client_type: "codex",
    liveness_reason: "no_transcript",
    transcript_age_s: null,
    tmux_pane: null,
    window_index: null,
  });

  const s = snap([main, max, codex], { background: [bgClaimed, bgPid] });
  const out = renderSnapshot(s, { color: false, width: 100 });

  // Header acknowledges the count; a collapsed (▸) section header replaces N rows.
  assert.ok(out.includes("3 agents (1 active)  +2 bg"), "header shows foreground count + bg suffix");
  assert.ok(
    out.includes("▸ 2 background processes (detached — no tmux pane, not jumpable) · b to show"),
    "a collapsed section header stands in for the detached processes",
  );

  // The phantom rows are NOT in the navigable table (collapsed), nor named "awaiting you".
  assert.ok(!out.includes("019eebb0"), "collapsed agent must not appear as a row");
  assert.ok(!out.includes("pid:88827"), "collapsed agent must not appear as a row");
  assert.ok(out.includes("awaiting you: max, codex"), "only real idle agents are the worklist");
});

test("renderSnapshot: showBackground expands the detached section into distinct dim rows", () => {
  const main = agent({
    short_id: "aaaa1111",
    window_name: "main",
    liveness: "active",
    liveness_reason: "transcript_fresh",
    awaiting_human: false,
  });
  const bgClaimed = agent({
    short_id: "019eebb0",
    window_name: null,
    client_type: "codex",
    server_pid: 5101,
    tmux_pane: null,
    window_index: null,
  });
  const bgPid = agent({
    short_id: "pid:88827",
    window_name: null,
    client_type: "codex",
    server_pid: 88827,
    liveness_reason: "no_transcript",
    transcript_age_s: null,
    tmux_pane: null,
    window_index: null,
  });

  const s = snap([main], { background: [bgClaimed, bgPid] });
  const out = renderSnapshot(s, { color: false, width: 100, showBackground: true });

  // Expanded header (▾ + "b to hide"), then the individual rows ARE shown, with the
  // real server pid so the operator can confirm "is this real?".
  assert.ok(out.includes("▾ 2 background processes (detached — no tmux pane, not jumpable) · b to hide"));
  assert.ok(out.includes("019eebb0") && out.includes("pid 5101"), "claimed detached row + its pid");
  assert.ok(out.includes("pid:88827"), "unclaimed detached row shown");
  // main remains the only real agent in the count; the section rows are not fleet rows.
  assert.ok(out.includes("1 agent (1 active)  +2 bg"));
});

test("renderSnapshot: no background ⇒ no footer, no +bg suffix (unchanged)", () => {
  const out = renderSnapshot(snap([agent({ short_id: "aaaa1111", window_name: "main" })]), {
    color: false,
    width: 100,
  });
  assert.ok(!out.includes("background"), "no footer when there are no detached processes");
  assert.ok(!out.includes("+1 bg") && !out.includes("+0 bg"), "no +bg suffix in the header");
});

// ── windowWithMarkers: the shared dock/editor windowing invariant ───────────────
test("windowWithMarkers: everything fits → whole list, no markers", () => {
  assert.deepEqual(windowWithMarkers(3, 1, 5), { start: 0, end: 3, above: 0, below: 0 });
  assert.deepEqual(windowWithMarkers(3, 2, 3), { start: 0, end: 3, above: 0, below: 0 });
});

test("windowWithMarkers: both sides hidden → accurate counts, section == budget", () => {
  // 10 items, budget 4, cursor 5: reserve 2 markers → 2 content rows centred on 5.
  const w = windowWithMarkers(10, 5, 4);
  assert.equal(w.above, w.start, "above count == hidden-above");
  assert.equal(w.below, 10 - w.end, "below count == hidden-below");
  assert.ok(5 >= w.start && 5 < w.end, "cursor visible");
  const section = (w.above > 0 ? 1 : 0) + (w.end - w.start) + (w.below > 0 ? 1 : 0);
  assert.ok(section <= 4, `section ${section} fits budget 4`);
  assert.ok(w.above > 0 && w.below > 0, "both markers present for an interior cursor");
});

test("windowWithMarkers: cursor at an edge reclaims the freed marker row", () => {
  const top = windowWithMarkers(10, 0, 4);
  assert.equal(top.above, 0, "no above marker at the top");
  assert.ok(0 >= top.start && 0 < top.end);
  const bot = windowWithMarkers(10, 9, 4);
  assert.equal(bot.below, 0, "no below marker at the bottom");
  assert.ok(9 >= bot.start && 9 < bot.end);
});

test("windowWithMarkers: budget ≤ 2 → bare cursor-visible window, markers suppressed", () => {
  const w = windowWithMarkers(8, 6, 2);
  assert.equal(w.above, 0);
  assert.equal(w.below, 0);
  assert.equal(w.end - w.start, 2, "exactly budget rows");
  assert.ok(6 >= w.start && 6 < w.end, "cursor still visible");
});

test("windowWithMarkers: INVARIANT — section ≤ budget ∧ cursor visible ∧ markers exact, exhaustively", () => {
  for (let total = 0; total <= 12; total++) {
    for (let budget = 1; budget <= 12; budget++) {
      for (let cursor = 0; cursor < Math.max(1, total); cursor++) {
        const { start, end, above, below } = windowWithMarkers(total, cursor, budget);
        const section = (above > 0 ? 1 : 0) + (end - start) + (below > 0 ? 1 : 0);
        const ctx = `total=${total} budget=${budget} cursor=${cursor}`;
        // The hard invariant: the rendered section never exceeds the row budget.
        assert.ok(section <= budget, `${ctx}: section ${section} ≤ budget ${budget}`);
        // When a marker IS shown its count is exact (no off-by-one, no dropped marker).
        if (above > 0) assert.equal(above, start, `${ctx}: above count exact`);
        if (below > 0) assert.equal(below, total - end, `${ctx}: below count exact`);
        // The cursor row is always inside the content window.
        if (total > 0) {
          const c = Math.min(cursor, total - 1);
          assert.ok(c >= start && c < end, `${ctx}: cursor visible in [${start},${end})`);
        }
        // Markers are only suppressed (rows hidden, no marker) when there's no room — i.e.
        // budget ≤ 2. Above that, any hidden edge MUST carry a marker.
        if (budget >= 3) {
          if (start > 0) assert.ok(above > 0, `${ctx}: hidden-above must show a marker`);
          if (end < total) assert.ok(below > 0, `${ctx}: hidden-below must show a marker`);
        }
      }
    }
  }
});

// ── renderDock: squash windowing ────────────────────────────────────────────────
function dockFleet(n: number): FleetSnapshot {
  const agents = Array.from({ length: n }, (_, i) => {
    const id = `${i}`.repeat(8).slice(0, 8);
    return agent({ session_id: `s-${i}`, short_id: id, window_name: `w${i}` });
  });
  return snap(agents);
}

test("renderDock: short fleet renders every row, no markers", () => {
  const out = renderDock(dockFleet(3), { color: false, width: 100, maxAgentRows: 6 });
  for (const w of ["w0", "w1", "w2"]) assert.ok(out.includes(w), `${w} present`);
  assert.ok(!out.includes("more above") && !out.includes("more below"), "no scroll markers");
});

test("renderDock: tall fleet windows to maxAgentRows with markers + keeps selection", () => {
  const out = renderDock(dockFleet(8), { color: false, width: 100, maxAgentRows: 4, selected: 6 });
  const body = out.split("\n");
  // header + footer + at most maxAgentRows lines for the agent section.
  assert.ok(body.length <= 2 + 4, `dock fits the budget (got ${body.length} lines)`);
  assert.ok(out.includes("w6"), "the selected row stays visible");
  assert.ok(/⋯ \d+ more/.test(out), "shows a '⋯ N more' marker instead of silently truncating");
});

test("renderDock: dockStatus replaces the footer hints", () => {
  const out = renderDock(dockFleet(2), {
    color: false,
    width: 100,
    maxAgentRows: 6,
    dockStatus: "nudge w0? press y to confirm",
  });
  assert.ok(out.includes("press y to confirm"), "status shown");
  assert.ok(!out.includes("⏎ jump"), "key hints replaced by the status line");
});

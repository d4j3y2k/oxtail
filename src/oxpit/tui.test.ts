import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveDockAutoSelect, stepInput, type InputAction, type PasteState } from "./tui.js";
import type { FleetAgent } from "./snapshot.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const FRESH: PasteState = { pasting: false, pasteBuf: "" };

// Convenience: run one chunk against a state and return both halves.
function step(state: PasteState, chunk: string, cap?: number) {
  return stepInput(state, chunk, cap);
}

test("stepInput: plain keys pass straight through as a key action", () => {
  const { state, actions } = step(FRESH, "abc");
  assert.deepEqual(actions, [{ t: "key", data: "abc" }]);
  assert.equal(state.pasting, false);
});

test("stepInput: a self-contained paste yields one paste action, no paste mode left", () => {
  const { state, actions } = step(FRESH, `${PASTE_START}hello world${PASTE_END}`);
  assert.deepEqual(actions, [{ t: "paste", data: "hello world" }]);
  assert.equal(state.pasting, false);
  assert.equal(state.pasteBuf, "");
});

test("stepInput: keys before a paste start dispatch first, then paste opens", () => {
  const { state, actions } = step(FRESH, `xy${PASTE_START}pasted`);
  assert.deepEqual(actions, [{ t: "key", data: "xy" }]);
  assert.equal(state.pasting, true, "still inside the paste (no END yet)");
  assert.equal(state.pasteBuf, "pasted");
});

test("stepInput: a paste spanning multiple chunks reassembles, flushes on END", () => {
  let s = step(FRESH, `${PASTE_START}part-one `);
  assert.equal(s.state.pasting, true);
  assert.deepEqual(s.actions, []);
  s = step(s.state, "part-two ");
  assert.equal(s.state.pasting, true);
  assert.equal(s.state.pasteBuf, "part-one part-two ");
  s = step(s.state, `part-three${PASTE_END}`);
  assert.deepEqual(s.actions, [{ t: "paste", data: "part-one part-two part-three" }]);
  assert.equal(s.state.pasting, false);
});

test("stepInput: content after PASTE_END in the same chunk is handled as keys", () => {
  const { state, actions } = step(FRESH, `${PASTE_START}body${PASTE_END}q`);
  assert.deepEqual(actions, [
    { t: "paste", data: "body" },
    { t: "key", data: "q" },
  ]);
  assert.equal(state.pasting, false);
});

// ── the #4 fix: ⌃C stays live mid-paste (⌃C is the ONLY quit since 16a051d) ──────
test("stepInput: ⌃C mid-paste yields quit and clears paste state (unstickable)", () => {
  // open a paste, leave it un-terminated across a chunk boundary…
  const opened = step(FRESH, `${PASTE_START}half a paste`);
  assert.equal(opened.state.pasting, true);
  // …then a ⌃C arrives (terminal aborts paste / never sends END): must quit.
  const { state, actions } = step(opened.state, "\x03");
  assert.ok(
    actions.some((a: InputAction) => a.t === "quit"),
    "⌃C while pasting must produce a quit action",
  );
  assert.equal(state.pasting, false, "paste mode cleared on quit");
  assert.equal(state.pasteBuf, "", "paste buffer cleared on quit");
});

test("stepInput: ⌃C mid-paste stops processing the rest of the chunk", () => {
  const opened = step(FRESH, PASTE_START);
  const { actions } = step(opened.state, "junk\x03more-junk");
  // exactly one action, the quit — nothing after ⌃C is dispatched.
  assert.deepEqual(actions, [{ t: "quit" }]);
});

test("stepInput: a literal ⌃C in NORMAL mode is passed to keys (handleKey decides)", () => {
  // Outside paste mode the chunk goes to handleKey verbatim — the quit decision is
  // handleKey's (exact "\x03" match), preserving pre-existing behavior.
  const { actions } = step(FRESH, "\x03");
  assert.deepEqual(actions, [{ t: "key", data: "\x03" }]);
});

// ── the #4 fix: an unterminated paste can't grow without bound ───────────────────
test("stepInput: an over-cap unterminated paste flushes and leaves paste mode", () => {
  const cap = 16;
  const { state, actions } = step({ pasting: true, pasteBuf: "" }, "x".repeat(20), cap);
  assert.deepEqual(actions, [{ t: "paste", data: "x".repeat(20) }], "flushed what we had");
  assert.equal(state.pasting, false, "left paste mode rather than buffering forever");
  assert.equal(state.pasteBuf, "");
});

test("stepInput: under-cap unterminated paste keeps buffering (no premature flush)", () => {
  const cap = 1_000_000;
  const { state, actions } = step({ pasting: true, pasteBuf: "" }, "small", cap);
  assert.deepEqual(actions, [], "nothing flushed yet — still mid-paste");
  assert.equal(state.pasting, true);
  assert.equal(state.pasteBuf, "small");
});

// ── resolveDockAutoSelect: the cockpit dock's window-local auto-selection ─────────
// Regression cover for the jump-highlight DRIFT: each per-window dock is its own
// process; the original closure latched auto-select OFF on the first cursor move and
// never re-armed it, so revisiting a navigated window showed the stale pick a row off.
const agent = (session_id: string, window_name: string | null): FleetAgent =>
  ({ session_id, server_pid: 1, window_name }) as FleetAgent;
const FLEET = [agent("s-main", "main"), agent("s-max", "max"), agent("s-codex", "codex")];

test("resolveDockAutoSelect: armed + active snaps the selection to this window's own agent", () => {
  const r = resolveDockAutoSelect(
    { selectedKey: "s-codex", dockAutoSelect: true },
    { windowName: "main", windowActive: true },
    FLEET,
  );
  assert.equal(r.selectedKey, "s-main");
  assert.equal(r.dockAutoSelect, true);
});

test("resolveDockAutoSelect: a cursor move STICKS while you're viewing the window (no re-arm)", () => {
  // latch off (you moved) + window active (you're viewing it) → selection unchanged so
  // you can pick a jump target; nothing re-arms it out from under you.
  const r = resolveDockAutoSelect(
    { selectedKey: "s-max", dockAutoSelect: false },
    { windowName: "main", windowActive: true },
    FLEET,
  );
  assert.equal(r.selectedKey, "s-max", "the moved-to pick stays put");
  assert.equal(r.dockAutoSelect, false);
});

test("resolveDockAutoSelect: leaving the window RE-ARMS and re-snaps to its own agent (the drift fix)", () => {
  // moved (latch off, selection=s-max) then switched away (window inactive): must re-arm
  // AND snap back to this window's agent so returning shows s-main, not the stale s-max.
  const r = resolveDockAutoSelect(
    { selectedKey: "s-max", dockAutoSelect: false },
    { windowName: "main", windowActive: false },
    FLEET,
  );
  assert.equal(r.selectedKey, "s-main", "re-snapped to this window's own agent");
  assert.equal(r.dockAutoSelect, true, "auto-select re-armed for the return");
});

test("resolveDockAutoSelect: tmux unreadable leaves the selection untouched", () => {
  const r = resolveDockAutoSelect({ selectedKey: "s-max", dockAutoSelect: false }, null, FLEET);
  assert.equal(r.selectedKey, "s-max");
  assert.equal(r.dockAutoSelect, false);
});

test("resolveDockAutoSelect: an unmatched window name re-arms but doesn't change the selection", () => {
  const r = resolveDockAutoSelect(
    { selectedKey: "s-max", dockAutoSelect: false },
    { windowName: "ghost", windowActive: false },
    FLEET,
  );
  assert.equal(r.selectedKey, "s-max", "no agent owns 'ghost' → selection unchanged");
  assert.equal(r.dockAutoSelect, true, "still re-armed (level rule keys on window_active alone)");
});

test("resolveDockAutoSelect: REGRESSION — repeated navigate→leave→return never drifts", () => {
  // Drives the exact multi-step the shipped bug failed: the old one-way latch left a
  // revisited window a row off, worse each cycle. Simulate one dock's lifecycle.
  let st: { selectedKey: string | null; dockAutoSelect: boolean } = {
    selectedKey: null,
    dockAutoSelect: true,
  };
  const tick = (windowName: string, windowActive: boolean) =>
    (st = resolveDockAutoSelect(st, { windowName, windowActive }, FLEET));

  tick("main", true); // startup in main's window
  assert.equal(st.selectedKey, "s-main");

  // user moves the cursor to pick a jump target (emulate move() clearing the latch)
  st = { selectedKey: "s-max", dockAutoSelect: false };
  tick("main", true); // still viewing main → pick STICKS
  assert.equal(st.selectedKey, "s-max");

  tick("main", false); // switched away → re-arm + re-snap to main in the background
  assert.equal(st.selectedKey, "s-main");
  assert.equal(st.dockAutoSelect, true);

  tick("main", true); // come back → already home, no drift
  assert.equal(st.selectedKey, "s-main");

  // second cycle — the OLD latch stayed off forever and drifted right here
  st = { selectedKey: "s-codex", dockAutoSelect: false };
  tick("main", false);
  tick("main", true);
  assert.equal(st.selectedKey, "s-main", "still snaps home — no cumulative drift");
});

test("resolveDockAutoSelect: prefers a LIVE agent over a dead breadcrumb, regardless of order", () => {
  // A window can carry dead breadcrumbs sharing its name (David's screenshot: cursor on a
  // dead `main`). Auto-select must pick the LIVE one independent of the snapshot sort order —
  // max's decouple, so a future re-sort can't silently bring the dead-wins bug back.
  const a = (session_id: string, liveness: FleetAgent["liveness"]): FleetAgent =>
    ({ session_id, server_pid: 1, window_name: "main", liveness }) as FleetAgent;
  const live = a("s-live", "idle");
  const dead = a("s-dead", "dead");
  const pick = (agents: FleetAgent[]) =>
    resolveDockAutoSelect(
      { selectedKey: null, dockAutoSelect: true },
      { windowName: "main", windowActive: true },
      agents,
    ).selectedKey;
  assert.equal(pick([dead, live]), "s-live", "dead listed first → still picks the live main");
  assert.equal(pick([live, dead]), "s-live", "live first → picks the live main");
  assert.equal(pick([dead]), "s-dead", "only dead share the name → falls back to it");
});


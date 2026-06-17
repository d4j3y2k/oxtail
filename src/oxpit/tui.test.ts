import { strict as assert } from "node:assert";
import { test } from "node:test";
import { stepInput, type InputAction, type PasteState } from "./tui.js";

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

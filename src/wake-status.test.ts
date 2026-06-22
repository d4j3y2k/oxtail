import { strict as assert } from "node:assert";
import { test } from "node:test";

import { honestFireStatus } from "./wake.js";

// H2 — honest wake status. A successful keystroke send is only a confident "fired"
// for a HOOKED peer (activity marker present: its hooks passively deliver and are
// the safety net). A HOOKLESS peer (Codex / no marker) send is OPEN-LOOP — nothing
// delivers passively and the paste-burst Enter may not have submitted — so it must
// report "fired_unconfirmed", never a bare "fired" that reads as confirmed pickup.

test("honestFireStatus: HOOKLESS peer (no activity marker) → fired_unconfirmed", () => {
  assert.equal(honestFireStatus("uuid-codex", null), "fired_unconfirmed");
});

test("honestFireStatus: HOOKED peer (fresh activity marker) → fired", () => {
  assert.equal(honestFireStatus("uuid-claude", { status: "idle", ageMs: 1000 }), "fired");
});

test("honestFireStatus: HOOKED peer (stale marker still present) → fired", () => {
  // A non-null marker means hooks exist (the passive safety net), even if stale.
  assert.equal(honestFireStatus("uuid-claude", { status: "busy", ageMs: 9_000_000 }), "fired");
});

test("honestFireStatus: unclaimed peer (no session_id) → fired_unconfirmed", () => {
  // An unclaimed peer is inherently hookless (no session to key a marker on), so a
  // wake to it is open-loop too — report the honest status, not a confident "fired"
  // (max N1: the one open-loop case the original gate still labeled "fired").
  assert.equal(honestFireStatus(null, null), "fired_unconfirmed");
});

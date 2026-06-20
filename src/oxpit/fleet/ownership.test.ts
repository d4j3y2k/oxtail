import { strict as assert } from "node:assert";
import { test } from "node:test";
import { listPanesWithMarkers, markersInSession, mintFleetId } from "./ownership.js";

const FS = "\x1f";

// A fake tmux that returns a canned list-panes -F payload (the executor injects
// `run` so the parse is testable without a real tmux server).
function fakeRun(rows: string[][]): (args: string[]) => string {
  return () => rows.map((r) => r.join(FS)).join("\n") + "\n";
}

test("listPanesWithMarkers parses fields and maps empty marker to null", () => {
  const run = fakeRun([
    ["%1", "oxtail", "0", "main", "1000", "claude", "oxtail-abcd1234"],
    ["%9", "oxtail", "0", "main", "2000", "nvim", ""], // unmarked human split
    ["%20", "other", "2", "max", "3000", "node", "other-55556666"],
  ]);
  const panes = listPanesWithMarkers(run);
  assert.equal(panes.length, 3);
  assert.deepEqual(panes[0], {
    pane: "%1",
    session: "oxtail",
    windowIndex: 0,
    windowName: "main",
    panePid: 1000,
    currentCommand: "claude",
    managedBy: "oxtail-abcd1234",
  });
  assert.equal(panes[1].managedBy, null, "empty @oxpit_managed → null");
  assert.equal(panes[2].managedBy, "other-55556666");
});

test("listPanesWithMarkers tolerates a window name containing spaces", () => {
  const run = fakeRun([["%1", "my session", "0", "main window", "1000", "claude", "f-1"]]);
  const panes = listPanesWithMarkers(run);
  assert.equal(panes[0].session, "my session");
  assert.equal(panes[0].windowName, "main window");
});

test("listPanesWithMarkers returns [] when tmux throws", () => {
  const run = () => {
    throw new Error("no server");
  };
  assert.deepEqual(listPanesWithMarkers(run), []);
});

test("markersInSession returns distinct fleetIds scoped to that session", () => {
  const run = fakeRun([
    ["%1", "oxtail", "0", "main", "1000", "claude", "oxtail-abcd1234"],
    ["%2", "oxtail", "1", "max", "1001", "claude", "oxtail-abcd1234"],
    ["%3", "other", "0", "main", "1002", "claude", "other-99"],
  ]);
  assert.deepEqual(markersInSession("oxtail", run), ["oxtail-abcd1234"]);
  assert.deepEqual(markersInSession("other", run), ["other-99"]);
  assert.deepEqual(markersInSession("nope", run), []);
});

test("mintFleetId is sanitized, prefixed, and unique-ish", () => {
  const a = mintFleetId("oxtail");
  const b = mintFleetId("oxtail");
  assert.match(a, /^oxtail-[0-9a-f]{8}$/);
  assert.notEqual(a, b);
  assert.match(mintFleetId("weird/name with spaces!"), /^weird-name-with-spaces--[0-9a-f]{8}$/);
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { killManagedWindow, listPanesWithMarkers, markersInSession, mintFleetId } from "./ownership.js";

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

// Real tmux escapes the 0x1F separator placed in the -F TEMPLATE to the literal
// 4-char string "\037" in its OUTPUT (verified tmux 3.5a). The parser MUST undo
// that, or it returns nothing against a live server — silently emptying the
// ownership listing (breaks the level probe AND RESET). The raw-\x1f mock above
// could never catch this; this feeds the escaped form a real tmux emits.
function fakeRunEscaped(rows: string[][]): (args: string[]) => string {
  return () => rows.map((r) => r.join("\\037")).join("\n") + "\n";
}

test("listPanesWithMarkers parses tmux's OCTAL-ESCAPED separator (real -F output)", () => {
  const run = fakeRunEscaped([
    ["%1", "oxtail", "0", "main", "1000", "claude", "oxtail-abcd1234"],
    ["%9", "oxtail", "0", "main", "2000", "nvim", ""], // unmarked human split
  ]);
  const panes = listPanesWithMarkers(run);
  assert.equal(panes.length, 2, "escaped separators must still yield rows");
  assert.equal(panes[0].pane, "%1");
  assert.equal(panes[0].session, "oxtail");
  assert.equal(panes[0].managedBy, "oxtail-abcd1234");
  assert.equal(panes[1].managedBy, null);
});

test("a foreign pane whose NAME contains a literal \\037 is SKIPPED, not made a phantom marker (max P5)", () => {
  // tmux does NOT escape backslashes, so a window/session name literally holding
  // the 4 chars "\037" renders identically to the escaped 0x1F separator — safeStr
  // permits "\","0","3","7". Such a foreign pane (we never spawn it) injects EXTRA
  // fields; the exact-count guard must SKIP it so it reads as UNOWNED, NOT mis-parse
  // a truthy field onto `managedBy` and fabricate a phantom fleetId (false ownership
  // is the dangerous direction for a teardown control). Fails on the old `< 7`.
  const run = fakeRunEscaped([
    ["%1", "oxtail", "0", "main", "1000", "claude", "oxtail-abcd1234"], // healthy → 7 fields
    ["%9", "human", "0", "wei\\037rd", "2000", "nvim", ""], // window name carries \037 → ≥8 fields
  ]);
  const panes = listPanesWithMarkers(run);
  assert.equal(panes.length, 1, "poisoned foreign row skipped, healthy row kept");
  assert.equal(panes[0].pane, "%1");
  assert.equal(panes[0].managedBy, "oxtail-abcd1234");
  // CRITICAL: the foreign \037-named pane must inject NO phantom ownership.
  assert.deepEqual(markersInSession("human", run), [], "no phantom fleetId from a foreign name");
});

test("markersInSession works on tmux's OCTAL-ESCAPED output (the live-tmux path)", () => {
  const run = fakeRunEscaped([
    ["%1", "oxtail", "0", "main", "1000", "claude", "oxtail-abcd1234"],
    ["%2", "oxtail", "1", "max", "1001", "claude", "oxtail-abcd1234"],
    ["%3", "other", "0", "main", "1002", "claude", "other-99"],
  ]);
  assert.deepEqual(markersInSession("oxtail", run), ["oxtail-abcd1234"]);
  assert.deepEqual(markersInSession("other", run), ["other-99"]);
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

// A tmux mock for killManagedWindow: `marker` = the target pane's @oxpit_managed
// (null = unmarked); `windows` = #{session_windows}; `panes` = the window's
// [paneId, marker] rows (defaults to a single pane carrying `marker`).
function killRun(o: { marker: string | null; windows?: number; panes?: Array<[string, string]> }) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    if (args[0] === "show-options") return o.marker ? `${o.marker}\n` : "\n";
    if (args[0] === "display-message") return `${o.windows ?? 3}\n`;
    if (args[0] === "list-panes") {
      const panes = o.panes ?? [["%1", o.marker ?? ""]];
      return `${panes.map(([p, m]) => `${p}=${m}`).join("\n")}\n`;
    }
    return "";
  };
  return { run, killed: () => calls.some((c) => c[0] === "kill-window"), calls };
}

test("killManagedWindow: kills a marked window when all three guards pass", () => {
  const { run, killed, calls } = killRun({ marker: "oxtail-abcd1234", windows: 3, panes: [["%1", "oxtail-abcd1234"]] });
  const r = killManagedWindow("%1", run);
  assert.equal(r.ok, true, "our marked, non-last, uniformly-owned window is killable");
  if (r.ok) assert.equal(r.fleetId, "oxtail-abcd1234");
  assert.ok(killed(), "kill-window fired");
  assert.ok(calls.some((c) => c[0] === "kill-window" && c.includes("%1")), "targets the pane's window");
});

test("killManagedWindow: refuses an UNMARKED (human) window", () => {
  const { run, killed } = killRun({ marker: null });
  const r = killManagedWindow("%9", run);
  assert.equal(r.ok, false, "an unmarked window is never ours to kill");
  if (!r.ok) assert.match(r.reason, /not oxpit-managed/);
  assert.ok(!killed(), "never kills an unmarked window");
});

test("killManagedWindow: refuses the session's LAST window (would collapse the session)", () => {
  const { run, killed } = killRun({ marker: "oxtail-abcd1234", windows: 1 });
  const r = killManagedWindow("%1", run);
  assert.equal(r.ok, false, "killing the only window would destroy the session");
  if (!r.ok) assert.match(r.reason, /only window|destroy the whole session/i);
  assert.ok(!killed(), "never kills the last window");
});

test("killManagedWindow: refuses a window holding an UNMANAGED split (won't destroy human work)", () => {
  const { run, killed } = killRun({
    marker: "oxtail-abcd1234",
    windows: 3,
    panes: [["%1", "oxtail-abcd1234"], ["%2", ""]], // %2 is a human split — unmanaged
  });
  const r = killManagedWindow("%1", run);
  assert.equal(r.ok, false, "a window with an unmanaged split is not cleanly ours to kill");
  if (!r.ok) assert.match(r.reason, /unmanaged|doesn't own/i);
  assert.ok(!killed(), "never kills a window containing an unmanaged split");
});

test("killManagedWindow: refuses a window holding ANOTHER fleet's pane", () => {
  const { run, killed } = killRun({
    marker: "oxtail-abcd1234",
    windows: 3,
    panes: [["%1", "oxtail-abcd1234"], ["%2", "oxtail-otherfleet"]],
  });
  const r = killManagedWindow("%1", run);
  assert.equal(r.ok, false, "a window mixing two fleets' panes is not cleanly ours to kill");
  assert.ok(!killed(), "never kills a window with a foreign-fleet pane");
});

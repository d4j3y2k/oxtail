import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseStatusArgs, runStatus } from "./cli.js";

test("parseStatusArgs: defaults", () => {
  const a = parseStatusArgs([]);
  assert.equal(a.json, false);
  assert.equal(a.pretty, false);
  assert.equal(a.color, undefined); // auto
  assert.equal(a.all, false);
  assert.equal(a.width, undefined);
  assert.equal(a.project, undefined);
});

test("parseStatusArgs: flags", () => {
  const a = parseStatusArgs(["--json", "--pretty", "--all"]);
  assert.equal(a.json, true);
  assert.equal(a.pretty, true);
  assert.equal(a.all, true);
});

test("parseStatusArgs: color on/off", () => {
  assert.equal(parseStatusArgs(["--no-color"]).color, false);
  assert.equal(parseStatusArgs(["--color"]).color, true);
});

test("parseStatusArgs: --width and --project, space and = forms", () => {
  assert.equal(parseStatusArgs(["--width", "120"]).width, 120);
  assert.equal(parseStatusArgs(["--width=80"]).width, 80);
  assert.equal(parseStatusArgs(["--project", "/a/b"]).project, "/a/b");
  assert.equal(parseStatusArgs(["--project=/c/d"]).project, "/c/d");
});

test("parseStatusArgs: unknown flags are ignored (forward-compat)", () => {
  const a = parseStatusArgs(["--client", "work", "--frobnicate"]);
  assert.equal(a.json, false); // didn't choke
});

test("parseStatusArgs: -h / --help", () => {
  assert.equal(parseStatusArgs(["-h"]).help, true);
  assert.equal(parseStatusArgs(["--help"]).help, true);
  assert.equal(parseStatusArgs([]).help, false);
});

test("runStatus --help prints usage and skips the snapshot", () => {
  const lines: string[] = [];
  const code = runStatus(["--help"], (l) => lines.push(l));
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /oxtail status/);
  assert.match(lines[0], /oxpit keys/);
});

test("runStatus --json emits valid parseable JSON with the snapshot shape", () => {
  const lines: string[] = [];
  // allProjects keeps this deterministic-ish regardless of cwd scoping; we only
  // assert the envelope shape, not the (environment-dependent) agent list.
  const code = runStatus(["--json", "--all"], (l) => lines.push(l));
  assert.equal(code, 0);
  assert.equal(lines.length, 1);
  const snap = JSON.parse(lines[0]);
  assert.equal(snap.schema_version, 1);
  assert.ok(Array.isArray(snap.agents));
  assert.ok(Array.isArray(snap.cycles));
  assert.ok(typeof snap.project_root === "string");
});

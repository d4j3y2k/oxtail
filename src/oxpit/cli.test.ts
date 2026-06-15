import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseMessageArgs, parseStatusArgs, runMessage, runStatus } from "./cli.js";

async function withHome<T>(fn: () => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-climsg-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn();
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

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

test("parseMessageArgs: positionals + flags", () => {
  const a = parseMessageArgs(["max", "hello", "world", "--no-wake"]);
  assert.deepEqual(a.positionals, ["max", "hello", "world"]);
  assert.equal(a.noWake, true);
  assert.equal(a.broadcast, false);
});

test("parseMessageArgs: broadcast / yes / cap / nudge", () => {
  const a = parseMessageArgs(["--broadcast", "--yes", "--cap", "3", "--nudge"]);
  assert.equal(a.broadcast, true);
  assert.equal(a.yes, true);
  assert.equal(a.cap, 3);
  assert.equal(a.nudge, true);
});

test("runMessage: no target prints usage and returns 1", async () => {
  await withHome(async () => {
    const lines: string[] = [];
    const code = await runMessage([], (l) => lines.push(l));
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /oxtail message/);
  });
});

test("runMessage: empty body is refused", async () => {
  await withHome(async () => {
    const lines: string[] = [];
    const code = await runMessage(["max"], (l) => lines.push(l)); // target, no body
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /empty message/);
  });
});

test("runMessage: unknown target errors (empty fleet)", async () => {
  await withHome(async () => {
    const lines: string[] = [];
    const code = await runMessage(["nobody", "hi"], (l) => lines.push(l));
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /no agent matches/);
  });
});

test("runMessage: broadcast with no live agents returns 1", async () => {
  await withHome(async () => {
    const lines: string[] = [];
    const code = await runMessage(["--broadcast", "hi"], (l) => lines.push(l));
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /no live|--yes/);
  });
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

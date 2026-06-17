import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_TROUBLE_CODE, checkExitCode, parseMessageArgs, parseStatusArgs, runMessage, runStatus } from "./cli.js";
import type { FleetTrouble } from "./render.js";

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
  assert.equal(a.noActivity, false); // real-time activity ON by default
});

test("parseStatusArgs: --no-activity", () => {
  assert.equal(parseStatusArgs(["--no-activity"]).noActivity, true);
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

test("parseStatusArgs: --check", () => {
  assert.equal(parseStatusArgs(["--check"]).check, true);
  assert.equal(parseStatusArgs([]).check, false);
});

test("runStatus --check on a healthy/empty fleet exits 0 (probe-friendly default)", async () => {
  await withHome(async () => {
    const lines: string[] = [];
    const code = runStatus(["--check", "--no-color"], (l) => lines.push(l));
    assert.equal(code, 0, "no trouble ⇒ exit 0 so scripts can branch on it");
  });
});

test("checkExitCode: the 🙋 awaiting worklist (and soft signals) NEVER trip --check (max)", () => {
  // Locks the deliberate invariant: an all-idle fleet (everyone awaiting you) is NORMAL,
  // not trouble — only hard, will-not-self-resolve problems make the probe exit non-zero.
  // Guards against a future refactor silently folding awaiting into the checkExitCode sum.
  const base: FleetTrouble = {
    deadlocks: 0, staleCycles: 0, orphaned: 0, stranded: 0,
    strandedOwners: 0, strandedMail: 0, strandedMailOwners: 0, stalled: 0, awaiting: 0, active: 0,
  };
  assert.equal(checkExitCode({ ...base, awaiting: 5 }), 0, "all-idle (awaiting>0) stays exit 0");
  assert.equal(checkExitCode({ ...base, stalled: 3 }), 0, "possibly-stalled is a soft hint, not a gate");
  assert.equal(checkExitCode({ ...base, staleCycles: 2 }), 0, "stale cycles are soft, not a gate");
  assert.equal(checkExitCode({ ...base, deadlocks: 1 }), CHECK_TROUBLE_CODE, "live deadlock IS hard trouble");
  assert.equal(checkExitCode({ ...base, orphaned: 1 }), CHECK_TROUBLE_CODE, "orphaned wait IS hard trouble");
  assert.equal(checkExitCode({ ...base, stranded: 1 }), CHECK_TROUBLE_CODE, "dead-owner stranded work IS hard trouble");
  assert.equal(checkExitCode({ ...base, strandedMail: 1 }), CHECK_TROUBLE_CODE, "dead-owner stranded mail IS hard trouble");
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

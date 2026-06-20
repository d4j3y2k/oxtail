import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnsureWindowResult } from "./ensure-window.js";
import { planSpawn, renderSpawnPlan, spawnFleet, tmuxSessionExists, tmuxSessionName } from "./spawn.js";
import type { FleetSpec } from "./types.js";

const spec: FleetSpec = {
  name: "demo.fleet",
  windows: [
    { name: "main", agent: "claude", model: "opus-4.8", role: "captain" },
    { name: "codex", agent: "codex", model: "gpt-5.5" },
  ],
};

function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-spawn-"));
  const prior = process.env.HOME;
  process.env.HOME = home;
  return (async () => {
    try {
      return await fn(home);
    } finally {
      process.env.HOME = prior;
      rmSync(home, { recursive: true, force: true });
    }
  })();
}

test("tmuxSessionName strips chars unsafe in tmux target syntax (: and .)", () => {
  assert.equal(tmuxSessionName("demo.fleet"), "demo-fleet");
  assert.equal(tmuxSessionName("a:b c"), "a-b-c");
  assert.equal(tmuxSessionName(""), "fleet");
});

test("planSpawn maps each window to a target + rendered recipe (no tmux)", () => {
  const plan = planSpawn(spec, "demo-fleet");
  assert.deepEqual(plan.map((p) => p.paneTarget), ["demo-fleet:main", "demo-fleet:codex"]);
  assert.match(plan[1].recipe, /joinClaim/); // codex recipe carries the join step
});

test("renderSpawnPlan shows the new-session + new-window + per-window steps", () => {
  const out = renderSpawnPlan(spec, "demo-fleet-abcd1234", "demo-fleet");
  assert.match(out, /new-session -d -s demo-fleet -n main/);
  assert.match(out, /new-window -t demo-fleet -n codex/);
  assert.match(out, /@oxpit_managed=demo-fleet-abcd1234/);
});

test("DRY-RUN (the default) mutates NOTHING — no tmux run calls", async () => {
  await withHome(async () => {
    const calls: string[][] = [];
    const res = await spawnFleet(spec, "/repo", {
      run: (args) => {
        calls.push(args);
        return "";
      },
      // dryRun defaults to true
    });
    assert.equal(res.dryRun, true);
    assert.equal(res.ok, true);
    assert.equal(calls.length, 0, "dry-run must not invoke tmux");
    assert.equal(res.plan.length, 2);
    assert.equal(res.results.length, 0);
  });
});

test("live SPAWN creates the session + windows, then ensures each SEQUENTIALLY", async () => {
  await withHome(async () => {
    const calls: string[][] = [];
    const ensureOrder: string[] = [];
    const res = await spawnFleet(spec, "/repo", {
      dryRun: false,
      run: (args) => {
        calls.push(args);
        if (args[0] === "list-panes") {
          const win = args[2].split(":")[1];
          return win === "main" ? "%10\n" : "%11\n";
        }
        return "";
      },
      ensure: async ({ target, window }) => {
        ensureOrder.push(`${window.name}@${target}`);
        return {
          window: window.name,
          occupancy: "empty-shell",
          action: "launched",
          ok: true,
          sessionId: `sid-${window.name}`,
        } satisfies EnsureWindowResult;
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, false);
    // session + window creation happened
    assert.ok(calls.some((c) => c[0] === "new-session" && c.includes("main")));
    assert.ok(calls.some((c) => c[0] === "new-window" && c.includes("codex")));
    // ensure ran once per window, in spec order, on the resolved panes
    assert.deepEqual(ensureOrder, ["main@%10", "codex@%11"]);
    assert.deepEqual(res.results.map((r) => r.sessionId), ["sid-main", "sid-codex"]);
  });
});

test("a window whose pane can't be resolved is reported, not skipped silently", async () => {
  await withHome(async () => {
    const res = await spawnFleet(spec, "/repo", {
      dryRun: false,
      run: (args) => (args[0] === "list-panes" ? "" : ""), // no pane id ever
      ensure: async ({ window }) =>
        ({ window: window.name, occupancy: "empty-shell", action: "launched", ok: true, sessionId: "x" }) satisfies EnsureWindowResult,
    });
    assert.equal(res.ok, false);
    assert.equal(res.results.length, 2);
    assert.ok(res.results.every((r) => /could not resolve pane/.test(r.reason ?? "")));
  });
});

test("REFUSES to spawn on top of an existing session (no clobber, no new-session)", async () => {
  await withHome(async () => {
    const calls: string[][] = [];
    const res = await spawnFleet(spec, "/repo", {
      dryRun: false,
      sessionName: "demo-fleet",
      run: (args) => {
        calls.push(args);
        // a session named exactly "demo-fleet" is already running
        if (args[0] === "list-sessions") return "other\ndemo-fleet\nthird\n";
        return "";
      },
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /already exists — refusing to spawn on top of it/);
    assert.equal(res.results.length, 0);
    // the refusal happened BEFORE any mutation
    assert.ok(!calls.some((c) => c[0] === "new-session"), "must not create a session on collision");
  });
});

test("tmuxSessionExists is an EXACT-name match (no prefix false-positive)", () => {
  const run = (args: string[]): string =>
    args[0] === "list-sessions" ? "oxtail\noxtail-2\nmyrepo\n" : "";
  assert.equal(tmuxSessionExists("oxtail", run), true);
  assert.equal(tmuxSessionExists("oxtail-2", run), true);
  assert.equal(tmuxSessionExists("oxt", run), false); // prefix must NOT match
  assert.equal(tmuxSessionExists("myrepo-x", run), false);
  // no tmux server (run throws) ⇒ nothing to collide with
  const throwing = (): string => {
    throw new Error("no server running");
  };
  assert.equal(tmuxSessionExists("oxtail", throwing), false);
});

test("session-creation failure aborts with an error, no per-window results", async () => {
  await withHome(async () => {
    const res = await spawnFleet(spec, "/repo", {
      dryRun: false,
      run: (args) => {
        if (args[0] === "new-session") throw new Error("tmux: dup session");
        return "";
      },
    });
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /session creation failed/);
    assert.equal(res.results.length, 0);
  });
});

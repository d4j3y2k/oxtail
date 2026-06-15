import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { RegistryEntry } from "../registry.js";
import type { FleetAgent } from "./snapshot.js";
import {
  chooseClient,
  jumpToAgent,
  listClients,
  listPanes,
  type TmuxRunner,
} from "./jump.js";

function agent(over: Partial<FleetAgent> = {}): FleetAgent {
  return {
    session_id: "11111111-1111-1111-1111-111111111111",
    short_id: "11111111",
    client_type: "claude-code",
    server_pid: 4242,
    cwd: "/proj",
    is_self: false,
    liveness: "idle",
    liveness_reason: "idle",
    transcript_age_s: 10,
    proc_sig: "ok",
    purpose: null,
    purpose_age_s: null,
    purpose_stale: false,
    possibly_stalled: false,
    unread: 0,
    unread_confidence: "high",
    open_work: 0,
    waiting: null,
    tmux_pane: "%7",
    tmux_session: "proj",
    ...over,
  };
}

function entry(over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    server_pid: 4242,
    started_at: 1,
    proc_sig: "sig",
    client: {
      type: "claude-code",
      session_id: "11111111-1111-1111-1111-111111111111",
      transcript_path: null,
      session_id_source: "env",
      cwd: "/proj",
    },
    tmux_pane: "%7",
    tmux_session: "proj",
    state: null,
    ...over,
  };
}

// ── chooseClient (pure) ───────────────────────────────────────────────────────

test("chooseClient: explicit --client wins", () => {
  const r = chooseClient([{ name: "c1", tty: "/t1", session: "s" }], "c1", "override");
  assert.deepEqual(r, { client: "override", ambiguous: false });
});

test("chooseClient: single other client is driven (cockpit stays put)", () => {
  const clients = [
    { name: "cockpit", tty: "/t1", session: "oxpit" },
    { name: "work", tty: "/t2", session: "proj" },
  ];
  const r = chooseClient(clients, "cockpit", undefined);
  assert.deepEqual(r, { client: "work", ambiguous: false });
});

test("chooseClient: only self attached ⇒ drive self", () => {
  const r = chooseClient([{ name: "self", tty: "/t", session: "s" }], "self", undefined);
  assert.deepEqual(r, { client: "self", ambiguous: false });
});

test("chooseClient: multiple others ⇒ self + ambiguous flag", () => {
  const clients = [
    { name: "self", tty: "/t0", session: "s" },
    { name: "a", tty: "/t1", session: "s" },
    { name: "b", tty: "/t2", session: "s" },
  ];
  const r = chooseClient(clients, "self", undefined);
  assert.equal(r.client, "self");
  assert.equal(r.ambiguous, true);
});

test("chooseClient: no clients ⇒ null", () => {
  assert.deepEqual(chooseClient([], "self", undefined), { client: null, ambiguous: false });
});

// ── tmux output parsing ───────────────────────────────────────────────────────

test("listPanes parses pane/session/window rows", () => {
  const run: TmuxRunner = () => "%1\tsess\t@0\n%2\ts2\t@5\n";
  assert.deepEqual(listPanes(run), [
    { pane: "%1", session: "sess", window: "@0" },
    { pane: "%2", session: "s2", window: "@5" },
  ]);
});

test("listClients parses client rows", () => {
  const run: TmuxRunner = () => "main\t/dev/ttys001\toxpit\n";
  assert.deepEqual(listClients(run), [{ name: "main", tty: "/dev/ttys001", session: "oxpit" }]);
});

test("listPanes returns [] when tmux throws", () => {
  const run: TmuxRunner = () => {
    throw new Error("no server");
  };
  assert.deepEqual(listPanes(run), []);
});

// ── jumpToAgent (injected deps) ───────────────────────────────────────────────

function fakeRunner(map: Record<string, string>): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRunner = (args) => {
    calls.push(args);
    return map[args[0]] ?? "";
  };
  return { run, calls };
}

test("jumpToAgent: happy path switches the chosen client", () => {
  const { run, calls } = fakeRunner({
    "list-panes": "%7\tproj\t@2\n",
    "list-clients": "cockpit\t/t1\toxpit\nwork\t/t2\tproj\n",
    "display-message": "cockpit",
  });
  const r = jumpToAgent(agent(), {
    run,
    inTmux: true,
    resolveEntry: () => entry(),
    verifyPane: () => "%7",
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.pane, "%7");
    assert.equal(r.session, "proj");
    assert.equal(r.client, "work"); // the OTHER client
  }
  const switched = calls.find((c) => c[0] === "switch-client");
  assert.ok(switched, "switch-client was invoked");
  assert.deepEqual(switched, ["switch-client", "-c", "work", "-t", "proj"]);
});

test("jumpToAgent: refuses when the pane can't be verified", () => {
  const { run } = fakeRunner({});
  const r = jumpToAgent(agent(), {
    run,
    inTmux: true,
    resolveEntry: () => entry(),
    verifyPane: () => null, // pid reused / pane gone
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /couldn't verify/);
});

test("jumpToAgent: agent gone from registry", () => {
  const { run } = fakeRunner({});
  const r = jumpToAgent(agent(), { run, inTmux: true, resolveEntry: () => null });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no longer in the registry/);
});

test("jumpToAgent: outside tmux yields a manual command", () => {
  const { run } = fakeRunner({ "list-panes": "%7\tproj\t@2\n" });
  const r = jumpToAgent(agent(), {
    run,
    inTmux: false,
    resolveEntry: () => entry(),
    verifyPane: () => "%7",
  });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.match(r.reason, /not running inside tmux/);
    assert.match(r.manual!, /tmux attach -t 'proj'/);
  }
});

test("jumpToAgent: refuses (no mutation) when the client choice is ambiguous", () => {
  const { run, calls } = fakeRunner({
    "list-panes": "%7\tproj\t@2\n",
    "list-clients": "self\t/t0\toxpit\nwork1\t/t1\tproj\nwork2\t/t2\tother\n",
    "display-message": "self",
  });
  const r = jumpToAgent(agent(), {
    run,
    inTmux: true,
    resolveEntry: () => entry(),
    verifyPane: () => "%7",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /multiple attached clients/);
  // Crucially, it must NOT have mutated tmux before refusing.
  assert.ok(!calls.some((c) => c[0] === "select-pane" || c[0] === "switch-client"));
});

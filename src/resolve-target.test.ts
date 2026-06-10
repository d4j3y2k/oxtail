// Unit tests for peer target resolution — specifically the v0.18 bootstrap
// rules: the caller is excluded from name-target ambiguity, and a sole
// unclaimed peer resolves to a routable (pid-addressed) entry instead of the
// caller being told its own session_id is the only candidate.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { register, type RegistryEntry } from "./registry.js";
import { resolveTarget } from "./resolve-target.js";

function withTempHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-resolve-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function entryFor(o: {
  pid: number;
  sid: string | null;
  tmux: string;
  cwd: string;
}): RegistryEntry {
  return {
    server_pid: o.pid,
    started_at: Math.floor(Date.now() / 1000),
    client: {
      type: o.sid ? "claude-code" : "codex",
      session_id: o.sid,
      transcript_path: null,
      session_id_source: "self-register",
      cwd: o.cwd,
    },
    tmux_pane: null,
    tmux_session: o.tmux,
    state: null,
  };
}

const CALLER_SID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeffff0000";

test("resolve: sole unclaimed peer in a shared tmux session resolves (bootstrap), self excluded", () => {
  withTempHome((home) => {
    // The live v0.17.1 failure shape: caller (claimed) + one unclaimed Codex
    // share tmux session 'shared'. Both candidates are on disk; the caller must
    // not count toward ambiguity, and the unclaimed peer must be routable.
    const caller = entryFor({ pid: process.pid, sid: CALLER_SID, tmux: "shared", cwd: home });
    register(caller);
    const unclaimed = entryFor({ pid: process.ppid, sid: null, tmux: "shared", cwd: home });
    register(unclaimed);

    const out = resolveTarget("shared", caller);
    assert.ok(out.ok, `expected ok, got ${JSON.stringify(out)}`);
    assert.equal(out.entry.server_pid, process.ppid);
    assert.equal(out.entry.client.session_id, null, "bootstrap target is unclaimed");
  });
});

test("resolve: name matching ONLY the caller reports self-send, not target-not-found", () => {
  withTempHome((home) => {
    const caller = entryFor({ pid: process.pid, sid: CALLER_SID, tmux: "lonely", cwd: home });
    register(caller);
    const out = resolveTarget("lonely", caller);
    assert.ok(!out.ok);
    assert.equal(out.error, "self-send");
  });
});

test("resolve: a dual-scope sibling sharing the caller's session_id is self, not a peer", () => {
  withTempHome((home) => {
    // Same agent, second MCP child (user-scope + project-scope config): same
    // session_id under a different pid must be excluded exactly like self.
    const caller = entryFor({ pid: process.pid, sid: CALLER_SID, tmux: "dual", cwd: home });
    register(caller);
    register(entryFor({ pid: process.ppid, sid: CALLER_SID, tmux: "dual", cwd: home }));
    const out = resolveTarget("dual", caller);
    assert.ok(!out.ok);
    assert.equal(out.error, "self-send");
  });
});

test("resolve: two non-self unclaimed peers stay ambiguous with the claim_session note", () => {
  withTempHome((home) => {
    const caller = entryFor({ pid: 999_999_1, sid: CALLER_SID, tmux: "crowded", cwd: home });
    // Two ALIVE unclaimed candidates (runner + parent); caller itself is not on
    // disk and not alive — irrelevant, callers aren't liveness-checked.
    register(entryFor({ pid: process.pid, sid: null, tmux: "crowded", cwd: home }));
    register(entryFor({ pid: process.ppid, sid: null, tmux: "crowded", cwd: home }));
    const out = resolveTarget("crowded", caller);
    assert.ok(!out.ok);
    assert.equal(out.error, "ambiguous-target");
    assert.match(out.note ?? "", /2 peer\(s\)/);
  });
});

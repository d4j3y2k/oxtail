// Unit tests for the sticky-claim store. Ancestor chains are synthetic and
// recovery deps are injected, so these are deterministic and don't depend on
// real ps output or the registry.

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimsDir,
  gcStaleClaims,
  recoverClaim,
  writeClaim,
  type Ancestor,
} from "./claims.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-claims-"));
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

const host: Ancestor = { pid: 4242, sig: "Sun May 31 04:33:05 2026" };
const launcherA: Ancestor = { pid: 111, sig: "launcher-a" };
const launcherB: Ancestor = { pid: 222, sig: "launcher-b" };
const now = () => Math.floor(Date.now() / 1000);

function makeTranscript(home: string, name = "rollout.jsonl"): string {
  const p = join(home, name);
  writeFileSync(p, "{}\n");
  return p;
}

test("claims: recovers through a different launcher when the host ancestor is shared", () => {
  withHome((home) => {
    const t = makeTranscript(home);
    writeClaim({
      client_type: "codex",
      cwd: "/repo",
      ancestors: [launcherA, host], // claimed under launcher A
      session_id: "sess-1",
      transcript_path: t,
      server_pid: 111,
      claimed_at: now(),
    });
    // Restart under a *different* launcher but the same host.
    const rec = recoverClaim("codex", "/repo", [launcherB, host]);
    assert.ok(rec, "should recover via the shared host ancestor");
    assert.equal(rec!.session_id, "sess-1");
    assert.equal(rec!.transcript_path, t);
  });
});

test("claims: no shared ancestor does not recover", () => {
  withHome((home) => {
    const t = makeTranscript(home);
    writeClaim({
      client_type: "codex",
      cwd: "/repo",
      ancestors: [launcherA, host],
      session_id: "sess-1",
      transcript_path: t,
      server_pid: 111,
      claimed_at: now(),
    });
    const rec = recoverClaim("codex", "/repo", [{ pid: 9999, sig: "x" }, { pid: 8888, sig: "y" }]);
    assert.equal(rec, null);
  });
});

test("claims: shared pid with a different signature (pid reuse) does not recover", () => {
  withHome((home) => {
    const t = makeTranscript(home);
    writeClaim({
      client_type: "codex",
      cwd: "/repo",
      ancestors: [host],
      session_id: "sess-1",
      transcript_path: t,
      server_pid: 111,
      claimed_at: now(),
    });
    const rec = recoverClaim("codex", "/repo", [{ pid: host.pid, sig: "Mon Jun 01 09:00:00 2026" }]);
    assert.equal(rec, null);
  });
});

test("claims: a missing transcript aborts recovery", () => {
  withHome((home) => {
    const gone = join(home, "never-created.jsonl");
    writeClaim({
      client_type: "codex",
      cwd: "/repo",
      ancestors: [host],
      session_id: "sess-1",
      transcript_path: gone,
      server_pid: 111,
      claimed_at: now(),
    });
    assert.equal(recoverClaim("codex", "/repo", [host]), null);
  });
});

test("claims: no record returns null", () => {
  withHome(() => {
    assert.equal(recoverClaim("codex", "/repo", [host]), null);
  });
});

test("claims: true tie between two matching sessions abstains", () => {
  withHome((home) => {
    const t1 = makeTranscript(home, "r1.jsonl");
    const t2 = makeTranscript(home, "r2.jsonl");
    const claimedAt = now();
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [launcherA, host],
      session_id: "sess-A", transcript_path: t1, server_pid: 1, claimed_at: claimedAt,
    });
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [launcherB, host],
      session_id: "sess-B", transcript_path: t2, server_pid: 2, claimed_at: claimedAt,
    });
    // Both share only `host` at the same depth with the same recency.
    assert.equal(recoverClaim("codex", "/repo", [host]), null);
  });
});

test("claims: stronger ancestry overlap wins over a newer weaker match", () => {
  withHome((home) => {
    const tWeak = makeTranscript(home, "weak.jsonl");
    const tStrong = makeTranscript(home, "strong.jsonl");
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [host],
      session_id: "weak", transcript_path: tWeak, server_pid: 1, claimed_at: now() + 100,
    });
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [launcherA, host],
      session_id: "strong", transcript_path: tStrong, server_pid: 2, claimed_at: now(),
    });

    const rec = recoverClaim("codex", "/repo", [launcherA, host]);
    assert.equal(rec?.session_id, "strong");
  });
});

test("claims: nearest current ancestor wins when overlap count ties", () => {
  withHome((home) => {
    const tNear = makeTranscript(home, "near.jsonl");
    const tFar = makeTranscript(home, "far.jsonl");
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [host],
      session_id: "far", transcript_path: tFar, server_pid: 1, claimed_at: now() + 100,
    });
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [launcherA],
      session_id: "near", transcript_path: tNear, server_pid: 2, claimed_at: now(),
    });

    const rec = recoverClaim("codex", "/repo", [launcherA, host]);
    assert.equal(rec?.session_id, "near");
  });
});

test("claims: distinct sessions tied on live-overlap abstain (recency is not identity, H1)", () => {
  withHome((home) => {
    const tOld = makeTranscript(home, "old.jsonl");
    const tNew = makeTranscript(home, "new.jsonl");
    // Two distinct sessions that overlap the live chain ONLY on the shared host,
    // at the same depth — identical overlap_count and nearest_overlap_current.
    // They differ only by recency, which says nothing about which child this is.
    // (Recent claimed_at so neither is GC'd as too-old by the write path.)
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [host],
      session_id: "old", transcript_path: tOld, server_pid: 1, claimed_at: now(),
    });
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [host],
      session_id: "new", transcript_path: tNew, server_pid: 2, claimed_at: now() + 50,
    });
    // Must abstain rather than adopt the newer session — adopting either risks
    // cross-session misrouting.
    assert.equal(recoverClaim("codex", "/repo", [host]), null);
  });
});

test("claims: distinct sessions sharing only a login-shell at different depths abstain (H1)", () => {
  withHome((home) => {
    const t1 = makeTranscript(home, "r1.jsonl");
    const t2 = makeTranscript(home, "r2.jsonl");
    // A login shell two sessions were both launched under. On restart each
    // session's own launcher re-spawned with a new pid and no longer overlaps,
    // so the live child overlaps BOTH stored claims only on this shared shell —
    // but at DIFFERENT record-side depths (0 vs 1).
    const loginShell: Ancestor = { pid: 5000, sig: "Sun May 31 04:00:00 2026" };
    writeClaim({
      client_type: "codex", cwd: "/repo",
      ancestors: [loginShell], // shell at record-depth 0
      session_id: "sess-A", transcript_path: t1, server_pid: 1, claimed_at: now() + 50,
    });
    writeClaim({
      client_type: "codex", cwd: "/repo",
      ancestors: [{ pid: 6001, sig: "dead-launcher-b" }, loginShell], // shell at record-depth 1
      session_id: "sess-B", transcript_path: t2, server_pid: 2, claimed_at: now(),
    });
    // Both score overlap_count=1, nearest_overlap_current=0; they differ only on
    // nearest_overlap_record (0 vs 1) — not a meaningful signal. Must abstain.
    assert.equal(recoverClaim("codex", "/repo", [loginShell]), null);
  });
});

test("claims: two sessions under different hosts each recover their own", () => {
  withHome((home) => {
    const t1 = makeTranscript(home, "r1.jsonl");
    const t2 = makeTranscript(home, "r2.jsonl");
    const hostA: Ancestor = { pid: 100, sig: "host-a" };
    const hostB: Ancestor = { pid: 200, sig: "host-b" };
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [hostA],
      session_id: "sess-A", transcript_path: t1, server_pid: 1, claimed_at: now(),
    });
    writeClaim({
      client_type: "codex", cwd: "/repo", ancestors: [hostB],
      session_id: "sess-B", transcript_path: t2, server_pid: 2, claimed_at: now(),
    });
    assert.equal(recoverClaim("codex", "/repo", [hostA])!.session_id, "sess-A");
    assert.equal(recoverClaim("codex", "/repo", [hostB])!.session_id, "sess-B");
  });
});

test("claims: re-claim of the same session overwrites in place (one record per session)", () => {
  withHome((home) => {
    const t = makeTranscript(home);
    const base = {
      client_type: "codex" as const,
      cwd: "/repo",
      ancestors: [host],
      transcript_path: t,
      server_pid: 111,
      claimed_at: now(),
    };
    writeClaim({ ...base, session_id: "sess-1" });
    writeClaim({ ...base, session_id: "sess-1", server_pid: 222 }); // re-claim, new server_pid
    const files = readdirSync(claimsDir()).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1, "same session must overwrite, not accumulate");
    assert.equal(recoverClaim("codex", "/repo", [host])!.server_pid, 222);
  });
});

test("claims: gc removes transcript-gone and too-old records, keeps live ones", () => {
  withHome((home) => {
    const tLive = makeTranscript(home, "live.jsonl");
    const tGone = makeTranscript(home, "doomed.jsonl");
    writeClaim({
      client_type: "codex", cwd: "/live", ancestors: [{ pid: 1, sig: "a" }],
      session_id: "live", transcript_path: tLive, server_pid: 1, claimed_at: now(),
    });
    writeClaim({
      client_type: "codex", cwd: "/doomed", ancestors: [{ pid: 2, sig: "b" }],
      session_id: "doomed", transcript_path: tGone, server_pid: 2, claimed_at: now(),
    });
    writeClaim({
      client_type: "codex", cwd: "/old", ancestors: [{ pid: 3, sig: "c" }],
      session_id: "old", transcript_path: tLive, server_pid: 3,
      claimed_at: now() - 20 * 24 * 60 * 60, // 20 days ago > 14d max age
    });

    unlinkSync(tGone);
    gcStaleClaims();

    assert.ok(recoverClaim("codex", "/live", [{ pid: 1, sig: "a" }]), "live survives");
    assert.equal(recoverClaim("codex", "/doomed", [{ pid: 2, sig: "b" }]), null, "transcript-gone gc'd");
    assert.equal(recoverClaim("codex", "/old", [{ pid: 3, sig: "c" }]), null, "too-old gc'd");
  });
});

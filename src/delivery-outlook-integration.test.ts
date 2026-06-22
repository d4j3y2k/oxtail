import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CURRENT_CAPABILITIES, type RegistryEntry } from "./registry.js";
import { resolveSendWake } from "./wake.js";

// Integration: drives the REAL resolveSendWake against REAL ~/.oxtail/activity
// marker files (under a redirected HOME), exercising the wiring + the live
// readActivity FS read + the ageMs>=0 skew fix end-to-end — the layer the pure
// classifyDeliveryOutlook unit test can't reach. readActivity() resolves the
// marker via homedir(), which defers to $HOME on POSIX (the same contract the
// registry tests rely on), so a temp HOME isolates these cases from the real
// store. `node --test` runs each file in its own process, so the HOME swap can't
// leak into sibling test files; withTempHome also restores it per-case.

const SID = "deliv-outlook-it-1234"; // already [A-Za-z0-9_-]-safe → no key munging

function peer(sessionId: string | null): RegistryEntry {
  return {
    server_pid: 999999,
    started_at: 1_700_000_000,
    client: {
      type: "claude-code",
      session_id: sessionId,
      transcript_path: null,
      session_id_source: "env",
      cwd: "/tmp/x",
    },
    tmux_pane: null,
    tmux_session: null,
    state: null,
    capabilities: CURRENT_CAPABILITIES,
  };
}

async function withTempHome(fn: (home: string) => Promise<void>): Promise<void> {
  const prev = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "oxtail-deliv-home-"));
  process.env.HOME = home;
  try {
    await fn(home);
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
}

// ageMs>0 → mtime in the past; ageMs<0 → mtime in the FUTURE (clock skew).
function writeMarker(home: string, sessionId: string, status: string, ageMs = 0): void {
  const dir = join(home, ".oxtail", "activity");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, sessionId);
  writeFileSync(p, status);
  if (ageMs !== 0) {
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(p, t, t);
  }
}

test("[it] plain send to a claimed IDLE peer → stranded_until_read, and NO wake_status (mutual exclusion)", async () => {
  await withTempHome(async (home) => {
    writeMarker(home, SID, "idle");
    const r = await resolveSendWake(peer(SID), undefined, undefined);
    assert.equal(r.delivery_outlook, "stranded_until_read");
    assert.equal(r.wake_status, undefined);
    assert.equal(r.wake_reason, undefined);
  });
});

test("[it] plain send to a claimed HOOKLESS peer (no marker) → fires a wake, no advisory", async () => {
  await withTempHome(async () => {
    // A hookless peer (Codex) has no passive delivery, so a plain send is wake-or-never:
    // resolveSendWake now FIRES the wake instead of merely advising unknown_liveness.
    // peer() has tmux_pane:null, so the wake can't land a keystroke → skipped_no_target
    // (deterministic without live tmux) — the point is a wake_status, not an advisory.
    const r = await resolveSendWake(peer(SID), undefined, undefined);
    assert.equal(r.wake_reason, "hookless_default");
    assert.equal(r.wake_status, "skipped_no_target");
    assert.equal(r.delivery_outlook, undefined, "wakes instead of stranding silently");
  });
});

test("[it] plain send to a FRESH-BUSY peer → no outlook (empty result)", async () => {
  await withTempHome(async (home) => {
    // A real peer's "busy" marker is at least milliseconds old by the time a
    // sender reads it; use a clearly-positive age so we test the fresh-busy
    // branch and not the ageMs>=0 skew guard (a same-instant write can land a
    // marginally-future mtime — that case is covered by the SKEWED-BUSY test).
    writeMarker(home, SID, "busy", 2_000); // 2s old → unambiguously fresh-busy
    const r = await resolveSendWake(peer(SID), undefined, undefined);
    assert.equal(r.delivery_outlook, undefined);
    assert.equal(r.wake_status, undefined);
  });
});

test("[it] plain send to a STALE-BUSY peer (age > TTL) → stranded_until_read", async () => {
  await withTempHome(async (home) => {
    writeMarker(home, SID, "busy", 11 * 60 * 1000); // 11min old > 10min default TTL
    const r = await resolveSendWake(peer(SID), undefined, undefined);
    assert.equal(r.delivery_outlook, "stranded_until_read");
  });
});

test("[it] SKEWED-BUSY (future mtime, negative age) → stranded_until_read [ageMs>=0 fix, live FS]", async () => {
  await withTempHome(async (home) => {
    writeMarker(home, SID, "busy", -5 * 60 * 1000); // mtime 5min in the FUTURE
    const r = await resolveSendWake(peer(SID), undefined, undefined);
    assert.equal(r.delivery_outlook, "stranded_until_read");
  });
});

test("[it] wake:'off' on an idle peer → no outlook (deliberate fire-and-forget)", async () => {
  await withTempHome(async (home) => {
    writeMarker(home, SID, "idle");
    const r = await resolveSendWake(peer(SID), "off", undefined);
    assert.equal(r.delivery_outlook, undefined);
    assert.equal(r.wake_status, undefined);
  });
});

test("[it] UNCLAIMED peer (no session_id) → no outlook", async () => {
  await withTempHome(async () => {
    const r = await resolveSendWake(peer(null), undefined, undefined);
    assert.equal(r.delivery_outlook, undefined);
  });
});

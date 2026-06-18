import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Mailbox } from "../mailbox.js";
import type { RegistryEntry } from "../registry.js";
import { operatorWakeText, sendOperatorMessage, type OperatorTarget } from "./operator.js";

// Async-aware HOME isolation (the wake-throttle writes under ~/.oxtail).
async function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-op-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function entry(
  o: { session_id?: string | null; server_pid?: number; proc_sig?: string } = {},
): RegistryEntry {
  return {
    server_pid: o.server_pid ?? process.pid, // live by default
    started_at: 1,
    proc_sig: o.proc_sig,
    client: {
      type: "claude-code",
      session_id: o.session_id ?? "s1",
      transcript_path: null,
      session_id_source: "env",
      cwd: "/proj",
    },
    tmux_pane: "%1",
    tmux_session: "proj",
    state: null,
    capabilities: { mailbox: { session_keyed: true } },
  };
}

const TARGET: OperatorTarget = { session_id: "s1", server_pid: process.pid, short_id: "max" };

type DeliverArgs = {
  route: { session_id: string | null | undefined; server_pid: number; session_keyed: boolean };
  body: string;
  from: string | undefined;
  options: Record<string, unknown>;
};

function captureDeliver() {
  const calls: DeliverArgs[] = [];
  const deliver = ((route: DeliverArgs["route"], body: string, from: string | undefined, options: Record<string, unknown>) => {
    calls.push({ route, body, from, options });
    return { schema_version: 1, id: "abc123def456abcd", body, enqueued_at: 1 } as Mailbox;
  }) as never;
  return { calls, deliver };
}

test("sendOperatorMessage: delivers as origin=operator with NO from_session_id", async () => {
  await withHome(async () => {
    const { calls, deliver } = captureDeliver();
    const r = await sendOperatorMessage(TARGET, "ping", {}, {
      resolveEntry: () => entry(),
      deliver,
      wake: async () => "fired",
      nowMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.message_id, "abc123def456abcd");
    assert.equal(r.wake_status, "fired");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].from, undefined, "operator messages carry NO from_session_id");
    assert.equal(calls[0].options.origin, "operator");
    assert.equal(calls[0].options.operator_source, "oxpit");
    assert.equal(calls[0].route.session_id, "s1");
    assert.equal(calls[0].route.session_keyed, true);
  });
});

test("operatorWakeText: single-line 'oxpit msg:' preview, newlines flattened", () => {
  assert.equal(operatorWakeText("hello world"), "oxpit msg: hello world");
  assert.equal(operatorWakeText("multi\nline\nmsg"), "oxpit msg: multi line msg");
});

test("operatorWakeText: a normal paragraph-length message is delivered WHOLE (no truncation)", () => {
  // The exact failure mode from the bug report: ~280-char human message was chopped at
  // 240. It must now arrive in full in the pane, not as a preview.
  const para = "x".repeat(800);
  assert.equal(operatorWakeText(para), `oxpit msg: ${para}`, "under the cap → verbatim, no '…'");
});

test("operatorWakeText: over-cap message gets a self-describing, actionable marker (not a bare '…')", () => {
  const t = operatorWakeText("y".repeat(2000));
  assert.ok(t.startsWith("oxpit msg: "));
  assert.ok(!t.endsWith("…"), "no bare trailing-off ellipsis that reads like the operator stopped");
  assert.match(t, /truncated by oxpit/, "names oxpit as the truncator");
  assert.match(t, /read_my_messages/, "points the recipient at the durable full copy");
  assert.match(t, /\+\d+ chars/, "reports how much was dropped");
});

test("sendOperatorMessage: wake receives the oxpit-msg content line", async () => {
  await withHome(async () => {
    let wakeText: string | undefined;
    const r = await sendOperatorMessage(TARGET, "ping the team", {}, {
      resolveEntry: () => entry(),
      deliver: captureDeliver().deliver,
      wake: async (_p, t) => {
        wakeText = t;
        return "fired";
      },
      nowMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(wakeText, "oxpit msg: ping the team");
  });
});

test("sendOperatorMessage: empty body is refused", async () => {
  await withHome(async () => {
    const { deliver, calls } = captureDeliver();
    const r = await sendOperatorMessage(TARGET, "   ", {}, {
      resolveEntry: () => entry(),
      deliver,
      wake: async () => "fired",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /empty/);
    assert.equal(calls.length, 0, "nothing delivered");
  });
});

test("sendOperatorMessage: target no longer registered", async () => {
  await withHome(async () => {
    const { deliver } = captureDeliver();
    const r = await sendOperatorMessage(TARGET, "hi", {}, { resolveEntry: () => null, deliver });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /no longer registered/);
  });
});

test("sendOperatorMessage: dead target pid refused", async () => {
  await withHome(async () => {
    const { deliver } = captureDeliver();
    const r = await sendOperatorMessage(TARGET, "hi", {}, {
      resolveEntry: () => entry({ server_pid: 2_000_000_000 }),
      deliver,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /not alive/);
  });
});

test("sendOperatorMessage: refuses on proc_sig mismatch (pid-reuse guard)", async () => {
  await withHome(async () => {
    const { deliver, calls } = captureDeliver();
    // Registered proc_sig differs from the live reading ⇒ the pid was recycled to an
    // unrelated process; must refuse before delivering. The proc-sig reader is INJECTED
    // (returns a definite, different sig) so the guard is exercised deterministically
    // rather than depending on the ambient `ps` (a sandbox without ps reads empty →
    // inconclusive → the guard wouldn't fire, masking this case).
    const r = await sendOperatorMessage(TARGET, "hi", {}, {
      resolveEntry: () => entry({ proc_sig: "registered-sig" }),
      procSig: () => "live-sig-differs",
      deliver,
      wake: async () => "fired",
    });
    assert.equal(r.ok, false);
    assert.match(r.reason!, /recycled|proc_sig/);
    assert.equal(calls.length, 0, "nothing delivered to a recycled pid");
  });
});

test("sendOperatorMessage: inconclusive (empty) proc_sig reading delivers — deliberate fail-open", async () => {
  await withHome(async () => {
    const { deliver, calls } = captureDeliver();
    // A transient/failed proc-sig read (e.g. ps refused) is inconclusive, NOT a
    // mismatch. Policy (mirrors resolveTarget): let it through — the wake path
    // re-verifies the pane — rather than fail closed and drop a legitimate send.
    const r = await sendOperatorMessage(TARGET, "hi", {}, {
      resolveEntry: () => entry({ proc_sig: "registered-sig" }),
      procSig: () => "",
      deliver,
      wake: async () => "fired",
    });
    assert.equal(r.ok, true, "inconclusive proc_sig does not block delivery");
    assert.equal(calls.length, 1);
  });
});

test("sendOperatorMessage: wake:false delivers without waking", async () => {
  await withHome(async () => {
    let woke = false;
    const { deliver } = captureDeliver();
    const r = await sendOperatorMessage(TARGET, "hi", { wake: false }, {
      resolveEntry: () => entry(),
      deliver,
      wake: async () => {
        woke = true;
        return "fired";
      },
      nowMs: 1000,
    });
    assert.equal(r.ok, true);
    assert.equal(r.wake_status, "off");
    assert.equal(woke, false);
  });
});

test("sendOperatorMessage: persistent wake throttle suppresses a rapid repeat", async () => {
  await withHome(async () => {
    const deps = {
      resolveEntry: () => entry({ session_id: "s-throttle" }),
      deliver: captureDeliver().deliver,
      wake: async () => "fired" as const,
    };
    const t: OperatorTarget = { session_id: "s-throttle", server_pid: process.pid, short_id: "x" };
    const r1 = await sendOperatorMessage(t, "a", {}, { ...deps, nowMs: 1000 });
    assert.equal(r1.wake_status, "fired");
    const r2 = await sendOperatorMessage(t, "b", {}, { ...deps, nowMs: 2000 }); // within 5s
    assert.equal(r2.wake_status, "skipped_throttled");
    const r3 = await sendOperatorMessage(t, "c", {}, { ...deps, nowMs: 11_000 }); // past window
    assert.equal(r3.wake_status, "fired");
  });
});

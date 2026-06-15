// oxpit operator actions — human-authorized messages sent FROM the cockpit.
//
// TRUST MODEL (codex's design): oxpit is an operator UI, NOT an agent. An operator
// message carries from_session_id: undefined and origin: "operator" — NEVER a
// minted/sentinel session_id — so it can't spoof a peer or claim higher authority
// (origin is provenance, not authentication). It is ONE-WAY: recordReceived (inside
// deliverToPeer) gives the recipient a durable ledger entry for audit + comms-log
// visibility, but with no from_session_id there is no reply target, so the peer's
// reply_to_message fails closed. Delivery + wake reuse the SAME canonical stack as
// agent sends (deliverToPeer + wakeForSend + chooseVerifiedWakePane) — oxpit is a
// controller over canonical modules, not a second mailbox implementation.

import { createHash } from "node:crypto";
import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { deliverToPeer, type DeliveryRoute } from "../delivery.js";
import { isAlive, readAllPassive, type RegistryEntry } from "../registry.js";
import { wakeForSend, type WakeStatus } from "../wake.js";

export const OPERATOR_SOURCE = "oxpit";
export const NUDGE_TEXT =
  "Operator nudge from oxpit — check your mailbox (read_my_messages) and your current state/work.";

// Persistent per-target operator-wake throttle. oxpit may be a short-lived CLI, so
// the in-memory wakePeer debounce doesn't survive across invocations; this guards
// against accidental/scripted wake storms to one target. mtime is the source of
// truth (mirrors autowake/pending-ask). Best-effort — a store failure never blocks.
const WAKE_THROTTLE_MS = (() => {
  const v = Number(process.env.OXTAIL_OPERATOR_WAKE_THROTTLE_MS);
  return Number.isFinite(v) && v > 0 ? v : 5000;
})();

function throttleDir(): string {
  return join(homedir(), ".oxtail", "operator-wake");
}
function throttlePath(sessionId: string): string {
  return join(throttleDir(), createHash("sha256").update(sessionId).digest("hex").slice(0, 32));
}

// True ⇒ this target was woken too recently; SUPPRESS the wake (the message is
// still delivered). Stamps a fresh record when it allows the wake through.
function operatorWakeThrottled(sessionId: string | null, nowMs: number): boolean {
  if (!sessionId) return false; // unclaimed: no stable key to throttle on
  try {
    const p = throttlePath(sessionId);
    try {
      if (nowMs - statSync(p).mtimeMs < WAKE_THROTTLE_MS) return true;
    } catch {
      // no prior record — fall through and stamp one
    }
    mkdirSync(throttleDir(), { recursive: true, mode: 0o700 });
    writeFileSync(p, "", { mode: 0o600 });
    // Stamp mtime to nowMs (the supplied clock) so the freshness comparison is
    // consistent whether nowMs is wall-clock (prod) or injected (tests).
    const t = nowMs / 1000;
    try {
      utimesSync(p, t, t);
    } catch {
      // best effort — a failure only skews freshness by the real-vs-injected delta
    }
    return false;
  } catch {
    return false; // store unusable — don't block the wake
  }
}

export type OperatorTarget = {
  session_id: string | null;
  server_pid: number;
  short_id: string;
};

export type OperatorWakeOutcome = WakeStatus | "skipped_throttled" | "off";

export type OperatorSendResult = {
  ok: boolean;
  target_short_id: string;
  target_session_id: string | null;
  message_id?: string;
  wake_status?: OperatorWakeOutcome;
  unclaimed?: boolean;
  reason?: string;
};

// Re-resolve the target's CURRENT registry entry at action time (by session_id when
// claimed, else server_pid) — never trust a stale snapshot row.
function freshEntry(target: OperatorTarget): RegistryEntry | null {
  const all = readAllPassive();
  if (target.session_id) {
    const m = all.find((e) => e.client.session_id === target.session_id);
    if (m) return m;
  }
  return all.find((e) => e.server_pid === target.server_pid) ?? null;
}

export type SendDeps = {
  nowMs?: number;
  // injectable for tests
  resolveEntry?: (t: OperatorTarget) => RegistryEntry | null;
  deliver?: typeof deliverToPeer;
  wake?: (peer: RegistryEntry) => Promise<WakeStatus>;
};

// Send one human-authorized operator message to a target agent. wake defaults on
// (operator wants prompt pickup) but is busy-gated + throttled.
export async function sendOperatorMessage(
  target: OperatorTarget,
  body: string,
  opts: { wake?: boolean } = {},
  deps: SendDeps = {},
): Promise<OperatorSendResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const resolveEntry = deps.resolveEntry ?? freshEntry;
  const deliver = deps.deliver ?? deliverToPeer;
  const wake = deps.wake ?? wakeForSend;
  const base = { target_short_id: target.short_id, target_session_id: target.session_id };

  if (!body.trim()) return { ok: false, ...base, reason: "empty message" };
  const entry = resolveEntry(target);
  if (!entry) return { ok: false, ...base, reason: "target is no longer registered" };
  if (!isAlive(entry.server_pid)) {
    return { ok: false, ...base, reason: "target process is not alive" };
  }

  const route: DeliveryRoute = {
    session_id: entry.client.session_id,
    server_pid: entry.server_pid,
    session_keyed: entry.capabilities?.mailbox?.session_keyed ?? false,
  };
  const msg = deliver(route, body, undefined, {
    origin: "operator",
    operator_source: OPERATOR_SOURCE,
  });

  let wake_status: OperatorWakeOutcome;
  if (opts.wake === false) {
    wake_status = "off";
  } else if (operatorWakeThrottled(entry.client.session_id, nowMs)) {
    wake_status = "skipped_throttled";
  } else {
    wake_status = await wake(entry);
  }

  return {
    ok: true,
    ...base,
    target_session_id: entry.client.session_id,
    message_id: msg.id,
    wake_status,
    unclaimed: entry.client.session_id == null,
  };
}

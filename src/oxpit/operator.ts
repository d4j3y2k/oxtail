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
import { isAlive, processStartSig, readAllPassive, type RegistryEntry } from "../registry.js";
import { wakeForSend, type WakeStatus } from "../wake.js";

export const OPERATOR_SOURCE = "oxpit";
export const NUDGE_TEXT =
  "Operator nudge from oxpit — check your mailbox (read_my_messages) and your current state/work.";

// The wake line typed into the target's pane for an operator message. Unlike a peer
// wake (the generic "read_my_messages" nudge), this shows the operator's CONTENT so
// it reads like a direct message in the agent's session. Single-line (newlines
// would submit early in the agent's prompt) + truncated; the FULL body is delivered
// to the mailbox and remains in the comms-log.
const WAKE_PREVIEW_MAX = 240;
export function operatorWakeText(body: string): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > WAKE_PREVIEW_MAX ? oneLine.slice(0, WAKE_PREVIEW_MAX) + "…" : oneLine;
  return `oxpit msg: ${preview}`;
}

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

// Read-only: was this target woken within the throttle window? (Split from the
// stamp so we only stamp AFTER a wake actually fires — a failed/no-target wake must
// NOT suppress a retry seconds later. codex review #4.)
function recentlyWoken(sessionId: string | null, nowMs: number): boolean {
  if (!sessionId) return false; // unclaimed: no stable key to throttle on
  try {
    return nowMs - statSync(throttlePath(sessionId)).mtimeMs < WAKE_THROTTLE_MS;
  } catch {
    return false; // no record / store unusable — don't block the wake
  }
}

// Stamp the throttle (mtime = nowMs, the supplied clock, so freshness is consistent
// whether nowMs is wall-clock or injected). Called ONLY after a wake fired.
function stampWake(sessionId: string | null, nowMs: number): void {
  if (!sessionId) return;
  try {
    mkdirSync(throttleDir(), { recursive: true, mode: 0o700 });
    const p = throttlePath(sessionId);
    writeFileSync(p, "", { mode: 0o600 });
    const t = nowMs / 1000;
    try {
      utimesSync(p, t, t);
    } catch {
      // best effort
    }
  } catch {
    // store unusable — throttle silently degrades (best-effort posture)
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
  wake?: (peer: RegistryEntry, wakeText?: string) => Promise<WakeStatus>;
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
  // PID-reuse guard BEFORE delivery (codex HIGH): isAlive alone can pass for a pid
  // the OS recycled to an unrelated process; we must not write an operator message
  // into a stranger's route. Mirror resolveTarget — refuse on a positively-different
  // proc_sig. (Empty reading = transient ps failure → inconclusive, let it through;
  // the wake path re-verifies the pane anyway.)
  if (entry.proc_sig) {
    const liveSig = processStartSig(entry.server_pid);
    if (liveSig && liveSig !== entry.proc_sig) {
      return { ok: false, ...base, reason: "target pid was recycled (proc_sig mismatch)" };
    }
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
  } else if (recentlyWoken(entry.client.session_id, nowMs)) {
    wake_status = "skipped_throttled";
  } else {
    // Wake carries the message content ("oxpit msg: …") so it shows in the target's
    // pane, unlike the generic peer read_my_messages nudge.
    wake_status = await wake(entry, operatorWakeText(body));
    // Stamp the throttle ONLY when the wake actually fired, so a failed/no-target
    // wake leaves the door open for a retry.
    if (wake_status === "fired") stampWake(entry.client.session_id, nowMs);
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

// Self-heal watchdog — re-fire a missed wake from the recipient's own MCP server.
//
// The dropped-baton stall: a wake-intended message (a completion / reply / durable
// delegation) is DELIVERED to an idle peer, but the best-effort tmux send-keys wake
// misses (strict fresh-idle gate, suppressed Enter, hookless open loop). The peer
// then sits idle forever with an unread message and the fleet stalls until a human
// pokes it. Delivery is durable; only the LIVENESS nudge was lost.
//
// This closes the loop from the ONE process guaranteed alive exactly when the bug
// exists — the idle recipient's own MCP server. On each tick it scans the
// pending-wake registry (records written by senders whose wake wasn't confidently
// delivered) for messages addressed to itself; for any whose delivery RECEIPT still
// hasn't appeared, if it's genuinely idle it re-nudges its OWN pane so the mailbox
// drains. Strictly gated so dual-scope children, restarts, and crash-loops can't
// storm: a persistent per-session throttle, a per-record attempt cap, a grace
// settle window (so the normal wake goes first), and consume-on-receipt.
//
// Module DAG (no cycles): pending-wake (leaf) ← wake ← self-heal ← server.

import { readActivity, wakeForSend, ASK_PEER_WAKE_TEXT, type WakeStatus } from "./wake.js";
import { autowakeKillSwitchOff, type ActivitySnapshot } from "./autowake.js";
import { readDeliveryReceipt } from "./mailbox.js";
import type { RegistryEntry } from "./registry.js";
import { trace } from "./trace.js";
import {
  bumpAttempt,
  consumePendingWake,
  defaultPendingWakeDir,
  gcPendingWake,
  listPendingWakesForRecipient,
  recordPendingWake,
  selfWokeRecently,
  stampSelfWoke,
  SELF_WAKE_THROTTLE_MS,
  type LivePendingWake,
} from "./pending-wake.js";

function envPosInt(name: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// How often the recipient's server checks for its own stuck mail.
export const SELF_WAKE_INTERVAL_MS = envPosInt("OXTAIL_SELF_WAKE_INTERVAL_MS", 30 * 1000);
// Max self-wakes per record before giving up (a wedged agent that never drains, or a
// wake that can never land). After the cap the record ages out via TTL.
export const SELF_WAKE_CAP = envPosInt("OXTAIL_SELF_WAKE_CAP", 3);
// Don't re-nudge a record younger than this: the sender's ORIGINAL wake just fired,
// give it time to work (and to flip the recipient to busy) before we second-guess it.
export const SELF_WAKE_GRACE_MS = envPosInt("OXTAIL_SELF_WAKE_GRACE_MS", 15 * 1000);

// Bare-name "off" kill-switch (mirrors autowakeKillSwitchOff).
export function selfWakeKillSwitchOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.OXTAIL_SELF_WAKE ?? "").trim().toLowerCase() === "off";
}

// WakeStatuses that mean "a wake was intended but NOT confidently delivered" — the
// only ones worth a self-heal record. Excludes: "fired" (hooked, confident),
// "skipped_busy" (peer mid-turn — its hook delivers), "skipped_deduped" (a wake for
// this reply already fired), "disabled" (kill-switch — respect it), and the absence
// of a status entirely (a plain FYI send — passive mail that legitimately waits for
// the next turn; recording it would break that contract).
const UNDELIVERED_WAKE_STATUSES: ReadonlySet<WakeStatus> = new Set<WakeStatus>([
  "fired_unconfirmed",
  "skipped_no_fresh_idle",
  "skipped_no_target",
  "skipped_debounced",
  "skipped_rate_limited",
  "skipped_store_error",
]);

// Called by the SENDER at each wake-intended send seam (send_message /
// reply_to_message / complete_work). Records a pending-wake iff the wake was not
// confidently delivered, so the RECIPIENT's watchdog can retry it. Best-effort,
// never throws (recordPendingWake degrades to no-op on an unusable store).
export function recordWakeIntent(
  recipientSessionId: string | null,
  messageId: string,
  senderSessionId: string | null,
  wakeStatus: WakeStatus | undefined,
  nowMs: number = Date.now(),
): void {
  if (!wakeStatus || !UNDELIVERED_WAKE_STATUSES.has(wakeStatus)) return;
  recordPendingWake(defaultPendingWakeDir(), recipientSessionId, messageId, senderSessionId, nowMs);
}

// PURE session-level gate: given the recipient's own liveness + throttle state, are
// we allowed to self-wake right now? Per-record filtering (receipt / grace / cap)
// happens in runSelfHealTick. Kept pure so the whole decision matrix is unit-tested.
export function decideSelfHeal(i: {
  killSwitchOff: boolean;
  claimed: boolean;
  throttleElapsed: boolean;
  activity: ActivitySnapshot;
}): { act: boolean; reason: string } {
  if (i.killSwitchOff) return { act: false, reason: "disabled" };
  if (!i.claimed) return { act: false, reason: "unclaimed" };
  if (!i.throttleElapsed) return { act: false, reason: "throttled" };
  if (!i.activity) return { act: false, reason: "no_marker" }; // hookless (codex) — can't confirm idle
  if (i.activity.status !== "idle") return { act: false, reason: "not_idle" };
  if (i.activity.ageMs < 0) return { act: false, reason: "skew" }; // future-dated marker — don't trust
  return { act: true, reason: "self_heal" };
}

export type SelfHealDeps = {
  nowMs?: number;
  dir?: string;
  readActivity?: (sid: string | null) => ActivitySnapshot;
  hasReceipt?: (messageId: string) => boolean;
  wake?: (peer: RegistryEntry, wakeText?: string) => Promise<WakeStatus>;
  throttleMs?: number;
  graceMs?: number;
  cap?: number;
};

// One watchdog tick for `entry` (this server's own agent). Returns a small result
// for tracing/testing. Never throws — a broken store degrades to "did nothing".
export async function runSelfHealTick(
  entry: RegistryEntry,
  deps: SelfHealDeps = {},
): Promise<{ fired: boolean; reason: string }> {
  const nowMs = deps.nowMs ?? Date.now();
  const dir = deps.dir ?? defaultPendingWakeDir();
  const readAct = deps.readActivity ?? readActivity;
  const hasReceipt = deps.hasReceipt ?? ((id: string) => readDeliveryReceipt(id) != null);
  const wake = deps.wake ?? wakeForSend;
  const throttleMs = deps.throttleMs ?? SELF_WAKE_THROTTLE_MS;
  const graceMs = deps.graceMs ?? SELF_WAKE_GRACE_MS;
  const cap = deps.cap ?? SELF_WAKE_CAP;

  const sid = entry.client.session_id;
  if (!sid) return { fired: false, reason: "unclaimed" }; // pre-claim window — skip
  // Honor BOTH the dedicated self-heal switch and the global auto-wake switch, so an
  // operator who silenced auto-wakes isn't surprised by self-heal nudges. (The
  // ASK_PEER_WAKE_STRATEGY=off switch is enforced deeper, in wakeForSend→wakePeer.)
  if (selfWakeKillSwitchOff() || autowakeKillSwitchOff()) return { fired: false, reason: "disabled" };

  gcPendingWake(dir, nowMs); // opportunistic cleanup of aged-out records (any recipient)

  const recs = listPendingWakesForRecipient(dir, sid, nowMs);
  if (recs.length === 0) return { fired: false, reason: "no_records" };

  // Consume delivered records (receipt present); collect the rest that are eligible
  // for a re-nudge — undelivered, past the grace settle window (so the sender's own
  // wake had its chance and the recipient would already be busy if it worked), and
  // under the attempt cap.
  const eligible: LivePendingWake[] = [];
  for (const r of recs) {
    if (hasReceipt(r.messageId)) {
      consumePendingWake(dir, sid, r.messageId); // landed — done, no wake
      continue;
    }
    if (r.ageS * 1000 < graceMs) continue; // too fresh — let the normal wake work first
    if (r.attempts >= cap) continue; // gave up on this one (TTL will reclaim it)
    eligible.push(r);
  }
  if (eligible.length === 0) return { fired: false, reason: "nothing_eligible" };

  const decision = decideSelfHeal({
    killSwitchOff: false, // already short-circuited above
    claimed: true,
    throttleElapsed: !selfWokeRecently(sid, nowMs, throttleMs),
    activity: readAct(sid),
  });
  if (!decision.act) return { fired: false, reason: decision.reason };

  // FIRE ONCE. Stamp the throttle BEFORE the keystrokes (single-winner claim vs a
  // sibling MCP child), then nudge our OWN pane so read_my_messages drains the mail.
  stampSelfWoke(sid, nowMs);
  let status: WakeStatus;
  try {
    status = await wake(entry, ASK_PEER_WAKE_TEXT);
  } catch (e) {
    // wakeForSend catches its own fire errors, but honor the "never throws" contract
    // regardless so a rejection can't escape a bare setInterval callback.
    trace("self_heal_wake_error", { session_id: sid, error: String(e) });
    return { fired: false, reason: "wake_error" };
  }
  // Count an attempt against the cap ONLY when keystrokes actually landed — a wake
  // that provably did nothing (skipped_busy: peer mid-turn will drain on its own;
  // skipped_no_target: pane churn; disabled) must not burn the retry budget or claim
  // to have fired. The TTL still bounds a wake that can never land.
  const fired = status === "fired" || status === "fired_unconfirmed";
  if (fired) for (const r of eligible) bumpAttempt(dir, sid, r.messageId, nowMs);
  trace("self_heal_wake", { session_id: sid, records: eligible.length, wake_status: status, fired });
  return { fired, reason: status };
}

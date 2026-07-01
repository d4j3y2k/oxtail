// Waiter-heal watchdog — re-poke a SILENT delegated peer from the waiter's own
// server (scenario B: the peer never replies at all).
//
// The sibling of self-heal (src/self-heal.ts). Where self-heal fixes a MISSED WAKE
// on a message already delivered to an idle recipient (the recipient re-nudges its
// OWN pane), this fixes the OTHER stall: A delegates work to B (ask_peer, or a
// durable action_required), goes idle, and B never produces a result — because the
// delegation's wake missed (B still hasn't seen it) OR B stalled / dropped it after
// receiving it. The delegation is durably delivered and A holds a durable EXPECTATION
// (pending-ask, extended in Phase 1); A's OWN server — the one process guaranteed
// alive while A is the blocked party — scans those expectations and, past a grace
// LONGER than self-heal's whole retry window, re-pokes B's pane so B drains the
// delegation and acts.
//
// TWO-PHASE off the delivery RECEIPT (readDeliveryReceipt, already built):
//   PRE-receipt  → B may never have gotten it: a MISSED WAKE we can fix → re-poke B.
//   POST-receipt → B HAS it in context but hasn't replied: we cannot distinguish
//                  "still working" from "dropped it" in-band, so we STOP poking (a
//                  keystroke is pointless) and leave it for the operator surface
//                  (oxpit ⚑, Phase 6, which reads the same expectation record).
//
// SAFETY (this INVERTS self-heal's self-targeting property — codex/max review):
// a re-poke is a BLIND cross-agent keystroke into ANOTHER agent's pane on a timer,
// so it is gated hard —
//   * L2 verified resolver at fire time: wakeForSend → wakePeer → chooseVerifiedWakePane
//     resolves B's pane from the LIVE process tree (never a cached/self-written pane),
//     with the proc_sig/pid-reuse guard, and refuses if unverifiable. The expectation
//     record NEVER stores a pane. So a re-poke is the SAME trust path ask_peer already
//     uses cross-agent — not new attack surface.
//   * target-ALIVE probe: resolveTarget refuses a dead / pid-reused / out-of-scope /
//     ambiguous peer → we don't hammer a corpse (that path escalates to the operator).
//   * B's own fresh-busy gate: wakeForSend skips a mid-turn (fresh-busy) hooked B
//     (skipped_busy) so we never garble a composer; a hookless B falls through to a
//     bounded blind fire, exactly the accepted hookless_default posture.
//   * bounded: a persistent per-TARGET throttle (single-winner across dual-scope
//     sibling children AND across multiple waiters on the same B), a grace settle
//     window (self-heal goes first), a per-record attempt cap, and the kill-switches.
//   * STOP conditions: a correlated reply in A's ledger, a delivery receipt, cap
//     reached, or target gone.
//
// Module DAG (no cycles): pending-ask/wake/resolve-target/received (leaves) ← waiter-heal ← server.

import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { autowakeKillSwitchOff } from "./autowake.js";
import { readDeliveryReceipt } from "./mailbox.js";
import {
  bumpPendingAskAttempt,
  consumePendingAsk,
  defaultPendingAskDir,
  gcPendingAsk,
  listPendingAsksForOwner,
  type LivePendingAsk,
} from "./pending-ask.js";
import { listLedgerReplyTargets } from "./received.js";
import type { RegistryEntry } from "./registry.js";
import { resolveTarget } from "./resolve-target.js";
import { selfWakeKillSwitchOff } from "./self-heal.js";
import { trace } from "./trace.js";
import { wakeForSend, type WakeStatus } from "./wake.js";

function envPosInt(name: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// How often the waiter's server checks for its own overdue delegations. Longer than
// self-heal's 30s: a re-poke is less urgent than a recipient draining its own mail,
// and the extra spacing keeps the cross-agent keystroke rate low.
export const WAITER_HEAL_INTERVAL_MS = envPosInt("OXTAIL_WAITER_HEAL_INTERVAL_MS", 60 * 1000);
// Don't re-poke an expectation younger than this. TEMPORAL COORDINATION (no
// cross-process lock, honoring the no-daemon constraint): this MUST exceed
// recipient self-heal's whole retry window (SELF_WAKE_GRACE_MS 15s + SELF_WAKE_CAP 3
// × SELF_WAKE_INTERVAL_MS 30s ≈ 105s) so a HOOKED B fixes its own missed wake FIRST
// and the waiter only fires when self-heal COULDN'T (a hookless B, or a genuinely
// silent one). 4 min default leaves comfortable margin.
export const WAITER_HEAL_GRACE_MS = envPosInt("OXTAIL_WAITER_HEAL_GRACE_MS", 4 * 60 * 1000);
// Max re-pokes per expectation before giving up (→ the operator surface). Mirrors
// SELF_WAKE_CAP; a poke that provably did nothing does not burn the budget.
export const WAITER_HEAL_CAP = envPosInt("OXTAIL_WAITER_HEAL_CAP", 3);
// Min gap between re-pokes to the SAME target, persisted so it holds across dual-
// scope sibling children AND across distinct waiters on the same peer (one poke
// drains B's whole mailbox, so coalescing per-target is correct, not lossy).
export const WAITER_HEAL_THROTTLE_MS = envPosInt("OXTAIL_WAITER_HEAL_THROTTLE_MS", 90 * 1000);

// Honors BOTH the dedicated self-wake switch and the global auto-wake switch, so an
// operator who silenced auto-wakes isn't surprised by cross-agent re-pokes.
export function waiterHealKillSwitchOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return selfWakeKillSwitchOff(env) || autowakeKillSwitchOff(env);
}

// ── Persistent per-target re-poke throttle ────────────────────────────────────
// One re-poke per target-session per window, regardless of how many expectations
// reference it or how many waiter processes tick concurrently. Separate namespace
// from self-heal's ~/.oxtail/self-wake (that one is keyed on the OWN session's self-
// nudge; this is keyed on the TARGET we're poking) so the two never interfere. mtime
// is the source of truth. Best-effort; a store failure never blocks the poke.
function waiterWakeDir(): string {
  return join(homedir(), ".oxtail", "waiter-wake");
}
function waiterWakePath(targetSessionId: string): string {
  return join(waiterWakeDir(), createHash("sha256").update(targetSessionId).digest("hex").slice(0, 32));
}
export function waiterWokeRecently(
  targetSessionId: string,
  nowMs: number,
  throttleMs: number = WAITER_HEAL_THROTTLE_MS,
): boolean {
  try {
    return nowMs - statSync(waiterWakePath(targetSessionId)).mtimeMs < throttleMs;
  } catch {
    return false; // no record / store unusable — don't block the poke
  }
}
export function stampWaiterWoke(targetSessionId: string, nowMs: number): void {
  try {
    mkdirSync(waiterWakeDir(), { recursive: true, mode: 0o700 });
    const p = waiterWakePath(targetSessionId);
    writeFileSync(p, "", { mode: 0o600 });
    const t = nowMs / 1000;
    try {
      utimesSync(p, t, t);
    } catch {
      // best effort — mtime drives the throttle window
    }
  } catch {
    // store unusable — throttle silently degrades (best-effort posture)
  }
}

// A re-poke "did something" only when keystrokes actually landed. skipped_busy (B
// mid-turn — its hook/poll delivers), skipped_no_target (dead/churned pane),
// skipped_debounced, and disabled must NOT burn the attempt budget or claim to fire.
function isRealFire(status: WakeStatus): boolean {
  return status === "fired" || status === "fired_unconfirmed";
}

export type WaiterHealDeps = {
  nowMs?: number;
  dir?: string;
  hasReceipt?: (messageId: string) => boolean;
  ledgerReplyTargets?: (ownerSessionId: string) => string[];
  resolve?: (target: string, caller: RegistryEntry) => ReturnType<typeof resolveTarget>;
  wake?: (peer: RegistryEntry) => Promise<WakeStatus>;
  wokeRecently?: (targetSessionId: string, nowMs: number) => boolean;
  stampWoke?: (targetSessionId: string, nowMs: number) => void;
  graceMs?: number;
  cap?: number;
};

export type WaiterHealResult = {
  fired: number; // re-pokes whose keystrokes landed this tick
  consumed: number; // expectations satisfied (a reply arrived) and cleared
  gaveUp: number; // records at/over the cap (surfaced to the operator, not re-poked)
  targetGone: number; // records whose target is unresolvable (surfaced, not re-poked)
  reason: string;
};

// One watchdog tick for `entry` (this server's own agent, the WAITER). Never throws
// — a broken store / registry degrades to "did nothing", never worse than today.
export async function runWaiterHealTick(
  entry: RegistryEntry,
  deps: WaiterHealDeps = {},
): Promise<WaiterHealResult> {
  const empty = (reason: string): WaiterHealResult => ({
    fired: 0,
    consumed: 0,
    gaveUp: 0,
    targetGone: 0,
    reason,
  });
  const nowMs = deps.nowMs ?? Date.now();
  const dir = deps.dir ?? defaultPendingAskDir();
  const hasReceipt = deps.hasReceipt ?? ((id: string) => readDeliveryReceipt(id) != null);
  const ledgerReplies = deps.ledgerReplyTargets ?? listLedgerReplyTargets;
  const resolve = deps.resolve ?? resolveTarget;
  const wake = deps.wake ?? wakeForSend;
  const wokeRecently = deps.wokeRecently ?? waiterWokeRecently;
  const stampWoke = deps.stampWoke ?? stampWaiterWoke;
  const graceMs = deps.graceMs ?? WAITER_HEAL_GRACE_MS;
  const cap = deps.cap ?? WAITER_HEAL_CAP;

  const sid = entry.client.session_id;
  if (!sid) return empty("unclaimed"); // pre-claim window — no expectations to own
  if (waiterHealKillSwitchOff()) return empty("disabled");

  gcPendingAsk(dir, nowMs); // opportunistic cleanup of aged-out records (any owner)

  // My own expectations. A restarted owner shares its session_id, so its pre-crash
  // records surface here automatically (adopt-on-restart is a property of the
  // session-keyed store). Only the v0.32 waiter-shaped records (target + messageId)
  // are re-pokeable; a legacy bare pending-ask is left for the reply-consume path.
  const recs = listPendingAsksForOwner(dir, sid, nowMs).filter(
    (r): r is LivePendingAsk & { target: string; messageId: string } =>
      !!r.target && !!r.messageId,
  );
  if (recs.length === 0) return empty("no_records");

  // A correlated reply already in MY ledger means the expectation is satisfied —
  // consume it (STOP) regardless of everything else. Computed once per tick.
  const answered = new Set(ledgerReplies(sid));

  const res: WaiterHealResult = { fired: 0, consumed: 0, gaveUp: 0, targetGone: 0, reason: "ran" };
  for (const r of recs) {
    if (answered.has(r.requestId)) {
      if (consumePendingAsk(dir, sid, r.requestId)) res.consumed++;
      continue;
    }
    // Target-alive probe: never re-poke a dead / pid-reused / out-of-scope peer.
    const resolved = resolve(r.target, entry);
    if (!resolved.ok) {
      res.targetGone++; // surfaced to the operator via the record's live-but-unresolvable state
      trace("waiter_heal_target_gone", { owner: sid, target: r.target, error: resolved.error });
      continue;
    }
    if (hasReceipt(r.messageId)) {
      // POST-receipt: B has the delegation in context. A keystroke is pointless and
      // we cannot tell "working" from "dropped" in-band → stop poking; the operator
      // surface (oxpit) owns escalation by age. Do NOT consume (a late reply still will).
      continue;
    }
    // PRE-receipt: a missed wake we can fix. Re-poke, bounded.
    if (r.ageS * 1000 < graceMs) continue; // let self-heal / the original wake go first
    if (r.attempts >= cap) {
      res.gaveUp++; // gave up re-poking; surfaced to the operator (TTL reclaims the record)
      continue;
    }
    if (wokeRecently(r.target, nowMs)) continue; // per-target throttle + single-winner
    // FIRE. Stamp the throttle BEFORE the keystrokes (single-winner vs a sibling /
    // another waiter ticking now), then re-poke B's OWN pane via the verified resolver.
    stampWoke(r.target, nowMs);
    let status: WakeStatus;
    try {
      status = await wake(resolved.entry);
    } catch (e) {
      trace("waiter_heal_wake_error", { owner: sid, target: r.target, error: String(e) });
      continue;
    }
    if (isRealFire(status)) {
      bumpPendingAskAttempt(dir, sid, r.requestId, nowMs);
      res.fired++;
    }
    trace("waiter_heal_repoke", {
      owner: sid,
      target: r.target,
      request_id: r.requestId,
      message_id: r.messageId,
      wake_status: status,
      attempts: r.attempts + (isRealFire(status) ? 1 : 0),
    });
  }
  return res;
}

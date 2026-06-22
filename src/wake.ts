// The wake subsystem: every path that turns "a message landed for an idle
// peer" into tmux send-keys keystrokes, and every gate that decides whether
// those keystrokes should fire at all. Extracted from server.ts (which keeps
// the MCP tool registrations and the ask_peer wait orchestration); the
// behavior here is the v0.7→v0.15 lineage documented in README/AGENTS.md:
// per-client routing, process-tree-verified pane targeting (#6), debounce
// (#5), busy/idle activity gating, the strict wake-on-reply default, and the
// durable pending-ask pull-back.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  autowakeKillSwitchOff,
  type ActivitySnapshot,
  claimWake,
  decideReplyAutoWake,
  defaultAutowakeDir,
} from "./autowake.js";
import type { ClientType } from "./clients.js";
import { consumePendingAsk, defaultPendingAskDir } from "./pending-ask.js";
import { chooseVerifiedWakePane, type RegistryEntry } from "./registry.js";
import { trace } from "./trace.js";
import { markWoke, newWakeDebounceStore, recentlyWoke } from "./wake-debounce.js";
import { fireKeystrokes } from "./keystrokes.js";

// Typed into the peer's TUI as a synthetic prompt, so it lands in their context
// once per wake — kept terse. For HOOKED Claude Code the delivered envelope
// carries the full instruction, but Codex and hookless Claude peers only get raw
// mailbox JSON from read_my_messages — so the wake itself must preserve BOTH paths:
// an action_required item is a durable OBLIGATION the peer closes with
// complete_work/block_work (answering it with a plain send_message leaves the
// obligation OPEN forever — a stall codex hit live), while an ordinary message is
// answered with send_message. Per Codex Phase-D review + the action_required fix.
export const ASK_PEER_WAKE_TEXT =
  "oxtail msg: read_my_messages, then act on it — close action_required work via complete_work/block_work; otherwise reply via send_message (reply_to=request_id if present)";

// The Codex paste-burst gap (CODEX_SUBMIT_DELAY_MS) and the low-level fire
// primitive (fireKeystrokes) now live in ./keystrokes.ts, shared with the oxpit
// fleet executor; see that module for the paste-burst rationale + verification.

export type WakeStatus =
  | "fired"             // keystrokes sent to a HOOKED peer — its hooks are the delivery safety net; the wake is only an accelerator
  | "fired_unconfirmed" // keystrokes sent to a HOOKLESS peer (Codex / no activity marker): OPEN-LOOP — nothing passively delivers and submission is NOT confirmed (the paste-burst Enter can be suppressed). NOT proof of pickup; the durable obligation + the peer's next read_my_messages are the guarantee
  | "skipped_unsupported" // client_type cannot be woken externally (reserved — no client currently returns this in auto mode)
  | "skipped_no_target" // no tmux pane/session resolved, or send-keys failed everywhere
  | "skipped_busy"      // peer is mid-turn — skipped the keystroke; hooks/poll deliver (send_message wake:auto + ask_peer)
  | "skipped_no_fresh_idle"  // reply-default wake: target not freshly idle (stale/unknown/busy/unclaimed) — Slice 1
  | "skipped_rate_limited"   // reply-default wake: this target was auto-woken too recently — Slice 1
  | "skipped_deduped"        // reply-default wake: already auto-woke for this (session_id, reply_to) — Slice 1
  | "skipped_store_error"    // reply-default wake: dedupe/rate store unusable — best-effort degrade, message still enqueued — Slice 1
  | "skipped_debounced"      // a wake fired for this peer within the debounce window — coalesced (issue #5)
  | "disabled";         // OXTAIL_ASK_PEER_WAKE_STRATEGY=off, or reply-default wake with OXTAIL_AUTOWAKE=off

// Send-time delivery-outlook advisory (participant-error feedback). A SEND can
// be delivered yet never read, because a plain fire-and-forget message does not
// wake an idle peer — the silent stall this advisory exists to flag to the
// SENDER, in-context, at send time. Only the genuinely-silent send path carries
// it (see classifyDeliveryOutlook); every path that already returns a
// wake_status stays silent rather than re-encode that signal into a parallel
// vocabulary.
export type DeliveryOutlook =
  | "stranded_until_read"  // claimed idle/stale-busy peer: read only at its next turn or a wake
  | "unknown_liveness";    // claimed peer with no activity marker (Codex / hookless Claude)

// H2 — honest wake status. A successful keystroke send is a confident "fired" ONLY
// for a HOOKED peer: one with a session_id AND a live activity marker (its hooks
// passively deliver and are the safety net). Every OTHER fire is OPEN-LOOP — a
// hookless claimed peer (Codex / no marker) OR an unclaimed peer (no session_id,
// inherently hookless) — nothing delivers passively and we never confirm the
// paste-burst's Enter actually submitted, so report "fired_unconfirmed": keystrokes
// sent, pickup NOT confirmed. (`!activity` mirrors classifyDeliveryOutlook's hookless
// proxy; the `!sessionId` arm closes max N1 — an unclaimed wake is open-loop too.)
// Pure so it is unit-testable without a live pane.
export function honestFireStatus(
  sessionId: string | null | undefined,
  activity: ActivitySnapshot,
): WakeStatus {
  return !sessionId || !activity ? "fired_unconfirmed" : "fired";
}

// OXTAIL_ASK_PEER_WAKE_STRATEGY = "auto" | "legacy" | "off"
//   auto    — per-client routing: Codex gets paste-burst-aware wake (500ms gap
//             between text and Enter); Claude Code gets legacy send-keys with
//             no gap; unknown clients get legacy v0.6 behavior.
//   legacy  — v0.6 behavior for every client (text + Enter, no gap, no
//             per-client routing). Escape hatch if auto mode misfires.
//   off     — wake disabled entirely; ask_peer becomes a blocking poll.
//             Caller can rely solely on the peer's natural turn cadence.
const ASK_PEER_WAKE_STRATEGY: "auto" | "legacy" | "off" = (() => {
  const v = (process.env.OXTAIL_ASK_PEER_WAKE_STRATEGY ?? "auto").toLowerCase();
  if (v === "auto" || v === "legacy" || v === "off") return v;
  return "auto";
})();

// Wake routing. The wake's job is to nudge an idle peer into a turn so it
// drains its mailbox. Mechanics differ per client:
//
//   Codex — `tmux send-keys -l <text>` followed by `send-keys Enter` would
//   work, EXCEPT Codex's paste-burst heuristic suppresses Enter for 120ms
//   after a fast typing burst (codex-rs/tui/src/bottom_pane/paste_burst.rs).
//   fireKeystrokes (./keystrokes.ts) inserts CODEX_SUBMIT_DELAY_MS between the
//   text and the Enter so the suppression window expires. Verified live 2026-05-13.
//
//   Claude Code — `tmux send-keys -l <text>` + immediate `send-keys Enter`,
//   no inter-keystroke gap. The Claude Code TUI has no paste-burst heuristic
//   that suppresses Enter, so the legacy v0.6 sequence works as-is. v0.7
//   originally shipped a fail-fast here, reasoning from the hook catalog
//   ("no idle hook" → "unwakeable") — but send-keys is a TUI-input
//   mechanism, not a hook, and it submits to the prompt the same way a
//   human keypress would. Restored to symmetric wake 2026-05-13 after an
//   end-to-end falsifying experiment against the live `oxtail-claudejr`
//   peer in this repo (ask_peer enqueue → manual send-keys → claudejr
//   entered a turn, drained mailbox via PreToolUse hook, replied via
//   send_message; round-trip confirmed).
//
//   Unknown — legacy v0.6 behavior (text + Enter, no gap). No implied
//   promise; if a new TUI lands and breaks, we treat it as unknown until
//   verified.
//
// askPeerWakeImpl keeps a generic pane→sessionName retry for its own unit
// tests, but PRODUCTION wakePeer now passes only the process-tree-verified pane
// (sessionName = null): a self-written tmux_session is not a trustworthy
// send-keys target (issue #6), and pane-id churn is handled by re-resolving the
// pane from server_pid on every wake rather than by a session fallback.
// Exported for unit testing the retry path; production callers use wakePeer
// which wires fireKeystrokes (./keystrokes.ts) via routing.
export async function askPeerWakeImpl(
  pane: string | null,
  sessionName: string | null,
  fire: (target: string) => void | Promise<void>,
): Promise<boolean> {
  if (!pane && !sessionName) {
    trace("ask_peer_wake_skipped", { reason: "no-pane-or-session" });
    return false;
  }
  const primary = pane ?? sessionName!;
  try {
    await fire(primary);
    trace("ask_peer_wake_fired", { target: primary });
    return true;
  } catch (e) {
    trace("ask_peer_wake_failed", { target: primary, error: String(e) });
  }
  if (pane && sessionName && pane !== sessionName) {
    try {
      await fire(sessionName);
      trace("ask_peer_wake_fired_retry", { target: sessionName });
      return true;
    } catch (e) {
      trace("ask_peer_wake_failed_retry", { target: sessionName, error: String(e) });
    }
  }
  return false;
}

// In-memory per-process wake-debounce state, keyed by peer session_id. Coalesces
// rapid repeat wakes to the same peer across all wake paths (issue #5).
const wakeDebounce = newWakeDebounceStore();

// Route a wake to a peer based on OXTAIL_ASK_PEER_WAKE_STRATEGY and the
// peer's client_type. Returns the wake_status that should surface in the
// response so callers can distinguish "we tried, no answer" from "we didn't
// try because the client can't be woken."
export async function wakePeer(
  peer: RegistryEntry,
  wakeText: string = ASK_PEER_WAKE_TEXT,
): Promise<WakeStatus> {
  if (ASK_PEER_WAKE_STRATEGY === "off") {
    trace("ask_peer_wake_skipped", { reason: "strategy-off" });
    return "disabled";
  }
  const clientType: ClientType = peer.client.type;
  // #5: coalesce a rapid repeat wake to the same peer (concurrent/retried
  // ask_peer, polling loops) so we don't stack a second notification line into
  // its composer. Keyed on session_id; an unclaimed peer (no id) isn't debounced.
  const sid = peer.client.session_id;
  if (sid && recentlyWoke(wakeDebounce, sid, Date.now())) {
    trace("ask_peer_wake_skipped", { reason: "debounced", target_session_id: sid });
    return "skipped_debounced";
  }
  // Security (#6): tmux_pane / tmux_session come from the peer's OWN registry
  // file, so a malicious local peer could point them at someone else's pane or
  // session to redirect our wake keystrokes. The ONLY trustworthy send-keys
  // target is the pane the live process tree says currently hosts the peer's
  // server_pid — chooseVerifiedWakePane resolves that and refuses (returns null)
  // when it can't be verified, instead of falling back to the self-written
  // cached pane or tmux_session. This also subsumes the old stale-pane re-
  // resolution race fix: we ALWAYS use the freshly process-tree-resolved pane.
  const verifiedPane = chooseVerifiedWakePane(peer);
  if (!verifiedPane) {
    trace("ask_peer_wake_skipped", {
      reason: "no-verified-pane",
      cached: peer.tmux_pane,
      server_pid: peer.server_pid,
      target_session_id: peer.client.session_id,
    });
    return "skipped_no_target";
  }
  if (verifiedPane !== peer.tmux_pane) {
    trace("ask_peer_wake_pane_refreshed", {
      cached: peer.tmux_pane,
      live: verifiedPane,
      server_pid: peer.server_pid,
    });
  }
  // Legacy mode bypasses per-client routing: every wake is the v0.6 sequence
  // (no inter-keystroke delay). Cast to "unknown" so fireKeystrokes skips the
  // Codex delay branch.
  const fireType: ClientType = ASK_PEER_WAKE_STRATEGY === "legacy" ? "unknown" : clientType;
  const fire = (target: string) => fireKeystrokes(target, fireType, wakeText);
  // #5: stamp the debounce BEFORE the (possibly async, paste-burst-delayed) fire
  // so a concurrent second wakePeer for this peer — which runs while we're
  // awaiting send-keys — sees the stamp and coalesces instead of double-firing.
  if (sid) markWoke(wakeDebounce, sid, Date.now());
  // No session-name fallback: a self-written tmux_session could target another
  // session, and the verified pane already handles pane-id churn. Pass null.
  const ok = await askPeerWakeImpl(verifiedPane, null, fire);
  if (!ok && sid) {
    // The fire failed (e.g. the pane vanished between verification and the
    // send-keys), so no keystroke landed. Clear the debounce stamp set pre-fire
    // above — otherwise a genuine retry within WAKE_DEBOUNCE_MS is suppressed as
    // "debounced" even though the peer was never actually woken (M1). The
    // pre-stamp only needs to survive a SUCCESSFUL fire's async paste gap.
    //
    // KNOWN RESIDUAL (accepted, v0.17.1 review): for a Codex peer the fire
    // awaits a paste-burst gap, so a concurrent wakePeer can read the stamp and
    // return skipped_debounced DURING that await; if this fire then fails and
    // clears the stamp, neither call woke the peer. The alternative — stamping
    // only after a successful fire — opens a double-fire window where two
    // interleaved text+Enter send-keys garble the peer's composer, which is
    // strictly worse than this rare missed wake (the message is enqueued either
    // way and delivers at the peer's next turn). Claude fires are fully
    // synchronous, so they cannot interleave here.
    wakeDebounce.delete(sid);
  }
  if (!ok) return "skipped_no_target";
  // H2: keystrokes landed, but only a HOOKED peer's "fired" implies likely pickup;
  // a hookless peer (Codex) has no passive delivery and no submit confirmation, so
  // report it open-loop. See honestFireStatus.
  return honestFireStatus(sid, readActivity(sid));
}

// --- send_message wake:auto gating -------------------------------------------
// A peer marks itself "busy" (UserPromptSubmit hook) / "idle" (Stop hook) in
// ~/.oxtail/activity/<session_id>. send_message wake:auto reads that so it never
// types into a peer that's mid-turn — the peer's PreToolUse/Stop hooks deliver
// during the turn, so a send-keys wake is only useful when the peer is idle.
// Keyed by session_id (the agent identity), NOT server_pid: a dual-scope agent
// has several MCP children sharing one session_id, and the hooks/sender must
// agree on the key (see AGENTS.md). Must match the sanitization in the hooks.
// How long a "busy" marker is trusted before a peer treats the turn as stale and
// wakes anyway. The PreToolUse hook re-stamps "busy" on every tool call, so
// a long ACTIVE turn stays fresh; this TTL only governs a turn that stops making
// tool calls (one giant single tool call, or a crash without a clean Stop) — the
// latter is exactly the stale-busy→wake recovery we want. Configurable for
// deployments with very long single-tool-call turns.
const ACTIVITY_BUSY_TTL_MS = (() => {
  const env = process.env.OXTAIL_ACTIVITY_BUSY_TTL_MS;
  if (!env) return 10 * 60 * 1000;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
})();

function activitySessionKey(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
}

function readActivity(sessionId: string | null): { status: string; ageMs: number } | null {
  if (!sessionId) return null;
  try {
    const p = join(homedir(), ".oxtail", "activity", activitySessionKey(sessionId));
    const status = readFileSync(p, "utf8").trim();
    return { status, ageMs: Date.now() - statSync(p).mtimeMs };
  } catch {
    return null;
  }
}

// A "fresh busy" marker = the peer is mid-turn RIGHT NOW: status "busy" with an
// age in [0, TTL). A NEGATIVE age (future mtime — clock skew) is NOT trusted as
// fresh (mirrors autowake's isFreshIdle), so a skewed busy marker falls through
// to a wake instead of silently suppressing one. ONE predicate, TWO consumers
// (the wake gate below + the delivery-outlook advisory) so they can never
// disagree about whether the peer is mid-turn.
function isFreshBusy(act: ActivitySnapshot): boolean {
  return !!act && act.status === "busy" && act.ageMs >= 0 && act.ageMs < ACTIVITY_BUSY_TTL_MS;
}

// Skip the wake only when the peer is FRESHLY busy. Idle, unknown (no activity
// file — hooks not installed), stale-busy (a turn that outran the TTL, or a
// peer that exited without a clean Stop), or skewed-busy (future mtime) all fall
// through to a wake.
function shouldWakeForSend(act: ActivitySnapshot): boolean {
  return !isFreshBusy(act);
}

// The delivery-outlook advisory. PURE (no tmux/FS/env): given the target
// identity, an activity snapshot, and the requested wake/reply mode, decide
// whether a SEND will silently strand on the peer — and ONLY for the truly-
// silent path. Every path that already carries a wake_status (wake:"auto", a
// reply-default wake, the durable pending-ask pull-back) returns null here:
// re-encoding wake_status into a parallel vocabulary is exactly what we do NOT
// do (per the round-1 design review). We fill only the hole where
// resolveSendWake would otherwise return {} with nothing to say:
//
//   wake:"off"          → caller chose fire-and-forget; nagging is alarm fatigue → null
//   replyTo set         → a reply carries its own wake_status → null
//   unclaimed peer      → handler already emits bootstrap+note → null
//   claimed, no marker  → Codex / hookless Claude: liveness unknown → "unknown_liveness"
//   claimed, fresh-busy → mid-turn; its hooks deliver this turn → null
//   claimed, idle / stale- or skewed-busy → won't self-read until its next turn
//                         or a wake → "stranded_until_read"
export function classifyDeliveryOutlook(input: {
  sessionId: string | null;
  activity: ActivitySnapshot;
  wake: "off" | "auto" | undefined;
  replyTo: string | undefined;
}): DeliveryOutlook | null {
  if (input.wake !== undefined || input.replyTo) return null;
  if (!input.sessionId) return null;
  if (!input.activity) return "unknown_liveness";
  if (isFreshBusy(input.activity)) return null;
  return "stranded_until_read";
}

export async function wakeForSend(
  peer: RegistryEntry,
  wakeText?: string,
): Promise<WakeStatus> {
  if (!shouldWakeForSend(readActivity(peer.client.session_id))) {
    trace("send_wake_skipped_busy", { target_session_id: peer.client.session_id });
    return "skipped_busy";
  }
  return wakePeer(peer, wakeText);
}

// --- Slice 1: wake-on-reply (reply_to default) -------------------------------
// A send_message that carries a reply_to is answering an earlier ask. The wake
// arg is a three-way for a reply:
//   unset  → the STRICT reply-default auto-wake (fresh-idle only, rate limit,
//            one-wake dedupe, env kill-switch — autowake.ts). wake_reason:
//            "reply_to_default".
//   "auto" → the caller explicitly opts into the LENIENT wakeForSend path
//            (idle/unknown/stale all wake; only fresh-busy is skipped). This is
//            the escape hatch for a requester with no idle marker — a Codex or
//            hookless-Claude requester that the strict gate skips as
//            skipped_no_fresh_idle. Not flagged reply_to_default: the caller
//            asked for it explicitly.
//   "off"  → no wake at all.
// Here we just wire identity/activity/time into the strict gate and fire the
// existing send-keys path when it says go.
//
// Note (per Codex's slice-1 correction): the fresh-idle gate makes an explicit
// "is the requester actively blocked in ask_peer?" suppression unnecessary —
// an active waiter is mid-turn and therefore marked busy, so it never reads as
// fresh-idle. That holds only as long as the busy/idle freshness is correct;
// it is not an independent proof.
//
// Triggers the STRICT reply-default path: a reply (reply_to set) with wake
// UNSET. Explicit "auto"/"off" opt out of the strict path (auto → lenient,
// off → none), so this is false for them.
export function replyAutoWakeTriggered(wake: "off" | "auto" | undefined, replyTo?: string): boolean {
  return !!replyTo && wake === undefined;
}

async function autoWakeOnReply(peer: RegistryEntry, replyTo: string): Promise<WakeStatus> {
  const sid = peer.client.session_id;
  const decision = decideReplyAutoWake({
    dir: defaultAutowakeDir(),
    sessionId: sid ?? null,
    replyTo,
    activity: readActivity(sid),
    nowMs: Date.now(),
  });
  if (!decision.fire) {
    trace("autowake_reply_skipped", { target_session_id: sid, status: decision.status });
    return decision.status;
  }
  trace("autowake_reply_fire", { target_session_id: sid });
  return wakePeer(peer);
}

// Stamp the autowake dedupe record for (sessionId, replyTo) when the durable
// pending-ask path fires, so a re-delivered / duplicate copy of the SAME reply
// can't separately strict-wake the requester via the fresh-idle reply-default
// (the in-memory wakePeer debounce is per-process and not reply_to-keyed, so it
// doesn't cover a restart or a >1s gap). Best-effort; we're stamping, not gating.
//
// Like the existing reply-default path (decideReplyAutoWake → claimWake), this is
// stamped on the wake ATTEMPT — before wakeForSend's keystroke outcome is known —
// and claimWake also stamps the per-target RATE record. Intentional and
// consistent with that path: one wake pulls the requester in to drain its whole
// mailbox, so a second reply within the rate window doesn't need its own wake.
// (It is NOT stamped on the wake:"off" / kill-switch-disabled paths, where no
// wake is intended — see resolveSendWake.)
function stampReplyWakeDedupe(sessionId: string | null, replyTo: string): void {
  if (!sessionId) return;
  try {
    claimWake(defaultAutowakeDir(), sessionId, replyTo, Date.now());
  } catch {
    // best effort — a failure only means a duplicate could still strict-wake,
    // which is harmless (debounced, and the requester drains an empty mailbox).
  }
}

// Resolve the wake for a send_message / reply_to_message. Order matters:
//   1. DURABLE pending-ask: if this reply satisfies an ask_peer that timed out
//      and recorded a pending obligation, consume it (regardless of wake mode —
//      a late reply satisfies the obligation even under wake:"off", and leaving
//      the record would let a later duplicate wake and violate the explicit off)
//      and fire the LENIENT wakeForSend so even a long-idle / markerless-Codex
//      requester is pulled back. The automatic (wake unset) variant honors the
//      OXTAIL_AUTOWAKE kill-switch; an explicit wake:"auto" intentionally does
//      not (it's the caller's explicit ask, matching existing semantics).
//   2. STRICT reply-default: a reply with wake UNSET and no pending record →
//      fresh-idle-only auto-wake (autowake.ts), wake_reason "reply_to_default".
//   3. Explicit wake:"auto" → lenient wakeForSend. wake:"off" → no wake.
export async function resolveSendWake(
  peer: RegistryEntry,
  wake: "off" | "auto" | undefined,
  replyTo: string | undefined,
): Promise<{ wake_status?: WakeStatus; wake_reason?: string; delivery_outlook?: DeliveryOutlook }> {
  if (replyTo) {
    const sid = peer.client.session_id ?? "";
    if (consumePendingAsk(defaultPendingAskDir(), sid, replyTo, Date.now())) {
      // wake:"off" and the kill-switch path do NOT wake — so they must NOT stamp
      // the wake-dedupe: stamping there would later suppress the strict wake for a
      // genuine, distinct second reply to the same request_id (no wake happened,
      // so there is nothing to dedupe against). Only stamp on the path that fires.
      if (wake === "off") {
        trace("late_reply_pending_suppressed", { target_session_id: sid });
        return { wake_reason: "late_reply_to_pending_suppressed" };
      }
      if (wake === undefined && autowakeKillSwitchOff()) {
        return { wake_status: "disabled", wake_reason: "late_reply_to_pending" };
      }
      // About to actually wake → stamp so a re-delivered copy of THIS reply can't
      // strict-wake again via the fresh-idle fallback.
      stampReplyWakeDedupe(peer.client.session_id, replyTo);
      trace("late_reply_pending_wake", { target_session_id: sid });
      return { wake_status: await wakeForSend(peer), wake_reason: "late_reply_to_pending" };
    }
  }
  if (replyAutoWakeTriggered(wake, replyTo)) {
    return { wake_status: await autoWakeOnReply(peer, replyTo!), wake_reason: "reply_to_default" };
  }
  if (wake === "auto") {
    return { wake_status: await wakeForSend(peer) };
  }
  // The silent seam: a plain send with wake unset and no reply correlation. This
  // is the ONLY path that returns no wake_status, so it is the only one that can
  // strand without the sender knowing — attach the delivery-outlook advisory.
  // (A wake:"off" caller also lands here; classifyDeliveryOutlook returns null
  // for it — they chose fire-and-forget.) readActivity(null) is a no-op, so an
  // unclaimed target costs no FS read; a claimed default-send costs one stat.
  if (wake === undefined && !replyTo) {
    const delivery_outlook = classifyDeliveryOutlook({
      sessionId: peer.client.session_id ?? null,
      activity: readActivity(peer.client.session_id),
      wake,
      replyTo,
    });
    if (delivery_outlook) return { delivery_outlook };
  }
  return {};
}

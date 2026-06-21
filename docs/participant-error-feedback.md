# Design: send-time participant-error feedback

**Status:** SHIPPED in v0.24.0 (2026-06-21). Author: main. Two-lens fleet review
(max = design/structure, codex = accuracy/edge-cases) resolved the four open
questions and reshaped the draft; the *Resolved design* section below is what was
built. The original draft proposal is kept after it for provenance. Related:
the `participant_error_stall_gap` memory.

## Problem — the silent stall

Agent A calls `send_message({ target: "B", body: "take over the migration" })` — a
plain, fire-and-forget send — while B is **idle** (not mid-turn). Every component
works as designed, and the work still strands:

1. Message written to B's mailbox. ✅ delivered.
2. B is idle → no PreToolUse/Stop hook fires (those fire only *during* B's turn).
3. A passed no `wake` → nothing nudges B into a turn.
4. B stays idle, never drains its mailbox, never sees the message.
5. `send_message` returned `{ ok: true, message_id, ... }` — A believes it handed off.
6. The work never happens. No error, no timeout. A human eventually notices and
   relays by hand — the exact thing oxtail exists to eliminate.

No lock failed, no ledger dropped, no race. This is a **participant error** (wrong
verb for B's state), and the system is currently **silent** about it.

## Observed incident (friction-named, not hypothetical)

**2026-06-17, during the v0.21.0 ship:** main parked two fix-verification messages as
plain `send_message` (no wake, no `action_required`) to an idle max + codex, then gated
the npm publish on replies that could never arrive. David caught it **by eye** (the
cockpit showed `✉2` + idle; `message_status` returned `pending`) and relayed manually —
itself a zero-relay violation (the cockpit had the evidence but nothing connected it to
"main is waiting on these two"). So this is both *observed* and *structurally silent*:
one felt instance undercounts it, because most occurrences are never felt.

## Why it's a distinct class

All prior reliability work hardens one axis: *a correctly-issued operation is never
lost* (locks, crash-consistent appends, received-ledger, durable delegation,
pending-ask). This is the orthogonal axis: *you issued the wrong operation for the
situation*. The machinery can't help — nothing malfunctioned.

It matters **more** in a human-out-of-the-loop loop: there's no human watching to
catch "B never did that," so the feedback must reach **the sender, in-context, at send
time**, where the agent can self-correct without a human.

## Why build it proactively (the dogfooding exception)

oxtail's rule is *don't build until friction is observed* — and this **was** observed
(the 2026-06-17 incident above). It's also **structurally silent**: you can't reliably
feel the *absence* of an action, so even the observed-friction bar undercounts it. Both
arguments point the same way — the failure mode is *defined by the missing signal*, so
the fix is *adding the signal*. Not speculative feature-building.

## Resolved design (as built, v0.24.0)

The two-lens review converged the 5-value draft into one narrow, additive signal.
Key insight (max): most of the draft's enum values just re-encode signals that
already exist (`woken` ≡ `wake_status:"fired"`, `durable_obligation` ≡
`obligation_durable`). So fill **only the actual hole** — the path where
`resolveSendWake` returns `{}` with no `wake_status` to say anything. And (codex):
because we never re-encode `wake_status`, we structurally avoid every false-"fine"
the draft risked (e.g. `skipped_rate_limited` looking like a successful wake).

**One conditional field**, `delivery_outlook`, emitted **only** on the genuinely-
silent send (plain `send_message`/`reply_to_message`: `wake` unset, no `reply_to`)
to a **claimed** peer — computed at the `resolveSendWake` `return {}` seam by a pure
`classifyDeliveryOutlook` (unit-tested), sharing one `isFreshBusy` predicate with
the wake gate so advisory and wake decision can never disagree. No `recipient_state`
(raw busy/idle/unknown telemetry would invite agents to re-implement the gating
oxtail owns — push the *decision*, not the *inputs*).

| Target state on a plain send | Emitted | Why |
|---|---|---|
| fresh-busy (mid-turn) | — (omit) | its hooks deliver this turn |
| `wake:"auto"` / reply / `wake:"off"` | — (omit) | already carries `wake_status`, or deliberate fire-and-forget |
| unclaimed (no session_id) | — (omit) | `bootstrap` + `note` already speak |
| claimed + idle / stale-busy / skewed-busy | `delivery_outlook:"stranded_until_read"` + `hint` | read only at its next turn or a wake |
| claimed + no activity marker (Codex/hookless) | `delivery_outlook:"unknown_liveness"` + `hint` | liveness unconfirmable; steer harder to durable verbs |

**The `hint`** is composed in the handler (wake.ts stays prose-free) and ordered by
**intent, with `wake:"auto"` last** (Q3): it legitimizes "leave it" first (FYI is the
correct default), then forks to `ask_peer` (answer this turn) / `action_required:true`
(durable, tracked via `my_open_work`) / `wake:"auto"` (bare nudge). The 2026-06-17
incident wanted a *durable/blocking handle*, not a nudge — so leading with `wake`
would teach the wrong lesson from the feature's own origin story.

**Resolved open questions:**
1. *Field shape* → one conditional field, two values; `recipient_state` dropped.
2. *Poll-only/hookless peer* → durable-not-lost ≠ self-delivering; a truly-idle
   `read_my_messages`-only peer is `unknown_liveness` (steer to durable verbs), not a
   false "will see it."
3. *Over-use of `wake:"auto"`* → mitigated by the intent-ordered hint (wake last) and
   the precise enum value (`_read`, not `_woken`); the hint is stateless (no dedupe).
4. *oxpit comms-log* → **no** per-line field (a send-time stamp ages false once the
   peer drains). Operator's real need is current state → the live trouble-view
   follow-on below, not a stored log field.

**Review-found extras folded in:** `isFreshBusy` now requires `ageMs >= 0`, so a
clock-skewed (future-mtime) busy marker no longer reads as fresh-busy — it wakes
(wake path) and classifies as `stranded_until_read` (advisory). Honest caveat: the
plain-send branch now does one `readActivity` stat it previously skipped — negligible,
and only on a claimed default-send (unclaimed costs zero FS).

---

## Proposed design — delivery outlook on the send response (original draft)

oxtail already computes the target's busy/idle state at send time (it reads
`~/.oxtail/activity/<session_id>` to decide `wake:"auto"`'s `skipped_busy`). Always
compute it, classify the delivery outlook, and return it — **loud only when bad**:

| Target state at send | Outlook | Response |
|---|---|---|
| busy (mid-turn) | fine — hooks deliver this turn | terse ok |
| idle + you woke it (`wake:"auto"` fired) | fine — woken | terse ok |
| idle + plain send, no wake, not `action_required` | **STRANDED** | loud hint ↓ |
| `action_required:true` | durable obligation — discovered via `my_open_work` | note `obligation_durable` (exists) |
| unknown (Codex/hookless — no activity marker) | can't tell | soft caution |

Proposed response additions (names TBD in review): `recipient_state:
"busy"|"idle"|"unknown"` and `delivery_outlook:
"will_see_this_turn"|"woken"|"stranded_until_woken"|"durable_obligation"|"unknown"`.
In the stranded case, a `hint`: *"B is idle and this send didn't wake it — it won't be
read until something wakes it. Resend with `wake:"auto"`, use `ask_peer`, or
`action_required:true` for a durable obligation."*

The agent reads this in the tool result and self-corrects in the same loop — no human.

## Consistency with existing signals

oxtail is already on this trajectory; this fills the conspicuous remaining hole:

- `obligation_durable` (action_required → is it really durable?)
- `bootstrap: true` (sole unclaimed peer guidance)
- `peer-has-no-session-id` (ask_peer to unclaimed target — already a *loud* error)
- `wake_status` (fired / skipped_busy / skipped_no_target / disabled)
- `correlation` (correlated / uncorrelated / none)

Plain-send-to-idle is the one adjacent participant-error case with no signal yet.

## Scope / non-goals

- **Additive signal only — zero behavior change.** It does NOT change wake behavior,
  so it can't break existing flows and doesn't relitigate the deliberately
  conservative wake stance (no auto-waking idle peers by default).
- Applies to `send_message` and `reply_to_message`. `ask_peer` already blocks/reports.
- Honor the "ordinary traffic pays zero bytes" discipline: terse on the good cases,
  the loud hint only in the stranded case.

## Follow-on (separate slice)

Extend `oxpit --check` / the trouble view from today's "work or mail stranded on a
*dead* owner" to "unread no-wake mail on a *live but idle* owner older than N" — catches
the case where the sender ignored the hint too.

## Risks / honest limits

- "idle" is best-effort — only the hooked Claude Code path maintains the activity
  marker. For Codex / hookless-Claude targets the outlook is `unknown` (soft caution),
  not a false guarantee. Still strictly better than silence.
- Avoid alarm fatigue: the loud hint must be reserved for the genuine stranded case,
  not every plain send.

## Open questions for review

1. Field names + shape (`delivery_outlook` enum values; one field or two?).
2. Should a `read_my_messages`-only peer (hookless, polls at turn start) count as
   "will eventually see it" rather than "stranded"? It depends whether it ever takes
   another turn — arguably still stranded if truly idle. (codex lens.)
3. Does the hint risk teaching agents to over-use `wake:"auto"` (noise)? Framing
   should steer to the *right* verb per case, not "always wake." (max lens.)
4. Worth a tiny `delivery_outlook` surfaced in oxpit's comms-log too?

## Rough effort

One focused session: classify outlook in the `send_message`/`reply_to_message` path,
terse-good/loud-stranded, tests, max+codex review. Small, contained, safe (additive).

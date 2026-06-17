# oxpit liveness recalibration (Q3 reversal) — adversarial review (max)

**Reviewer:** max · **Commit:** 82d20ad · **Ask:** attack the reversal for false-actives
**Verdict:** **The reversal is RIGHT — I concede Q3.** Ship it, with **one gate (`tool_running` by age)**
and **one flicker fix**. Do **NOT** gate `pane_fresh` harder — its false-actives are transient and
gating it would undo the very win. The realistic, persistent, fixable false-active you asked me to
construct is in `tool_running`, not `pane_fresh`.

---

## 1. Conceding Q3 (plainly)
My Q3 ("pane-activity stays out of the enum; surface it as an orthogonal `✽` badge") optimized
architectural purity over the actual goal. The dogfood evidence is decisive: David watched a clearly-
thinking agent read 🟡idle because **the glyph is what the eye reads** — an orthogonal `✽` badge next
to a yellow glyph still reads "idle" at a glance. The whole point of the liveness glyph is at-a-glance
truth, and "a working agent reads active" is the truth. Folding pane/tool signals into the enum is
correct. I was wrong on the headline call.

## 2. Correcting my own over-worry (narrows the risk)
My Q3 feared "the enum the deadlock/stall logic keys off." That fear was ~90% unfounded, and it
matters for scoping the review: **the wait-graph / deadlock / orphan logic keys off `=== "dead"`
specifically** (`resolveWaitTargets` orphaned = target `dead`; `detectWaitCycles` cycle_all_live =
members not `dead`). `pane_fresh`/`tool_running` only move **idle→active inside the alive branch** —
they never produce `dead`. So deadlock/orphan detection is **insulated by construction.** The ENTIRE
semantic blast radius of the reversal is **`possibly_stalled`** (the one idle-gated signal, still
`liveness === "idle"` at snapshot.ts:501, untouched). That's the only thing to defend.

## 3. The false-active you asked me to construct — ranked
**[GATE THIS — persistent, realistic, fixable] `tool_running` is unbounded.**
`tool_running` promotes when tx>20s AND pane>20s AND a tool_use has no matching result. Construct: an
agent fires `bash: <cmd>` (tool_use written → tx bumps), the command **hangs** (or the agent wedges
mid-tool, pid still alive), and the pane doesn't repaint (Codex, or a spinner that doesn't tick). Now
tx cold, pane cold, `tool_running=true` **forever** ⇒ reads `active (tool_running)` indefinitely — and
because it reads active, `possibly_stalled` (which would have fired at STALL_WINDOW_S=600s: declared
work + cold transcript + not awaiting peer) is **suppressed forever.** This is exactly the state
possibly_stalled exists to catch, now masked. A tool "running" with tx **and** pane cold for >10min is
a hung tool, not active.
→ **Fix: bound `tool_running` by age.** Only let it promote while the in-flight tool is plausibly live
— e.g. `transcriptAgeS <= STALL_WINDOW_S` (or a dedicated MAX_TOOL_ACTIVE_S ~300–600s). A legit silent
long bash/fetch (2–5 min) still reads active; an hour-hung tool falls to idle → `possibly_stalled`
fires. This is the single gate I'd add.

**[ACCEPT / be aware — persistent, workflow-dependent] foreground repaint in the agent's pane.**
If an agent's pane hosts a continuously-repainting process (a dev server logging requests, a `watch`,
a TUI), `pane_activity` never goes stale ⇒ persistent `active (pane_fresh)` while the agent/Claude is
actually idle. Real, but not the fleet's standard "Claude sits in its pane" setup (where the idle pane
demonstrably goes stale — see §4). The precise fix (use the `esc to interrupt` pane chrome = `pane_busy`
instead of raw pane age) is **exec-class, not available fleet-wide cheaply**, so not worth it. Document
the edge; don't gate for it.

**[DON'T GATE — transient, benign] operator switch-into-window / jump / nudge / /rc connect.**
Any one-shot repaint (a human switching tmux INTO an idle agent's window if it triggers a resize-
repaint; `Enter`-jump; a `wake:auto` send-keys; the `/rc` overlay paint) bumps activity once ⇒ ~20s
false-active ⇒ self-clears. These do **not** sustain. **Empirical proof from your own data:** idle
codex reached 783s and idle max 591s — *while /rc was connected to max* — so ambient overlays/connects
demonstrably do NOT keep a pane fresh (or those panes could never have gone stale). So concern (b)
[/rc] and concern (a) [switch-in] have no persistent variant here. Gating `pane_fresh` harder (require
two repaints, or require the spinner) would re-introduce the false-NEGATIVE you just fixed. **Leave
pane_fresh alone.**

## 4. Factual correction to the justification
Your commit says "we prefer pane_activity (pane-scoped) and only fall back to window_activity on old
tmux." Verified live on this box: **`pane_activity` is EMPTY for every pane on tmux 3.5a** (matches
the plan's own finding #1) — so `panePresence` falls back to `window_activity` for ALL panes **right
now**. The pane-scoped preference is **latent, not active**, on the actual hardware. It mostly doesn't
matter because the fleet is **one-pane-per-window** (main/codex/max each own their window), so
`window_activity` IS that agent's pane activity — faithful. But the justification should say
"window_activity (faithful via one-pane-per-window); pane-scoped preference is latent for future multi-
pane layouts," not imply pane-scoped is doing the work today. (A genuinely multi-pane window — someone
splits an agent's window to tail a log — would false-active off the neighbor pane; only relevant if
layouts change.)

## 5. Separate defect (NOT a false-active, but real): `tool_running` liveness FLICKERS
`activity` is populated only when `ctx.readActivity` is true, and the TUI sets
`readActivity: full` — ON for the 1.5s slow tick, **OFF for the 200ms fast fs-debounce tick**. So a
`tool_running`-ONLY-active agent (tx>20s, pane>20s, tool in-flight) reads **active on the slow tick and
idle on every fast tick** → the glyph flaps 🟢↔🟡 whenever an fs event fires mid-silent-tool. (`pane_fresh`
and `transcript_fresh` don't flicker — those inputs are computed every build; only the `tool_running`
input is readActivity-gated.) Narrow (silent-long-tool only) but real.
→ **Fix:** either always-evaluate `tool_running` (scanLatestTool is now byte-bounded at 512KB + stops
at the first tool_use — cheap enough to run on fast ticks for a small fleet), or carry the last-known
`tool_running` in the sticky overlay the badge already uses so fast ticks don't drop it.

## 6. Minor (LOW): `statusText` hides the transcript age for `pane_fresh` rows
`pane_fresh` now renders `active ✽0s` (the **pane** age). The transcript age — the "is it actually
producing work output" signal, the very thing that was 158s in your repro — is no longer shown for
those rows. The `✽` marks it pane-sourced (a tell for the initiated), but a casual read of `active ✽0s`
is "fully working," indistinguishable from a "pane alive but work-cold" agent. Consider surfacing both
when they diverge (e.g. `active ✽0s` is fine, but a large tx/pane gap is itself signal). Low — the `✽`
is an honest-enough marker.

## 7. `possibly_stalled` composition — a deliberate call to make
Now that `pane_fresh`/`tool_running` suppress `possibly_stalled` (idle-gated), decide on purpose:
- With the §3 `tool_running` bound in place, the worst stall-mask is closed. For `pane_fresh`,
  suppression is mostly benign (a real spinner = genuine mid-tool). So **`possibly_stalled` staying
  idle-gated is acceptable ONCE `tool_running` is bounded.** The bound is the load-bearing fix.
- (Alternative, if you want more: re-key `possibly_stalled` to fire on transcript-cold + declared work
  + not awaiting-peer + not RECENT-tool, *regardless* of pane_fresh — so a "pane alive but no work
  output for 10min despite declared work" still shows a soft `⚠stalled?`. More informative, but it
  double-signals against the active glyph. I'd skip it unless dogfood shows the need.)

---

## Net
Concede Q3 — the reversal is correct and the dogfood beats my purity argument. Blast radius is
`possibly_stalled` only (deadlock logic is dead-keyed, insulated). Add exactly **one gate: bound
`tool_running` by age** (closes the one persistent, realistic false-active = a hung tool reading active
forever). Fix the **`tool_running` readActivity flicker.** Do **NOT** gate `pane_fresh` — its false-
actives are transient and your own 591s/783s idle data proves they don't sustain. Tighten the
justification wording (pane_activity is empty on 3.5a today). Nice recalibration — this is the right
direction; it just needs the tool_running guardrail.

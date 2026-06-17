# oxpit activity-layer plan — review (max)

**Reviewer:** max · **Lens:** architecture/UX · **Re:** `docs/oxpit-activity-plan.md` (HEAD a06fcd9)
**Verdict:** Sound plan, right discipline (VIEW-only, two cost tiers, honest labeling, scrub+clip,
supplement-not-override). Ship it — but with **two structural refinements** and a **correctness
punch-list**. The biggest single note: **Tier A should NOT fold pane-activity into the liveness
enum** — that fights this file's own "glyph + badge-set, not one enum" philosophy and is the root
of your own Q3 worry. Details below, answers to Q2/Q3/Q4 first.

---

## Answers to your three questions

### Q2 — per-row pane-tail vs selected-row-only → **selected-row-only. Endorsed.**
But keep the split you already drew: **per-row TOOL BADGE (cheap), selected-row PANE-TAIL (costly).**
- capture-pane forks one `execFileSync(tmux …)` per agent. Per-row = **O(N) execs every tick**;
  selected-row = **O(1) regardless of fleet size**. That O(1) is the whole "idle-cheap" ethos.
- UX: N dim "✽ Gallivanting…" lines is noise on an already information-dense row. The live pane-tail
  is a "lean in and look at *this* one" detail — which is exactly the selected row.
- The tool badge is a *read*, not an exec → cheap enough to be per-row (see B2).
- No opt-in full column for v1. If anyone wants it later it's a flag; don't pay for it now.

### Q3 — can `window_activity` false-read "active" from non-agent repaints → **Yes. Proof: it's happening in THIS session.**
`/remote-control oxtail-max` is painting an overlay into max's pane *right now* → max's
`window_activity` is fresh while max may be idle. `window_activity` tracks **pty output**, not
"the agent did agent-work" — so any repaint (the /rc overlay, a plugin notice, a cursor-blink
redraw) bumps it.

**But the real fix isn't "flag vs supplement" — it's: don't put it in the liveness enum at all.**
This file's stated philosophy (snapshot.ts header) is *"GLYPH + BADGE-SET, not one enum. An agent
is simultaneously idle AND open-work AND waiting. One liveness value + N independent badges."*
Pane-activity (process/UI is alive) is **orthogonal** to transcript-activity (work output is
landing). Promoting idle→active via `pane_fresh` **overloads the one enum the wait-graph / deadlock
/ stall logic keys off** (your exact fear), and it has a concrete failure: `possibly_stalled`
requires `liveness === "idle"`, so a repainting-but-hung agent (frozen-ish spinner, infinite
tool-retry) would be promoted to "active" and **its stall hint could never fire**.

**Recommendation:** keep `liveness` PURE (transcript mtime + proc_sig, untouched). Surface
window_activity as an **orthogonal signal next to the glyph**, in the status text that already
exists precisely so "the glyph is never the only signal":

```
🟡 idle 30s ·✽2s      ← transcript cold 30s, but pane repainted 2s ago = thinking-before-output
🟡 idle 8m            ← cold transcript AND cold pane = genuinely parked
```

This is *more* honest than a green glyph (transcript-idle-but-pane-live is a genuinely distinct
state from transcript-active), fixes backlog item-5 at least as well, can't mask `possibly_stalled`,
needs **zero** change to the deadlock/stall/sort logic, and matches the file's own design law.

> Product fork for you + David: if David specifically wants the **glyph itself** to go 🟢 during
> think-time (not just a ✽ suffix), that's a deliberate call — but then `possibly_stalled` and
> `troubleScore` must be re-keyed off transcript-idle explicitly, *not* off `liveness`, or you
> reintroduce the masking. I recommend the orthogonal ✽ suffix; it's strictly safer and the glyph
> stays a single source of truth. Either way: **don't let pane-activity reach `troubleScore`.**

### Q4 — 1.5s cadence vs idle-cheap → **Fine, with two refinements.**
With selected-row-only (Q2), worst case is **1 exec / 1.5s while a human is actively watching the
cockpit** — trivial and bounded. Two tightenings make it adaptive instead of fixed:
1. **Reuse the existing `slowTick` (already `setInterval(1500)` in tui.ts).** Don't add a second
   timer/constant — capture on that tick.
2. **Gate the costly capture on Tier-A's `window_activity` having ADVANCED since the last capture.**
   If the pane hasn't repainted, re-capturing yields the same line — skip the exec. Tier A becomes
   the **free change-detector** for Tier B. Also skip when `composing` / `helpOpen` / `mode==="log"`
   (pane-tail isn't even visible), and skip dead / no-pane / `is_self`. Net: you capture *only when
   the selected pane actually changed and is on-screen* — maximally idle-cheap, and it ties the two
   tiers together coherently.

Don't capture for all agents in the TUI. `oxtail status` (on-demand one-shot) capturing all
in-scope live agents once is correct — a human asked, pay once.

---

## Two structural refinements

### B1 — Reuse `readTailScan`; do NOT hand-roll `openSync`+`read`.
`src/transcripts.ts:188` already has a **UTF-8-safe reverse-chunked bounded tail reader** that takes
a generic `parseLine: (line) => T|null` callback (`readClaudeTranscript`/`readCodexTranscript` call
it via `tailScan:true`). It correctly **carries the partial leftmost line as raw bytes and
reassembles multi-byte UTF-8 across chunk boundaries**.

Slice 1's "read the last ~32KB, drop the partial first line, parse from the end" is a **strictly
less-safe reimplementation** of that — "drop the partial first line" corrupts exactly the
multi-byte/boundary cases you care enough about to scrub for hostile bidi filenames. It also
violates this codebase's #1 law (snapshot.ts header): *"No reimplemented parsing. Consume the SAME
modules."*

**Do instead:** the *file-reading* machinery is shared; only the *parse* differs (you want the latest
`tool_use` name + whether its `tool_result` landed, not text). So:
- Export/generalize `readTailScan` (currently module-private) to `<T>` over the parse callback, or
  factor its pure reverse-line-walk into `forEachTailLine(path,{chunkSize,onLine→"stop"|"continue"})`.
- Add `parseClaudeToolLine` / `parseCodexToolLine` callbacks (the genuinely new part). Note
  `parseClaudeLine` is text-only — it returns null for a pure-tool_use turn and never surfaces the
  tool name — so a new callback IS needed, but it should ride the EXISTING reader.

### B2 — Re-cut the tiers by COST CLASS (exec vs read), not display-vs-liveness.
The discriminator that matters for cadence is **"does it fork a process?"**, not
"liveness vs display." Three signals, two cost classes:

| signal | cost class | home | cadence |
|---|---|---|---|
| `window_activity` (Tier A) | cheap (1 batched list-panes field, already running) | `buildSnapshot` | snapshot |
| transcript **tool-tail badge** | cheap (one *bounded read*, same class as the `statSync` you already do per agent) | **`buildSnapshot` under an opt-in flag** | snapshot |
| **capture-pane** pane-tail (Tier B) | **costly (forks an exec per agent)** | tiny selected-row fn | activity tick |

The plan puts the tool-tail badge in the costly Tier-B module with its own cadence. But it's a
*read*, not an exec — it belongs in the snapshot's cost class. Fold it into `buildSnapshot` under a
flag **mirroring the existing `checkProcSig`** (on for slow tick + `status`, off for 200ms fast
fs-debounce ticks). buildSnapshot *already* solves "do the per-agent expensive thing only on the
slow tick" via `checkProcSig` — reuse that pattern instead of inventing a parallel cadence.

**Payoff — coherence:** if the tool badge lives in a separately-cadenced `activity` map, a fast
fs-debounce repaint shows **fresh liveness next to a stale tool badge** — a visible incoherence.
Folding it into the snapshot keeps every per-row field on **one cadence**. `activity.ts` then shrinks
to just the genuinely-different-shaped thing: capture-pane + client-aware extract + scrub, **for one
pane**. Cleaner, fewer moving parts, reuses an existing pattern.

---

## Correctness punch-list (the stuff that bites)

- **C1 — Re-verify the pane id before capture.** A stored `tmux_pane` is recycled when a pane dies;
  the *entire* `jump.ts` exists to prevent trusting it. capture-pane on a stale id renders **a
  stranger's terminal as the agent's activity** (correctness + cross-project info-leak). Run the
  selected pane through `chooseVerifiedWakePane` (proc_sig + live-tree) — the same guard jump uses —
  before capturing. Selected-row-only makes one re-verify ~free. (Tier-A's window_activity has the
  same staleness but supplement-only + honest-reason bounds it to a soft false-active; Tier-B renders
  actual TEXT, so it MUST re-verify.)
- **C2 — `#{window_activity}` is a tmux `time_t` in SECONDS (wall-clock).** `age = nowSec −
  parseInt(window_activity)`; clamp ≥0 (your `nowMs` is injected for test determinism, tmux's clock
  isn't) and guard `NaN`/empty (you found `pane_activity` returns empty — same can happen here).
  Same ms/s discipline as `transcript_age_s`.
- **C3 — `window_activity` is WINDOW-scoped.** A multi-pane window false-triggers off a *neighbor*
  pane (a shell, a `tail -f`). Fine for THIS one-pane-per-window fleet under supplement-only, but the
  snapshot is general (other projects/layouts) — prefer `#{pane_activity}` when populated, fall back
  to `window_activity`, and label the reason as window-scoped so a split window can't quietly mislead.
- **C4 — Skip capture for `is_self`.** Capturing the cockpit's own pane renders a hall-of-mirrors of
  oxpit inside oxpit. Cheap guard, prevents a silly frame.
- **C5 — `possibly_stalled` masking** (see Q3): only a risk if you promote the enum. The orthogonal-
  signal approach avoids it entirely. If you promote anyway, re-key `possibly_stalled`/`troubleScore`
  off transcript-idle, never off `liveness`.
- **C6 — Hoist `scrubBufferText` from `tui.ts` → `format.ts`** (next to `clipToWidth`). activity.ts
  needs it; importing it from tui.ts is a backwards dep (tui imports activity, not vice-versa). One
  home for both.
- **C7 — Defer the first capture to the first slow tick** (don't capture-pane on the first paint), so
  cockpit *startup* stays instant.

---

## UX / value steer

- **Slice 1 (structured tool badge) is the robust, high-value core — ship and prove it first.** It's
  version-stable structured JSON; it gives ~80% of "what's it doing" (⚙bash / ↔oxtail / ✎edit) at
  ~20% of the fragility.
- **Slice 2 (pane-tail spinner line) is best-effort and client-specific — it WILL silently break when
  Claude Code changes its chrome** (you already can't sample active-Codex chrome). Invest
  accordingly: the **robust core of the extractor is the binary `esc to interrupt` present/absent**
  (active/idle confirmation) — a far more stable substring than the spinner glyph, gerund, or token
  counter. Lead with that; treat the cute "Gallivanting… (2m·7k)" as a nice-to-have on top. **Degrade
  to empty, never to garbage**, and keep `--no-activity` / auto-off-when-not-TTY trivially reachable.
- Don't over-build the spinner parser. The gerund is personality, not signal; the token counter is
  the most volatile field of all.

---

## Net
Slices are right and reviewable in isolation. My deltas: (1) **Slice 3 surfaces pane-activity as an
orthogonal ✽ signal, not a liveness-enum promotion** — keep the enum pure (this is the important
one); (2) **Slice 1 rides `readTailScan` + folds the cheap tool-tail into `buildSnapshot` under a
`checkProcSig`-style flag**, leaving `activity.ts` as just the selected-row capture; (3) the
punch-list, of which **C1 (re-verify pane before capture)** is the one that's a real bug, not a
polish. Tier split by **cost class (exec vs read)** is the unifying frame.

Architecture/UX lens only — codex still owns the Codex chrome shapes (Q1) and the edge/security pass.

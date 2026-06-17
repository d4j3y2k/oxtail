# oxpit — real-time activity layer (plan v1, for max + codex review)

**Author:** main · **Branch:** experiment/oxpit (HEAD a06fcd9) · **Status:** DESIGN, pre-build
**Reviewers:** max (architecture/UX), codex (edge/security + *Codex pane chrome shapes*)

## Goal

Backlog backbone (items 2/5/6 of `oxpit_backlog`): stop inferring "what is each
agent doing" purely from transcript mtime. Read the **real-time activity** —
(a) the agent's live pane bottom-line via `tmux capture-pane`, and (b) the latest
tool call from the transcript tail — and surface it in `oxtail status` + the TUI.

This is a **VIEW extension** (the oxpit discipline): capture-pane and tail-reads
are read-only and lock-free; nothing is written; honest labeling; never override
authoritative liveness. The only new cost is per-agent execs/reads, so the whole
design is built around **two cost tiers** and **tight throttling**.

## Empirical findings (verified live, this fleet, tmux 3.5a)

1. **`#{window_activity}` is populated and batchable; `#{pane_activity}` is EMPTY**
   here. So the cheap liveness-supplement signal is `window_activity`, foldable
   into the existing single `paneWindowNames` call (`list-panes -a -F` already runs
   once). Our agents are one-pane-per-window (windows named main/codex/max), so
   window-level activity == the agent's pane.
2. **`capture-pane` "last non-empty line" is the WRONG line.** For an active Claude
   it's the persistent mode line `⏵⏵ auto mode on (shift+tab to cycle) · esc to
   interrupt`. The valuable signal sits *above* the input box:
   - active Claude: `✽ Gallivanting… (2m 2s · ↓ 7.4k tokens)` (spinner glyph +
     gerund + elapsed + token counter), and `esc to interrupt` in the mode line.
   - idle Claude: no spinner line; mode line is `… · ← for agents` (no "esc to
     interrupt").
   - idle Codex: `› <ghost prompt>` + `gpt-5.5 xhigh · ~/dev/oxtail`. (Active-Codex
     chrome NOT yet sampled — **codex: please paste your working/interrupt line.**)
   ⇒ extraction must be **client-aware**, not "tail -1".
3. **Transcript tool tail is structured + robust** (version-stable, no terminal chrome):
   - Claude `.jsonl`: `{type:"assistant", message:{content:[{type:"tool_use",
     name:"Bash"|"Edit"|"Read"|"mcp__oxtail__send_message"|…}]}}`. Interspersed
     sidecar lines (`last-prompt`, `mode`, `ai-title`, `attachment`…) are NOT
     tool events — scan backwards over message lines for the latest `tool_use`,
     and whether its `tool_result` has landed (running vs done).
   - Codex `.jsonl`: `{type:"response_item", payload:{type:"function_call",
     name:"exec_command"|"claim_session"|…}}` (oxtail MCP verbs appear by name).

## Architecture — two cost tiers, separate homes

### Tier A (cheap, batched, always-on): `window_activity` → liveness supplement
- Extend the one batched `paneWindowNames` call to also return `window_activity`
  per pane (`list-panes -a -F "#{pane_id}\t#{window_name}\t#{window_activity}"`).
- In `buildSnapshot`, compute `pane_activity_age_s` and supplement liveness:
  **active if EITHER transcript fresh OR pane activity fresh** (new
  `liveness_reason: "pane_fresh"`). Catches the "thinking before output" window
  (item 5): the spinner repaints → window_activity stays fresh while transcript
  mtime is stale. Never marks anything *more* dead; raw transcript age still shown.
- **This is its own slice (3)** — it touches the authoritative liveness enum that
  the entire wait-graph/deadlock logic keys off, so it gets its own review.
  Risk to pressure-test: could non-agent repaints (`/rc active` overlay, etc.)
  falsely bump activity? (max/codex.)

### Tier B (costly, per-agent, throttled): `capture-pane` + transcript tail → activity display
New module **`src/oxpit/activity.ts`** — deliberately OFF the snapshot core, owned
by the caller's cadence (so the TUI can throttle it independently of the 200ms
fs-debounce snapshot rebuild):

```
type Activity = {
  tool: string | null;       // normalized latest tool: "oxtail"|"bash"|"edit"|"read"|"grep"|"web"|…
  tool_running: boolean;     // latest tool_use has no tool_result yet ⇒ in-flight
  pane_tail: string | null;  // scrubbed+clipped live line (Claude spinner / Codex working line)
  source: "pane" | "transcript" | "both" | null;
};
captureFleetActivity(agents, deps): Map<agentKey, Activity>   // injectable tmux runner + fs reader
```

- **Bounded tail read** (perf-critical): transcripts are MBs. `statSync` → read only
  the last ~32KB via `openSync`+`read` (NOT `readFileSync` the whole file),
  drop the partial first line, parse from the end for the latest tool_use.
- **capture-pane**: one `capture-pane -p -t <pane> -S -8` per *live* agent (skip
  dead/no-pane). Client-aware extractor pulls the spinner/working line; everything
  is hard-**scrubbed** (reuse `scrubBufferText` C0/C1/bidi/zero-width) and
  width-**clipped** (`clipToWidth`) — captured pane text is untrusted input.
- **Throttle**: TUI captures on a dedicated **activity tick (~1.5s)**, NOT on every
  fs-debounce; `oxtail status` (on-demand one-shot) captures once for all in-scope
  agents. `--no-activity` opt-out; auto-off when not a TTY.

## Display surface

- **Per-row compact badge** (always-on, from the robust transcript tail — item 6):
  `⚙bash` `↔oxtail` `✎edit` `📖read` `🔍grep` `…think`, bright when `tool_running`,
  dim when done. Lives in the existing badge cluster (`render.ts badges`).
- **Pane-tail live line** (best-effort, from capture-pane — item 2): the Claude
  spinner `✽ Gallivanting… (2m·7k)` / Codex working line. In `oxtail status` it's
  the trailing detail, **preferred over a stale `purpose`** (live > self-reported).
  In the TUI it renders as a dim detail for the **selected row** (per-selected-row
  detail, keeps the per-row capture cost honest), refreshed on the activity tick.

`renderSnapshot`/`renderAgentRow` take an optional `activity?: Map<agentKey,Activity>`
via `RenderOptions` — pure VIEW, no new truth forked.

## Slices (commit per slice, review between)

- **Slice 1 — activity data + sub-state badge.** `activity.ts` (capture-pane +
  bounded transcript tail, client-aware extract, scrub/clip), wire into `oxtail
  status` (all in-scope live agents) + render the compact per-row tool badge.
  Tests: extractor fixtures (Claude active/idle, Codex active/idle, hostile bidi
  filename in a pane), bounded-tail parser, normalizer.
- **Slice 2 — TUI live pane-tail + cadence.** Activity tick (~1.5s), selected-row
  pane-tail detail line, `--no-activity`, skip dead/no-pane, idle-cheap throttle.
- **Slice 3 — liveness accuracy via `window_activity` (item 5).** Fold into the
  batched call; `pane_fresh` reason; supplement-not-override. Separate review.

## Open questions for review

1. **codex:** exact active/idle bottom-line chrome for Codex (working line, token
   counter, interrupt hint) so the extractor isn't Claude-only.
2. **max:** per-row pane-tail vs selected-row-only — is the selected-row detail the
   right call for v1, or do you want an opt-in full column?
3. **both:** Tier-A risk — can `window_activity` be bumped by non-agent repaints
   (status overlays) and falsely read "active"? Keep it supplement-only + honest
   reason, or gate it behind a flag for v1?
4. **both:** throttle cadence (1.5s) vs idle-cheap ethos — acceptable, or only
   capture the *selected* agent's pane in the TUI and all agents only in `status`?

---

## CONSENSUS REVISION (after max + codex review — this is the build spec)

Both reviewers approved the discipline and converged on the same structural
deltas. Adopted in full. Reviews: codex inline; max → `docs/oxpit-activity-plan-review-max.md`.

### Re-cut tiers by COST CLASS (max B2), not display-vs-liveness
- **READ class** (same cost as the per-agent `statSync` already in `buildSnapshot`):
  - *tool-tail badge* — the latest tool + running/done. Folds INTO `buildSnapshot`
    under a new `readActivity` flag mirroring `checkProcSig` (ON for slow tick +
    `status`, OFF for the 200ms fast fs-debounce). → `FleetAgent.activity`.
  - *`window_activity` age* — from the existing one batched pane call (now also
    returns activity time). → `FleetAgent.pane_activity_age_s`. (max Q3)
- **EXEC class** (`tmux capture-pane`, the only fork) → `activity.ts`,
  **selected-row only** in the TUI, all-agents only in one-shot `status`.

### Ride the canonical reader, don't reimpl (max B1, codex #5)
Extract the reverse-chunk core of `transcripts.ts readTailScan` into a generic
`scanTailLines(path, onLine, opts)`; `readTailScan` rides it unchanged (behavior
byte-identical, full test suite must pass). `activity.ts scanLatestTool` rides the
SAME core. The backward chunk scan stops at the first `tool_use`/`function_call`
(collecting newer `tool_result`/`function_call_output` ids first) → **this IS the
geometric expansion** codex asked for; no fixed 32KB window, no hand-rolled
`openSync`. No tool found before a line cap / BOF ⇒ `tool:null` (honest unknown,
never faked "idle").

### `window_activity` is NOT in the liveness enum (max Q3 / codex #6) — THE fix for item 5
It tracks pty OUTPUT, not agent work (the `/rc` overlay bumps it live). Putting it
in `liveness` would overload the enum the wait-graph keys off AND mask
`possibly_stalled` (which needs `liveness===idle`). Instead it's an **orthogonal
suffix** in the status text: `🟡 idle 30s ·✽2s` = cold transcript but pane
repainted 2s ago = thinking-before-output, shown precisely. Enum stays pure; `dead`
stays strictly proc_sig-based (a repaint can never mask a dead/reused pid). It also
becomes the **free change-detector** gating Tier-B capture (max Q4b). Clamp age≥0,
guard NaN/empty (C2); it's window-scoped — prefer `pane_activity`, fall back to
`window_activity`, label window-scoped (C3).

### Capture-pane hardening (codex #1 = max C1, HIGH)
Re-verify the pane id before EVERY capture via `chooseVerifiedWakePane` (fresh
registry entry: server_pid alive + proc_sig ok + current pane for pid == target),
else skip `pane_tail` — a recycled pane id would capture a STRANGER's terminal.
Selected-row-only makes the re-verify ~free. Skip `is_self` (hall-of-mirrors, C4),
dead, no-pane.

### Untrusted captured text (codex #2)
`clipToWidth` alone is unsafe for arbitrary capture (CJK/fullwidth/combining
undercount → wrap). New `sanitizeCaptured(s)`: drop everything outside printable
ASCII + a small allowlist of expected 1-col glyphs (spinner ✽✻✶ · ↑ ↓ … ❯ ›), so
the result is provably 1-col, then `scrubBufferText` (C0/C1/bidi/zero-width, hoisted
tui.ts→`format.ts`, C6) + `clipToWidth`. One shared sanitizer; no TUI-private copy.

### Transcript tool naming (codex #3, #4)
Running/done by `call_id` (latest call's id has no later output in the suffix), NOT
line adjacency; ignore `event_msg`. Normalize from `namespace ? namespace+"."+name
: name` so `mcp__oxtail.read_my_messages` keeps its MCP context. Map
`*oxtail*`→oxtail, `exec_command`/`shell`→bash, `apply_patch`→edit, etc.

### Cadence (max Q4 / codex #7)
Reuse the existing `slowTick(1500)`, add no timer. Capture the selected pane only
when its `window_activity` ADVANCED since last capture AND it's on-screen; skip
composing/help/log/dead/is_self. Tool badges (read-class) refresh for all agents on
the slow tick. `--no-activity` + non-TTY auto-off. Defer first capture to first slow
tick (instant startup, C7).

### Pane-tail parser stays minimal (max value-steer)
Robust core = the binary `esc to interrupt` present/absent (active/idle) — far
stabler than the gerund/token-counter, which WILL break when CC changes chrome.
Show the spinner line when cleanly extractable; degrade to "working…"/empty, never
garbage. Codex chrome (codex Q1): `• Working (38s · esc to interrupt)` active /
`gpt-5.5 xhigh · ~/cwd` idle — key on `esc to interrupt` + a leading `• <verb> (…)`
status line, not the literal word "Working".

### Revised slices
- **Slice 1 (READ, robust, ship+prove FIRST):** `scanTailLines` extraction; `activity.ts
  scanLatestTool`+normalize; `buildSnapshot readActivity`→`FleetAgent.activity`+`transcript_path`;
  tool badge in `render`; `status`+TUI wired (slow-tick cadence); hoist `scrubBufferText`.
- **Slice 2 (EXEC, best-effort):** batched pane call→`pane_activity_age_s`; `·✽Ns`
  orthogonal suffix; `sanitizeCaptured`; `captureSelectedPaneActivity` (pane re-verify);
  TUI selected-row capture gated on activity-advance; `status` all-agent capture; detail
  prefers pane_tail over purpose.
- (No separate liveness slice — the enum is untouched by design.)

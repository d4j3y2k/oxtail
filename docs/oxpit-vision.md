# oxpit → primary fleet console — design (for review)

Status: PLAN, pre-build. On branch `experiment/oxpit`. Up for adversarial review
(skeptic / simplifier / realist) before we commit to building.

## Vision
oxpit becomes the **hub** from which the human monitors and communicates with the
**entire agent fleet — including `main`** — from one side window. The native Claude
Code / Codex CLI TUIs **coexist**: when the human wants the richer hands-on
experience they jump in (or switch windows). oxpit doesn't replace them; it's where
you live to *coordinate and access* all the separate windows. Primary use: at-home
monitoring + interaction.

The **original need** — "is this peer actively thinking/working or idle, without
cycling through windows" — is the foundation and is already done (liveness +
wait-graph). Everything below builds the "interact from here too" layer on top.

## Foundation (already shipped on the branch)
- Read: fleet status (liveness/active/idle/dead, work badges, wait-graph w/ deadlock
  + orphaned-wait detection), comms-log (full-text, `l` / `--log`), agent names from
  tmux window names.
- Navigate: `⏎` jump to an agent's pane (client-aware, target-session preferred).
- Act: `n` nudge, `m` message (basic), `oxtail message` CLI, broadcast — all
  operator-origin (from_session_id undefined, origin:"operator", one-way, audited).
- Discipline: passive-view reads (canonical modules, no draining), canonical operator
  send path, zero deps, raw-ANSI, don't-fork-truth.

## Scope of this plan
1. **Message every agent, including `main`.** Drop the can't-message-self refusal;
   keep a `*` "your main thread" marker for awareness. Messaging `main` from oxpit
   injects into the human's Claude Code conversation (desired: avoids jump-to-main-
   and-back).
2. **Rich composer.** Multi-line. **Enter = send, Alt+Enter = newline** (decided).
   Robust **bracketed-paste** handling (detect paste boundaries so a multi-line paste
   doesn't fire-send and control chars don't corrupt the field). Backspace + basic
   edit; cursor-nav/history are later polish. Rendered as a multi-line panel.
3. **Attachments — attach-by-reference.** CONSTRAINT: oxtail messages are text; there
   is no channel to inject image bytes into a peer's context. So oxpit captures the
   file → the message carries its **path** → the recipient agent reads it with its own
   tools (Claude reads images natively; Codex reads files). Capture (macOS-first):
   drag-a-file (pastes path), clipboard-image (`pngpaste`/`osascript` → save to
   `~/.oxtail/attachments/`), or typed/pasted path. Composer shows `📎 a.png, b.pdf`;
   send = text + "operator attached: <paths>".
4. **Per-agent conversation view** (the "never leave oxpit" core). Select an agent →
   a chat pane: its **recent transcript** (canonical `readClaudeTranscript` /
   `readCodexTranscript`, passive + budgeted) **interleaved with your operator sends**
   into one timeline, **live tail-following** as it works, with the composer at the
   bottom. Read + write per agent without jumping in.
5. **Awareness / alerts.** Highlight deadlock / idle-with-open-work / stalled;
   comms search/filter. (Lighter; mostly read.)

## Principles (keep)
- Reads stay a passive VIEW via canonical readers (transcripts too) — no draining, no
  locks, tolerate torn lines, don't fork truth.
- Writes stay the canonical operator path (origin:"operator", one-way, recorded for
  audit/comms-log). The conversation view is a **viewer + injector**, asymmetric — be
  honest about it (the agent doesn't experience a symmetric thread).
- Zero deps, raw-ANSI. macOS-first for clipboard; degrade elsewhere.

## Proposed build order
- **A** — rich composer + bracketed paste (+ allow messaging main).
- **A.5** — attachments (attach-by-reference).
- **B** — per-agent conversation view (transcript tail + interleave + composer).
- **C** — awareness/alerts + comms search.

## Hard parts / questions for reviewers
- **Conversation interleave + live tail perf:** reading a growing transcript on a
  cadence for the *selected* agent only — budget it; is tail-scan enough; how to merge
  the agent's transcript turns with operator sends into one ordered timeline (clock
  skew, missing timestamps)?
- **Attachments:** is attach-by-reference the right model (vs the impossible "inline
  into peer context")? clipboard capture robustness; multiple files; missing-file +
  cleanup of `~/.oxtail/attachments`.
- **Composer:** bracketed paste + Alt+Enter detection vary by terminal — robustness?
  editing ceiling for v1?
- **Scope:** this turns oxpit from a dashboard into a multi-agent **chat client** —
  is that the right thing, or is it over-reach? What should be CUT from v1?
  (simplifier lens.)
- **Trust:** messaging `main` injects into the human's own Claude session — always
  desired? any guardrail needed?
- **Merge:** all on an unmerged branch; more build = more before it ships. Sequence?

## Out of scope (v1, noted)
- Inline image *rendering* in oxpit (iTerm2-only protocol; not how a peer sees it).
- Symmetric agent↔operator threads (operator messages stay one-way).
- Full editor (cursor nav, kill-ring, history).

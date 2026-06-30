# Changelog

All notable changes to oxtail are documented here. The format loosely follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[semantic versioning](https://semver.org/) (pre-1.0: minor versions may carry
behavioral changes). Dates are release dates of the published npm tag.

The hook protocol has its own version (`HOOK_MARKER_VERSION`); when it bumps,
re-run `npx oxtail install-hook`. The current hook version is noted per release.

## [0.29.0] — 2026-06-30

**One keystroke flips between the agent and its dock — Ctrl-], set up for you.**
- `oxpit dock` now binds **Ctrl-]** to flip focus between the agent pane (top) and the dock
  pane (bottom) of the current cockpit window — the single-key nav that makes living in the
  dock effortless. It works in macOS Terminal.app out of the box: NO `~/.tmux.conf` edits,
  NO Terminal.app settings. The cockpit installs a tmux binding at assembly time (never
  written to a config file), and a `⌃] flip` footer hint makes it discoverable.
- Dock-aware + safe. The binding goes to the agent when you're on the dock and to the dock
  otherwise (robust even if you split the agent pane); it's a no-op outside cockpit windows,
  so Ctrl-] passes straight through to your other tmux sessions untouched. It never clobbers
  an existing Ctrl-] binding (detects and skips, with a warning), and `OXTAIL_OXPIT_FLIP=off`
  disables the whole thing. Prefix nav (`C-b ↑/↓`) still works too.
- Why Ctrl-]: Terminal.app doesn't send Option as Meta (so `M-` bindings are dead) and the
  F-keys collide with laptop media keys; Ctrl-] is delivered cleanly, isn't grabbed by
  macOS, and isn't used by the claude/codex TUIs. Verified end-to-end on tmux 3.5a.

## [0.28.4] — 2026-06-30

**The dock keeps the agent you landed on highlighted, even after you navigate.**
- Fixed a cumulative jump-highlight drift. Each per-window cockpit dock is its own
  `oxpit --dock` process, and once you moved the cursor in one (to pick a jump target)
  its window-local auto-select latched OFF and never re-armed — so returning to that
  window later showed a stale selection a row off, worse the more you jumped. v0.28.3
  fixed the window→agent _matching_; this fixes the _re-arm_ so the match keeps applying.
- A dock now re-snaps to its OWN window's agent whenever you aren't viewing its window
  (keyed on tmux `window_active`), so switching back to any window always lands on that
  window's agent. A cursor move still sticks while you're in the window (you can pick a
  jump target); leaving and returning resets it. A short, self-stopping focus poll closes
  a quick window-bounce the 1.5s refresh tick used to miss. Idle-cheap: the poll runs only
  while a dock is mid-navigation and stops the instant it re-arms.

## [0.28.3] — 2026-06-30

**Dock height + the selector lands on the agent you jumped to.**
- The self-sized dock gets a couple rows of breathing room (header + agents + footer, plus
  ~2) instead of hugging the content exactly.
- Fixed an off-by-one where jumping into a window highlighted the agent before/after the
  one you landed on: the window\u2019s agent is now matched by WINDOW NAME (each fleet agent
  lives in a window named after it) rather than pane id, which was drifting the selection.

## [0.28.2] — 2026-06-30

**Dock self-sizes + remembers the window you jumped to.** Two more cockpit polish items:
- **The dock pane now sizes ITSELF** to fit the fleet (header + agents + footer, capped),
  in its own process after the window has settled \u2014 so the half-screen ballooning is gone
  for good (the earlier weld-side resize kept losing a race with the foreground agent\u2019s
  startup re-layout). Shrink-only: snug when tmux over-allocates, never fights a bigger pane.
- **Each window\u2019s dock highlights that window\u2019s agent.** Jump to a window and its agent is
  already selected (re-resolved until it registers), so you can keep navigating from where
  you are instead of the cursor snapping back to the top \u2014 until you move it yourself.

## [0.28.1] — 2026-06-30

**Cockpit nav: `\u23ce` keeps you in the dock; main-window dock sized right.** Two follow-ups to
the omnipresent dock:
- **`\u23ce` no longer teleports you into the agent pane.** Now that every window has a dock,
  jumping switches to the agent\u2019s WINDOW but lands you on *that window\u2019s dock pane* \u2014 the agent
  above you changes, you stay in the cockpit, and `\u23ce` again flips to the next. (Bypasses the
  client picker entirely, so a second attached client \u2014 e.g. a remote-control client \u2014 can\u2019t
  cause the \u201cmultiple terminals\u201d refusal either.)
- **The main window\u2019s dock was still \u2248half the screen.** The detached split + proportional
  rescale-on-attach was fought by the foreground agent\u2019s startup re-layout. The session is
  now pre-sized to the real client size *before* splitting, so the dock is correct from the
  start on every window.

## [0.28.0] — 2026-06-30

**The dock is omnipresent.** `oxpit dock` now welds the dock strip into **every** window
of the cockpit, not just the main one — so when you switch to any agent (max, codex, …)
the fleet HUD is right there below it. That is the point of oxpit: a *persistent* cockpit
you never tab away from, not a strip that vanishes when you leave the main window. One
lightweight `oxpit --dock` process per window; idempotent (re-running never stacks a second
strip in a window that has one).

## [0.27.2] — 2026-06-30

**Fixes from live `oxpit dock` use.** Two cockpit bugs that surfaced on a fresh machine:
- **Dock pane was ~half the terminal.** The dock split happens on a detached session at
  tmux's default ~24 rows, then attaching scales the panes proportionally to the real
  terminal — so a fixed-row dock ballooned. The height is now pinned to the real size
  (`resize-pane` after switch-client; pre-sized session for a bare attach).
- **`⏎` jump failed with "multiple terminals could be moved."** The client picker was
  built for oxpit-in-a-side-tab (move your *other* work-client), so it excluded your own
  client — and a second attached client (e.g. a remote-control client) made it ambiguous.
  Now, when your own client is already viewing the cockpit session, `⏎` moves *you* to the
  agent (the dock-cockpit case), unambiguously.

## [0.27.1] — 2026-06-30

**Fix: `oxpit dock` in a fresh project gave an empty dock instead of the spawn flow.**
A project with no `.oxtail/fleet.json` fell through to "bare shell + dock" — nothing
spawned, the strip read "no agents in this project yet," and a new user hit a dead end.
Now `oxpit dock` opens the fleet editor seeded with the built-in **default fleet**
(main/max/codex) for *any* new session, so a fresh project gets the review-then-`y`-spawn
flow exactly like a configured one (`w` in the editor saves it to `.oxtail/fleet.json`).
`oxpit dock --no-spawn` remains the bare shell + dock; `--go` still skips the editor.

## [0.27.0] — 2026-06-29

**`oxpit dock` — assemble the whole cockpit in one command.** The natural front door
to a fleet: run `oxpit dock` in your project and it opens your fleet config, you hit
`y`, and it spawns the crew (each agent in a tmux window), welds the live dock strip
(`oxpit --dock`) onto the bottom of the main window, and drops you in — main agent on
top, the HUD below, jump to any peer with `⏎`. One command, you're in the cockpit.

**`oxtail setup` — one-command onboarding.** New companion to `oxpit dock`: a new
machine (or an upgrade) gets ready in one step. It registers the oxtail MCP server with
Claude Code (`~/.claude.json`) and Codex CLI (`~/.codex/config.toml`), installs the
message-delivery hook, and checks the external prerequisites (tmux, the claude/codex
CLIs) with clear next-steps. Idempotent and non-destructive: it only *adds* an entry
when it's missing (an existing one is left untouched), backs up each file to
`<file>.oxtail-bak` before its first edit, and `--dry-run` previews everything. So the
new-user path is now: `npm i -g oxtail` → `oxtail setup` → `oxpit dock`.

- **Config-first.** On a new fleet, `oxpit dock` opens the fleet editor (the grid with
  model/effort pickers) so you review or tweak the spec before launch; `y` applies →
  spawn (or sync an existing session) → weld dock → attach. An already-running session
  skips the editor and just docks you in (instant). `--no-spawn` gives a bare shell +
  dock; `--go`/`-y` skips the editor; `--dry-run` prints the plan; `--rows`/`--session`/
  `--project` tune it.
- **Watch the crew come up.** The spawn launches agents sequentially (each waits for its
  launch artifact), so instead of a static line that reads as hung, the overlay shows a
  live checklist — `✓ main · ✓ max · ⠹ codex launching… · ◦ test` — ticking as each
  agent lands (spawn engine gained an `onWindowDone` progress callback).
- **Safe + idempotent.** Reuses the existing spawn lifecycle (refuse-to-clobber + the
  per-repo lock); the dock pane is marked `@oxpit_dock` so re-running attaches instead of
  stacking a second strip; a busy fleet lock now surfaces a clean "another op in progress"
  line instead of a raw stack trace. Bare terminal → `attach`; inside tmux → `switch-client`.

No hook-protocol change (`HOOK_MARKER_VERSION` unchanged).

## [0.26.0] — 2026-06-29

**The dock becomes a real cockpit.** `oxpit --dock` renders the fleet as a thin
one-line-per-agent strip for a short bottom tmux pane — an always-on HUD welded under
wherever you work. This release makes it a first-class surface instead of a glance-only
strip: you can flip into it live, and every interactive flow now survives the squashed
vertical space instead of clipping its controls off the bottom.

- **`d` toggles dock ↔ full in place.** Dock mode was launch-only (`--dock`); now `d`
  flips the live view between the compact strip and the full table in the same process —
  collapse to a HUD when heads-down, expand to triage. Footers and `?` help advertise it.
- **The fleet editor (`S` / `R`) survives a short pane.** Its control footer is pinned
  (collapsing to one dense line when tight), the window grid scrolls to keep the cursor
  visible, and the model/effort pick-menu windows its options with a `⋯ N more` marker.
  Previously a 9-row dock clipped the `save` / `apply` / edit-key hints entirely — you
  couldn't see how to operate it. This also fixes a latent full-view bug where a very
  large fleet clipped its own footer off the bottom.
- **Compose (`m`) is budget-aware.** The composer caps itself to the pane — attachments
  collapse to a count, the buffer tail-windows, the hint shortens — and a slice backstop
  closes a real overflow/desync bug (a multi-line draft plus the hint used to overflow a
  short pane with no guard).
- **Confirms are visible in the dock.** `nudge` / `kill` / error prompts rode the
  full-view footer only, so in dock mode "press y to confirm" was invisible. The strip
  now shows the live status line in place of its key hints while a confirm is pending.
- **The strip never silently truncates.** A fleet taller than the pane now windows to a
  `⋯ N more above/below` marker around the selection, the same idiom as the full table.

The spawn/sync/reset plan previews and the comms-log panel were already squash-safe (they
pin their confirm and window the body); this release brings the interactive editor,
composer, and the strip itself up to the same standard. No hook-protocol change
(`HOOK_MARKER_VERSION` unchanged).

## [0.25.0] — 2026-06-22

**Reliability hardening — silent-failure drift, found by a live multi-agent
pressure-test.** The delivery core was sound, but the observability/actuation layer
around it had drifted: best-effort, never-throw guards were turning hard failures into
*silent* ones, and the suite asserted the happy-path contract, never the emergent one.
An adversarial review by the Claude+Codex fleet surfaced the pattern and the bugs —
several the green suite couldn't see. Every fix ships with a test asserting the
*emergent* contract.

- **Durable delegation survives disk pressure.** `deliverToPeer` recorded the
  obligation ledger, enqueued the mailbox line, and *swallowed* a ledger-write failure
  — so under low disk an `action_required` delegation could land in the mailbox with no
  ledger entry, invisible to `my_open_work`: durability silently voided. It now **fails
  loud** on a ledger-write failure (aborts before enqueue → the sender retries).
  Ordinary messages keep best-effort delivery; the `received` ledger also cleans up its
  temp file on ENOSPC instead of leaking it.
- **Honest wake status — no false `"fired"`.** A wake reported `"fired"` when the
  send-keys command succeeded, not when a hookless peer (Codex) actually submitted. A
  successful fire to a hookless or unclaimed peer now reports **`"fired_unconfirmed"`**
  (keystrokes sent, pickup NOT confirmed — the durable obligation + the peer's next
  `read_my_messages` are the guarantee). `ask_peer`'s grace path now reports
  `skipped_busy` rather than a false `"fired"`.
- **The wake stimulus closes obligations.** It told a woken peer to "reply via
  `send_message`", but `action_required` work closes via `complete_work`/`block_work`
  — so a delegated Codex left its obligation open forever. The text now branches.
- **Ghost rows without erasing the stranded signal.** A prior fleet incarnation's dead
  sessions left `⚫dead·gone` breadcrumbs nothing reaped. `register()` now sweeps them
  (`gcDeadBreadcrumbs`), **signal-safe**: a dead session still holding undrained mail
  (pid OR session box) or an open obligation is KEPT, so the cockpit's stranded `⚑`/`✉`
  warning is never silently erased; the same keep-gate governs `readAll`. Reaps are
  compare-and-clear (identity-pin before unlink).
- **oxpit: collapsible background section + reconfigurable RESET.** Detached pane-less
  processes collapse off the navigable fleet into a `(b)`-toggled footer (no longer
  cluttering the list or mis-reading as "awaiting you"), and a fleet reconfigure can
  precede a `RESET` (`R → e`). A **waiting** detached agent stays foreground — its wait
  must stay on the wait-graph and in `--check`.
- **Codex no longer stalls; orphaned MCP servers self-reap.** A plain `send_message` to
  an idle hookless peer (Codex) now wakes it (previously a black hole). An MCP server
  whose host dies uncleanly self-reaps — via stdin-EOF and an orphan-watchdog that now
  catches Linux-subreaper reparenting too, not just pid 1 — instead of lingering as a
  detached `pid:<n>` breadcrumb.
- **Test hygiene.** A promise-unaware `withHome` test helper leaked a `/tmp` dir per
  suite run; made promise-aware.

The whole arc — diagnose → fix → adversarial verify → BLOCK→AMEND→APPROVE → ship — ran
through the live Claude+Codex fleet, human-out-of-loop. Hook protocol unchanged.

## [0.24.0] — 2026-06-21

**Send-time delivery outlook — the sender learns when a plain send will strand.**
Closes the participant-error stall gap: a plain `send_message` to an *idle* peer is
delivered yet never read (no hook fires, no wake), `ok: true` comes back, and the
work silently strands — the exact human-relay this project exists to eliminate. The
machinery never malfunctioned; the sender just used the wrong verb for the peer's
state, and the system was silent about it. Now it speaks, in-context, at send time:

- **`delivery_outlook` on `send_message` / `reply_to_message`.** A plain send (no
  `wake`, no `reply_to`) to a **claimed** peer that won't read it this turn returns
  `delivery_outlook` plus a `hint`:
  - `"stranded_until_read"` — the peer is idle (or stale-/skewed-busy); it reads this
    only at its next turn or a wake.
  - `"unknown_liveness"` — the peer has no activity marker (Codex / hookless Claude);
    liveness can't be confirmed.
- **Additive — the advisory is read-only.** `delivery_outlook` adds a response field
  and changes no delivery or wake decision (the one disclosed wake change this release
  is the clock-skew fix below, in the safe direction).
  The field is **omitted on every path that already speaks**: a mid-turn (fresh-busy)
  peer whose hooks will deliver, anything you woke (`wake: "auto"`), a reply that
  carries its own `wake_status`, a `wake: "off"` deliberate fire-and-forget, and an
  unclaimed target (which already gets `bootstrap` + `note`). No parallel vocabulary
  re-encoding `wake_status` — the advisory fills only the genuinely-silent seam.
- **Intent-keyed hint, `wake: "auto"` last.** The hint legitimizes "leave it" first
  (passive delivery is the correct default for FYI traffic), then forks by intent —
  `ask_peer` (need an answer this turn), `action_required: true` (durable task tracked
  via `my_open_work`), and only then `wake: "auto"` (a bare nudge) — so it steers to
  the *right* verb instead of training a reflexive "always wake."
- **Clock-skew fix (found in review).** The shared `isFreshBusy` predicate now requires
  a non-negative marker age, so a future-mtime ("busy") marker is no longer mistaken
  for a live mid-turn peer: the wake path wakes it (rather than `skipped_busy`) and the
  outlook flags it as a possible strand — the safe direction on both.

Designed against the `participant-error-feedback` spec with a two-lens fleet review
(design/structure + accuracy/edge-cases). No hook-protocol change (`HOOK_MARKER_VERSION`
unchanged). Follow-on (separate slice): an `oxpit --check` trouble view for "unread
no-wake mail on a live-but-idle owner older than N."

## [0.23.1] — 2026-06-21

- **Docs: world-class README restructure.** The README is now a lean, visual-first
  hub (−78% words): release history moved to this changelog, the threat model to
  `SECURITY.md`, and the full tool/protocol reference to `docs/tools.md` +
  `docs/protocol.md`. The npm tarball now ships those relocated docs (`package.json`
  `files`) so the README's relative links resolve. No runtime changes.

## [0.23.0] — 2026-06-20

**oxpit goes VIEWER → ACTOR.** The fleet cockpit can now stand up, converge, and
tear down whole tmux agent-fleets from a `.oxtail/fleet.json` spec, idempotent and
**dry-run by default**:

- **SPAWN** — create a fresh fleet: one window per spec entry, each agent launched,
  bound to its launch-time readiness artifact, and auto-joined.
- **SYNC** — converge a *live* fleet to the spec: add windows it gained, delete
  windows it lost, and leave healthy ones running **untouched**.
- **RESET** — teardown + relaunch in place.

Every mutation is **additive-allowlist-guarded** (only panes carrying oxpit's
`@oxpit_managed` marker AND matching a spec window are ever touched, so a human's
editor or dev-server split is structurally safe), **confirm-fidelity-gated** (the
live run only acts on what the operator saw in the preview), and held under a
per-repo fleet lock. `kill-session` is banned; deletes are per-window and
quadruple-guarded. Hooks unchanged (**v14**).

## [0.22.1] — 2026-06-17

- **oxpit operator messages arrive whole.** The pane wake preview was capped at 240
  chars, so a paragraph-length operator note was chopped mid-sentence. Cap raised
  240 → 1500; on real overflow the marker now names oxpit as the truncator and
  points at `read_my_messages` for the durable full copy. The delivery path was
  always whole — only the pane preview was lossy. Hooks unchanged (**v14**).

## [0.22.0] — 2026-06-17

- **Standalone `oxpit` command.** `npm i -g oxtail` then run `oxpit` from any repo
  (auto-scopes to the cwd project; `npx oxtail oxpit` for no-install). The
  `oxtail oxpit` subcommand and the standalone bin share one `runOxpitCli` wrapper.
- **Supply-chain hygiene.** Lockfile bumped (`hono`, `qs`, `esbuild`) to patch
  unreachable HTTP-stack advisories; `package.json` deps unchanged and in-range,
  repo audit clean.

## [0.21.0] — 2026-06-17

- **oxpit fleet cockpit (hooks v14).** `oxtail status` / `oxtail oxpit` — a
  read-only VIEW that infers liveness, the wait-graph (+ live-deadlock and
  orphaned-wait detection), real-time tool/pane activity badges, a cross-fleet
  comms-log, jump-to-pane, and operator messaging. Built on the canonical
  registry/ledger/mailbox modules rather than re-deriving their semantics.
  Operator messages are unforgeable over MCP and framed untrusted/one-way.
  Stranded work or mail on a dead owner surfaces as fleet trouble (`--check`).

## [0.20.0] — 2026-06-14

- **Hook-path obligation surfacing (hooks v13).** Durable delegation (0.19)
  recorded the obligation at delivery, but the *hook* path rendered only the reply
  fields and steered to `reply_to_message` — which does not close an obligation, so
  a hooked receiver could answer and leave the obligation OPEN forever. Fix: the
  hook envelope now renders a per-message `| action_required` tag and, when a batch
  carries an obligation, a one-line steer to close with `complete_work` /
  `block_work`. Gated so ordinary traffic pays zero extra bytes.

## [0.19.1] — folded into 0.20.0 (hooks v12)

- **Subagent hook-swallow fixed.** A Task subagent's tool call fires the PreToolUse
  hook with the SAME `session_id` as the main loop, so the mailbox drain ran inside
  the subagent's throwaway context and silently lost peer messages from the main
  loop. Fix: `pretooluse.sh` skips the drain on a non-empty `agent_id` (keeps the
  busy marker); the mail waits for the main loop's next PreToolUse / Stop.

## [0.19.0] — 2026-06-14

- **Durable delegation — wake as accelerator, not source of truth.**
  `send_message({ action_required: true })` makes the (claimed, obligations-capable)
  receiver's ledger line an OPEN OBLIGATION that survives a missed / mistimed /
  crossed wake: the owner rediscovers it via **`my_open_work`** + the
  **`open_work_count`** surfaced on `read_my_messages`, and closes it with
  **`complete_work`** / **`block_work`** — which deliver the outcome to the original
  requester (correlated when the delegation was an `ask_peer`), wake them, and stamp
  the obligation terminal. Correctness lives on the receiver's disk
  (record-before-append), entirely off the wake path — so Codex is first-class with
  **no new hook**. Capability-gated; a pre-0.19 peer degrades to ordinary mail.

## [0.18.0] — 2026-06-10 (hooks v11)

- **Delivery receipts + `message_status`.** Every path that hands a message into an
  agent's context writes a write-once delivery receipt, and the new `message_status`
  tool answers a question `read_session` never could: `"delivered"` (with
  `delivered_at`/`via`/recipient), `"pending"` (still queued), or an honest
  `"unknown"` with the likely cause. Receipts/outbox prune after ~7 days.
- **In-band bootstrap.** Target resolution no longer counts the caller itself toward
  name-target ambiguity, so a sole unclaimed peer now resolves: `send_message`
  delivers to its pid box and `wake:"auto"` nudges its verified pane, so
  "go `claim_session`" travels in-band instead of over a human tmux relay.

## [0.17.1] — 2026-06-10 (hooks v10)

- **Auto-join date fix.** `sessionstart.sh` recorded `ps lstart`'s raw bytes, which
  pad single-digit days with a double space, so `ancestorConfirmed`'s exact match
  silently failed on days 1–9 of *every month*. The hook now collapses internal
  space runs and the server normalizes on read.
- **Hook self-heal.** The `hook-drain` helper now truncates a non-empty mailbox
  whose lines are all torn/invalid, instead of re-spawning a Node helper on every
  tool call. Plus orphaned empty-mailbox GC at server start and several install
  hardening fixes. Re-run `npx oxtail install-hook` after upgrading.

## [0.17.0] — 2026-06-09 (hooks v9)

- **Session-keyed mailboxes.** A session's inbox is now a single file keyed by its
  `client.session_id` instead of one file per MCP-child pid, so a pid rotation can
  no longer strand mail by construction. Senders route on the receiver's advertised
  `capabilities.mailbox.session_keyed`; readers drain the session box plus any
  legacy pid boxes with `message_id` dedup.
- **hook-drain helper.** The PreToolUse/Stop hooks became thin bash triggers: the
  empty-inbox fast path stays pure bash, but lock + parse + render moved to a
  `hook-drain` helper — the *same compiled lock/mailbox code the server runs*.
- **SessionStart auto-join.** The manual `/oxtail-join` ceremony is no longer
  required for hooked Claude Code sessions.

## [0.16.2] — 2026-06-06

- **`read_session` freshness/provenance.** Every return now says *which*
  identity/thread it read and how it was derived (`resolved_session_id`,
  `session_id_source`) and how stale the backing transcript is (`transcript_mtime`,
  `transcript_age_seconds`) — closing a silent false-negative where a sticky-
  recovered identity pinned to an old transcript read as "peer never replied." The
  tool is documented as browse/diagnostic only.

## [0.16.1] — 2026-06-05

- **Receive convention for no-hook peers.** The `read_my_messages` description no
  longer says no-hook peers "must poll" — that wording sent an idle Codex into a
  sleep-loop. Delivery is sender-driven: a wake-bearing send re-invokes an idle
  peer's pane; the receiver reads once at the start of that turn.

## [0.16.0] — 2026-06-05

- **Compile-sim hardening.** A 3-lens compile-sim pass over the delivery core
  surfaced 4 HIGH + 5 MEDIUM + 4 LOW correctness fixes — including `recoverClaim`
  abstaining instead of guessing, a wall-clock (not retry-count) lock-acquire
  budget, a `proc_sig` start-time signature that detects OS pid reuse before waking
  a stranger's pane, and torn-line-safe mailbox migration.

## [0.15.0] — 2026-06-05

- **Durable `ask_peer`.** A timed-out `ask_peer` records a pending obligation
  (keyed on requester `session_id` + `request_id`, written *before* a final
  authoritative union-drain), so the peer's reply — arriving minutes or hours later
  — *wakes the requester back* (`wake_reason: "late_reply_to_pending"`) instead of
  landing silently. The pull-back takes the lenient wake path, reaching even a
  markerless idle Codex requester. New env: `OXTAIL_PENDING_ASK_TTL_MS` (1h),
  `OXTAIL_ACTIVITY_BUSY_TTL_MS` (10m); default `ask_peer` timeout 45s → 60s.

## [0.14.1] — 2026-06-04

- Union reader `drainMany` dedups by `message_id`, so a migrate/rescue crash-window
  leaving the same message in two boxes is delivered exactly once.

## [0.14.0] — 2026-06-04

- **Crash-consistency + lock hardening.** A compile-sim pass plus four Codex
  adversarial rounds hardened the delivery core: mailbox appends heal a torn record
  boundary; full-file rewrites go through temp file + atomic `rename`; the `mkdir`
  lock gains an owner-token sidecar so release only removes a lock it still owns and
  stale-clear is single-winner + compare-and-clear. A provably race-free
  stale-recoverable lock isn't achievable on a plain shared FS — the residuals are
  enumerated in `src/locks.ts` and bounded to a rare double-delivery, never a wedge
  or torn file.

## [0.13.0] — 2026-06-03

- **Reply by id.** `reply_to_message(message_id, body)` looks the inbound envelope
  up in a durable per-session **received-ledger** and derives the reply target and
  `reply_to` itself, replacing the manual rewiring that silently degraded a
  correlated exchange into loose mailbox traffic. The ledger is written *before* the
  mailbox line is visible, so a handle the hook displays is always resolvable. Fail-
  closed on an unknown/aged-out id.

## [0.12.0] — 2026-06-03

- **Wake hardening (issues #5/#6/#7).** Wake keystrokes only ever target the pane
  the process tree confirms hosts the peer's `server_pid` — never a self-written
  `tmux_pane`/`tmux_session`; registry entries whose `server_pid` doesn't match
  their filename are rejected. Rapid repeat wakes are coalesced
  (`skipped_debounced`). `oxtail diagnose` summarizes wake outcomes from
  `MCP_TRACE_FILE`, and a scheduled CI job flags drift in Codex's paste-burst window.

## [0.11.0] — 2026-06-03

- **Wake-on-reply.** A reply (`send_message` with `reply_to`) auto-wakes a
  freshly-idle requester by default, so an awaited answer doesn't strand an idle
  peer. Strictly gated (fresh-idle only, per-target rate limit, one-wake dedupe,
  `OXTAIL_AUTOWAKE=off` kill-switch). `wake:"off"` opts out.

## [0.10.3] — 2026-06-02

- Hook-envelope token-efficiency pass (1-line preamble, inline header, dropped the
  rendered `origin`); ~100B/delivery saved. `HOOK_MARKER_VERSION` → 5.

## [0.10.2] — 2026-06-01

- Fixed a stale-hook correlation bug: an upgraded install's stale hook stripped
  `request_id`, breaking correlated ask/reply on the receive side. `HOOK_MARKER_VERSION`
  bump + CI guard + startup freshness check.

## [0.10.1] — 2026-06-01

- **Correlated delegate-and-wait.** `ask_peer` now sends a `request_id`; upgraded
  peers reply with `send_message({ reply_to })` and the waiter ignores same-peer
  chatter that doesn't match. Legacy peers are still supported, marked
  `correlation: "uncorrelated"`.
- **Identity monotonicity.** `claim_session` / `register_my_session` and sticky-claim
  recovery are authoritative after they set a session id; later automatic detection
  cannot clobber a claimed id with stale env data.
- Hook push budgeting + provenance (`origin: "peer"`, peer-not-authority framing,
  `OXTAIL_HOOK_MAX_BODY_CHARS`).

## [0.9.0] — 2026-05-31

- **Deliver-on-complete (Stop hook).** A message that lands as the agent finishes a
  turn blocks the stop and is read + answered before it goes idle. Loop-safe via
  `stop_hook_active`.
- **State-gated idle wake.** `send_message({ wake: "auto" })` nudges an idle peer
  via per-client `tmux send-keys`, gated off a busy/idle activity flag so it never
  types into a peer that's mid-turn.
- **Sticky Codex claim.** A restarted Codex MCP child recovers its `session_id` from
  a persisted claim, so identity survives an MCP restart without a manual re-claim.

## [0.8.0] — 2026-05-13

- Symmetric Claude Code wake: Claude Code peers wake via the same send-keys
  mechanism as Codex, without the paste-burst gap. Removed the v0.7 fail-fast that
  wrongly treated Claude Code as unwakeable.

## [0.7.0] / [0.7.1] — 2026-05-13

- **Per-client wake routing.** `ask_peer` routes its wake per `client_type`. Codex
  uses a 500ms gap between text and Enter to defeat its TUI's paste-burst heuristic
  (`PASTE_ENTER_SUPPRESS_WINDOW`); Claude Code uses no gap. Verified live against
  the `oxtail-codex` and `oxtail-claudejr` peers. `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off`
  as a rollback. See [issue #3](https://github.com/d4j3y2k/oxtail/issues/3).

## [0.6.0] / [0.6.1] — 2026-05-12/13

- **Delegate-and-wait.** `ask_peer({ target, body })` blocks server-side until the
  peer replies or a timeout elapses.

## [0.5.0] — 2026-05-11

- **Cross-session messaging.** `send_message({ target, body })` + `read_my_messages()`,
  backed by a per-session mailbox drained under an `mkdir`-based advisory lock. Opt-in
  PreToolUse hook (`npx oxtail install-hook`) for mid-turn delivery to Claude Code.

## [0.4.0] — 2026-05-10

- **Reliable peer identity.** Peer `client_session_id` and `transcript_path` resolve
  reliably for Claude Code and Codex peers even though Claude Code strips its
  session-id env var from MCP children, via a layered detection strategy (env →
  birth-time fingerprint) with a `claim_session` escape hatch.
- Registry files created mode `0o700`/`0o600`; existing installs tightened on first run.

### Earlier

- **0.3.0** — reliable peer identity groundwork.
- **0.2.0** — `read_session` (peer transcript reads).
- **0.1.0** — `list_project_sessions` (peer discovery).

# oxtail

A coordination layer for parallel AI coding agent sessions. Multiple Claude Code or Codex CLI sessions working in the same project root become aware of each other through an MCP server (running locally) that exposes peer-discovery and cross-session-state tools.

Scope is **project-root as the unit**. Sessions in one project root see each other; sessions in another see each other; cross-project there is no visibility, by design.

## What this isn't

- **Not a phone client.** An earlier client-side experiment explored a custom phone PWA for AI coding agents. It's paused — Termius + tmux + plain SSH won the daily-drive comparison. The actual unmet need is coordination logic, not a custom client.
- **Not a competitor to Terminator.** Terminator is a separate desktop multi-agent orchestration tool with its own coherent UI. oxtail is a server-side layer that any MCP client can leverage. Both coexist; oxtail is intentionally a separate repo to keep Terminator's identity clean.
- **Not a wrapper around tmux.** tmux is the implementation primitive most likely to back the session registry, but oxtail's identity is "agent peer awareness," not "session multiplexing." Don't bake "tmux" into tool names or public surface.

## Architecture sketch

- **Transport:** MCP. Both Claude Code and Codex CLI speak it natively, so one server serves both.
- **Surface:** invocable from any client that hosts an agent — phone via SSH+Termius, desktop iTerm, the iOS Claude app, etc. The client is irrelevant to oxtail.
- **Registry (leaning):** `tmux list-sessions` filtered by project-derived names, rather than a custom JSON registry. Free dead-session detection, free naming, no daemon to maintain. Decision pending real-use signals.
- **Project scoping:** project root inferred from session CWD at agent startup.

## Status: v0.10.1 ready, dogfooding

Nine MCP tools live: `list_project_sessions`, `read_session`, `claim_session`, `set_my_state`, `register_my_session`, `get_my_session`, the v0.5 messaging pair `send_message` and `read_my_messages`, and `ask_peer` (delegate-and-wait, introduced v0.6, per-client wake routing in v0.7). Registered both project-locally (via `.mcp.json` using `tsx ./src/server.ts` for the dev loop) and globally (in `~/.claude.json` and `~/.codex/config.toml`, pointing at `dist/server.js`).

The v0.4.0 change: peer `client_session_id` and `transcript_path` now resolve reliably for Claude Code and Codex peers, even though Claude Code strips its session-id env var from MCP children. Detection layers in `src/detect/` — env, then birth-time fingerprint matching of transcript files, with a `claim_session` escape hatch (`register_my_session` is kept for debugging) — see `README.md` for details.

The follow-on additions (`claim_session`, `set_my_state`) introduce a peer-awareness layer: `list_project_sessions` now surfaces each peer's `state` card so an agent can learn what its peers are doing without paying for `read_session`. Raw transcripts become the deep-dive fallback, not the default mode of peer awareness.

Current phase remains **dogfooding**: use the tools in real parallel-agent work, log friction in `NOTES.md`. Each version (v0.1 list_project_sessions → v0.2 read_session → v0.3 reliable peer identity → v0.4 peer-awareness state cards → v0.5 peer-to-peer messaging → v0.6 delegate-and-wait → v0.7 per-client wake routing → v0.8 symmetric Claude Code wake → v0.9 deliver-on-complete and state-gated idle wake → v0.10 token-efficiency → v0.10.1 correlated ask/reply and identity hardening) shipped only after observed friction named the next addition; the same gating applies to whatever comes next.

The v0.5 change: two new MCP tools (`send_message`, `read_my_messages`) plus an opt-in `PreToolUse` hook installable via `npx oxtail install-hook`. Friction observed while pairing on Terminator — two agents in the same project root can see each other's state cards and transcripts but couldn't say anything to each other. Now they can. Claude Code peers see messages mid-turn (via the hook); Codex peers (or unhooked Claude Code) see them next-turn (via polling `read_my_messages`).

The v0.6 change: one new MCP tool (`ask_peer`) that turns v0.5's async pings into a blocking delegate-and-wait. Friction observed while dogfooding v0.5 — `send_message` lets agents say things to each other, but the sender doesn't stay in-turn waiting for a reply. The original implementation blocked until a reply with a matching `from_session_id` landed. v0.10.1 keeps that as the legacy fallback but upgrades capable peers to strict `request_id` / `reply_to` correlation, so stale same-peer chatter cannot satisfy a wait.

The v0.7 change: per-client wake routing after the v0.6 wake was found to be broken against idle TUI peers. Spike investigation (issue #3) revealed Codex's paste-burst heuristic (`codex-rs/tui/src/bottom_pane/paste_burst.rs`) was suppressing Enter for ~120ms after a fast typed burst — `tmux send-keys -l text` + immediate `send-keys Enter` looked like a paste, so the trailing Enter was forcibly converted to newline. Fix: a 500ms gap between the text and the Enter for Codex peers. Verified live 2026-05-13 against the live `oxtail-codex` peer in this repo. v0.7 also fail-fasted Claude Code targets with `wake_status: "skipped_unsupported"` based on a reading of the Claude Code hook catalog (no idle hook surface → "architecturally unwakeable") — but that reasoning conflated *hook events* (which Claude Code doesn't expose for idle) with *TUI input* (which works fine via `tmux send-keys`, the same mechanism that wakes Codex). A falsifying experiment 2026-05-13 against the live `oxtail-claudejr` peer confirmed the full round-trip works: ask_peer enqueue → manual send-keys → peer entered a turn → PreToolUse hook drained mailbox → peer replied via send_message. The fail-fast was a self-inflicted regression against oxtail's symmetric-matrix vision (Claude↔Claude, Claude↔Codex, both directions), so the short-circuit was removed in the follow-up. Claude Code peers now wake via the same send-keys mechanism, just without the Codex paste-burst gap. Wake strategy is overridable via `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` as a rollback.

The v0.9/v0.10.1 changes close the public dogfooding gaps found by real peer traffic: Stop hook deliver-on-complete, state-gated `send_message({ wake: "auto" })`, sticky Codex claim recovery, monotonic session identity after explicit claim, body-budgeted hook pushes, and provenance wording that frames peer messages as context rather than user authority.

## How to collaborate on this project

- **Don't add features without observed friction.** Speculative structure locks in design before observation has informed it. The publish-readiness work (LICENSE, README restructure, npm metadata) was the exception, because "ship it so a third party can install it" is itself the observed need.
- **Ask clarifying questions** about scope, architecture, the MCP tool set, anything unclear. Surfacing assumptions matters more than guessing.
- **Keep observation notes in `NOTES.md`** (or a single scratchpad). Don't sprawl across multiple unstructured files.
- **Don't change code based on theories — change it based on observed deltas** between actual behavior and current capability. Theorizing an orchestration API before real friction surfaces is the same antipattern as theorizing a UI fix before instrumenting.

## Design principles (locked in)

1. **Project-scoped, never global.** No cross-project visibility, ever.
2. **Implementation detail stays out of public naming.** tmux is plumbing.
3. **Both Claude Code and Codex CLI must work** with whatever we build. MCP is the cross-tool protocol; Skills are Claude-specific syntactic sugar that wraps MCP tools, never primary functionality.
4. **Minimum viable first.** One MCP tool that's actually used > five speculative ones.

## Invariants worth defending

- **`client.session_id` is the unique agent identity.** Not `server_pid`, not `tmux_session`. One Claude/Codex client can be backed by multiple MCP server children — the documented dual-scope setup (project `.mcp.json` + user `~/.claude.json`) intentionally spawns two oxtail processes per session, and Claude Code/Codex restarts during a long session can leak ghost children. The registry stores one file per `server_pid`, so duplicates per `session_id` are the norm; `readAll()` collapses them by `session_id` (freshest `started_at` wins). Any new code that reasons about peer identity must key on `client.session_id` — adding lookups keyed on `server_pid` or `tmux_session` will reintroduce the bug class where peer reads bail with misleading scope errors (see commit history for the v0.6-era dedupe fix).
- **Session identity is monotonic after first non-null resolution.** Automatic detection is a bootstrap aid. Once `claim_session`, `register_my_session`, or sticky-claim recovery sets a session id, later env/birth-time detection and `get_my_session` refreshes must preserve it. Only another explicit claim can change it.
- **`ask_peer` replies must correlate when the peer supports it.** Same-peer chatter is not a reply. Upgraded peers advertise `capabilities.mailbox.reply_to` and must satisfy waits with `from_session_id == target.session_id` plus `reply_to == request_id`; unmatched messages stay in the mailbox. The older `from_session_id`-only path is legacy compatibility and must be surfaced as `correlation: "uncorrelated"`. For no-capability peers, stale same-peer chatter may still satisfy the wait; that is an explicit compatibility limitation, not a correctness guarantee.
- **Peer messages are context, not user authority.** Mailbox provenance (`origin: "peer"`, `request_id`, `reply_to`, `source_message_id`) is diagnostic metadata, not a trust boundary. Hook text must keep the trust framing visible — the "context, not user authority" line plus the `from_session_id` / `request_id` / `reply_to` reply fields (full protocol names) are rendered on every delivery — and injected hook bodies must stay under an explicit budget. Single-valued provenance the framing already implies (`origin: "peer"`) stays in the mailbox JSONL but need not be rendered into context.

## Recently shipped

- **Protocol hardening (v0.10.1).** `ask_peer` now stamps outbound messages with `request_id`; reply-to-capable peers answer with `send_message({ reply_to: request_id })`, and the waiter ignores stale same-peer messages. Explicit identity claims are monotonic, so stale automatic detection cannot clobber a real client session id. PreToolUse/Stop hook pushes are body-budgeted and labeled as peer context, not user authority.
- **Deliver-on-complete and state-gated wake (v0.9).** The Stop hook delivers waiting messages at turn end, closing the text-only-turn gap left by PreToolUse. `UserPromptSubmit`/`Stop` maintain a busy/idle flag so `send_message({ wake: "auto" })` nudges idle peers without typing into a busy composer. Sticky Codex claim recovery keeps identity across MCP child restarts.
- **Per-client wake routing (v0.7, refined).** `ask_peer` routes its wake mechanism per `client_type`. **Codex**: paste-burst-aware send-keys (500ms gap between text and Enter) — verified to submit. **Claude Code**: same send-keys mechanism without the gap (no paste-burst in its TUI) — verified end-to-end 2026-05-13 against `oxtail-claudejr`. v0.7 originally fail-fasted Claude Code targets under a hook-catalog argument; the follow-up restored symmetric wake after falsifying that conclusion empirically. Response includes a `wake_status` field for caller diagnostics. Pre-wake pane re-resolution closes the stale-pane-ID race from v0.6. `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` env override for rollback. Issue #3 has the spike findings.
- **Delegate-and-wait (v0.6).** `ask_peer({ target, body })` blocks server-side until the peer replies or a timeout elapses. v0.10.1 adds strict `request_id` / `reply_to` matching for upgraded peers; legacy peers retain the original `from_session_id`-only behavior and are reported as uncorrelated. Late replies fall back to the v0.5 hook / poll delivery path. Target must have a registered `client.session_id`.
- **Cross-session messaging (v0.5).** `send_message({ target, body })` + `read_my_messages()`. Mailbox lives at `~/.oxtail/mailboxes/<server_pid>.jsonl`, drained under an `mkdir`-based advisory lock. Opt-in PreToolUse hook (`npx oxtail install-hook`) for mid-turn delivery to Claude Code.

## Deliberately deferred

- **Output capture** (vs. metadata only). Costs a wrapper layer (`script -F` or pty-mirror). Only worth doing if real friction shows metadata isn't enough.
- **Codex mid-turn delivery.** Pending Codex CLI exposing a hook surface.
- **Delivery receipts / read receipts.** Sender learns `{ ok: true, message_id }`; whether the recipient saw it is invisible. Add when real use names the shape.
- **Broadcast / multi-recipient send_message.** 1:1 only in v0.5.
- **Orphan mailbox cleanup.** Mailbox files for dead pids accumulate in `~/.oxtail/mailboxes/`. Tiny and harmless; revisit when real waste shows up in `du`.
- **Skill set.** Decide after the first MCP tool exists and we know what it feels like to use raw.
- **MCP tool naming.** Pick after observation tells us the verbs.

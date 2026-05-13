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

## Status: v0.7.0 shipped, dogfooding

Nine MCP tools live: `list_project_sessions`, `read_session`, `claim_session`, `set_my_state`, `register_my_session`, `get_my_session`, the v0.5 messaging pair `send_message` and `read_my_messages`, and `ask_peer` (delegate-and-wait, introduced v0.6, per-client wake routing in v0.7). Registered both project-locally (via `.mcp.json` using `tsx ./src/server.ts` for the dev loop) and globally (in `~/.claude.json` and `~/.codex/config.toml`, pointing at `dist/server.js`).

The v0.4.0 change: peer `client_session_id` and `transcript_path` now resolve reliably for Claude Code and Codex peers, even though Claude Code strips its session-id env var from MCP children. Detection layers in `src/detect/` — env, then birth-time fingerprint matching of transcript files, with a `claim_session` escape hatch (`register_my_session` is kept for debugging) — see `README.md` for details.

The follow-on additions (`claim_session`, `set_my_state`) introduce a peer-awareness layer: `list_project_sessions` now surfaces each peer's `state` card so an agent can learn what its peers are doing without paying for `read_session`. Raw transcripts become the deep-dive fallback, not the default mode of peer awareness.

Current phase remains **dogfooding**: use the tools in real parallel-agent work, log friction in `NOTES.md`. Each version (v0.1 list_project_sessions → v0.2 read_session → v0.3 reliable peer identity → v0.4 peer-awareness state cards → v0.5 peer-to-peer messaging → v0.6 delegate-and-wait → v0.7 per-client wake routing) shipped only after observed friction named the next addition; the same gating applies to whatever comes next.

The v0.5 change: two new MCP tools (`send_message`, `read_my_messages`) plus an opt-in `PreToolUse` hook installable via `npx oxtail install-hook`. Friction observed while pairing on Terminator — two agents in the same project root can see each other's state cards and transcripts but couldn't say anything to each other. Now they can. Claude Code peers see messages mid-turn (via the hook); Codex peers (or unhooked Claude Code) see them next-turn (via polling `read_my_messages`).

The v0.6 change: one new MCP tool (`ask_peer`) that turns v0.5's async pings into a blocking delegate-and-wait. Friction observed while dogfooding v0.5 — `send_message` lets agents say things to each other, but the sender doesn't stay in-turn waiting for a reply. `ask_peer` blocks server-side until a reply with a matching `from_session_id` lands (or a fixed timeout elapses) and fires a `tmux send-keys` wake against the peer's pane.

The v0.7 change: per-client wake routing after the v0.6 wake was found to be broken against idle TUI peers. Spike investigation (issue #3) revealed two distinct constraints, fixed differently. For **Codex**: the root cause was not `\r`-as-newline as initially suspected, but Codex's paste-burst heuristic (`codex-rs/tui/src/bottom_pane/paste_burst.rs`) suppressing Enter for ~120ms after a fast typed burst — `tmux send-keys -l text` + immediate `send-keys Enter` looked like a paste, so the trailing Enter was forcibly converted to newline. Fix: a 500ms gap between the text and the Enter. Verified live 2026-05-13 against the live `oxtail-codex` peer in this repo. For **Claude Code**: idle peers are architecturally unwakeable from outside the process — the documented Claude Code hook surface has no idle event, no polling, no external "start a turn" mechanism (`Notification` is outbound-only; `FileChanged` only fires inside an in-flight turn). v0.7 ask_peer fail-fasts for Claude Code targets with `wake_status: "skipped_unsupported"` rather than burning the 45s timeout. The outbound is still enqueued and delivered next time the peer enters a turn. Wake strategy is overridable via `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` as a rollback.

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

## Recently shipped

- **Per-client wake routing (v0.7).** `ask_peer` now routes its wake mechanism per `client_type`. Codex: paste-burst-aware send-keys (500ms gap between text and Enter) — verified to actually submit. Claude Code: fail-fast with `wake_status: "skipped_unsupported"` since the hook surface has no idle event. Response gains a `wake_status` field for caller diagnostics. Pre-wake pane re-resolution closes the stale-pane-ID race from v0.6. `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` env override for rollback. Issue #3 has the spike findings.
- **Delegate-and-wait (v0.6).** `ask_peer({ target, body })` blocks server-side until the peer replies (filtered by `from_session_id`) or a fixed timeout elapses. Late replies fall back to the v0.5 hook / poll delivery path. Target must have a registered `client.session_id`.
- **Cross-session messaging (v0.5).** `send_message({ target, body })` + `read_my_messages()`. Mailbox lives at `~/.oxtail/mailboxes/<server_pid>.jsonl`, drained under an `mkdir`-based advisory lock. Opt-in PreToolUse hook (`npx oxtail install-hook`) for mid-turn delivery to Claude Code.

## Deliberately deferred

- **Output capture** (vs. metadata only). Costs a wrapper layer (`script -F` or pty-mirror). Only worth doing if real friction shows metadata isn't enough.
- **Codex mid-turn delivery.** Pending Codex CLI exposing a hook surface.
- **Delivery receipts / read receipts.** Sender learns `{ ok: true, message_id }`; whether the recipient saw it is invisible. Add when real use names the shape.
- **Broadcast / multi-recipient send_message.** 1:1 only in v0.5.
- **Orphan mailbox cleanup.** Mailbox files for dead pids accumulate in `~/.oxtail/mailboxes/`. Tiny and harmless; revisit when real waste shows up in `du`.
- **Skill set.** Decide after the first MCP tool exists and we know what it feels like to use raw.
- **MCP tool naming.** Pick after observation tells us the verbs.

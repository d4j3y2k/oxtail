# oxtail

[![test](https://github.com/d4j3y2k/oxtail/actions/workflows/test.yml/badge.svg)](https://github.com/d4j3y2k/oxtail/actions/workflows/test.yml)

Run two or more coding agents in the same repo and let them see each other. oxtail is a local MCP server that gives parallel Claude Code and Codex CLI sessions peer awareness: each session can list the others running in the same project root, read their state cards, and (when needed) read their transcripts directly. No fixed cap — every oxtail-aware session in the project shows up in `list_project_sessions`.

Works for any mix of clients that speak MCP — Claude Code, Codex CLI, or one of each. Scope is **project-root as the unit**: sessions in `/path/to/foo` see each other; sessions in `/path/to/bar` see each other; cross-project there is no visibility, by design.

## Privacy

oxtail reads what's on disk locally and surfaces it to peers on the same machine.

- The session registry at `~/.oxtail/sessions/<pid>.json` is created mode `0o700`/`0o600` (v0.4.0+). Files there contain your session id, transcript path, cwd, and `state.purpose` text. Existing users upgrading from older versions get their permissions tightened on first run.
- `read_session` returns whatever the user typed and what the peer agent produced. Treat the returned content as context, not as fresh user input.
- This is designed for **single-user-on-one-machine** use. On a shared-tenancy host, other users with shell access could read your registry files; on a single-user laptop they cannot. Crossing user boundaries is out of scope.

## Install

End users — paste into your MCP config and oxtail is fetched from npm on first use. Pinning to a version is recommended for daily configs; the floating form is documented below for one-shot tries.

**Claude Code** — add to `~/.claude.json` (global) or any project's `.mcp.json`:

```jsonc
{ "mcpServers": { "oxtail": { "command": "npx", "args": ["-y", "oxtail@0.9.1"] } } }
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.oxtail]
command = "npx"
args = ["-y", "oxtail@0.9.1"]
```

**Claude slash command** (`/oxtail-join`):

```sh
mkdir -p ~/.claude/commands
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.9.1/.claude/commands/oxtail-join.md \
  -o ~/.claude/commands/oxtail-join.md
```

**Codex skill** (`/oxtail-join`):

```sh
mkdir -p ~/.codex/skills/oxtail-join/agents
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.9.1/integrations/codex/oxtail-join/SKILL.md \
  -o ~/.codex/skills/oxtail-join/SKILL.md
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.9.1/integrations/codex/oxtail-join/agents/openai.yaml \
  -o ~/.codex/skills/oxtail-join/agents/openai.yaml
```

Floating form (`npx -y oxtail` with no `@`) exists for trying it out; don't pin daily configs to it — it floats end users into whatever the next published version turns out to be.

Contributing? `git clone https://github.com/d4j3y2k/oxtail && cd oxtail && npm install && npm test`.

## Requirements

- `tmux` on `PATH`
- Node 20+

## MCP tools

- `list_project_sessions` — tmux sessions in or under a given project root, enriched with `client_type`, `client_session_id`, and the peer's `state` card. Returns **one row per registered agent** — rows may share `name` when peers share a tmux session (Terminator multi-window). Disambiguate via `client_session_id`.
- `read_session` — the recent transcript of a peer session, as clean per-turn messages when the peer is oxtail-aware (Claude Code and Codex CLI), or as raw tmux pane text otherwise. Accepts a tmux session name OR a `client_session_id` UUID; an ambiguous tmux name returns `ambiguous-target` with the candidate UUIDs.
- `claim_session` — single-shot session registration. The routine path: `Bash echo $CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID` for Codex) → `claim_session({ session_id })`. Returns `{ ok, session_id, transcript_path }`.
- `set_my_state` — write a small "state card" onto this session's registry entry so peers can see what we're doing without reading our transcript. v1 surfaces a single field, `purpose` (≤200 chars).
- `send_message` — **fire-and-forget** message to a peer. Target is a tmux session name or a raw `client_session_id` UUID. Body ≤ 8KB. Delivery is async via the peer's mailbox file. By default does **not** wake an idle peer; pass `wake: "auto"` to nudge one (state-gated — see [Waking an idle peer](#waking-an-idle-peer)). (v0.5+)
- `read_my_messages` — drain this session's mailbox and return any queued messages. Codex peers (and unhooked Claude Code) poll this; Claude Code peers with the hooks installed see messages mid-turn (PreToolUse) or at turn end (Stop) instead. (v0.5+)
- `ask_peer` — **delegate-and-wait**. Enqueues a message and blocks server-side until the peer replies (or the fixed timeout elapses, default 45s, tunable via `OXTAIL_ASK_PEER_TIMEOUT_MS`). Routes the wake per `client_type`: Codex gets a paste-burst-aware `tmux send-keys` wake (500ms gap before Enter to defeat the paste-burst heuristic); Claude Code gets the same send-keys mechanism without the gap (its TUI has no paste-burst). Response includes `wake_status` so the caller can distinguish "we polled and got nothing" from "no tmux pane resolved." Use `send_message` for fire-and-forget. (v0.7+)
- `register_my_session` — pin this MCP server's `session_id` directly. Kept for debugging; prefer `claim_session`.
- `get_my_session` — return this MCP server's own registry entry plus a per-strategy detection diagnosis. Useful for debugging.

See [design principles](https://github.com/d4j3y2k/oxtail/blob/v0.9.1/AGENTS.md) for scope and architecture.

## Usage from an agent

```
claim_session({ session_id: "<uuid from $CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID>" })
set_my_state({ purpose: "wiring up state cards" })
list_project_sessions({ project_root: "/path/to/project" })
read_session({ name: "primary" })                    // auto: transcript if peer registered, else pane
read_session({ name: "claude", mode: "transcript", limit: 50 })
read_session({ name: "primary", mode: "pane", pane_lines: 500 })
read_session({ name: "<peer-uuid>", mode: "transcript" })   // UUID form: needed when peers share a tmux session
send_message({ target: "primary", body: "<system-reminder>checking in</system-reminder>" })
send_message({ target: "<peer-uuid>", body: "..." })        // UUID form: same disambiguation
read_my_messages()
ask_peer({ target: "primary", body: "[Handoff] please audit X and tell me what you find" })
  // → blocks server-side until the peer replies via send_message, then returns their body
```

Omitting `project_root` triggers a best-effort `.git`-ancestor walk from the server's own cwd. The response includes `inferred: true` when this happens. Pass `project_root` explicitly when you can.

## Peer awareness without raw transcripts

The cheapest way to learn what peers are doing is `list_project_sessions`. Each row carries an optional `state` card written by the peer via `set_my_state` — currently `{ purpose, updated_at }`. Reading the card costs almost nothing compared to `read_session`, which spends tokens on the full transcript. Use `read_session` when the card isn't enough.

## Peer messaging (v0.5)

Two MCP tools let peers in the same project root talk to each other:

```
send_message({ target: "<tmux-session-name OR client_session_id UUID>", body: "..." })
  → { ok: true, message_id, target_session_id, target_server_pid }

read_my_messages()
  → { ok: true, drained: true, count, messages: [...] }
```

The mailbox lives at `~/.oxtail/mailboxes/<server_pid>.jsonl`, append-only JSONL, drained under an `mkdir`-based advisory lock. The transport is intentionally dumb: 8KB UTF-8 body cap, sender chooses the framing (raw text or pre-wrapped `<system-reminder>...</system-reminder>`).

Cross-project sends are rejected, never silently dropped. Sending to a peer with the same tmux session name as another live peer returns `ambiguous-target` with the candidate `client_session_id`s — use the UUID form to disambiguate.

### Mid-turn vs next-turn delivery (the asymmetry)

Claude Code peers can receive messages **autonomously** via three opt-in hooks:

```sh
npx oxtail install-hook
```

This installs three small bash scripts under `~/.oxtail/hooks/` and adds matching entries to `~/.claude/settings.json` (tracked by a `_oxtailHook` marker). Reverse with `npx oxtail uninstall-hook`:

- **`hooks.PreToolUse`** → `pretooluse.sh` — delivers **mid-turn**. It reads each `PreToolUse` event's `session_id` from stdin, locates the matching mailbox, and emits the queued messages as `additionalContext` on the next tool-call boundary.
- **`hooks.Stop`** → `stop.sh` — delivers **at turn end** (deliver-on-complete). When the agent finishes a turn with messages still waiting, it emits a `decision: "block"` envelope so the agent continues and reads + responds before going idle, instead of leaving the messages until the next turn.
- **`hooks.UserPromptSubmit`** → `userpromptsubmit.sh` — no delivery; it maintains a **busy/idle activity flag** in `~/.oxtail/activity/<session_id>` (busy on a turn start, idle on a real Stop). A sender consults this so `send_message({ wake: "auto" })` only fires a send-keys wake when the peer is actually idle (see [Waking an idle peer](#waking-an-idle-peer)).

The PreToolUse and Stop hooks include the message body plus `message_id` and `from_session_id` metadata when the sender is registered, so a receiver can reply with `send_message({ target: "<from_session_id>", body: "..." })` even when the sender is not visible in `list_project_sessions`.

Codex CLI peers and any Claude Code session without the hooks installed receive messages **next-turn** by calling `read_my_messages` explicitly. Both clients send messages identically. The asymmetry exists because Claude Code exposes PreToolUse/Stop/UserPromptSubmit hook surfaces that inject context or fire on lifecycle events; Codex CLI does not currently expose an equivalent.

**Coverage and its edges.** PreToolUse fires only before a tool call, so a turn that produces only text — no tool calls — never triggers it; the Stop hook closes that gap by delivering at turn end. One deliberate edge remains: the Stop hook honors the `stop_hook_active` flag and exits without blocking on a re-entry, so `decision: "block"` can never loop — which means a message that arrives *during* a Stop-blocked continuation waits for the next turn rather than extending the current one. A truly idle peer (no turn in flight) is reached by `send_message({ wake: "auto" })` or `ask_peer` (both fire an external wake), or by an explicit `read_my_messages`.

### Waking an idle peer

`send_message` is fire-and-forget by default. Pass `wake: "auto"` to also nudge an **idle** peer into a turn so it drains its mailbox promptly:

```js
send_message({ target: "<peer>", body: "...", wake: "auto" })
// → { ok: true, message_id, ..., wake_status: "fired" | "skipped_busy" | "skipped_no_target" | "disabled" }
```

It is **state-gated** off the activity flag above: if the peer is mid-turn (`busy`), the wake is skipped (`skipped_busy`) because its PreToolUse/Stop hooks will deliver during the turn — no point typing into a busy composer. Idle, unknown (hooks not installed), or stale-busy peers get a per-client `tmux send-keys` wake (Codex gets the paste-burst-aware gap; Claude Code does not). `wake: "off"` (the default) preserves the pure fire-and-forget contract.

**Codex and the wake matrix.** The send-keys wake needs a tmux pane. A Codex peer running **outside tmux** has none, so it returns `wake_status: "skipped_no_target"` — its idle delivery stays poll-based (`read_my_messages`). Run Codex **inside a tmux pane** to get symmetric idle-wake; the routing already handles the Codex paste-burst case.

### Hook coexistence

`install-hook` manages three events (`PreToolUse`, `Stop`, `UserPromptSubmit`); on each it replaces any prior oxtail entry in place and otherwise appends, so existing third-party entries are preserved. **The PreToolUse path is verified against Terminator's `_terminatorHook` v1 in Claude Code 2.1.139:** both hooks' `additionalContext` envelopes reached the model (install order: Terminator first, oxtail second — which is what `install-hook.mjs` produces by appending). Coexistence of the Stop and UserPromptSubmit hooks with third-party entries on those events uses the same append logic but is not separately verified.

If you have a hook installed on a managed event that isn't from Terminator and isn't oxtail, `install-hook` prints a one-line note and proceeds — coexistence behavior with arbitrary third-party hooks is not pre-verified.

### Trust model

oxtail trusts any process running as the **same local user** to enqueue messages. The mailbox directory is mode `0o700` (private), so other users on the host cannot read or write. **On a shared-tenancy box (containers, multi-user dev hosts, etc.), do not run oxtail-aware agents:** any local process under your user can inject `<system-reminder>` content directly into a Claude session. The threat boundary is the same as `~/.ssh/` — what your user processes do, you trust.

## Delegate-and-wait (v0.7)

`ask_peer` extends v0.5's mailbox transport into a blocking primitive:

```
ask_peer({ target, body })
  → {
      ok: true,
      message_id,
      wake_status: "fired" | "skipped_unsupported" | "skipped_no_target" | "disabled",
      reply: { id, body, enqueued_at, from_session_id } | null,
      timed_out,
    }
```

`wake_status` distinguishes the four outcomes a caller may need to handle differently. `fired` means the wake was attempted (or the reply arrived during the grace window, so no wake was needed). `skipped_unsupported` is reserved — no client currently returns this in auto mode (both Codex and Claude Code wake via send-keys). `skipped_no_target` means no tmux pane/session resolved for the target. `disabled` means `OXTAIL_ASK_PEER_WAKE_STRATEGY=off` is in effect.

`timed_out` is `true` only when the poll loop ran to its deadline without a reply.

### Per-client wake routing

`ask_peer` routes the wake mechanism per `client_type`. Verified 2026-05-13 via spike investigations and end-to-end falsifying experiments against the live `oxtail-codex` and `oxtail-claudejr` peers in this repo:

- **Codex** — `tmux send-keys -l <text>` followed by `send-keys Enter` is the wake. The keystrokes are split by 500ms because Codex's TUI has a paste-burst heuristic in `codex-rs/tui/src/bottom_pane/paste_burst.rs` (`PASTE_BURST_MIN_CHARS=3`, `PASTE_ENTER_SUPPRESS_WINDOW=120ms`) that converts Enter→newline for ~120ms after a fast typed burst. Without the gap, the wake text accumulates in the composer and Enter is suppressed. With the gap, Codex submits and enters a turn. 500ms is a deliberately generous multiple of the documented window for upstream-drift safety.

- **Claude Code** — `tmux send-keys -l <text>` + immediate `send-keys Enter`, no inter-keystroke gap. The Claude Code TUI has no paste-burst suppression, so back-to-back text+Enter submits cleanly. Once the peer is in a turn, the oxtail PreToolUse hook drains queued messages as `additionalContext` on the peer's first tool call (or the peer reads them explicitly via `read_my_messages`). v0.7 originally shipped a fail-fast here, reasoning from the [hook catalog](https://code.claude.com/docs/en/hooks) that "no idle hook" meant "unwakeable" — but send-keys is a TUI-input mechanism, not a hook event, and it submits the same way a human keypress would. The fail-fast was a self-inflicted gap against oxtail's symmetric-matrix vision (Claude↔Claude, Claude↔Codex, both directions); restored to symmetric wake in the v0.7 follow-up after an end-to-end falsifying experiment confirmed the full round-trip works.

- **Unknown** — legacy v0.6 wake (text + Enter, no gap). No implied promise; if a new TUI lands, treat it as unknown until verified.

### Wake strategy override

`OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` (default `auto`):

- `auto` — per-client routing above.
- `legacy` — v0.6 behavior for every client (no paste-burst gap, no per-client routing). Escape hatch if auto mode misfires.
- `off` — wake disabled entirely; ask_peer becomes a pure blocking poll. Response surfaces `wake_status: "disabled"`. Useful as a rollback if a Codex update changes the paste-burst constants and the auto-mode delay no longer covers the window.

### Mechanics

1. Enqueue `body` into the target's mailbox (same as `send_message`).
2. Wait ~500ms for a hook-delivered reply (rare path — handles the case where the peer was already mid-tool-call and replied immediately).
3. Route and fire the wake via `wake_status` resolution (see above).
4. Poll the caller's mailbox at 200ms for a reply with `from_session_id == target.session_id`. Other peers' messages stay in the mailbox untouched.
5. Return the reply on match, or `{ reply: null, timed_out: true, wake_status }` after the fixed timeout. Late replies fall back to the normal v0.5 hook / `read_my_messages` path — never lost, just delivered out of band.

### Pane staleness

Pane targeting can go stale: `tmux_pane` is cached at server startup, but tmux can reuse pane ids after a pane is killed. v0.7 re-resolves the pane from the peer's `server_pid` at wake-time (via process-tree ancestry), preferring the live pane id over the cached one. If the peer is no longer in any tmux pane (orphaned), oxtail falls back to the registered tmux session name. If both targeting attempts fail, `wake_status` returns `skipped_no_target`.

### Constraints

- The target peer must have a registered `client.session_id`. Codex peers must call `claim_session` / `register_my_session` first; without that, `ask_peer` returns `error: "peer-has-no-session-id"` rather than guessing.
- Timeout defaults to 45000ms (conservative under typical MCP-client tool-call abort windows). For longer dialogues, the calling agent chains multiple `ask_peer` calls in one turn rather than configuring a longer single block.

### Tuning the timeout

If `ask_peer` returns an abort error before its built-in 45s timeout fires, your MCP client's tool-call ceiling is lower than 45s. Override the bound at server startup:

```sh
OXTAIL_ASK_PEER_TIMEOUT_MS=30000 npx -y oxtail@0.9.1
```

The server reads the env var once at boot and uses it as the fixed timeout for all `ask_peer` calls in that session. Values must be positive numbers; anything else falls back to the 45000ms default.

### Recommended permissions for autonomous agent-to-agent collaboration

The user-approval prompt on every `ask_peer` call interrupts the back-and-forth dynamic. To allow agents to initiate delegation without per-call prompts, add to `~/.claude/settings.json`:

```jsonc
{
  "permissions": {
    "allow": [
      "mcp__oxtail__ask_peer",
      "mcp__oxtail__send_message",
      "mcp__oxtail__read_my_messages"
    ]
  }
}
```

Without an allowlist, Claude Code prompts on first use of each MCP tool with an "always allow" option — pick that once per project to get the same effect.

### Body framing

Peers see the body verbatim. A handoff is naturally read as an assignment, not chat, when framed that way — include an objective and a requested next action. The repo doesn't ship a fixed envelope convention yet; convention will follow real use.

## Self-registration and the peer registry

Each oxtail server, when spawned by an agent, writes a small record to `~/.oxtail/sessions/<pid>.json` containing the client type, session id, transcript path, and tmux pane. Sibling servers read this directory to find peer transcripts. Records auto-clean on process exit and on read (dead PIDs pruned). Sessions whose agents are not oxtail-aware (or are not LLM agents at all — bash, vim, vite dev servers) still show up in `list_project_sessions` and are readable via `read_session` in pane mode.

## How session_id resolution works (v0.4.0)

Claude Code does not propagate `CLAUDE_CODE_SESSION_ID` to MCP child processes — and a process-tree spike confirmed it isn't recoverable via parent-env inspection either: the var only lives in Bash tool subshells. The MCP `initialize` handshake also carries no session id. So oxtail uses a layered detection strategy:

1. **`env`** — direct read of `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`. Structurally null on Claude Code today; fires on Codex when `CODEX_THREAD_ID` is present in the MCP env.
2. **`birth-time`** — match the MCP server's `started_at` against `*.jsonl` birth times in the project transcript dir. Resolves only when there is exactly one post-start candidate within a 5-minute window. Two or more in-window candidates means another agent is sharing this project, in which case birth-time abstains rather than guess.
3. **`register_my_session`** — designed escape hatch. The agent reads its own session id from a Bash tool subshell (`echo $CLAUDE_CODE_SESSION_ID`) and pins it.

Detection runs on startup, again at MCP handshake (`oninitialized`), and is retried at +1s/+5s/+30s/+5min via `unref`'d timers — covering the case where the transcript file doesn't exist yet at handshake time.

When a strategy doesn't fire, it returns an abstention with a `reason` (e.g. `"2 post-start transcripts in 5min window — ambiguous"`), and `get_my_session` adds a top-level `next_step` block carrying the exact bash command to run for the escape hatch. A fresh agent can act in one round trip without investigating each null.

If `MCP_TRACE_FILE` is set in the environment, every detection run appends an NDJSON record with trigger, winning strategy, per-strategy outcomes, and `next_step`. Useful for diagnosing unresolved `client_session_id`s in the wild.

## Status

v0.9.0. Completes the autonomous peer-messaging matrix: a message reaches a Claude Code peer whether it's mid-turn, finishing, or fully idle — in both directions, with no human relay.

- **Deliver-on-complete (Stop hook).** PreToolUse only fires before a tool call, so a text-only turn never triggered it. The new `Stop` hook closes that gap: a message that lands as the agent finishes a turn blocks the stop and is read + answered before it goes idle. Loop-safe via `stop_hook_active`.
- **State-gated idle wake.** `send_message({ wake: "auto" })` nudges an idle peer via per-client `tmux send-keys`, gated off a busy/idle activity flag maintained by the `UserPromptSubmit`/`Stop` hooks — so it never types into a peer that's mid-turn. Returns `wake_status: fired | skipped_busy | skipped_no_target | disabled`. A Codex peer must be inside a tmux pane to be idle-woken (otherwise `skipped_no_target`, and delivery stays poll-based).
- **Sticky Codex claim.** A restarted Codex MCP child — whose `CODEX_THREAD_ID` is stripped from its subprocess env — recovers its `session_id` from a persisted claim keyed by client type + cwd + a bounded process-ancestor chain, so identity survives an MCP restart without a manual re-claim.
- **Identity hardening.** Hooks and activity key on `client.session_id` (never `server_pid`), so a dual-scope agent's sibling MCP children act as one identity; delivery hooks drain all sibling mailboxes; nested git repos are treated as separate projects for scope matching.

Builds on v0.7's per-client wake routing (verified live 2026-05-13): Codex peers wake via a 500ms-gap send-keys sequence that defeats their TUI's paste-burst heuristic; Claude Code peers wake via the same mechanism without the gap (no paste-burst in its TUI). `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` remains as a rollback. See [issue #3](https://github.com/d4j3y2k/oxtail/issues/3) for the v0.7 spike findings.

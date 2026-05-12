# oxtail

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
{ "mcpServers": { "oxtail": { "command": "npx", "args": ["-y", "oxtail@0.6.0"] } } }
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.oxtail]
command = "npx"
args = ["-y", "oxtail@0.6.0"]
```

**Claude slash command** (`/oxtail-join`):

```sh
mkdir -p ~/.claude/commands
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.6.0/.claude/commands/oxtail-join.md \
  -o ~/.claude/commands/oxtail-join.md
```

**Codex skill** (`/oxtail-register`):

```sh
mkdir -p ~/.codex/skills/oxtail-register/agents
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.6.0/integrations/codex/oxtail-register/SKILL.md \
  -o ~/.codex/skills/oxtail-register/SKILL.md
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.6.0/integrations/codex/oxtail-register/agents/openai.yaml \
  -o ~/.codex/skills/oxtail-register/agents/openai.yaml
```

Floating form (`npx -y oxtail` with no `@`) exists for trying it out; don't pin daily configs to it — it floats end users into whatever the next published version turns out to be.

Contributing? `git clone https://github.com/d4j3y2k/oxtail && cd oxtail && npm install && npm test`.

## Requirements

- `tmux` on `PATH`
- Node 20+

## MCP tools

- `list_project_sessions` — tmux sessions in or under a given project root, enriched with `client_type`, `client_session_id`, and the peer's `state` card for oxtail-aware peers.
- `read_session` — the recent transcript of a peer session, as clean per-turn messages when the peer is oxtail-aware (Claude Code and Codex CLI), or as raw tmux pane text otherwise.
- `claim_session` — single-shot session registration. The routine path: `Bash echo $CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID` for Codex) → `claim_session({ session_id })`. Returns `{ ok, session_id, transcript_path }`.
- `set_my_state` — write a small "state card" onto this session's registry entry so peers can see what we're doing without reading our transcript. v1 surfaces a single field, `purpose` (≤200 chars).
- `send_message` — send a short text message to a peer session in the same project root. Target is a tmux session name or a raw `client_session_id` UUID. Body ≤ 8KB. Delivery is async via the peer's mailbox file. (v0.5+)
- `read_my_messages` — drain this session's mailbox and return any queued messages. Codex peers (and unhooked Claude Code) poll this; Claude Code peers with the PreToolUse hook installed see messages mid-turn instead. (v0.5+)
- `ask_peer` — send a message to a peer **and block until they reply** (or a fixed timeout elapses). Combines `send_message` with a server-side wait, plus a `tmux send-keys` wake to nudge idle peers. Returns the peer's reply body. Use this for synchronous delegate-and-wait dynamics; use `send_message` for fire-and-forget. (v0.6+)
- `register_my_session` — pin this MCP server's `session_id` directly. Kept for debugging; prefer `claim_session`.
- `get_my_session` — return this MCP server's own registry entry plus a per-strategy detection diagnosis. Useful for debugging.

See [design principles](https://github.com/d4j3y2k/oxtail/blob/v0.5.0/AGENTS.md) for scope and architecture.

## Usage from an agent

```
claim_session({ session_id: "<uuid from $CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID>" })
set_my_state({ purpose: "wiring up state cards" })
list_project_sessions({ project_root: "/path/to/project" })
read_session({ name: "primary" })                    // auto: transcript if peer registered, else pane
read_session({ name: "claude", mode: "transcript", limit: 50 })
read_session({ name: "primary", mode: "pane", pane_lines: 500 })
send_message({ target: "primary", body: "<system-reminder>checking in</system-reminder>" })
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

Claude Code peers can receive messages **mid-turn** via an opt-in PreToolUse hook:

```sh
npx oxtail install-hook
```

This drops a small bash script at `~/.oxtail/hooks/pretooluse.sh` and adds a `hooks.PreToolUse` entry in `~/.claude/settings.json`. The hook reads each `PreToolUse` event's `session_id` from stdin, locates the matching mailbox, and emits `additionalContext` into the next tool-call boundary. Reverse with `npx oxtail uninstall-hook`.

Codex CLI peers and any Claude Code session without the hook installed receive messages **next-turn** by calling `read_my_messages` explicitly. Both clients send messages identically. The asymmetry exists because Claude Code exposes a PreToolUse hook surface that injects `additionalContext`; Codex CLI does not currently expose an equivalent.

**Caveat for Claude Code receivers:** PreToolUse fires only before a tool call. A turn that produces only text — no tool calls — never triggers the hook; messages enqueued during that turn surface on the next tool call (or via an explicit `read_my_messages`). For pair-debugging UX, senders should not assume mid-turn delivery is universal.

### Hook coexistence

The oxtail hook coexists with other `hooks.PreToolUse` entries. **Verified against Terminator's `_terminatorHook` v1 in Claude Code 2.1.139:** both hooks' `additionalContext` envelopes reached the model. Install order: Terminator first, oxtail second — `install-hook.mjs` appends to a non-empty array, which matches the verified configuration. If you reinstall hooks in a different order, you may need to re-test.

If you have a PreToolUse hook installed that isn't from Terminator and isn't oxtail, `install-hook` prints a one-line note and proceeds — coexistence behavior with arbitrary third-party hooks is not pre-verified.

### Trust model

oxtail trusts any process running as the **same local user** to enqueue messages. The mailbox directory is mode `0o700` (private), so other users on the host cannot read or write. **On a shared-tenancy box (containers, multi-user dev hosts, etc.), do not run oxtail-aware agents:** any local process under your user can inject `<system-reminder>` content directly into a Claude session. The threat boundary is the same as `~/.ssh/` — what your user processes do, you trust.

## Delegate-and-wait (v0.6)

`ask_peer` extends v0.5's mailbox transport into a synchronous primitive:

```
ask_peer({ target, body })
  → { ok: true, message_id, reply: { id, body, enqueued_at, from_session_id } | null, timed_out }
```

Mechanics:

1. Enqueue `body` into the target's mailbox (same as `send_message`).
2. Wait ~500ms for a hook-delivered reply (rare path — handles the case where the peer was already mid-tool-call and replied immediately).
3. Fire a `tmux send-keys` wake against the peer's pane: a single literal line `[oxtail] new peer message — run mcp__oxtail__read_my_messages and respond via mcp__oxtail__send_message` followed by Enter. This nudges idle peers without requiring the human at the other end to type.
4. Poll the caller's mailbox at 200ms for a reply with `from_session_id == target.session_id`. Other peers' messages stay in the mailbox untouched.
5. Return the reply on match, or `{ reply: null, timed_out: true }` after the fixed timeout. Late replies fall back to the normal v0.5 hook / `read_my_messages` path — never lost, just delivered out of band.

Constraints:

- The target peer must have a registered `client.session_id`. Codex peers must call `claim_session` / `register_my_session` first; without that, `ask_peer` returns `error: "peer-has-no-session-id"` rather than guessing.
- Timeout is fixed (single server-side constant pinned conservatively under typical MCP-client abort windows). For longer dialogues, the calling agent chains multiple `ask_peer` calls in one turn rather than configuring a longer single block.
- The wake is best-effort. If `tmux send-keys` fails (no tmux server, no pane, copy-mode), the peer may still respond on its own via polling — the only loss is the immediacy of the nudge.

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

v0.6.0. Adds `ask_peer` on top of v0.5's mailbox transport: an agent can send a message and block until the peer replies, with an automatic `tmux send-keys` wake for idle peers. Combined with the existing PreToolUse hook, two Claude Code sessions can now sustain a back-and-forth handoff inside a single turn of the delegating agent. Codex peers are supported as targets once they've claimed a session.

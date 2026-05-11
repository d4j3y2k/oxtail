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
{ "mcpServers": { "oxtail": { "command": "npx", "args": ["-y", "oxtail@0.4.0"] } } }
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.oxtail]
command = "npx"
args = ["-y", "oxtail@0.4.0"]
```

**Claude slash command** (`/oxtail-join`):

```sh
mkdir -p ~/.claude/commands
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.4.0/.claude/commands/oxtail-join.md \
  -o ~/.claude/commands/oxtail-join.md
```

**Codex skill** (`/oxtail-register`):

```sh
mkdir -p ~/.codex/skills/oxtail-register/agents
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.4.0/integrations/codex/oxtail-register/SKILL.md \
  -o ~/.codex/skills/oxtail-register/SKILL.md
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.4.0/integrations/codex/oxtail-register/agents/openai.yaml \
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
- `register_my_session` — pin this MCP server's `session_id` directly. Kept for debugging; prefer `claim_session`.
- `get_my_session` — return this MCP server's own registry entry plus a per-strategy detection diagnosis. Useful for debugging.

See [design principles](https://github.com/d4j3y2k/oxtail/blob/v0.4.0/AGENTS.md) for scope and architecture.

## Usage from an agent

```
claim_session({ session_id: "<uuid from $CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID>" })
set_my_state({ purpose: "wiring up state cards" })
list_project_sessions({ project_root: "/path/to/project" })
read_session({ name: "primary" })                    // auto: transcript if peer registered, else pane
read_session({ name: "claude", mode: "transcript", limit: 50 })
read_session({ name: "primary", mode: "pane", pane_lines: 500 })
```

Omitting `project_root` triggers a best-effort `.git`-ancestor walk from the server's own cwd. The response includes `inferred: true` when this happens. Pass `project_root` explicitly when you can.

## Peer awareness without raw transcripts

The cheapest way to learn what peers are doing is `list_project_sessions`. Each row carries an optional `state` card written by the peer via `set_my_state` — currently `{ purpose, updated_at }`. Reading the card costs almost nothing compared to `read_session`, which spends tokens on the full transcript. Use `read_session` when the card isn't enough.

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

v0.4.0. Reliable peer identity: `client_session_id` resolves automatically for Claude Code and Codex via filesystem fingerprint matching, with a self-register escape hatch for ambiguous cases. Project-local and global registrations both supported.

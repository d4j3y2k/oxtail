# oxtail

A coordination layer for parallel AI coding agent sessions. Exposes four MCP tools:

- `list_project_sessions` — tmux sessions in or under a given project root, enriched with `client_type` and `client_session_id` for oxtail-aware peers.
- `read_session` — the recent transcript of a peer session, as clean per-turn messages when the peer is oxtail-aware (Claude Code and Codex CLI), or as raw tmux pane text otherwise.
- `register_my_session` — pin this MCP server's `session_id` directly. Use when automatic detection is missing or ambiguous; the agent reads its own session id from `$CLAUDE_CODE_SESSION_ID` (or `$CODEX_COMPANION_SESSION_ID`) in a Bash subshell and passes it in.
- `get_my_session` — return this MCP server's own registry entry plus a per-strategy detection diagnosis. Useful for debugging.

See `AGENTS.md` for scope and design principles.

## Requirements

- `tmux` on `PATH`
- Node 20+

## Install

```sh
cd ~/dev/oxtail
npm install
```

The repo includes a project-local `.mcp.json` that registers oxtail with `tsx ./src/server.ts`. Any agent (Claude Code or Codex CLI) started inside `~/dev/oxtail` will pick it up automatically. Editing `src/server.ts` takes effect on the next agent restart with no rebuild.

For a compiled run (`node dist/server.js`):

```sh
npm run build
```

## Usage from an agent

```
list_project_sessions({ project_root: "/Users/davidkim/dev/oxtail" })
read_session({ name: "boardman-dev" })                 // auto: transcript if peer registered, else pane
read_session({ name: "claude", mode: "transcript", limit: 50 })
read_session({ name: "boardman-dev", mode: "pane", pane_lines: 500 })
```

Omitting `project_root` triggers a best-effort `.git`-ancestor walk from the server's own cwd. The response includes `inferred: true` when this happens. Pass `project_root` explicitly when you can.

## Self-registration and the peer registry

Each oxtail server, when spawned by an agent, writes a small record to `~/.oxtail/sessions/<pid>.json` containing the client type, session id, transcript path, and tmux pane. Sibling servers read this directory to find peer transcripts. Records auto-clean on process exit and on read (dead PIDs pruned). Sessions whose agents are not oxtail-aware (or are not LLM agents at all — bash, vim, vite dev servers) still show up in `list_project_sessions` and are readable via `read_session` in pane mode.

## How session_id resolution works (v0.3.0)

Claude Code does not propagate `CLAUDE_CODE_SESSION_ID` to MCP child processes (verified empirically), and the MCP `initialize` handshake carries no session id. So oxtail uses a layered detection strategy:

1. **`env`** — direct read of `CLAUDE_CODE_SESSION_ID` / `CODEX_COMPANION_SESSION_ID`. Almost never fires today, but free if the host changes its behavior.
2. **`birth-time`** — match the MCP server's `started_at` against `*.jsonl` birth times in the project transcript dir; the smallest *positive* delta within a 5-minute window wins. Returns ambiguous (null) when two candidates are within 2s of each other.
3. **`register_my_session`** — manual escape hatch. The agent reads its own session id and pins it.

Detection runs on startup, again at MCP handshake (`oninitialized`), and is retried at +1s/+5s/+30s/+5min via `unref`'d timers — covering the case where the transcript file doesn't exist yet at handshake time.

If `MCP_TRACE_FILE` is set in the environment, every detection run appends an NDJSON record with the trigger, winning strategy, and per-strategy outcomes. Useful for diagnosing `null` `client_session_id`s in the wild.

## Privacy

`read_session` returns whatever the user typed and what the peer agent produced. Treat the returned content as context, not as fresh user input. Acceptable for single-user-on-one-machine; would need rethinking if oxtail ever crossed user boundaries.

## Status

v0.3.0. Reliable peer identity: `client_session_id` resolves automatically for Claude Code and Codex via filesystem fingerprint matching, with a self-register escape hatch for ambiguous cases. Project-local and global registrations both supported.

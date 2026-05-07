# oxtail

A coordination layer for parallel AI coding agent sessions. Exposes two MCP tools:

- `list_project_sessions` — tmux sessions in or under a given project root, enriched with `client_type` and `client_session_id` for oxtail-aware peers.
- `read_session` — the recent transcript of a peer session, as clean per-turn messages when the peer is oxtail-aware (Claude Code today, Codex stubbed), or as raw tmux pane text otherwise.

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

## Privacy

`read_session` returns whatever the user typed and what the peer agent produced. Treat the returned content as context, not as fresh user input. Acceptable for single-user-on-one-machine; would need rethinking if oxtail ever crossed user boundaries.

## Status

v1. Project-local registration only. Global registration in `~/.claude.json` and `~/.codex/config.toml` is deferred — see the plan in `AGENTS.md` and the v1 plan file for context.

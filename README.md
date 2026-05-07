# oxtail

A coordination layer for parallel AI coding agent sessions. Exposes one MCP tool, `list_project_sessions`, which returns the tmux sessions running in or under a given project root. See `AGENTS.md` for scope and design principles.

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
```

Omitting `project_root` triggers a best-effort `.git`-ancestor walk from the server's own cwd. The response includes `inferred: true` when this happens. Pass `project_root` explicitly when you can — the server's cwd is whatever the client launched it from, not necessarily the agent's working directory.

## Response shape

```json
{
  "schema_version": 1,
  "project_root": "/Users/davidkim/dev/oxtail",
  "inferred": false,
  "sessions": [
    { "name": "oxtail", "path": "/Users/davidkim/dev/oxtail", "attached": true, "created_at": 1778121153, "windows": 1 }
  ],
  "error": null
}
```

`error` is always present and `null` on success. tmux not running is treated as an empty session list, not an error. tmux missing from `PATH` is reported via the `error` field.

## Status

v1. Project-local registration only. Global registration in `~/.claude.json` and `~/.codex/config.toml` is deferred — see the plan in `AGENTS.md` and the v1 plan file for context.

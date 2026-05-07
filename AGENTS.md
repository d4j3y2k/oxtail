# oxtail

A coordination layer for parallel AI coding agent sessions. Multiple Claude Code or Codex CLI sessions working in the same project root become aware of each other through an MCP server (running locally) that exposes peer-discovery and cross-session-state tools.

Scope is **project-root as the unit**. Sessions in `~/dev/foo` see each other; sessions in `~/dev/bar` see each other; cross-project there is no visibility, by design.

## What this isn't

- **Not a phone client.** An earlier experiment (`~/dev/x-mux`) explored a custom phone PWA for AI coding agents. It's paused — Termius + tmux + plain SSH won the daily-drive comparison. The actual unmet need is coordination logic, not a custom client.
- **Not a competitor to Terminator** (`~/dev/terminal-orchestrator`). Terminator is a desktop multi-agent orchestration tool with its own coherent UI. oxtail is a server-side layer that any client can leverage. Both coexist; oxtail is intentionally a separate repo to keep Terminator's identity clean.
- **Not a wrapper around tmux.** tmux is the implementation primitive most likely to back the session registry, but oxtail's identity is "agent peer awareness," not "session multiplexing." Don't bake "tmux" into tool names or public surface.

## Architecture sketch

- **Transport:** MCP. Both Claude Code and Codex CLI speak it natively, so one server serves both.
- **Surface:** invocable from any client that hosts an agent — phone via SSH+Termius, desktop iTerm, the iOS Claude app, etc. The client is irrelevant to oxtail.
- **Registry (leaning):** `tmux list-sessions` filtered by project-derived names, rather than a custom JSON registry. Free dead-session detection, free naming, no daemon to maintain. Decision pending real-use signals.
- **Project scoping:** project root inferred from session CWD at agent startup.

## Status: v1 shipped, dogfooding

v1 is live. The first tool, `list_project_sessions(project_root)`, is implemented as a stdio MCP server backed by `tmux list-sessions`. Registered both project-locally (via `.mcp.json` using `tsx ./src/server.ts` for the dev loop) and globally (in `~/.claude.json` and `~/.codex/config.toml`, pointing at `dist/server.js`).

Current phase is **dogfooding**: use it in real parallel-agent work and log friction in `NOTES.md` as it surfaces. The next tool will be named by observation, not by speculation. See `NOTES.md` for review notes; see the v1 plan at `~/.claude/plans/cozy-forging-hickey.md` for design rationale and deferred items.

## How to collaborate on this project

- **Do not start scaffolding.** No `package.json`, no MCP server stub, no skills, no tests — until the developer explicitly says it's time. Speculative structure will lock in design before observation has informed it.
- **Ask clarifying questions** about scope, architecture, the eventual MCP tool set, anything unclear. Surfacing assumptions now is the most useful contribution.
- **Keep observation notes in `NOTES.md`** (or a single scratchpad). Don't sprawl across multiple unstructured files. The point of the observation phase is concentrated raw material for the eventual design pass.
- **The `2026-05-06` lesson from x-mux applies here:** don't change code based on theories — change it based on observed deltas between actual behavior and current capability. Theorizing an orchestration API before real friction surfaces is the same antipattern as theorizing a UI fix before instrumenting.

## Design principles (locked in)

1. **Project-scoped, never global.** No cross-project visibility, ever.
2. **Implementation detail stays out of public naming.** tmux is plumbing.
3. **Both Claude Code and Codex CLI must work** with whatever we build. MCP is the cross-tool protocol; Skills are Claude-specific syntactic sugar that wraps MCP tools, never primary functionality.
4. **Minimum viable first.** One MCP tool that's actually used > five speculative ones.

## Deliberately deferred

- **Output capture** (vs. metadata only). Costs a wrapper layer (`script -F` or pty-mirror). Only worth doing if real friction shows metadata isn't enough.
- **Cross-session messaging** (note from session A to session B). Probably useful eventually; not until real use names the shape.
- **Skill set.** Decide after the first MCP tool exists and we know what it feels like to use raw.
- **MCP tool naming.** Pick after observation tells us the verbs.

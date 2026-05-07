# Claude Plan Feedback

Feedback on Claude's saved plan at `/Users/davidkim/.claude/plans/cozy-forging-hickey.md`.

## Strong parts

- The proposed surface is appropriately small: one MCP tool, metadata only, no daemon, no messaging, no output capture.
- Using `tmux list-sessions` as the first registry is sensible. It gets dead-session cleanup and session naming from existing infrastructure instead of creating a custom registry too early.
- `schema_version: 1` is a good low-cost choice that leaves room for response-shape changes later.

## Main concerns

- The plan assumes the project is ready to move from observation to implementation. `AGENTS.md` still says not to scaffold until the developer explicitly says it is time, so this should be treated as a ready-to-execute proposal, not active work.
- Global registration in both `~/.claude.json` and `~/.codex/config.toml` is probably too much for the first pass. Project-local `.mcp.json` should come first; global config can wait until the tool proves useful.
- `process.cwd()` inference needs validation. MCP server cwd may vary by client and config path, and it will not track agent `cd` changes after startup. The explicit `project_root` argument should be treated as the reliable path when inference is uncertain.
- The tool description says "other agent sessions," but without caller identity the tool cannot reliably exclude the caller. The contract should say it lists project sessions, not only peers.

## Suggested edits

Recommended v1 sequence:

1. Implement only the local project MCP server files.
2. Verify JSON-RPC manually.
3. Verify project-local `.mcp.json`.
4. Use it in real Claude/Codex sessions for a bit.
5. Add global registrations only after the local tool proves useful.

Suggested response shape:

```json
{
  "schema_version": 1,
  "project_root": "/Users/davidkim/dev/oxtail",
  "inferred": true,
  "sessions": [],
  "error": null
}
```

Clarify in the README and tool description that callers should pass `project_root` explicitly when inference is uncertain.

## Pushback

README and global registration snippets may be premature if this repo is still observation-driven. A first note should capture the observed friction that justified leaving pre-implementation, then the smallest local MCP implementation can follow. That keeps the project history aligned with the stated discipline in `AGENTS.md`.

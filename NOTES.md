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

## 2026-05-08 dogfooding: Codex self-registration env mismatch

- In this Codex session, `get_my_session` correctly surfaced the unresolved `client.session_id` and recommended the `register_my_session` escape hatch.
- The suggested shell command was `echo $CODEX_COMPANION_SESSION_ID`, but that variable was empty in the Codex shell. Available related vars included `CODEX_THREAD_ID`.
- `CODEX_THREAD_ID` matched the UUID in the active rollout transcript path: `~/.codex/sessions/2026/05/08/rollout-2026-05-08T09-28-33-019e07c6-8e39-7d00-aa6f-cdff47651add.jsonl`.
- Registering `CODEX_THREAD_ID` with `register_my_session` succeeded, and `list_project_sessions` then showed `oxtail3` with `client_type: codex` and the correct `client_session_id`.

Follow-up: support `CODEX_THREAD_ID` as the preferred Codex env strategy alias and use it in `next_step` guidance. **Resolved (2026-05-09):** `src/detect/envStrategy.ts:4` checks `CODEX_THREAD_ID` first, falling back to `CODEX_COMPANION_SESSION_ID`. `src/detect/index.ts:53–58` emits `echo $CODEX_THREAD_ID` in `next_step` for Codex clients. Tests at `src/detect/envStrategy.test.ts:29` and `src/detect/index.test.ts:60` cover both behaviors.

## 2026-05-08 dogfooding: self-registration UX/context overhead

- Registering this Codex session succeeded via the intended path: `get_my_session`, shell-read `CODEX_THREAD_ID`, `register_my_session`, then verify with `get_my_session`.
- Operator feedback: this felt too long-winded for a tool whose purpose is lightweight shared context across multiple sessions.
- The skill currently behaves like a visible workflow recipe. That is mechanically correct, but it spends chat/context on implementation ceremony.
- Desired UX for routine use: quiet execution and a final compact result, ideally just registration success, `session_id`, and `transcript_path`.

Follow-up: tighten the registration skill and/or add a single high-level MCP/tooling path so the common case does not bloat the transcript. **Resolved (2026-05-09):** `claim_session` is the single high-level path. The Claude `oxtail-join` command and Codex `oxtail-register` skill now use it — two tool calls (Bash echo + claim_session) instead of three or four, with a compact `{ ok, session_id, transcript_path }` response.

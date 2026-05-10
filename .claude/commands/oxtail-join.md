Initiate this Claude session's participation in oxtail's peer registry so sibling agents in this project root can resolve our `client_session_id` and read our transcript directly (rather than falling back to raw tmux pane capture).

Why this is needed: Claude Code strips `CLAUDE_CODE_SESSION_ID` from MCP children, so the oxtail server can't read our session id from its own env. The var IS available in Bash tool subshells. When two or more Claude Code sessions share a project, birth-time fingerprint matching also can't safely disambiguate. So we register manually.

Do this:

1. Run `echo "$CLAUDE_CODE_SESSION_ID"` via the Bash tool. Confirm a UUID comes back.
2. Call the oxtail MCP tool `claim_session` with `{ session_id: "<the UUID from step 1>" }`. Report back `session_id` and `transcript_path` from the response.

If step 1 returns empty, we are not running inside Claude Code — bail out and tell the user.

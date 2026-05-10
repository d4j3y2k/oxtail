---
name: oxtail-register
description: Register the current Codex agent session with the oxtail MCP peer registry. Use when the user asks to join oxtail, register with oxtail, run oxtail-register, fix oxtail client_session_id detection, or make this Codex session visible/readable to peer agents in the same project.
---

# Oxtail Register

Register this Codex session with oxtail quickly and verify the result.

## Communication Contract

This workflow is meant to be lightweight. For routine success, do not narrate
each internal step or paste diagnostic JSON. If a skill announcement is required,
keep it to one short sentence. The final response should be only:

```text
Registered: <session_id>
Transcript: <transcript_path>
```

If the session was already registered, use:

```text
Already registered: <session_id>
Transcript: <transcript_path>
```

Only explain the detection strategy, environment variables, or fallback behavior
when registration fails or the user explicitly asks.

## Workflow

1. Call `mcp__oxtail__get_my_session`.
2. If `entry.client.session_id` is already non-null, report the compact "Already registered" result and stop.
3. Run this shell command in the current project:

   ```sh
   printf '%s\n' "${CODEX_THREAD_ID:-$CODEX_COMPANION_SESSION_ID}"
   ```

4. If the command returns an empty string, do not scan transcripts unless the user asks. Report that Codex exposed neither `CODEX_THREAD_ID` nor `CODEX_COMPANION_SESSION_ID`.
5. Call `mcp__oxtail__claim_session` with `{ "session_id": "<id from step 3>" }`. The response contains `session_id` and `transcript_path` directly — no extra verification call needed. Report the compact "Registered" result.

Prefer `CODEX_THREAD_ID`; `CODEX_COMPANION_SESSION_ID` is only a compatibility fallback.

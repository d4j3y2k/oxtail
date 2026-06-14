---
name: oxtail-join
description: Join this Codex session into the oxtail MCP peer registry. Use when the user asks to join oxtail, register with oxtail, run oxtail-join, fix oxtail client_session_id detection, or make this Codex session visible/readable to peer agents in the same project.
---

# Oxtail Join

Join this Codex session into the oxtail peer registry quickly and verify the result.

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

## Receiving messages after joining (standing convention)

Codex has no PreToolUse/Stop hook, so messages arrive via `read_my_messages` rather than auto-injection. That does **not** mean you must poll:

- After you acknowledge a task or send a reply, **end your turn and go idle.** Do **not** sit in a `read_my_messages` sleep-loop, and do **not** fire a blocking `ask_peer` just to provoke a response.
- **Delivery is sender-driven.** For anything that needs you to act promptly, the peer must wake you (`ask_peer`, or `send_message`/`reply_to_message` with `wake:auto`). A wake that reaches your idle, resolvable pane send-keys-re-invokes you — call `read_my_messages` **once** at the start of that turn, then act.
- **The wake is best-effort, not a guarantee.** If a message arrives while you are mid-turn the wake is skipped (`skipped_busy`) and the message waits in your mailbox. So a single `read_my_messages` at a turn boundary — your manual equivalent of Claude's Stop hook — is reasonable to catch what landed while you were busy. That is **one** read, never a loop.
- A plain wake-less `send_message` is passive inbox traffic. Don't keep yourself alive to watch for it; you'll see it the next time you're invoked for any reason.
- When you reply, prefer `reply_to_message(message_id, …)` so the exchange stays correlated.

In short: **idle is safe — trust the wake.** The *sender* owns prompt delivery (an autonomous flow must use `ask_peer` or `wake:auto`); you must not compensate for a wake-less send by polling. Idle-polling and blocking `ask_peer`s to "wait" for a peer are the main source of avoidable latency on the Codex side.

## Owned work — durable delegation (standing convention)

A peer can hand you durable work with `send_message({ action_required: true })`. That becomes an OPEN OBLIGATION on your side that **survives a missed or mistimed wake** — it lives on disk (your received-ledger), not on the wake reaching you. So you never have to poll to avoid dropping delegated work; you just reconcile it at a turn boundary:

- `read_my_messages` includes **`open_work_count`** when you owe unfinished work. **When `open_work_count > 0`, call `my_open_work`**, do each item, then close it.
- Close every item explicitly: **`complete_work(message_id, body)`** when done (this both delivers your result to the requester and clears the obligation), or **`block_work(message_id, reason)`** if you can't. Do **not** treat an interim "working on it" reply as completion — only `complete_work` closes it.
- Forgetting to close leaves a phantom-open obligation that keeps showing up in `my_open_work` (with its age). The close tool *is* the natural reply path for delegated work — use it instead of a bare `reply_to_message`.

Because the obligation is durable, this is the autonomy-safe way to take on long or hand-off work: a wake just tells you *sooner*; the work is found regardless.

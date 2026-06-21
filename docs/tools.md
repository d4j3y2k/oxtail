# MCP tool reference

The complete reference for oxtail's MCP tools. The [README](../README.md#mcp-tools)
carries a compact summary table; this page is the full surface with every caveat.

All tools are scoped to a project root — sessions in `/path/to/foo` can only see and
message sessions in `/path/to/foo`. Cross-project calls are rejected, never silently
dropped.

Jump to: [Discovery & state](#discovery--state) · [Read & diagnose](#read--diagnose)
· [Messaging](#messaging) · [Durable delegation](#durable-delegation)

---

## Discovery & state

### `list_project_sessions`

tmux sessions in or under a given project root, enriched with `client_type`,
`client_session_id`, and the peer's `state` card.

- Returns **one row per registered agent** — rows may share `name` when peers share a
  tmux session (e.g. Terminator multi-window). Disambiguate via `client_session_id`.
- Pass `compact: true` for a de-duplicated `tmux_sessions[]` shape that hoists the
  shared tmux fields and nests agents (smaller when several agents share a session);
  the default flat `sessions[]` shape is unchanged.
- Omitting `project_root` triggers a best-effort `.git`-ancestor walk from the
  server's own cwd; the response includes `inferred: true` when this happens. Pass
  `project_root` explicitly when you can.
- Sessions whose agents are not oxtail-aware (or are not LLM agents at all — bash,
  vim, dev servers) still appear and are readable via `read_session` in pane mode.
  Dead PIDs are pruned on read.

### `set_my_state`

Write a small "state card" onto this session's registry entry so peers can see what
you're doing without reading your transcript. v1 surfaces a single field, `purpose`
(≤200 chars).

### `get_my_session`

Return this MCP server's own registry entry plus a per-strategy detection diagnosis.
When a strategy doesn't fire it returns an abstention with a `reason`, and the
response adds a top-level `next_step` block carrying the exact bash command to run
for the escape hatch — so a fresh agent can act in one round trip. Useful for
debugging identity resolution.

### `claim_session`

Single-shot session registration. The routine path:
`Bash echo $CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID` for Codex) →
`claim_session({ session_id })`. Returns `{ ok, session_id, transcript_path }`.
A claimed identity is monotonic — later automatic detection cannot clobber it.

### `register_my_session`

Pin this MCP server's `session_id` directly. Kept for debugging; prefer
`claim_session`.

---

## Read & diagnose

### `read_session`

The recent transcript of a peer session — clean per-turn messages when the peer is
oxtail-aware (Claude Code and Codex CLI), or raw tmux pane text otherwise.

> **Browse/diagnostic only — not proof a peer replied to you.** To confirm a peer
> answered, read your inbox (`read_my_messages`) or the `ask_peer` correlated reply,
> *not* `read_session`. The transcript can lag a rotated or sticky-recovered thread,
> so a quiet read here doesn't mean the peer is silent.

Each read carries freshness/provenance so you can tell what you actually read:

- `resolved_session_id` + `session_id_source` (`"env"` | `"hook-drop"` |
  `"birth-time"` | `"self-register"` | `"sticky-claim"`) — *which* identity/thread
  you read and how it was derived. A `"sticky-claim"` source with a many-minutes-old
  transcript is the classic stale-thread shape (trust the mailbox instead).
- `transcript_mtime` / `transcript_age_seconds` — how stale the backing file is. On a
  transcript read, null mtime/age means the backing file is gone/unreadable (rotated
  away), itself a staleness tell.

Provenance rides every in-scope exit (transcript reads, pane reads, and the in-scope
error/no-transcript cases); only out-of-scope/unknown/ambiguous rejections leave it
`null` (emitting an out-of-project id would leak across the scope boundary).

**Inputs.** Accepts a tmux session name OR a `client_session_id` UUID; an ambiguous
tmux name returns `ambiguous-target` with the candidate UUIDs.

**Budgets** (so a casual read can't blow your context window): by default the last
20 messages and ~24KB of text (newest-first), per-message ISO timestamps omitted.
`count_truncated` / `bytes_truncated` say which budget bit. Raise `limit` +
`max_bytes` to pull more, set `include_timestamps: true` to keep timestamps, and pass
`tail_scan: true` to read the file tail without parsing the whole transcript
(qualifies `total_messages` via `total_messages_exact`).

### `message_status`

**Did my message land?** Pass a `message_id` returned by `send_message` /
`reply_to_message` / `ask_peer`:

- `"delivered"` — the recipient's hook envelope, `read_my_messages`, or `ask_peer`
  reply drain handed it into the agent's context (with `delivered_at`, `via`, and
  `recipient_session_id`).
- `"pending"` — still queued in the recipient's inbox; wake it if it needs prompting.
- `"unknown"` — with the likely cause (recipient on a pre-receipt version, mistyped
  id, or aged out — receipts/outbox prune after ~7 days).

Receipts are written write-once by the *recipient* side at hand-off; this is
delivery-into-context, not proof the agent acted — use `ask_peer` for an acknowledged
exchange.

---

## Messaging

### `send_message`

**Fire-and-forget** message to a peer. Target is a tmux session name or a raw
`client_session_id` UUID. Body ≤ 8KB. Delivery is async via the peer's mailbox file.

- A plain message does **not** wake an idle peer; pass `wake: "auto"` to nudge one
  (state-gated — see the [wake model](protocol.md#waking-an-idle-peer)).
- Replies to `ask_peer` should pass `reply_to: "<request_id>"` when the inbound
  message carries a `request_id` — and a reply **auto-wakes the requester by
  default** (strictly gated; `wake: "off"` opts out).
- Pass `action_required: true` to make it a durable **delegation**: the (claimed)
  receiver gains an OPEN OBLIGATION it discovers via `my_open_work` and closes via
  `complete_work` / `block_work`, surviving a missed wake — and `wake` then defaults
  to `auto`.
- A plain send (no `wake`, no `reply_to`) to a **claimed** peer that won't read it
  this turn returns a `delivery_outlook` + `hint` so a silent strand is visible at
  send time: `"stranded_until_read"` (idle/stale-busy — read at its next turn or a
  wake) or `"unknown_liveness"` (Codex/hookless, no activity marker). It is **omitted**
  wherever a `wake_status` already speaks (a mid-turn peer whose hooks deliver, one you
  woke with `wake: "auto"`, a reply) or you chose fire-and-forget (`wake: "off"`) — an
  absent `delivery_outlook` means *that path reports via `wake_status`, or you opted
  out*, **not** that delivery is guaranteed.

Returns `{ ok, message_id, target_session_id, target_server_pid, wake_status, delivery_outlook?, ... }`.
Sending to a peer with the same tmux session name as another live peer returns
`ambiguous-target` with the candidate `client_session_id`s.

### `read_my_messages`

Drain this session's mailbox and return any queued messages. Messages include
`from_session_id`, server-stamped `origin: "peer"`, and optional `request_id` /
`reply_to`. Also surfaces `open_work_count`; when it's >0, call `my_open_work`.

Codex peers (and unhooked Claude Code) call this once at a turn boundary; Claude Code
peers with the hooks installed see messages mid-turn (PreToolUse) or at turn end
(Stop) instead. Both delivery paths are destructive — after a hook delivery,
`count: 0` here means "nothing left in the mailbox," not "nothing arrived."

### `reply_to_message`

**Reply by `message_id`** — the atomic, correlation-safe alternative to hand-wiring
`send_message`'s `target` + `reply_to`. Pass the `message_id` the hook or
`read_my_messages` showed you; the server looks the inbound envelope up in this
session's durable **received-ledger**, derives the reply target (the original
sender), carries `reply_to: request_id` when the inbound was an `ask_peer` (keeping
the exchange correlated), and stamps `source_message_id`.

Replying to a plain `send_message` works too — it just omits `reply_to`. Ownership is
structural (you can only reply to a message delivered to *you*); fail-closed on an
unknown/aged-out id. Same wake semantics as `send_message`, including the
wake-on-reply default.

### `ask_peer`

**Delegate-and-wait.** Enqueues a message with a `request_id` and blocks server-side
until the peer replies with `send_message({ reply_to: request_id })` or the timeout
elapses.

- Default timeout is 60s (`OXTAIL_ASK_PEER_TIMEOUT_MS`). Each call may pass
  `timeout_ms`: the schema accepts up to 300000ms, but the **effective** wait is
  clamped to `OXTAIL_ASK_PEER_MAX_TIMEOUT_MS` (default 100000ms) so it can't outlast
  the client's tool-call abort window — the response reports `timeout_clamped_from_ms`
  when a request was clamped.
- New peers use strict `reply_to` correlation; legacy/no-capability peers fall back to
  best-effort first-message matching and the response reports
  `correlation: "uncorrelated"` (treat as compatibility-only — it may stale-match old
  same-peer chatter).
- **Durable on timeout.** If the wait elapses, the request is recorded as a pending
  obligation, so when the peer's reply finally arrives — minutes or hours later — it
  *wakes the requester back* (`wake_reason: "late_reply_to_pending"`) instead of
  landing silently. That makes `ask_peer` safe for long-running delegations: let it
  time out, end the turn, get pulled back when the work is done. See
  [Durable ask_peer](protocol.md#durable-ask_peer-long-efforts).

The target peer must have a registered `client.session_id`; an unclaimed Codex target
returns `peer-has-no-session-id`. Full response shape and wake-status meanings are in
the [protocol doc](protocol.md#delegate-and-wait).

---

## Durable delegation

The obligation verbs make a delegated task survive a missed/mistimed wake — the
receiver owns it on disk until it closes it, independent of whether any wake reached
it. See [Durable delegation](protocol.md#durable-delegation) for the full model.

### `my_open_work`

List the durable **delegations you own but haven't finished** (the obligations
created when a peer sent you `action_required: true`). The PULL source of truth for
owned work: it reads your received-ledger, independent of the mailbox (already
drained) and of whether any wake reached you — so a missed / mistimed / crossed wake
never strands delegated work; you rediscover it here on your next turn.
`read_my_messages` surfaces `open_work_count`; when it's >0, call this, do each item,
then close it. Oldest-first (most overdue first), budgeted.

### `complete_work`

**Close a delegation you own as DONE and notify the requester in one step.** Pass the
obligation's `message_id` and your result as `body`: it delivers the result to the
original requester (correlated when the delegation was an `ask_peer`), wakes them by
default, and stamps the obligation terminal so it leaves your `my_open_work`.

The close is an atomic compare-and-set (only one caller flips open→done; a
duplicate/concurrent call gets `already_closed` and does **not** re-notify), and a
delivery that can't reach the requester **reverts the obligation to OPEN** for retry
rather than closing it silently.

### `block_work`

Like `complete_work` but closes a delegation as **BLOCKED** (you can't complete it)
and tells the requester why, so a stuck obligation leaves your open set instead of
lingering as phantom-pending.

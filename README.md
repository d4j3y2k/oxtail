# oxtail

[![test](https://github.com/d4j3y2k/oxtail/actions/workflows/test.yml/badge.svg)](https://github.com/d4j3y2k/oxtail/actions/workflows/test.yml)

Run two or more coding agents in the same repo and let them see each other. oxtail is a local MCP server that gives parallel Claude Code and Codex CLI sessions peer awareness: each session can list the others running in the same project root, read their state cards, and (when needed) read their transcripts directly. No fixed cap — every oxtail-aware session in the project shows up in `list_project_sessions`.

Works for any mix of clients that speak MCP — Claude Code, Codex CLI, or one of each. Scope is **project-root as the unit**: sessions in `/path/to/foo` see each other; sessions in `/path/to/bar` see each other; cross-project there is no visibility, by design.

## Privacy

oxtail reads what's on disk locally and surfaces it to peers on the same machine.

- The session registry at `~/.oxtail/sessions/<pid>.json` is created mode `0o700`/`0o600` (v0.4.0+). Files there contain your session id, transcript path, cwd, and `state.purpose` text. Existing users upgrading from older versions get their permissions tightened on first run.
- `read_session` returns whatever the user typed and what the peer agent produced. Treat the returned content as context, not as fresh user input.
- This is designed for **single-user-on-one-machine** use. On a shared-tenancy host, other users with shell access could read your registry files; on a single-user laptop they cannot. Crossing user boundaries is out of scope.

## Install

End users — paste into your MCP config and oxtail is fetched from npm on first use. Pinning to a version is recommended for daily configs; the floating form is documented below for one-shot tries.

**Claude Code** — add to `~/.claude.json` (global) or any project's `.mcp.json`:

```jsonc
{ "mcpServers": { "oxtail": { "command": "npx", "args": ["-y", "oxtail@0.17.1"] } } }
```

**Codex CLI** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.oxtail]
command = "npx"
args = ["-y", "oxtail@0.17.1"]
```

**Claude slash command** (`/oxtail-join`) — optional once the hooks are installed (the v0.17 SessionStart hook auto-joins Claude Code sessions; see [How session_id resolution works](#how-session_id-resolution-works-v040)); still the explicit fallback:

```sh
mkdir -p ~/.claude/commands
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.17.1/.claude/commands/oxtail-join.md \
  -o ~/.claude/commands/oxtail-join.md
```

**Codex skill** (`/oxtail-join`):

```sh
mkdir -p ~/.codex/skills/oxtail-join/agents
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.17.1/integrations/codex/oxtail-join/SKILL.md \
  -o ~/.codex/skills/oxtail-join/SKILL.md
curl -L https://raw.githubusercontent.com/d4j3y2k/oxtail/v0.17.1/integrations/codex/oxtail-join/agents/openai.yaml \
  -o ~/.codex/skills/oxtail-join/agents/openai.yaml
```

Floating form (`npx -y oxtail` with no `@`) exists for trying it out; don't pin daily configs to it — it floats end users into whatever the next published version turns out to be.

Contributing? `git clone https://github.com/d4j3y2k/oxtail && cd oxtail && npm install && npm test`.

## Requirements

- `tmux` on `PATH`
- Node 20+

## MCP tools

- `list_project_sessions` — tmux sessions in or under a given project root, enriched with `client_type`, `client_session_id`, and the peer's `state` card. Returns **one row per registered agent** — rows may share `name` when peers share a tmux session (Terminator multi-window). Disambiguate via `client_session_id`. Pass `compact: true` for a de-duplicated `tmux_sessions[]` shape that hoists the shared tmux fields and nests agents (smaller when several agents share a session); the default flat `sessions[]` shape is unchanged.
- `read_session` — the recent transcript of a peer session, as clean per-turn messages when the peer is oxtail-aware (Claude Code and Codex CLI), or as raw tmux pane text otherwise. **Browse/diagnostic only — not proof a peer replied to you:** to confirm a peer answered a request, read your inbox (`read_my_messages`) or the `ask_peer` correlated reply, *not* `read_session`. The transcript can lag a rotated or sticky-recovered thread, so a quiet read here doesn't mean the peer is silent. Each read therefore carries freshness/provenance: `resolved_session_id` + `session_id_source` (`"env"` | `"hook-drop"` | `"birth-time"` | `"self-register"` | `"sticky-claim"`) say *which* identity/thread you read and how it was derived, and `transcript_mtime` / `transcript_age_seconds` say how stale the backing file is — a `"sticky-claim"` source with a many-minutes-old transcript is the classic stale-thread shape (trust the mailbox instead); on a transcript read, null mtime/age means the backing file is gone/unreadable (rotated away), itself a staleness tell. Provenance (`resolved_session_id` + `session_id_source`) rides every in-scope exit — transcript reads, pane reads, and the in-scope error/no-transcript cases — so you can always tell which identity answered; only the out-of-scope/unknown/ambiguous rejections leave it `null` (emitting an out-of-project id would leak across the scope boundary). The transcript mtime/age are transcript-only. Accepts a tmux session name OR a `client_session_id` UUID; an ambiguous tmux name returns `ambiguous-target` with the candidate UUIDs. Transcript reads are **budgeted** so a casual read can't blow your context window: by default the last 20 messages and ~24KB of text (newest-first), per-message ISO timestamps omitted. `count_truncated` / `bytes_truncated` say which budget bit; raise `limit` + `max_bytes` to pull more, set `include_timestamps: true` to keep timestamps, and pass `tail_scan: true` to read the file tail without parsing the whole transcript (qualifies `total_messages` via `total_messages_exact`).
- `claim_session` — single-shot session registration. The routine path: `Bash echo $CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID` for Codex) → `claim_session({ session_id })`. Returns `{ ok, session_id, transcript_path }`.
- `set_my_state` — write a small "state card" onto this session's registry entry so peers can see what we're doing without reading our transcript. v1 surfaces a single field, `purpose` (≤200 chars).
- `send_message` — **fire-and-forget** message to a peer. Target is a tmux session name or a raw `client_session_id` UUID. Body ≤ 8KB. Delivery is async via the peer's mailbox file. A plain message does **not** wake an idle peer; pass `wake: "auto"` to nudge one (state-gated — see [Waking an idle peer](#waking-an-idle-peer)). Replies to `ask_peer` should pass `reply_to: "<request_id>"` when the inbound message carries a `request_id` — and a reply **auto-wakes the requester by default** (strictly gated; `wake: "off"` opts out). (v0.5+)
- `read_my_messages` — drain this session's mailbox and return any queued messages. Messages include `from_session_id`, server-stamped `origin: "peer"`, and optional `request_id` / `reply_to`. Codex peers (and unhooked Claude Code) poll this; Claude Code peers with the hooks installed see messages mid-turn (PreToolUse) or at turn end (Stop) instead. (v0.5+)
- `ask_peer` — **delegate-and-wait**. Enqueues a message with a `request_id` and blocks server-side until the peer replies with `send_message({ reply_to: request_id })` or the timeout elapses. Default timeout is 60s (`OXTAIL_ASK_PEER_TIMEOUT_MS`), and each call may pass `timeout_ms`. New peers use strict `reply_to` correlation; legacy/no-capability peers fall back to best-effort first-message matching and the response reports `correlation: "uncorrelated"`. That legacy path may stale-match old same-peer chatter, so callers should treat `uncorrelated` as compatibility-only. **Durable on timeout (v0.15+):** if the wait elapses, the request is recorded as a pending obligation, so when the peer's reply finally arrives — minutes or hours later — it *wakes the requester back* (`wake_reason: "late_reply_to_pending"`) instead of landing silently. That makes `ask_peer` safe for long-running delegations: let it time out, end the turn, get pulled back when the work is done. Use `send_message` for fire-and-forget. (v0.7+)
- `reply_to_message` — **reply by `message_id`**. The atomic, correlation-safe alternative to hand-wiring `send_message`'s `target` + `reply_to`: pass the `message_id` the hook or `read_my_messages` showed you and the server looks the inbound envelope up in this session's durable **received-ledger**, derives the reply target (the original sender), carries `reply_to: request_id` when the inbound was an `ask_peer` (keeping the exchange correlated), and stamps `source_message_id`. Replying to a plain `send_message` works too — it just omits `reply_to`. Ownership is structural (you can only reply to a message delivered to *you*); fail-closed on an unknown/aged-out id. Same wake semantics as `send_message`, including the wake-on-reply default. (v0.13+)
- `register_my_session` — pin this MCP server's `session_id` directly. Kept for debugging; prefer `claim_session`.
- `get_my_session` — return this MCP server's own registry entry plus a per-strategy detection diagnosis. Useful for debugging.

See [design principles](https://github.com/d4j3y2k/oxtail/blob/v0.17.1/AGENTS.md) for scope and architecture.

## Usage from an agent

```
claim_session({ session_id: "<uuid from $CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID>" })
set_my_state({ purpose: "wiring up state cards" })
list_project_sessions({ project_root: "/path/to/project" })
read_session({ name: "primary" })                    // auto: transcript if peer registered, else pane (budgeted: last 20 msgs, ~24KB)
read_session({ name: "claude", mode: "transcript", limit: 50, max_bytes: 60000 })  // pull more
read_session({ name: "claude", mode: "transcript", include_timestamps: true })      // keep ISO timestamps
read_session({ name: "claude", mode: "transcript", tail_scan: true })               // fast tail read on huge transcripts
read_session({ name: "primary", mode: "pane", pane_lines: 500, pane_max_chars: 40000 })
read_session({ name: "<peer-uuid>", mode: "transcript" })   // UUID form: needed when peers share a tmux session
send_message({ target: "primary", body: "<system-reminder>checking in</system-reminder>" })
send_message({ target: "<peer-uuid>", body: "...", reply_to: "<ask request_id>" })  // correlated reply
read_my_messages()
ask_peer({ target: "primary", body: "[Handoff] please audit X and tell me what you find" })
  // → blocks server-side until the peer replies via send_message, then returns their body
reply_to_message({ message_id: "<id from the hook / read_my_messages>", body: "..." })
  // → looks up the inbound envelope, derives target + reply_to itself; correlated when the inbound was an ask_peer
```

Omitting `project_root` triggers a best-effort `.git`-ancestor walk from the server's own cwd. The response includes `inferred: true` when this happens. Pass `project_root` explicitly when you can.

## Peer awareness without raw transcripts

The cheapest way to learn what peers are doing is `list_project_sessions`. Each row carries an optional `state` card written by the peer via `set_my_state` — currently `{ purpose, updated_at }`. Reading the card costs almost nothing compared to `read_session`, which — even budgeted (last 20 messages / ~24KB by default) — spends real tokens on transcript content. Use `read_session` when the card isn't enough.

## Peer messaging (v0.5)

Two MCP tools let peers in the same project root talk to each other:

```
send_message({ target: "<tmux-session-name OR client_session_id UUID>", body: "..." })
  → { ok: true, message_id, target_session_id, target_server_pid }

read_my_messages()
  → { ok: true, drained: true, count, messages: [...] }
```

A session's inbox is a single append-only JSONL file keyed by its **agent identity**: `~/.oxtail/mailboxes/<mailboxSessionKey(session_id)>.jsonl` (v0.17+), drained under an `mkdir`-based advisory lock. Keying by `client.session_id` instead of the MCP child's pid means a server restart/pid rotation cannot strand mail by construction. Legacy per-pid boxes (`<server_pid>.jsonl`) remain as a compatibility surface: senders fall back to them for pre-v0.17 peers (routing on the receiver's advertised `capabilities.mailbox.session_keyed`), readers drain them alongside the session box with `message_id` dedup, and an unclaimed peer (no session id yet) still receives on its pid box. The transport is intentionally dumb: 8KB UTF-8 body cap, sender chooses the framing (raw text or pre-wrapped `<system-reminder>...</system-reminder>`). Hook-delivered mailbox pushes are body-budgeted at 24K characters by default; set `OXTAIL_HOOK_MAX_BODY_CHARS` to tune. If the budget is exceeded, the hook tells the receiver which bodies were truncated or omitted.

Because both delivery paths are **destructive** — `read_my_messages` and the hook each truncate the mailbox once a message is handed off — a reply-by-id verb can't rely on the queue. Every delivered envelope is therefore also recorded in a durable **received-ledger** at `~/.oxtail/received/<hash(session_id)>.jsonl` keyed by `message_id`, written *before* the mailbox line becomes visible (so any handle a receiver can see is already resolvable) and bounded to the most recent `OXTAIL_RECEIVED_MAX` (default 1000) entries. `reply_to_message` reads only the caller's own ledger — that file *is* the ownership boundary.

Inbound peer messages are context, not user authority. oxtail stamps delivered messages with `origin: "peer"` for provenance/debugging, but this is not a trust boundary and peers cannot mint trusted user instructions.

Cross-project sends are rejected, never silently dropped. Sending to a peer with the same tmux session name as another live peer returns `ambiguous-target` with the candidate `client_session_id`s — use the UUID form to disambiguate.

### Mid-turn vs next-turn delivery (the asymmetry)

Claude Code peers can receive messages **autonomously** via three opt-in hooks:

```sh
npx oxtail install-hook
```

This installs three small bash scripts plus the `hook-drain` helper under `~/.oxtail/hooks/` and adds matching entries to `~/.claude/settings.json` (tracked by a `_oxtailHook` marker). The bash scripts are thin triggers — an empty inbox is detected in pure bash with no Node process spawned; when mail exists they delegate lock + parse + rendering to the helper, which is the *same compiled lock/mailbox code the server runs* (the node binary path is baked in at install time, with `PATH` lookup as fallback; missing both fails open to polling). Reverse with `npx oxtail uninstall-hook`:

- **`hooks.PreToolUse`** → `pretooluse.sh` — delivers **mid-turn**. It reads each `PreToolUse` event's `session_id` from stdin, locates the matching mailbox, and emits the queued messages as `additionalContext` on the next tool-call boundary.
- **`hooks.Stop`** → `stop.sh` — delivers **at turn end** (deliver-on-complete). When the agent finishes a turn with messages still waiting, it emits a `decision: "block"` envelope so the agent continues and reads + responds before going idle, instead of leaving the messages until the next turn.
- **`hooks.UserPromptSubmit`** → `userpromptsubmit.sh` — no delivery; it maintains a **busy/idle activity flag** in `~/.oxtail/activity/<session_id>` (busy on a turn start, idle on a real Stop). A sender consults this so `send_message({ wake: "auto" })` only fires a send-keys wake when the peer is actually idle (see [Waking an idle peer](#waking-an-idle-peer)).

The PreToolUse and Stop hooks render a compact one-line header per message — `message_id`, `from_session_id`, and optional `request_id` / `reply_to`, using the full protocol field names so they map directly onto `send_message`'s arguments — followed by the body, so a receiver can reply with `send_message({ target: "<from_session_id>", body: "...", reply_to: "<request_id>" })` even when the sender is not visible in `list_project_sessions`. The single-valued `origin: "peer"` field stays in the mailbox JSONL as provenance but is no longer rendered into context — it carries nothing the peer-message framing doesn't already imply. Hook-delivered bodies are budgeted by `OXTAIL_HOOK_MAX_BODY_CHARS` (default 24000) so a mailbox burst cannot consume an unbounded context slice.

Hook delivery drains the mailbox before injecting the context. If a receiver calls `read_my_messages` immediately after reading hook-delivered bodies, `count: 0` means "nothing left in the mailbox," not "nothing arrived."

Codex CLI peers and any Claude Code session without the hooks installed receive messages **next-turn** by calling `read_my_messages` explicitly. Both clients send messages identically. The asymmetry exists because Claude Code exposes PreToolUse/Stop/UserPromptSubmit hook surfaces that inject context or fire on lifecycle events; Codex CLI does not currently expose an equivalent.

**Coverage and its edges.** PreToolUse fires only before a tool call, so a turn that produces only text — no tool calls — never triggers it; the Stop hook closes that gap by delivering at turn end. One deliberate edge remains: the Stop hook honors the `stop_hook_active` flag and exits without blocking on a re-entry, so `decision: "block"` can never loop — which means a message that arrives *during* a Stop-blocked continuation waits for the next turn rather than extending the current one. A truly idle peer (no turn in flight) is reached by `send_message({ wake: "auto" })` or `ask_peer` (both fire an external wake), or by an explicit `read_my_messages`.

### Waking an idle peer

`send_message` is fire-and-forget by default. Pass `wake: "auto"` to also nudge an **idle** peer into a turn so it drains its mailbox promptly:

```js
send_message({ target: "<peer>", body: "...", wake: "auto" })
// → { ok: true, message_id, ..., wake_status: "fired" | "skipped_busy" | "skipped_no_target" | "disabled" }
```

It is **state-gated** off the activity flag above: if the peer is mid-turn (`busy`), the wake is skipped (`skipped_busy`) because its PreToolUse/Stop hooks will deliver during the turn — no point typing into a busy composer. Idle, unknown (hooks not installed), or stale-busy peers get a per-client `tmux send-keys` wake (Codex gets the paste-burst-aware gap; Claude Code does not). `wake: "off"` preserves the pure fire-and-forget contract.

**Wake-on-reply (the default for replies).** A reply — a `send_message` that carries `reply_to` — auto-wakes the requester **by default**, so an awaited answer doesn't strand an idle peer and force a human to relay it. You don't have to remember `wake: "auto"`; pass `wake: "off"` to opt out.

```js
send_message({ target: "<requester>", body: "...", reply_to: "<request_id>" })
// → { ok: true, ..., wake_status: "...", wake_reason: "reply_to_default" }
```

The reply path is deliberately **stricter** than explicit `wake: "auto"`. It fires only when the target is **freshly idle** — an `idle` activity marker newer than `OXTAIL_AUTOWAKE_FRESH_IDLE_MS` (default 5 min). Stale, unknown, missing, or busy state yields `skipped_no_fresh_idle` (no best-effort wake — typing unprompted into a terminal that may be unattended is the risk we refuse to take). Two more guards bound it: a **per-target rate limit** (`OXTAIL_AUTOWAKE_MIN_INTERVAL_MS`, default 4s → `skipped_rate_limited`) since one wake already drains the whole mailbox, and a **one-wake dedupe** keyed on `(session_id, reply_to)` (`skipped_deduped`) so a duplicate or late hook drain of the same reply can't re-fire. If the dedupe/rate store is somehow unwritable the wake degrades to `skipped_store_error` rather than failing the (already-delivered) message. The env kill-switch `OXTAIL_AUTOWAKE=off` disables reply auto-wake entirely (`wake_status: "disabled"`). Every outcome that reaches the gate surfaces a `wake_status`; the reply path also stamps `wake_reason: "reply_to_default"` (present even on a resolve error like `ambiguous-target`, where there's no single target to wake).

**Coverage (which requesters this reaches).** The fresh-idle gate keys on the requester's busy/idle activity marker, which only the Claude Code hooks maintain. So wake-on-reply currently closes the stranding for a **hooked Claude Code requester** (the originally-observed case: a peer's async reply to an idle Claude session). A **Codex** requester — or a Claude requester without the hooks installed — has no idle marker, so a reply with `wake` unset returns `skipped_no_fresh_idle` and is **not** auto-woken; reach it with an explicit `wake: "auto"`, which always takes the lenient wake path (idle/unknown/stale all wake; only a fresh-`busy` peer is skipped) and bypasses the strict fresh-idle gate even for a reply.

For the **`ask_peer` case specifically**, the Codex/unhooked-requester direction is now closed *by default* (v0.15+, see [Durable `ask_peer`](#durable-ask_peer-long-efforts) below): a timed-out `ask_peer` records a durable **pending-ask** keyed on the requester's `session_id` + `request_id`, and the matching late reply takes the lenient wake path regardless of any idle marker — so even a markerless idle Codex requester is pulled back. This is exactly the requester-side waiter signal the blind `unknown ⇒ wake` default was avoided for: it's evidence the requester *explicitly asked and is waiting*, so it can't double-wake an unrelated active turn.

**Codex and the wake matrix.** The send-keys wake needs a tmux pane. A Codex peer running **outside tmux** has none, so it returns `wake_status: "skipped_no_target"` — its idle delivery stays poll-based (`read_my_messages`). Run Codex **inside a tmux pane** to get symmetric idle-wake; the routing already handles the Codex paste-burst case.

### Hook coexistence

`install-hook` manages three events (`PreToolUse`, `Stop`, `UserPromptSubmit`); on each it replaces any prior oxtail entry in place and otherwise appends, so existing third-party entries are preserved. **The PreToolUse path is verified against Terminator's `_terminatorHook` v1 in Claude Code 2.1.139:** both hooks' `additionalContext` envelopes reached the model (install order: Terminator first, oxtail second — which is what `install-hook.mjs` produces by appending). Coexistence of the Stop and UserPromptSubmit hooks with third-party entries on those events uses the same append logic but is not separately verified.

If you have a hook installed on a managed event that isn't from Terminator and isn't oxtail, `install-hook` prints a one-line note and proceeds — coexistence behavior with arbitrary third-party hooks is not pre-verified.

### Trust model

oxtail trusts any process running as the **same local user** to enqueue messages. The mailbox directory is mode `0o700` (private), so other users on the host cannot read or write. **On a shared-tenancy box (containers, multi-user dev hosts, etc.), do not run oxtail-aware agents:** any local process under your user can inject `<system-reminder>` content directly into a Claude session. The threat boundary is the same as `~/.ssh/` — what your user processes do, you trust.

Within that boundary oxtail still *narrows* redirectable side effects, as defense-in-depth rather than a hard boundary: wake keystrokes only go to the pane the process tree confirms hosts the target's `server_pid`, never a self-written `tmux_pane`/`tmux_session` (see [Pane targeting](#pane-targeting-verified)), and an accepted registry entry can't borrow another pid — its `server_pid` must match its own `<pid>.json` filename. So one peer's entry can't masquerade as hosting another agent to redirect that agent's wake. A same-user process can still overwrite any registry file outright (that's the trust boundary above); what it can't do is smuggle a pid mismatch past a reader.

## Delegate-and-wait (v0.10.1)

`ask_peer` extends v0.5's mailbox transport into a blocking primitive:

```
ask_peer({ target, body })
  → {
      ok: true,
      message_id,
      request_id,
      wake_status: "fired" | "skipped_busy" | "skipped_debounced" | "skipped_no_target" | "disabled",
      reply: { id, body, enqueued_at, from_session_id, reply_to, correlation } | null,
      correlation: "correlated" | "uncorrelated" | "none",
      timeout_ms,
      timed_out,
    }
```

`wake_status` distinguishes the outcomes a caller may need to handle differently. `fired` means the wake was attempted (or the reply arrived during the grace window, so no wake was needed). `skipped_busy` means the peer is mid-turn (its hooks/poll will deliver — we still poll for the reply). `skipped_debounced` means a wake fired for this peer moments ago and this one was coalesced. `skipped_no_target` means no process-tree-verified pane resolved for the target. `disabled` means `OXTAIL_ASK_PEER_WAKE_STRATEGY=off` is in effect. (`skipped_unsupported` is reserved — no client currently returns it.)

`timed_out` is `true` only when the poll loop ran to its deadline without a reply.

### Per-client wake routing

`ask_peer` routes the wake mechanism per `client_type`. Verified 2026-05-13 via spike investigations and end-to-end falsifying experiments against the live `oxtail-codex` and `oxtail-claudejr` peers in this repo:

- **Codex** — `tmux send-keys -l <text>` followed by `send-keys Enter` is the wake. The keystrokes are split by 500ms because Codex's TUI has a paste-burst heuristic in `codex-rs/tui/src/bottom_pane/paste_burst.rs` (`PASTE_BURST_MIN_CHARS=3`, `PASTE_ENTER_SUPPRESS_WINDOW=120ms`) that converts Enter→newline for ~120ms after a fast typed burst. Without the gap, the wake text accumulates in the composer and Enter is suppressed. With the gap, Codex submits and enters a turn. 500ms is a deliberately generous multiple of the documented window for upstream-drift safety.

- **Claude Code** — `tmux send-keys -l <text>` + immediate `send-keys Enter`, no inter-keystroke gap. The Claude Code TUI has no paste-burst suppression, so back-to-back text+Enter submits cleanly. Once the peer is in a turn, the oxtail PreToolUse hook drains queued messages as `additionalContext` on the peer's first tool call (or the peer reads them explicitly via `read_my_messages`). v0.7 originally shipped a fail-fast here, reasoning from the [hook catalog](https://code.claude.com/docs/en/hooks) that "no idle hook" meant "unwakeable" — but send-keys is a TUI-input mechanism, not a hook event, and it submits the same way a human keypress would. The fail-fast was a self-inflicted gap against oxtail's symmetric-matrix vision (Claude↔Claude, Claude↔Codex, both directions); restored to symmetric wake in the v0.7 follow-up after an end-to-end falsifying experiment confirmed the full round-trip works.

- **Unknown** — legacy v0.6 wake (text + Enter, no gap). No implied promise; if a new TUI lands, treat it as unknown until verified.

### Wake strategy override

`OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` (default `auto`):

- `auto` — per-client routing above.
- `legacy` — v0.6 behavior for every client (no paste-burst gap, no per-client routing). Escape hatch if auto mode misfires.
- `off` — wake disabled entirely; ask_peer becomes a pure blocking poll. Response surfaces `wake_status: "disabled"`. Useful as a rollback if a Codex update changes the paste-burst constants and the auto-mode delay no longer covers the window.

### Mechanics

1. Enqueue `body` into the target's mailbox (same as `send_message`).
2. Wait ~500ms for a hook-delivered reply (rare path — handles the case where the peer was already mid-tool-call and replied immediately).
3. Route and fire the wake via `wake_status` resolution (see above).
4. Poll the caller's mailbox at 200ms. For reply-to-capable peers, only a message with both `from_session_id == target.session_id` and `reply_to == request_id` satisfies the wait; non-matching messages stay in the mailbox untouched. Legacy/no-capability peers are best-effort and are marked `correlation: "uncorrelated"`; this preserves old peers but can stale-match old same-peer chatter.
5. Return the reply on match, or `{ reply: null, timed_out: true, wake_status, correlation: "none" }` after the timeout. Late replies fall back to the normal v0.5 hook / `read_my_messages` path — never lost, just delivered out of band.

### Pane targeting (verified)

A peer's cached `tmux_pane` / `tmux_session` are written by the peer into its **own** registry file, so they aren't trustworthy targets for keystrokes — a malicious local peer could point them at someone else's pane. The **only** send-keys target oxtail uses is the pane the live process tree says currently hosts the peer's `server_pid` (resolved at wake-time via `ps`/`tmux` ancestry — unforgeable by editing a JSON file). This also handles pane-id churn for free: the pane is always re-resolved fresh. If `server_pid` can't be bound to any live pane, oxtail **refuses** to wake (`wake_status: "skipped_no_target"`) rather than fall back to a self-written value. `server_pid` itself is self-written too, so registry entries whose `server_pid` doesn't match their own `<pid>.json` filename are rejected — a forged entry can't borrow another process's pane. The pane id that does reach `tmux` is shape-validated (`%\d+`); session names are no longer used as a send-keys target at all. (Hardening from issue #6.)

### Wake debouncing

All wake paths funnel through one place, which **coalesces** rapid repeat wakes to the same peer: if a wake fired for a peer within `OXTAIL_WAKE_DEBOUNCE_MS` (default 1s), a follow-up wake is skipped (`wake_status: "skipped_debounced"`) and relies on the still-pending response. This keeps a retried `ask_peer`, two callers racing the same peer, or a polling loop from stacking notification lines into the peer's composer. In-memory and per-process by design. (Issue #5.)

### Constraints

- The target peer must have a registered `client.session_id`. Codex peers must call `claim_session` / `register_my_session` first; without that, `ask_peer` returns `error: "peer-has-no-session-id"` rather than guessing.
- Timeout defaults to 60000ms — enough headroom for a slower multi-tool-call peer reply (e.g. a Codex peer running `set_my_state` + `reply_to_message` + composing a report, observed ~46s) while staying under both known callers' tool-call abort windows (Claude Code is clean to ~60s; Codex aborts ~120s). Pass `timeout_ms` on a call when a specific delegation needs a different bound; max 300000ms.

### Tuning the timeout

If `ask_peer` returns an abort error before its built-in 60s timeout fires, your MCP client's tool-call ceiling is lower than 60s. Override the bound at server startup:

```sh
OXTAIL_ASK_PEER_TIMEOUT_MS=30000 npx -y oxtail@0.17.1
```

The server reads the env var once at boot and uses it as the fixed timeout for all `ask_peer` calls in that session. Values must be positive numbers; anything else falls back to the 60000ms default.

### Durable `ask_peer` (long efforts)

The blocking wait is a *short* primitive (bounded by the client's tool-call abort window, ~60s). A real task can take minutes or hours — far longer than any wait can block. So `ask_peer` decouples the **wait** from the **delivery of the answer**:

- On timeout (for a correlated peer + a claimed requester), the request is recorded as a durable **pending-ask** at `~/.oxtail/pending-ask/p-<hash(session_id, request_id)>`, keyed on the *requester's* `session_id` + `request_id`. A `recordPendingAsk` runs **before** one final authoritative union-drain of the requester's mailbox (write-before-final-drain), so a reply that lands in the poll-vs-deadline gap is returned immediately, and a reply that arrives later finds the persisted record.
- When that reply eventually arrives, `resolveSendWake` finds the matching pending-ask, **consumes it** (atomic `unlink`, single-winner — a duplicate/re-delivered reply can't re-fire), and takes the **lenient** wake path (`wake_reason: "late_reply_to_pending"`). Because the record is *proof the requester explicitly asked and is waiting*, the wake fires regardless of the 5-min fresh-idle window — and reaches a **markerless idle Codex** requester that the strict reply-default would skip. It also stamps the autowake dedupe for `(session_id, request_id)` so a later duplicate can't strict-wake via the fresh-idle fallback.
- `wake: "off"` still **consumes** the record (the obligation is satisfied — leaving it would let a later duplicate wake and violate the explicit off) but suppresses the wake (`wake_reason: "late_reply_to_pending_suppressed"`). The automatic (wake-unset) path honors `OXTAIL_AUTOWAKE=off` (`wake_status: "disabled"`); an explicit `wake: "auto"` intentionally does not.
- The reply drain is a **union across the requester's sibling MCP-child pids** (`drainMatchingReplyMany`), mirroring `read_my_messages` — a dual-scope requester's reply may land in a sibling pid, not the one that blocked in `ask_peer`.

Records are honored for `OXTAIL_PENDING_ASK_TTL_MS` (default 1h, sized for long efforts): a reply after that still delivers durably via `read_my_messages` but won't fire the pull-back wake (`consumePendingAsk` is TTL-aware — it removes an over-TTL record without waking). GC is **opportunistic** — abandoned records (a reply that never came) are swept when a later `ask_peer` times out, not on a wall-clock timer; the files are tiny, and a reply always cleans up its own record on arrival.

**The pattern:** `ask_peer` a long task → let it return `timed_out: true` → end your turn → get woken when the answer lands. Pair with a generous `OXTAIL_ACTIVITY_BUSY_TTL_MS` if your turns run long (see below).

### Keeping a long turn marked busy

`wake: "auto"` skips a peer that is **freshly `busy`** (mid-turn — its hooks deliver, so a keystroke wake would be noise). The `busy` marker is set at turn start (UserPromptSubmit hook) and **re-stamped on every tool call** (PreToolUse hook, v0.15+), so a long *active* turn stays fresh and never invites a spurious wake. A turn that stops making tool calls — one giant single tool call, or a crash without a clean Stop — ages past `OXTAIL_ACTIVITY_BUSY_TTL_MS` (default 10 min) and then *does* wake, which is the intended stale-busy → recovery behavior. Widen the TTL for deployments with very long single-tool-call turns.

### Recommended permissions for autonomous agent-to-agent collaboration

The user-approval prompt on every `ask_peer` call interrupts the back-and-forth dynamic. To allow agents to initiate delegation without per-call prompts, add to `~/.claude/settings.json`:

```jsonc
{
  "permissions": {
    "allow": [
      "mcp__oxtail__ask_peer",
      "mcp__oxtail__send_message",
      "mcp__oxtail__read_my_messages"
    ]
  }
}
```

Without an allowlist, Claude Code prompts on first use of each MCP tool with an "always allow" option — pick that once per project to get the same effect.

### Body framing

Peers see the body verbatim. A handoff is naturally read as an assignment, not chat, when framed that way — include an objective and a requested next action. The repo doesn't ship a fixed envelope convention yet; convention will follow real use.

## Self-registration and the peer registry

Each oxtail server, when spawned by an agent, writes a small record to `~/.oxtail/sessions/<pid>.json` containing the client type, session id, transcript path, and tmux pane. Sibling servers read this directory to find peer transcripts. Records auto-clean on process exit and on read (dead PIDs pruned). Sessions whose agents are not oxtail-aware (or are not LLM agents at all — bash, vim, vite dev servers) still show up in `list_project_sessions` and are readable via `read_session` in pane mode.

## How session_id resolution works (v0.4.0)

Claude Code does not propagate `CLAUDE_CODE_SESSION_ID` to MCP child processes — and a process-tree spike confirmed it isn't recoverable via parent-env inspection either: the var only lives in Bash tool subshells. The MCP `initialize` handshake also carries no session id. So oxtail uses a layered detection strategy:

1. **`env`** — direct read of `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`. Structurally null on Claude Code today; fires on Codex when `CODEX_THREAD_ID` is present in the MCP env.
2. **`hook-drop`** (v0.17, auto-join) — Claude Code's SessionStart hook *does* receive the session id on stdin, so `npx oxtail install-hook` installs a `sessionstart.sh` that drops `{session_id, cwd, transcript_path}` plus the writing hook's `$PPID` + start-time signature into `~/.oxtail/session-starts/`. The server adopts the drop whose recorded host process is an **ancestor of this MCP server** (high confidence — each session adopts exactly the drop written by the Claude process above it, so multiple sessions sharing a project disambiguate cleanly), or the sole cwd-matching drop when ancestry can't be read (medium). Several unconfirmable candidates → abstain, never guess. With the hooks installed, **the manual `/oxtail-join` ceremony is no longer needed for Claude Code** — it remains useful as the explicit fallback and for Codex.
3. **`birth-time`** — match the MCP server's `started_at` against `*.jsonl` birth times in the project transcript dir. Resolves only when there is exactly one post-start candidate within a 5-minute window. Two or more in-window candidates means another agent is sharing this project, in which case birth-time abstains rather than guess.
4. **`register_my_session`** — designed escape hatch. The agent reads its own session id from a Bash tool subshell (`echo $CLAUDE_CODE_SESSION_ID`) and pins it.

Detection runs on startup, again at MCP handshake (`oninitialized`), and is retried at +1s/+5s/+30s/+5min via `unref`'d timers — covering the case where the transcript file doesn't exist yet at handshake time.

Automatic detection is bootstrap-only once a non-null session id exists. After `claim_session` / `register_my_session` or sticky-claim recovery, later detection and `get_my_session` calls preserve the existing id; only another explicit claim can change it.

When a strategy doesn't fire, it returns an abstention with a `reason` (e.g. `"2 post-start transcripts in 5min window — ambiguous"`), and `get_my_session` adds a top-level `next_step` block carrying the exact bash command to run for the escape hatch. A fresh agent can act in one round trip without investigating each null.

If `MCP_TRACE_FILE` is set in the environment, every detection run appends an NDJSON record with trigger, winning strategy, per-strategy outcomes, and `next_step`. Useful for diagnosing unresolved `client_session_id`s in the wild.

### Diagnosing wakes (`oxtail diagnose`)

The same `MCP_TRACE_FILE` also captures a `wake_outcome` record for every wake (which tool drove it and the resulting `wake_status`). Run:

```sh
oxtail diagnose
```

to get a summary — counts by `wake_status`, broken down by tool — so "is the wake mechanism working in my environment?" is one command instead of grepping JSONL. With `MCP_TRACE_FILE` unset it just prints how to enable tracing. (Issue #7.)

A scheduled CI job (`.github/workflows/codex-drift.yml`, also runnable on demand) fetches Codex's upstream `PASTE_ENTER_SUPPRESS_WINDOW` and fails if it drifts past oxtail's 500ms Codex wake gap — so a future Codex release that would break the wake surfaces as a red job rather than a silent field regression.

## Status

v0.17.1. Pushes the autonomous peer-messaging matrix toward zero human relay, hardens the wake/delivery core against crash and race classes, makes delegation durable across long (minutes-to-hours) efforts, and rekeys the mailbox itself onto the agent identity.

- **Auto-join date fix + hook self-heal (v0.17.1, hooks v10).** A 3-lens compile-sim pass over v0.17.0 plus a live Claude↔Codex test session surfaced three fixes. (1) `sessionstart.sh` recorded `ps lstart`'s raw bytes, which pad single-digit days with a double space (`Tue Jun  9 …`) — but the reader rebuilds ancestor sigs single-spaced, so `ancestorConfirmed`'s exact match silently failed on days 1–9 of *every month*, exactly the multi-session-per-project case ancestry exists to disambiguate (confirmed live against a production drop on 2026-06-09). The hook now collapses internal space runs and the server normalizes on read, so drops from stale v9 hooks still confirm. (2) The `hook-drain` helper now truncates a non-empty mailbox whose lines are all torn/invalid — previously such a box re-spawned a Node helper on every tool call until a server-side drain cleared it, defeating the quiet-inbox-is-pure-bash design. (3) `ask_peer`'s grace-window and poll-success paths now sweep migrate-crash duplicate replies from transiently-locked sibling boxes, matching the timeout path — closing a rare window where a later `read_my_messages` re-delivered an already-returned reply (plus a fresh-union sweep on success, so a sibling MCP child that appeared *during* the wait is covered too). Housekeeping from the same review: orphaned empty mailbox files (nothing in the registry routes to them, ≥7 days untouched) are now GC'd at server start instead of accumulating forever; the hooks shape-gate the stdin session_id to the UUID charset before it reaches a registry grep; `install-hook` uses a function replacer so a `$` in the node path can't corrupt the baked `node_bin` line; the CI hook-version guard now covers the helper's full dependency closure (`mailbox.ts`/`locks.ts`/`trace.ts`, not just `hook-drain.ts`); and the pure list-shaping helpers moved to `list-shape.ts` because importing `server.ts` for them runs its top-level `register()` — which made one test file silently act as a live agent against the real `$HOME`. Re-run `npx oxtail install-hook` after upgrading.
- **Session-keyed mailboxes + hook-drain helper (v0.17.0).** A session's inbox is now a single file keyed by its `client.session_id` (`~/.oxtail/mailboxes/<mailboxSessionKey(session_id)>.jsonl`) instead of one file per MCP-child pid — so a pid rotation (the restart class behind the v0.10.x split-identity bug family) can no longer strand mail by construction, and the documented resolve→enqueue orphan residual is closed for v0.17+ readers. Senders route on the receiver's advertised `capabilities.mailbox.session_keyed` (pre-v0.17 peers keep getting pid-keyed mail they can actually read), readers drain the session box plus any legacy pid boxes with `message_id` dedup, and a legacy send whose registry breadcrumb vanished mid-flight rescues a session-box copy. The PreToolUse/Stop hooks became thin bash triggers: the empty-inbox fast path is still pure bash (no Node process on a quiet tool call), but lock + JSON parse + budget + rendering moved to a `hook-drain` helper installed beside the scripts — the *same compiled lock/mailbox code the server runs*, ending the era of the awk JSON parser, the bash lock mirror, and the key-order coupling. The helper handshake is versioned and fails open. Re-run `npx oxtail install-hook` after upgrading (the server warns if you don't).
- **`read_session` freshness/provenance (v0.16.2).** Every `read_session` return now says *which* identity/thread it read and how it was derived (`resolved_session_id`, `session_id_source`) and how stale the backing transcript is (`transcript_mtime`, `transcript_age_seconds`) — closing a silent false-negative where a sticky-recovered identity pinned to an old transcript read as "peer never replied" while the peer was live elsewhere. The tool is documented as browse/diagnostic only: confirm a reply via the mailbox (`read_my_messages` / the `ask_peer` correlated reply), never via `read_session`.
- **Receive convention for no-hook peers (v0.16.1).** The `read_my_messages` description no longer says no-hook peers "must poll" — observed live, that wording sent an idle Codex into sleep-loop polling and a 100s blocking `ask_peer` that bought nothing. Delivery is sender-driven: a wake-bearing send re-invokes an idle peer's pane; the receiver reads once at the start of that turn, acts, and ends the turn. The Codex join skill documents the same standing convention ("idle is safe — trust the wake").
- **Compile-sim hardening (v0.16.0).** A 3-lens compile-sim pass (strict frontend / concrete interpreter / symbolic path explorer) over the delivery core surfaced 4 HIGH + 5 MEDIUM + 4 LOW correctness fixes — including `recoverClaim` abstaining instead of guessing, a wall-clock (not retry-count) lock-acquire budget, a `proc_sig` start-time signature that detects OS pid reuse before waking a stranger's pane, and torn-line-safe mailbox migration.
- **Durable `ask_peer` + long-effort liveness (v0.15.0).** A timed-out `ask_peer` records a pending obligation (`~/.oxtail/pending-ask/`, keyed on requester `session_id` + `request_id`, written *before* a final authoritative union-drain), so the peer's reply — arriving minutes or hours later — *wakes the requester back* (`wake_reason: "late_reply_to_pending"`) instead of landing silently. The pull-back takes the lenient wake path, so it reaches even a markerless idle Codex requester — closing the last wake-on-reply asymmetry. The reply drain unions the requester's sibling MCP-child pids (and sweeps migrate-crash duplicates) so a dual-scope reply can't strand. Separately, the `PreToolUse` hook now re-stamps the `busy` marker every tool call, so a long *active* turn never reads as stale-busy and invites a spurious wake. New env: `OXTAIL_PENDING_ASK_TTL_MS` (1h), `OXTAIL_ACTIVITY_BUSY_TTL_MS` (10m); `ask_peer` default timeout 45s→60s.
- **Reply by id (v0.13.0).** `reply_to_message(message_id, body)` removes the manual `target` + `reply_to` rewiring that silently degraded a correlated exchange into loose mailbox traffic: the server looks the inbound envelope up in a durable per-session **received-ledger** (`~/.oxtail/received/<hash(session_id)>.jsonl`), derives the reply target and `reply_to` itself, and enforces ownership structurally (you can only reply to a message delivered to you). The ledger is written *before* the mailbox line is visible — so a handle the hook displays is always resolvable even though both delivery paths destroy the queue entry once it is handed off. Fail-closed on an unknown/aged-out id.
- **Wake-on-reply (v0.11.0).** A reply — `send_message` with `reply_to` — auto-wakes a freshly-idle requester by default, so an awaited answer doesn't strand an idle peer. Strictly gated (fresh-idle only, per-target rate limit, one-wake dedupe, `OXTAIL_AUTOWAKE=off` kill-switch). `wake:"off"` opts out; explicit `wake:"auto"` is the escape hatch for a requester without an idle marker (Codex / hookless Claude).
- **Wake hardening (v0.12.0).** Wake keystrokes only ever target the pane the process tree confirms hosts the peer's `server_pid` — never a self-written `tmux_pane`/`tmux_session`, and registry entries whose `server_pid` doesn't match their filename are rejected. Rapid repeat wakes to one peer are coalesced (`skipped_debounced`). `oxtail diagnose` summarizes wake outcomes from `MCP_TRACE_FILE`, and a scheduled CI job flags drift in Codex's paste-burst window before it can break the wake.
- **Correlated delegate-and-wait.** `ask_peer` now sends a `request_id`; upgraded peers reply with `send_message({ reply_to })`, and the waiter ignores same-peer chatter that does not match. Legacy peers are still supported, but their replies are marked `correlation: "uncorrelated"`.
- **Identity monotonicity.** `claim_session` / `register_my_session` and sticky-claim recovery are authoritative after they set a session id; later automatic detection cannot clobber a claimed id with stale env data.
- **Hook push budgeting and provenance.** PreToolUse/Stop delivery stamps `origin: "peer"`, reminds receivers that peer messages are not user authority, and caps hook-injected body text via `OXTAIL_HOOK_MAX_BODY_CHARS`.
- **Deliver-on-complete (Stop hook).** PreToolUse only fires before a tool call, so a text-only turn never triggered it. The new `Stop` hook closes that gap: a message that lands as the agent finishes a turn blocks the stop and is read + answered before it goes idle. Loop-safe via `stop_hook_active`.
- **State-gated idle wake.** `send_message({ wake: "auto" })` nudges an idle peer via per-client `tmux send-keys`, gated off a busy/idle activity flag maintained by the `UserPromptSubmit`/`Stop` hooks — so it never types into a peer that's mid-turn. Returns `wake_status: fired | skipped_busy | skipped_no_target | disabled`. A Codex peer must be inside a tmux pane to be idle-woken (otherwise `skipped_no_target`, and delivery stays poll-based).
- **Sticky Codex claim.** A restarted Codex MCP child — whose `CODEX_THREAD_ID` is stripped from its subprocess env — recovers its `session_id` from a persisted claim keyed by client type + cwd + a bounded process-ancestor chain, so identity survives an MCP restart without a manual re-claim.
- **Identity hardening.** Hooks and activity key on `client.session_id` (never `server_pid`), so a dual-scope agent's sibling MCP children act as one identity; delivery hooks drain all sibling mailboxes; nested git repos are treated as separate projects for scope matching.

Builds on v0.7's per-client wake routing (verified live 2026-05-13): Codex peers wake via a 500ms-gap send-keys sequence that defeats their TUI's paste-burst heuristic; Claude Code peers wake via the same mechanism without the gap (no paste-burst in its TUI). `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` remains as a rollback. See [issue #3](https://github.com/d4j3y2k/oxtail/issues/3) for the v0.7 spike findings.

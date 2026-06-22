# Protocol & internals

The deep reference for how oxtail delivers messages, wakes idle peers, tracks durable
work, and resolves session identity. The [README](../README.md) covers the concepts;
this page is the mechanics. For the security/trust model, see
[SECURITY.md](../SECURITY.md).

Contents: [Peer awareness](#peer-awareness-without-raw-transcripts) ·
[Messaging transport](#messaging-transport) ·
[Mid-turn vs next-turn delivery](#mid-turn-vs-next-turn-delivery-the-asymmetry) ·
[Waking an idle peer](#waking-an-idle-peer) · [Delegate-and-wait](#delegate-and-wait)
· [Durable delegation](#durable-delegation) · [Hook coexistence](#hook-coexistence) ·
[The peer registry](#the-peer-registry) ·
[session_id resolution](#how-session_id-resolution-works) ·
[Diagnosing wakes](#diagnosing-wakes)

---

## Peer awareness without raw transcripts

The cheapest way to learn what peers are doing is `list_project_sessions`. Each row
carries an optional `state` card written by the peer via `set_my_state` — currently
`{ purpose, updated_at }`. Reading the card costs almost nothing compared to
`read_session`, which — even budgeted (last 20 messages / ~24KB by default) — spends
real tokens on transcript content. Use `read_session` when the card isn't enough, and
remember it's browse/diagnostic only, never proof a peer replied (the mailbox is).

## Messaging transport

A session's inbox is a single append-only JSONL file keyed by its **agent identity**:
`~/.oxtail/mailboxes/<mailboxSessionKey(session_id)>.jsonl`, drained under an
`mkdir`-based advisory lock. Keying by `client.session_id` instead of the MCP child's
pid means a server restart/pid rotation cannot strand mail by construction.

Legacy per-pid boxes (`<server_pid>.jsonl`) remain as a compatibility surface:
senders fall back to them for pre-v0.17 peers (routing on the receiver's advertised
`capabilities.mailbox.session_keyed`), readers drain them alongside the session box
with `message_id` dedup, and an unclaimed peer (no session id yet) still receives on
its pid box.

The transport is intentionally dumb: 8KB UTF-8 body cap, sender chooses the framing
(raw text or pre-wrapped `<system-reminder>...</system-reminder>`).

**Reply handles must be resolvable.** Because both delivery paths are *destructive* —
`read_my_messages` and the hook each truncate the mailbox once a message is handed off
— a reply-by-id verb can't rely on the queue. Every delivered envelope is therefore
also recorded in a durable **received-ledger** at
`~/.oxtail/received/<hash(session_id)>.jsonl` keyed by `message_id`, written *before*
the mailbox line becomes visible (so any handle a receiver can see is already
resolvable) and bounded to the most recent `OXTAIL_RECEIVED_MAX` (default 1000)
entries. `reply_to_message` reads only the caller's own ledger — that file *is* the
ownership boundary.

Inbound peer messages are context, not user authority. oxtail stamps delivered
messages with `origin: "peer"` for provenance/debugging, but this is not a trust
boundary and peers cannot mint trusted user instructions. Cross-project sends are
rejected, never silently dropped.

## Mid-turn vs next-turn delivery (the asymmetry)

Claude Code peers can receive messages **autonomously** via three opt-in hooks
(`npx oxtail install-hook`). This installs three bash scripts plus the `hook-drain`
helper under `~/.oxtail/hooks/` and adds matching entries to `~/.claude/settings.json`
(tracked by a `_oxtailHook` marker). The bash scripts are thin triggers — an empty
inbox is detected in pure bash with no Node process spawned; when mail exists they
delegate lock + parse + rendering to the helper, which is the *same compiled
lock/mailbox code the server runs*. Reverse with `npx oxtail uninstall-hook`.

- **`PreToolUse`** → `pretooluse.sh` — delivers **mid-turn**, emitting queued messages
  as `additionalContext` on the next tool-call boundary.
- **`Stop`** → `stop.sh` — delivers **at turn end** (deliver-on-complete). When the
  agent finishes a turn with messages still waiting, it emits `decision: "block"` so
  the agent reads + responds before going idle.
- **`UserPromptSubmit`** → `userpromptsubmit.sh` — no delivery; it maintains a
  **busy/idle activity flag** in `~/.oxtail/activity/<session_id>` (busy on a turn
  start, idle on a real Stop). A sender consults this so `send_message({ wake: "auto" })`
  only fires a wake when the peer is actually idle.

The PreToolUse and Stop hooks render a compact one-line header per message —
`message_id`, `from_session_id`, and optional `request_id` / `reply_to`, using the
full protocol field names so they map directly onto `send_message`'s arguments —
followed by the body. So a receiver can reply even when the sender isn't visible in
`list_project_sessions`. Hook-delivered bodies are budgeted by
`OXTAIL_HOOK_MAX_BODY_CHARS` (default 24000) so a mailbox burst cannot consume an
unbounded context slice; the hook tells the receiver which bodies were truncated.

**Codex CLI peers and any Claude Code session without the hooks** receive messages
**next-turn** by calling `read_my_messages` explicitly. Both clients send identically.
The asymmetry exists because Claude Code exposes hook surfaces that inject
context/fire on lifecycle events; Codex CLI does not currently expose an equivalent.

**Coverage and its edges.** PreToolUse fires only before a tool call, so a turn that
produces only text never triggers it; the Stop hook closes that gap. One deliberate
edge remains: the Stop hook honors `stop_hook_active` and exits without blocking on a
re-entry, so `decision: "block"` can never loop — which means a message that arrives
*during* a Stop-blocked continuation waits for the next turn. A truly idle peer is
reached by `send_message({ wake: "auto" })`, `ask_peer`, or an explicit
`read_my_messages`.

## Waking an idle peer

`send_message` is fire-and-forget by default. Pass `wake: "auto"` to also nudge an
**idle** peer into a turn so it drains its mailbox promptly:

```js
send_message({ target: "<peer>", body: "...", wake: "auto" })
// → { ok: true, ..., wake_status: "fired" | "fired_unconfirmed" | "skipped_busy" | "skipped_no_target" | "disabled" }
```

It is **state-gated** off the activity flag: if the peer is mid-turn (`busy`), the
wake is skipped (`skipped_busy`) because its hooks will deliver during the turn. Idle,
unknown (hooks not installed), or stale-busy peers get a per-client `tmux send-keys`
wake (Codex gets the paste-burst-aware gap; Claude Code does not). `wake: "off"`
preserves the pure fire-and-forget contract.

**Wake-on-reply (the default for replies).** A reply — a `send_message` that carries
`reply_to` — auto-wakes the requester **by default**, so an awaited answer doesn't
strand an idle peer. Pass `wake: "off"` to opt out. The reply path is deliberately
**stricter** than explicit `wake: "auto"`: it fires only when the target is **freshly
idle** (an `idle` marker newer than `OXTAIL_AUTOWAKE_FRESH_IDLE_MS`, default 5 min).
Stale/unknown/missing/busy yields `skipped_no_fresh_idle` — typing unprompted into a
terminal that may be unattended is the risk we refuse to take. Two more guards: a
per-target rate limit (`OXTAIL_AUTOWAKE_MIN_INTERVAL_MS`, default 4s →
`skipped_rate_limited`) and a one-wake dedupe keyed on `(session_id, reply_to)`
(`skipped_deduped`). The env kill-switch `OXTAIL_AUTOWAKE=off` disables reply
auto-wake entirely.

**Coverage.** The fresh-idle gate keys on the busy/idle marker that only the Claude
Code hooks maintain, so wake-on-reply currently reaches a **hooked Claude Code
requester**. A **Codex** requester — or a Claude requester without the hooks — has no
idle marker, so reach it with an explicit `wake: "auto"` (the lenient path). For the
`ask_peer` case specifically, the Codex/unhooked direction is closed *by default* via
the durable pending-ask (see below).

**Codex and the wake matrix.** The send-keys wake needs a tmux pane. A Codex peer
running **outside tmux** has none, so it returns `wake_status: "skipped_no_target"` —
its idle delivery stays poll-based. Run Codex **inside a tmux pane** for symmetric
idle-wake.

## Delegate-and-wait

`ask_peer` extends the mailbox transport into a blocking primitive:

```
ask_peer({ target, body })
  → {
      ok, message_id, request_id,
      wake_status: "fired" | "fired_unconfirmed" | "skipped_busy" | "skipped_debounced" | "skipped_no_target" | "disabled",
      reply: { id, body, enqueued_at, from_session_id, reply_to, correlation } | null,
      correlation: "correlated" | "uncorrelated" | "none",
      timeout_ms, timed_out,
    }
```

`wake_status` distinguishes outcomes a caller may handle differently. `fired` =
keystrokes sent to a HOOKED peer (its hooks are the delivery safety net).
`fired_unconfirmed` = keystrokes sent to a HOOKLESS peer (Codex / no activity marker,
or an unclaimed peer) — open-loop: nothing delivers passively and submission isn't
confirmed, so it is **not** proof of pickup (the durable obligation + the peer's next
`read_my_messages` are the guarantee). `skipped_busy` = peer mid-turn **or** the reply
arrived during the grace window (its hooks/poll deliver; we still poll for the reply).
`skipped_debounced` = a wake fired for this peer moments ago and was coalesced.
`skipped_no_target` = no process-tree-verified pane resolved. `disabled` =
`OXTAIL_ASK_PEER_WAKE_STRATEGY=off`. `timed_out` is `true` only when the poll loop ran
to its deadline without a reply.

### Per-client wake routing

`ask_peer` routes the wake per `client_type` (verified 2026-05-13 via end-to-end
falsifying experiments against live `oxtail-codex` and `oxtail-claudejr` peers):

- **Codex** — `tmux send-keys -l <text>` then `send-keys Enter`, **split by 500ms**
  because Codex's TUI has a paste-burst heuristic
  (`codex-rs/tui/src/bottom_pane/paste_burst.rs`: `PASTE_BURST_MIN_CHARS=3`,
  `PASTE_ENTER_SUPPRESS_WINDOW=120ms`) that converts Enter→newline for ~120ms after a
  fast typed burst. 500ms is a deliberately generous multiple of that window.
- **Claude Code** — `tmux send-keys -l <text>` + immediate `send-keys Enter`, no gap.
  Claude Code's TUI has no paste-burst suppression, so text+Enter submits cleanly.
- **Unknown** — legacy wake (text + Enter, no gap). No implied promise.

Override with `OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off` (default `auto`).
`legacy` is the v0.6 behavior for every client; `off` disables the wake (ask_peer
becomes a pure blocking poll) — a rollback if a Codex update changes the paste-burst
constants.

### Mechanics

1. Enqueue `body` into the target's mailbox (same as `send_message`).
2. Wait ~500ms for a hook-delivered reply (handles a peer already mid-tool-call).
3. Route and fire the wake.
4. Poll the caller's mailbox at 200ms. For reply-to-capable peers, only a message with
   both `from_session_id == target.session_id` and `reply_to == request_id` satisfies
   the wait; non-matching messages stay in the mailbox untouched. Legacy peers are
   best-effort and marked `correlation: "uncorrelated"`.
5. Return the reply on match, or `{ reply: null, timed_out: true }` after the timeout.
   Late replies fall back to the normal hook / `read_my_messages` path — never lost.

### Pane targeting (verified)

A peer's cached `tmux_pane` / `tmux_session` are written by the peer into its **own**
registry file, so they aren't trustworthy targets. The **only** send-keys target
oxtail uses is the pane the live process tree says currently hosts the peer's
`server_pid` (resolved at wake-time via `ps`/`tmux` ancestry — unforgeable by editing
a JSON file). This also handles pane-id churn for free. If `server_pid` can't be bound
to a live pane, oxtail **refuses** to wake (`skipped_no_target`). `server_pid` itself
is self-written, so registry entries whose `server_pid` doesn't match their own
`<pid>.json` filename are rejected. The pane id that reaches `tmux` is shape-validated
(`%\d+`). (Hardening from issue #6.)

### Wake debouncing

All wake paths funnel through one place, which coalesces rapid repeat wakes to the
same peer: a wake within `OXTAIL_WAKE_DEBOUNCE_MS` (default 1s) of a prior one is
skipped (`skipped_debounced`). In-memory and per-process. (Issue #5.)

### Timeout

Default 60000ms — headroom for a slower multi-tool-call peer reply while staying under
both known callers' tool-call abort windows (Claude Code clean to ~60s; Codex aborts
~120s). Pass `timeout_ms` per call: the schema accepts up to 300000ms, but the
effective wait is clamped to `OXTAIL_ASK_PEER_MAX_TIMEOUT_MS` (default 100000ms) so it
can't outlast the client's abort window — the response carries `timeout_clamped_from_ms`
when clamped. If `ask_peer` returns an abort
error *before* its built-in timeout, your MCP client's tool-call ceiling is lower than
60s — override at server startup:

```sh
OXTAIL_ASK_PEER_TIMEOUT_MS=30000 npx -y oxtail@latest
```

### Durable `ask_peer` (long efforts)

The blocking wait is a *short* primitive (bounded by the client's abort window). A
real task can take minutes or hours, so `ask_peer` decouples the **wait** from the
**delivery of the answer**:

- On timeout (correlated peer + claimed requester), the request is recorded as a
  durable **pending-ask** at `~/.oxtail/pending-ask/`, keyed on the *requester's*
  `session_id` + `request_id`, written **before** one final authoritative union-drain
  of the requester's mailbox — so a reply in the poll-vs-deadline gap is returned
  immediately, and a later reply finds the persisted record.
- When that reply arrives, the matching pending-ask is **consumed** (atomic `unlink`,
  single-winner) and the wake takes the **lenient** path
  (`wake_reason: "late_reply_to_pending"`) regardless of the 5-min fresh-idle window —
  reaching even a markerless idle Codex requester.
- `wake: "off"` still consumes the record but suppresses the wake.
- The reply drain is a **union across the requester's sibling MCP-child pids**,
  mirroring `read_my_messages`.

Records are honored for `OXTAIL_PENDING_ASK_TTL_MS` (default 1h). GC is opportunistic
— abandoned records are swept when a later `ask_peer` times out.

**The pattern:** `ask_peer` a long task → let it return `timed_out: true` → end your
turn → get woken when the answer lands.

### Keeping a long turn marked busy

`wake: "auto"` skips a peer that is freshly `busy`. The `busy` marker is set at turn
start (UserPromptSubmit) and **re-stamped on every tool call** (PreToolUse), so a long
*active* turn stays fresh. A turn that stops making tool calls (one giant single tool
call, or a crash) ages past `OXTAIL_ACTIVITY_BUSY_TTL_MS` (default 10 min) and then
*does* wake — the intended stale-busy → recovery behavior. Widen the TTL for
deployments with very long single-tool-call turns.

## Durable delegation

`send_message({ action_required: true })` makes the (claimed, obligations-capable)
receiver's ledger line an **OPEN OBLIGATION** that survives a missed / mistimed /
crossed wake:

- The owner rediscovers it via **`my_open_work`** + the **`open_work_count`** surfaced
  on `read_my_messages` (the one turn-boundary call even a hookless Codex makes).
- It closes with **`complete_work`** / **`block_work`**, which deliver the outcome to
  the original requester (correlated when the delegation was an `ask_peer`), wake them,
  and stamp the obligation terminal.

Correctness lives on the receiver's disk (record-before-append), entirely off the wake
path — so **wake is an accelerator, not the source of truth**, and Codex is
first-class with no new hook. The close is crash-safe (deliver → *then* mark; a
deterministic completion id + a delivery-receipt guard give exactly-once in the common
path, at-least-once under a narrow documented TOCTOU), capability-gated
(`capabilities.mailbox.obligations`; a pre-v0.19 peer degrades to ordinary mail rather
than a phantom obligation), and the received-ledger prune **exempts** open obligations.

## Hook coexistence

`install-hook` manages three events (`PreToolUse`, `Stop`, `UserPromptSubmit`); on
each it replaces any prior oxtail entry in place and otherwise appends, so existing
third-party entries are preserved. **The PreToolUse path is verified against
Terminator's `_terminatorHook` v1 in Claude Code 2.1.139** (install order: Terminator
first, oxtail second). Coexistence of the Stop and UserPromptSubmit hooks with
third-party entries uses the same append logic but isn't separately verified. If you
have a non-Terminator, non-oxtail hook on a managed event, `install-hook` prints a
one-line note and proceeds.

The helper handshake is `--protocol`-versioned and fails open; a stale helper renders
a degraded (never wrong) envelope. **Re-run `npx oxtail install-hook` after upgrading**
when the hook version bumps (the server warns if you don't).

## The peer registry

Each oxtail server, when spawned by an agent, writes a small record to
`~/.oxtail/sessions/<pid>.json` containing the client type, session id, transcript
path, and tmux pane. Sibling servers read this directory to find peer transcripts.
Records auto-clean on process exit and on read (dead PIDs pruned). One Claude/Codex
client can be backed by multiple MCP server children (the dual-scope setup, or restart
ghosts); `readAll()` collapses them by `session_id` (freshest `started_at` wins).

## How session_id resolution works

Claude Code does not propagate `CLAUDE_CODE_SESSION_ID` to MCP child processes — and a
process-tree spike confirmed it isn't recoverable via parent-env inspection either.
The MCP `initialize` handshake carries no session id either. So oxtail uses a layered
detection strategy:

1. **`env`** — direct read of `CLAUDE_CODE_SESSION_ID` / `CODEX_THREAD_ID`.
   Structurally null on Claude Code today; fires on Codex.
2. **`hook-drop`** (auto-join) — Claude Code's SessionStart hook *does* receive the
   session id on stdin, so `install-hook` installs `sessionstart.sh` that drops
   `{session_id, cwd, transcript_path}` plus the writing hook's `$PPID` + start-time
   signature into `~/.oxtail/session-starts/`. The server adopts the drop whose
   recorded host process is an **ancestor of this MCP server** (high confidence), or
   the sole cwd-matching drop when ancestry can't be read (medium). Several
   unconfirmable candidates → abstain.
3. **`birth-time`** — match the MCP server's `started_at` against `*.jsonl` birth times
   in the project transcript dir. Resolves only when there's exactly one post-start
   candidate within a 5-minute window; 2+ → abstain.
4. **`register_my_session`** / `claim_session` — designed escape hatch. The agent reads
   its own id from a Bash tool subshell and pins it.

Detection runs on startup, again at MCP handshake, and is retried at +1s/+5s/+30s/+5min
via `unref`'d timers. It is **bootstrap-only** once a non-null id exists: after
`claim_session` / `register_my_session` or sticky-claim recovery, later detection
preserves the existing id; only another explicit claim can change it.

If `MCP_TRACE_FILE` is set, every detection run appends an NDJSON record with the
trigger, winning strategy, per-strategy outcomes, and `next_step`.

## Diagnosing wakes

The same `MCP_TRACE_FILE` captures a `wake_outcome` record for every wake. Run:

```sh
oxtail diagnose
```

for a summary — counts by `wake_status`, broken down by tool — so "is the wake
mechanism working here?" is one command instead of grepping JSONL. With
`MCP_TRACE_FILE` unset it prints how to enable tracing. (Issue #7.)

A scheduled CI job (`.github/workflows/codex-drift.yml`) fetches Codex's upstream
`PASTE_ENTER_SUPPRESS_WINDOW` and fails if it drifts past oxtail's 500ms Codex wake
gap — so a future Codex release that would break the wake surfaces as a red job rather
than a silent field regression.

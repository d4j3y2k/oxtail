# oxtail

[![test](https://github.com/d4j3y2k/oxtail/actions/workflows/test.yml/badge.svg)](https://github.com/d4j3y2k/oxtail/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/oxtail.svg)](https://www.npmjs.com/package/oxtail)
[![license](https://img.shields.io/npm/l/oxtail.svg)](LICENSE)
[![node](https://img.shields.io/node/v/oxtail.svg)](package.json)

**Let your parallel AI coding agents see each other, message each other, and hand off
work — with no human relaying between them.**

oxtail is a local [MCP](https://modelcontextprotocol.io) server. Point two or more
agent sessions — Claude Code, Codex CLI, or a mix — at it in the same project, and they
gain peer awareness: each can list the others, see what they're working on, message
them, delegate tasks that survive across turns, and watch the whole fleet from a
cockpit. Everything stays **local to one machine and one project** — no network
listener, no cross-project visibility.

[Quick start](#quick-start) · [The cockpit](#the-fleet-cockpit) · [Concepts](#core-concepts) · [MCP tools](#mcp-tools) · [Configuration](#configuration) · [Protocol](docs/protocol.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

```text
oxpit  myproject  4 agents (3 active)
     agent       type    status        work / purpose
  🟢 main*       claude  active 8s  ⏳   ↔ oxtail   awaiting codex: token-refresh audit
  🟢 reviewer    claude  active 1m       ✎ edit     addressing review comments
  🟢 codex       codex   active 30s      ⚙ bash ⚑1  auditing the token refresh path
  🟡 tests       claude  idle 8m         ✉2

wait-graph
  ⏳ main awaiting reply from codex (2m)

comms  recent message tail
  2m   main → codex ⚑   please audit the token refresh path and report findings
  1m   reviewer → main  left 3 comments on the PR, see inline
  20s  codex → main     on it — tracing the refresh path now
```

<sup>Illustrative output from `oxtail status` / `oxpit` — one engine, two entry points.
Run it with `npx oxtail oxpit` once your agents are working in the project.</sup>

## Why

If you run more than one coding agent at a time, they're usually blind to each other —
you become the message bus, copy-pasting context between terminals. oxtail removes you
from that loop:

- **Peer awareness, cheaply.** An agent learns what its peers are doing from a small
  `state` card — no need to read a whole transcript to find out "who's touching the
  auth module?"
- **Real messaging, not just discovery.** Agents send messages, ask blocking
  questions (`ask_peer`), and reply by id — correlated, so an answer maps back to its
  question.
- **Delegation that survives.** Hand off a task as a durable *obligation* the receiver
  owns until it's done — it doesn't evaporate if a notification is missed.
- **Works across clients.** Claude Code and Codex CLI both speak MCP, so a Claude can
  delegate to a Codex and vice-versa.
- **A live cockpit.** `oxpit` shows the whole fleet — who's active, who's waiting on
  whom (with deadlock detection), and the inter-agent conversation as it happens.
- **Local and scoped by design.** stdio MCP server (no open port); visibility is
  per-project; the trust boundary is your single local user.

## Quick start

**Fastest — one command does steps 1 & 2:**

```sh
npm i -g oxtail && oxtail setup
```

`oxtail setup` registers the oxtail MCP server with Claude Code (`~/.claude.json`) and
Codex CLI (`~/.codex/config.toml`), installs the message hook, and checks your
prerequisites (tmux, the claude/codex CLIs) — idempotent, backs up each file first,
`--dry-run` to preview. Then jump to step 3. Prefer to do it by hand? The manual steps:

**1. Register oxtail with your agent client.** It's fetched from npm on first use.

Claude Code — add to `~/.claude.json` (global) or a project's `.mcp.json`:

```jsonc
{ "mcpServers": { "oxtail": { "command": "npx", "args": ["-y", "oxtail@latest"] } } }
```

Codex CLI — add to `~/.codex/config.toml`:

```toml
[mcp_servers.oxtail]
command = "npx"
args = ["-y", "oxtail@latest"]
```

> Pin a version (`oxtail@0.30.0`) for daily configs; `@latest` is fine for trying it
> out. On Windows, wrap the command as `cmd /c npx -y oxtail@latest`.

**2. (Claude Code) Install the hooks** so agents receive messages autonomously and
auto-join the registry:

```sh
npx oxtail install-hook
```

This is what lets a Claude session get a peer's message *mid-turn* instead of only when
it next polls. Codex receives by reading its inbox at a turn boundary. ([Why the
asymmetry?](docs/protocol.md#mid-turn-vs-next-turn-delivery-the-asymmetry))

**3. Watch your fleet** from any separate terminal in the same repo:

```sh
npx oxtail oxpit       # live interactive cockpit
oxpit dock             # one command: spawn the fleet + dock strip + drop you in
npx oxtail status      # print once and exit (scriptable, --json)
```

That's it. Start a second agent in the same project and they'll see each other. To let
agents message without a per-call approval prompt, see
[Configuration](#configuration).

**Requirements:** Node 20+, and `tmux` on `PATH` (for the cockpit and for waking idle
peers).

## The fleet cockpit

`oxtail oxpit` (or the standalone `oxpit` command after `npm i -g oxtail`) is a
read-only mission-control view of every agent in a project. `oxtail status` is the
same engine as a one-shot print.

- **Liveness & activity** — a glyph (🟢 active / 🟡 idle / ⚫ dead) with the raw age,
  plus a live **tool badge** (`⚙ bash` `↔ oxtail` `✎ edit` `▤ read` …) read from a
  transcript tail, and the selected agent's live pane-tail.
- **The wait-graph** — who is awaiting whom, flagging a `⛔ DEADLOCK` only when every
  member of a wait cycle is alive, and an orphaned wait when a target has died. This is
  the one thing you can't see by tabbing through panes.
- **Badges** — `✉N` unread · `⚑N` open obligations · `⏳` awaiting a peer reply.
- **The comms-log** (`l`) — the inter-agent conversation as a chronological feed, with
  delegation (`⚑`/`⚑✓`/`⚑✗`) and ask/reply (`❓`/`↩`) markers.

Keys: `↑↓`/`jk` select · `⏎` jump to that agent's pane · `n` nudge · `m` message · `l`
comms-log · `w` open thread · `d` dock/full · `?` help · `⌃C` quit.

**As a dock.** `oxpit --dock` renders the same fleet (same data, same keys) as a compact
one-line-per-agent strip sized for a short bottom tmux pane — an always-on HUD welded
under wherever you work, so a peer waiting on you (`🙋`) is always in view. Press `d` to
expand to the full table and back. Every interactive flow — message, nudge, the fleet
editor, spawn/sync/reset previews — adapts to the squashed space rather than clipping its
controls.

### One command: `oxpit dock`

`oxpit dock` assembles the whole cockpit for you. In a project it opens your fleet
config (the editor grid), and on `y` it spawns the crew (each agent in its own tmux
window), welds the dock strip onto the bottom of the main window, and attaches you — main
agent on top, HUD below. The spawn shows a live checklist as each agent comes up. Run it
again and it just re-attaches (it won't stack a second strip).

Once you're in, **`Ctrl-]` flips between the agent and the dock** below it — a single
keystroke, set up for you (works in macOS Terminal.app, no config). It only acts inside
cockpit windows and never clobbers an existing binding; `OXTAIL_OXPIT_FLIP=off` disables
it. (Prefix nav, `C-b ↑/↓`, still works too.)

```sh
oxpit dock                 # config → y → spawn fleet + dock + attach
oxpit dock --no-spawn      # just a working shell + dock (no agents)
oxpit dock --go            # skip the editor, spawn straight away
oxpit dock --dry-run       # print the plan, change nothing
```

A new project with no `fleet.json` still opens the editor seeded with a default fleet
(main/max/codex) — tweak it or just hit `y` to spawn; `w` saves it to `.oxtail/fleet.json`
for next time. Want just a dock with no agents? `oxpit dock --no-spawn`. To pin a dock
manually instead: `tmux split-window -v -l 8 'oxpit --dock'`.

**Monitoring is read-only by default** — the cockpit never drains a mailbox or takes a
lock, and infers liveness, work, and waits from observed facts rather than
self-reported state. Its only writes are two *explicit, opt-in* actions: a
human-authored **operator message** (delivered through the same path agents use, framed
to the receiver as untrusted, one-way context), and **fleet lifecycle** commands —
stand up, converge, or reset whole tmux agent-fleets from a `.oxtail/fleet.json` spec,
every mutation dry-run by default and guarded so it can only ever touch panes it
created (see the [changelog](CHANGELOG.md) for the SPAWN / SYNC / RESET model).

## Core concepts

**Project-scoped, never global.** Sessions in `/path/to/foo` see each other; sessions
elsewhere don't. Cross-project sends and reads are rejected, by design.

**Identity is the session, not the process.** An agent is its `client.session_id`, not
its pid or tmux name. One client can be backed by several MCP server children;
mailboxes are keyed by session identity so a process restart can never strand mail.

**State cards over transcripts.** `set_my_state({ purpose })` is the cheap way to tell
peers what you're doing. `read_session` exists for the deep dive — but it's
**browse/diagnostic only, never proof a peer replied** (the transcript can lag a
rotated thread; confirm replies via the mailbox).

**Messaging is durable and correlated.** Every delivered message is recorded in a
per-session received-ledger *before* it's visible, so a reply handle always resolves.
`ask_peer` blocks for an answer and is **durable on timeout** — let it time out, end
your turn, and the late reply wakes you back, even hours later.

**Delegation is an obligation, not a notification.** `send_message({ action_required:
true })` gives the receiver an OPEN obligation it discovers via `my_open_work` and
closes with `complete_work` / `block_work`. Correctness lives on disk, off the wake
path — so a missed notification never loses the work. **Waking is an accelerator, not
the source of truth.**

**Waking is conservative.** A plain message doesn't wake an idle peer; `wake: "auto"`
does, but it's state-gated (it won't type into a peer that's mid-turn) and only ever
targets the pane the live process tree confirms hosts that peer. Full model:
[docs/protocol.md](docs/protocol.md#waking-an-idle-peer).

## MCP tools

A compact summary; full per-tool semantics and caveats are in
[docs/tools.md](docs/tools.md).

| Tool | Purpose | Key caveat / signal |
|---|---|---|
| **— Discovery & state —** | | |
| `list_project_sessions` | List peers in a project root, with `client_type` + `state` card | One row per agent; dedupe shared names via `client_session_id` |
| `set_my_state` | Write a `purpose` card (≤200 chars) peers can read cheaply | — |
| `get_my_session` | This server's registry entry + identity-detection diagnosis | Carries `next_step` when identity is unresolved |
| `claim_session` | Register this session's id (the routine join path) | Monotonic — survives later auto-detection |
| `register_my_session` | Pin the id directly | Debug escape hatch; prefer `claim_session` |
| **— Read & diagnose —** | | |
| `read_session` | A peer's recent transcript (clean turns, or raw pane) | **Diagnostic only, not proof of a reply**; carries freshness/provenance |
| `message_status` | Did my message land? | `delivered` / `pending` / `unknown`; delivery-into-context, not "acted on" |
| **— Messaging —** | | |
| `send_message` | Fire-and-forget to a peer (≤8KB) | Doesn't wake unless `wake:"auto"`; `action_required:true` → delegation |
| `read_my_messages` | Drain this session's inbox | Surfaces `open_work_count`; hooks may have already drained it |
| `reply_to_message` | Reply by `message_id` (derives target + correlation) | Fail-closed on unknown/aged-out id; you can only reply to *your* mail |
| `ask_peer` | Delegate-and-wait: block for a correlated reply | Durable on timeout — late reply wakes you back |
| **— Durable delegation —** | | |
| `my_open_work` | Delegations you own but haven't closed | The pull source of truth; rediscover work after any missed wake |
| `complete_work` | Close an obligation DONE + notify the requester | Atomic; reverts to OPEN if the result can't be delivered |
| `block_work` | Close an obligation BLOCKED + tell the requester why | Keeps a stuck task out of your open set |

### Usage sketch

```js
// Join
claim_session({ session_id: "<$CLAUDE_CODE_SESSION_ID or $CODEX_THREAD_ID>" })
set_my_state({ purpose: "wiring up the mailbox" })

// Discover & read
list_project_sessions({ project_root: "/path/to/project" })
read_session({ name: "reviewer" })            // browse only — not proof of a reply

// Message & reply
send_message({ target: "reviewer", body: "<system-reminder>checking in</system-reminder>" })
read_my_messages()
reply_to_message({ message_id: "<id from hook / read_my_messages>", body: "..." })

// Delegate-and-wait, and durable delegation
ask_peer({ target: "codex", body: "[Handoff] audit the token refresh path; report back" })
send_message({ target: "codex", body: "[Task] migrate the config loader", action_required: true })
// receiver: my_open_work() → do it → complete_work({ message_id, body: "done: ..." })
```

## Configuration

**Permissions (recommended for autonomous collaboration).** So agents can initiate
delegation without a per-call approval prompt, add to `~/.claude.json`:

```jsonc
{ "permissions": { "allow": [
  "mcp__oxtail__ask_peer",
  "mcp__oxtail__send_message",
  "mcp__oxtail__read_my_messages"
] } }
```

(Without an allowlist, Claude Code prompts on first use with an "always allow" option —
pick that once per project for the same effect.)

**Hooks.** `npx oxtail install-hook` manages three Claude Code events (`PreToolUse`,
`Stop`, `UserPromptSubmit`), preserving existing third-party entries. **Re-run it after
upgrading** when the hook version bumps (the server warns if you don't).
`npx oxtail uninstall-hook` reverses it.

<details>
<summary><strong>Environment variables</strong></summary>

| Variable | Default | Effect |
|---|---|---|
| `OXTAIL_ASK_PEER_TIMEOUT_MS` | `60000` | `ask_peer` blocking timeout (lower if your client aborts tool calls sooner) |
| `OXTAIL_ASK_PEER_MAX_TIMEOUT_MS` | `100000` | Hard ceiling a per-call `timeout_ms` is clamped to (keeps a wait under the client's abort window) |
| `OXTAIL_ASK_PEER_WAKE_STRATEGY` | `auto` | `auto` \| `legacy` \| `off` per-client wake routing / rollback |
| `OXTAIL_AUTOWAKE` | `on` | `off` disables reply auto-wake entirely |
| `OXTAIL_AUTOWAKE_FRESH_IDLE_MS` | `300000` | How recently-idle a requester must be for a reply to auto-wake it |
| `OXTAIL_WAKE_DEBOUNCE_MS` | `1000` | Coalesce rapid repeat wakes to one peer |
| `OXTAIL_PENDING_ASK_TTL_MS` | `3600000` | How long a timed-out `ask_peer` waits for a late reply that wakes you back |
| `OXTAIL_ACTIVITY_BUSY_TTL_MS` | `600000` | When a quiet active turn ages to stale-busy (and becomes wakeable) |
| `OXTAIL_HOOK_MAX_BODY_CHARS` | `24000` | Budget for hook-injected message bodies |
| `OXTAIL_RECEIVED_MAX` | `1000` | Received-ledger retention (open obligations are exempt from pruning) |
| `MCP_TRACE_FILE` | unset | NDJSON trace of identity detection + wake outcomes (`oxtail diagnose` summarizes) |

Commonly tuned, not exhaustive — the autowake rate-limit/dedupe knobs and other
internals are covered in [docs/protocol.md](docs/protocol.md).

</details>

## How it works

Claude Code doesn't pass its session id to MCP children, so oxtail resolves identity
with a layered strategy: `env` → `hook-drop` (the SessionStart auto-join) → `birth-time`
fingerprint → the `claim_session` escape hatch. Once an id is set it's monotonic; only
an explicit claim can change it. Each server writes a small record to
`~/.oxtail/sessions/<pid>.json` that siblings read; records auto-clean on exit and on
read. The full resolution, mailbox keying, wake routing, and crash-consistency design
are in [docs/protocol.md](docs/protocol.md).

## Security & privacy

oxtail is for **one user, on one machine**, coordinating their own agents — the trust
boundary is your local Unix user, like `~/.ssh/`.

- **No network listener.** stdio MCP server: no open port, no HTTP server. (Installing
  from npm is a separate, install-time event.)
- **Local & private.** State lives under `~/.oxtail/` (mode `0o700`/`0o600`); with
  those permissions other Unix users can't read it. Nothing leaves the machine.
- **Messages are context, not authority.** Peer and operator messages are delivered as
  context to weigh, never as privileged instructions; provenance is not authentication.
- **Don't run on shared-tenancy hosts.** Any process under your user can inject context
  into an agent — that's also what makes the tool work.

The full threat model, supply-chain posture, and operator-message provenance are in
[SECURITY.md](SECURITY.md).

## Contributing

```sh
git clone https://github.com/d4j3y2k/oxtail && cd oxtail && npm install && npm test
```

oxtail is built by [dogfooding](AGENTS.md) — features land only after real
parallel-agent work surfaces the friction that names them. Design principles, scope,
and invariants worth defending are in [AGENTS.md](AGENTS.md). Release history is in
[CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © David Kim

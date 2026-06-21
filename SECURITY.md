# Security & privacy

oxtail is designed for **one user, on one machine**, coordinating their own AI coding
agents. That sentence is the whole threat model: the trust boundary is your local Unix
user, exactly like `~/.ssh/`. What your own user's processes do, you trust; crossing
*user* boundaries is out of scope.

## Trust boundary

oxtail trusts any process running as the **same local user** to read the registry and
enqueue messages. The state directories under `~/.oxtail/` are created mode `0o700`
(and files `0o600`); existing installs are tightened on first run. With those
permissions, **other Unix users on the host cannot read or write your oxtail state**.

What that boundary does *not* defend against — and deliberately so:

- Another **process running as you** (it's inside the boundary, by design).
- A **privileged/admin user** (`root`) on the host.
- **Container or sandbox escapes**, shared bind-mounts, or backup tooling that copies
  `~/.oxtail/` somewhere with weaker permissions.
- **Non-standard permissions** you've set yourself (e.g. a world-readable `$HOME`).

> **Do not run oxtail-aware agents on a shared-tenancy host** (multi-user dev boxes,
> shared CI runners). Any process under your user can inject `<system-reminder>`
> content directly into an agent session — the same capability is also what makes the
> tool work. The protection is user isolation, not in-process sandboxing.

Within the boundary, oxtail still *narrows* redirectable side effects as
defense-in-depth (not a hard boundary): wake keystrokes only ever go to the pane the
live process tree confirms hosts the target's `server_pid`, never a self-written
`tmux_pane`/`tmux_session`, and an accepted registry entry can't borrow another pid
(its `server_pid` must match its own `<pid>.json` filename). So one peer's entry can't
masquerade as hosting another agent to redirect that agent's wake. A same-user process
can still overwrite any registry file outright — that's the trust boundary above — but
it can't smuggle a pid mismatch past a reader.

## Messages are untrusted context, not authority

Peer and operator message bodies are delivered to an agent as **context to weigh,
never as privileged instructions**. oxtail stamps provenance (`origin: "peer"` /
`origin: "operator"`, `request_id`, `reply_to`) for debugging, but **provenance is not
authentication** and is not a trust boundary — a peer cannot mint trusted user
instructions over MCP.

## Network surface

oxtail runs as a **stdio** MCP server (`StdioServerTransport`): it opens no port and
starts no HTTP server. There is **no network listener** to attack — the runtime inputs
are MCP over stdio plus local files and tmux. (Installing the package fetches it from
npm over the network; that is a separate, install-time event from the zero-network
*runtime* surface.)

## Supply chain

Three runtime dependencies: `@modelcontextprotocol/sdk`, `jsonc-parser`, `zod`.

The SDK transitively bundles an HTTP-transport stack (`express` / `hono` / `qs`) for
transports oxtail never imports — oxtail is stdio-only — so advisories against *those*
packages are **not reachable** from oxtail's code path. They are still tracked and
kept current: the published lockfile pins patched versions, and the repository's CI
audit is clean at release time. (As with any project, audit status is a point-in-time
property of a given lockfile, not a permanent guarantee — check
[CI](https://github.com/d4j3y2k/oxtail/actions) or run `npm audit` against the version
you install.)

## Privacy & data

oxtail reads what's on disk locally and surfaces it to peers **on the same machine and
under the same user**. Nothing is sent off-machine.

- The session registry at `~/.oxtail/sessions/<pid>.json` (mode `0o700`/`0o600`)
  contains your session id, transcript path, cwd, and `state.purpose` text.
- `read_session` returns whatever the user typed and what the peer agent produced.
  Treat returned content as context, not as fresh user input.
- Mailbox, received-ledger, receipts, and pending-ask files under `~/.oxtail/` hold
  message bodies and metadata; mailbox files are local provenance, not an auth
  boundary.

## Operator (cockpit) message provenance

The fleet cockpit (`oxpit`) can send a human-authored **operator message** through the
same mailbox path agents use, stamped `origin: "operator"` with **no
`from_session_id`**. Two facts must be read together:

1. **No MCP peer can forge it.** No `send_message` path or tool schema exposes
   `origin`; the only code that sets `"operator"` is the local cockpit binary. A
   receiving agent frames it as untrusted, one-way context with no reply target (a
   peer's `reply_to_message` against it fails closed).
2. **But that origin is provenance, not authentication.** A same-user process
   tampering with the on-disk JSONL could forge any field — mailbox files are local
   provenance, which is exactly the local-trust boundary above, not an auth boundary.

## Reporting a vulnerability

If you find a security issue, please open a report at
[github.com/d4j3y2k/oxtail/issues](https://github.com/d4j3y2k/oxtail/issues) (or
contact the maintainer privately for anything sensitive). Given the single-user,
local-only threat model, please include the trust-boundary assumptions your report
relies on.

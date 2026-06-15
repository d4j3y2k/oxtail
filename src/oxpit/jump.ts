// oxpit jump — focus a peer's tmux pane from the cockpit.
//
// HARDENING (consensus): a stored tmux_pane is NEVER trusted at action time —
// pane ids (%n) are recycled when a pane dies, and a pid can be reused. So jump
// RE-RESOLVES the target from the live registry by session identity, then runs it
// through chooseVerifiedWakePane — the same proc_sig + live-process-tree guard the
// wake path uses — to bind a pane that provably still hosts THIS agent. If that
// fails (agent moved/died/reused), we refuse rather than switch into a stranger.
//
// CLIENT-AWARE: every tmux command targets an explicit client. The nice cockpit
// UX is two terminals — the cockpit in one, your work in another — where jump
// drives the OTHER client so the cockpit stays visible. We detect oxpit's own
// client and, when there's exactly one other attached client, drive that;
// otherwise we drive our own client (the single-terminal case) or honor --client.
// Outside tmux we print a manual `attach` command instead of guessing.

import { execFileSync } from "node:child_process";
import {
  chooseVerifiedWakePane,
  isValidTmuxPane,
  readAll,
  type RegistryEntry,
} from "../registry.js";
import type { FleetAgent } from "./snapshot.js";

export type TmuxRunner = (args: string[]) => string;

export type JumpResult =
  | {
      ok: true;
      pane: string;
      session: string;
      window: string;
      client: string | null; // client we switched; null when only select-pane ran
      dryRun?: boolean; // true ⇒ resolved the plan but mutated nothing
      manual?: never;
    }
  | { ok: false; reason: string; manual?: string };

export function realTmux(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type PaneRow = { pane: string; session: string; window: string };

export function listPanes(run: TmuxRunner): PaneRow[] {
  let out: string;
  try {
    out = run(["list-panes", "-a", "-F", "#{pane_id}\t#{session_name}\t#{window_id}"]);
  } catch {
    return [];
  }
  const rows: PaneRow[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [pane, session, window] = line.split("\t");
    if (pane && session && window) rows.push({ pane, session, window });
  }
  return rows;
}

// Map live pane_id → its tmux window name, in one batched call. The cockpit uses
// this for the human-facing AGENT label (you `rename-window main/max/codex` and it
// shows that instead of a hex session id). Pure display — identity/jump stay keyed
// on session_id, so a rename can never mis-target. Empty map when tmux is absent.
export function paneWindowNames(run: TmuxRunner = realTmux): Map<string, string> {
  let out: string;
  try {
    out = run(["list-panes", "-a", "-F", "#{pane_id}\t#{window_name}"]);
  } catch {
    return new Map();
  }
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [pane, name] = line.split("\t");
    if (pane && name) m.set(pane, name);
  }
  return m;
}

type ClientRow = { name: string; tty: string; session: string };

export function listClients(run: TmuxRunner): ClientRow[] {
  let out: string;
  try {
    out = run(["list-clients", "-F", "#{client_name}\t#{client_tty}\t#{client_session}"]);
  } catch {
    return [];
  }
  const rows: ClientRow[] = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [name, tty, session] = line.split("\t");
    if (name) rows.push({ name, tty: tty ?? "", session: session ?? "" });
  }
  return rows;
}

// oxpit's own attached client name, best-effort: a `display-message` with no -t
// resolves against the invoking client (oxpit's controlling terminal).
export function selfClientName(run: TmuxRunner): string | null {
  try {
    const name = run(["display-message", "-p", "#{client_name}"]).trim();
    return name || null;
  } catch {
    return null;
  }
}

// Pick which client to drive. Pure + unit-tested. Priority: explicit --client →
// the single OTHER attached client (keep cockpit visible) → our own client
// (single-terminal) → null (none attached; caller prints the manual command).
export function chooseClient(
  clients: ClientRow[],
  selfClient: string | null,
  explicit: string | undefined,
): { client: string | null; ambiguous: boolean } {
  if (explicit) return { client: explicit, ambiguous: false };
  if (clients.length === 0) return { client: null, ambiguous: false };
  const others = clients.filter((c) => c.name !== selfClient);
  if (others.length === 1) return { client: others[0].name, ambiguous: false };
  if (others.length === 0) return { client: selfClient, ambiguous: false };
  // More than one other client: ambiguous. Prefer self (the predictable choice)
  // and let the caller surface that --client can disambiguate.
  return { client: selfClient ?? others[0].name, ambiguous: true };
}

// Re-resolve the agent's CURRENT registry entry by session identity (handles MCP
// child pid rotation since the snapshot was taken). Falls back to server_pid for
// unclaimed agents.
function freshEntry(agent: FleetAgent): RegistryEntry | null {
  let entries: RegistryEntry[];
  try {
    entries = readAll();
  } catch {
    return null;
  }
  if (agent.session_id) {
    const m = entries.find((e) => e.client.session_id === agent.session_id);
    if (m) return m;
  }
  return entries.find((e) => e.server_pid === agent.server_pid) ?? null;
}

export type JumpDeps = {
  run?: TmuxRunner;
  inTmux?: boolean;
  client?: string;
  // Resolve + validate the full plan (pane, client) but mutate NOTHING — no
  // select-pane / switch-client. Lets a caller preview a jump, and lets the live
  // switch-client path be verified against a real fleet without disturbing it.
  dryRun?: boolean;
  // injectable for tests
  resolveEntry?: (agent: FleetAgent) => RegistryEntry | null;
  verifyPane?: (entry: RegistryEntry) => string | null;
};

export function jumpToAgent(agent: FleetAgent, deps: JumpDeps = {}): JumpResult {
  const run = deps.run ?? realTmux;
  const inTmux = deps.inTmux ?? Boolean(process.env.TMUX);
  const resolveEntry = deps.resolveEntry ?? freshEntry;
  const verifyPane =
    deps.verifyPane ??
    ((e: RegistryEntry) =>
      chooseVerifiedWakePane({
        tmux_pane: e.tmux_pane,
        server_pid: e.server_pid,
        proc_sig: e.proc_sig,
      }));

  const entry = resolveEntry(agent);
  if (!entry) {
    return { ok: false, reason: `${agent.short_id} is no longer in the registry` };
  }
  const pane = verifyPane(entry);
  if (!pane || !isValidTmuxPane(pane)) {
    return {
      ok: false,
      reason: `couldn't verify a live pane for ${agent.short_id} (moved, exited, or pid reused)`,
    };
  }
  const loc = listPanes(run).find((p) => p.pane === pane);
  if (!loc) {
    return { ok: false, reason: `pane ${pane} not found in tmux` };
  }

  // Outside tmux (cockpit in a bare terminal): we can't drive a client — and we
  // must NOT mutate an attached tmux session from here, so return the manual
  // command BEFORE any select-* call. Single-quote the session so an exotic name
  // is safe to paste.
  if (!inTmux) {
    return {
      ok: false,
      reason: "not running inside tmux",
      manual: `tmux attach -t '${loc.session}' \\; select-pane -t ${pane}`,
    };
  }

  // Decide which client to drive BEFORE mutating anything. With ≥2 OTHER attached
  // clients the choice is a guess, so refuse rather than silently switch an
  // arbitrary human's terminal — tell the operator to disambiguate with --client.
  const clients = listClients(run);
  const self = selfClientName(run);
  const choice = chooseClient(clients, self, deps.client);
  if (choice.ambiguous && !deps.client) {
    const others = clients
      .filter((c) => c.name !== self)
      .map((c) => c.name)
      .join(", ");
    return {
      ok: false,
      reason: `multiple attached clients (${others}); pass --client <name> to choose which terminal to move`,
    };
  }

  // Dry run: the plan is fully resolved and validated — report it without touching
  // tmux. (Used to preview a jump and to verify the live path non-destructively.)
  if (deps.dryRun) {
    return { ok: true, pane, session: loc.session, window: loc.window, client: choice.client, dryRun: true };
  }

  // Focus the target pane within its window/session, then move the chosen client.
  try {
    run(["select-pane", "-t", pane]);
    run(["select-window", "-t", pane]);
    if (choice.client) {
      run(["switch-client", "-c", choice.client, "-t", loc.session]);
    } else {
      run(["switch-client", "-t", loc.session]);
    }
  } catch (e) {
    return {
      ok: false,
      reason: `tmux jump failed: ${e instanceof Error ? e.message : e}`,
      manual: `tmux switch-client -t '${loc.session}' \\; select-pane -t ${pane}`,
    };
  }
  return { ok: true, pane, session: loc.session, window: loc.window, client: choice.client };
}

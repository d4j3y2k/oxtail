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

export type PaneInfo = {
  name: string | null; // tmux window name (human label), null when unnamed
  // Last pty-output time (epoch seconds). This is OUTPUT activity, NOT agent
  // liveness — a status overlay / spinner repaint bumps it — so the cockpit
  // surfaces it ONLY as an orthogonal "pane repainted Ns ago" hint, never folded
  // into the liveness enum. Prefers pane_activity (pane-scoped); falls back to
  // window_activity (window-scoped) on tmux builds that don't populate the former.
  activity_at: number | null;
  // tmux window index — the fleet list is ordered by it so the rows stay put (match
  // the agent's window order in tmux) instead of re-sorting as states change.
  window_index: number | null;
};

function toEpochSeconds(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// One batched list-panes call: pane_id → window name + last pty-activity time. The
// cockpit uses the name for the human-facing AGENT label (you `rename-window
// main/max/codex` and it shows that instead of a hex session id; identity/jump stay
// keyed on session_id so a rename can never mis-target) and the activity time for
// the orthogonal pane-recent hint. Empty map when tmux is absent.
export function panePresence(run: TmuxRunner = realTmux): Map<string, PaneInfo> {
  let out: string;
  try {
    out = run([
      "list-panes",
      "-a",
      "-F",
      "#{pane_id}\t#{window_name}\t#{pane_activity}\t#{window_activity}\t#{window_index}",
    ]);
  } catch {
    return new Map();
  }
  const m = new Map<string, PaneInfo>();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [pane, name, paneAct, winAct, winIdx] = line.split("\t");
    if (!pane) continue;
    const wi = winIdx != null && winIdx !== "" ? Number(winIdx) : NaN;
    m.set(pane, {
      name: name || null,
      activity_at: toEpochSeconds(paneAct) ?? toEpochSeconds(winAct),
      window_index: Number.isFinite(wi) ? wi : null,
    });
  }
  return m;
}

// Back-compat: pane_id → window name only, derived from the one batched call.
export function paneWindowNames(run: TmuxRunner = realTmux): Map<string, string> {
  const m = new Map<string, string>();
  for (const [pane, info] of panePresence(run)) if (info.name) m.set(pane, info.name);
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

// Pick which client to drive. Pure + unit-tested. Priority:
//   explicit --client
//   → the single OTHER client ALREADY VIEWING the target's session (the one a jump
//     can actually move to the agent; clients on unrelated sessions — e.g. another
//     project's tmux session — are never hijack targets)
//   → our own client (single-terminal case)
//   → ambiguous (caller refuses + lists candidates) when the choice is a guess.
// `targetSession` is the session the agent's pane lives in.
export function chooseClient(
  clients: ClientRow[],
  selfClient: string | null,
  explicit: string | undefined,
  targetSession: string,
): { client: string | null; ambiguous: boolean; candidates?: string[] } {
  if (explicit) return { client: explicit, ambiguous: false };
  if (clients.length === 0) return { client: null, ambiguous: false };
  const others = clients.filter((c) => c.name !== selfClient);
  if (others.length === 0) return { client: selfClient, ambiguous: false }; // only us
  // Prefer clients already on the target's session — those follow cleanly to the
  // agent's window. Unrelated-session clients are excluded so a jump never drags
  // another project's terminal across.
  const onTarget = others.filter((c) => c.session === targetSession);
  if (onTarget.length === 1) return { client: onTarget[0].name, ambiguous: false };
  if (onTarget.length > 1) {
    return { client: selfClient ?? onTarget[0].name, ambiguous: true, candidates: onTarget.map((c) => c.name) };
  }
  // No other client is viewing the target session: don't hijack an unrelated
  // terminal — surface the choice (the candidates are the unrelated clients).
  return { client: selfClient ?? others[0].name, ambiguous: true, candidates: others.map((c) => c.name) };
}

// Re-resolve an agent's CURRENT registry entry by session identity (handles MCP
// child pid rotation since the snapshot was taken). Falls back to server_pid for
// unclaimed agents. Exported so the activity capture path re-verifies a pane against
// the SAME fresh entry jump does (a recycled pane id must never be captured blind).
export function freshEntry(
  agent: { session_id: string | null; server_pid: number },
  read: () => RegistryEntry[] = readAll,
): RegistryEntry | null {
  let entries: RegistryEntry[];
  try {
    entries = read();
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

// Single-quote a value for a PASTE-able shell command (the manual fallback strings).
// Embedded single quotes are escaped the POSIX way ('\'' ) so an exotic session name
// can't break out (codex — runtime tmux calls are argv-safe; this is paste safety).
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

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

  // Decide which attached tmux client to drive BEFORE mutating anything. This works
  // from a BARE terminal too: `tmux switch-client` talks to the server regardless of
  // whether oxpit itself is a tmux client, so the cockpit can run in a plain side tab
  // and still move your tmux work-client to the agent. Inside tmux we exclude oxpit's
  // OWN client (don't move the cockpit); in a bare terminal there is no own client.
  const clients = listClients(run);
  const self = inTmux ? selfClientName(run) : null;
  const manual = `tmux attach -t ${shellQuote(loc.session)} \\; select-pane -t ${pane}`;
  // No tmux client attached anywhere → nothing to move; hand over the attach command.
  if (clients.length === 0) {
    return {
      ok: false,
      reason: "no tmux client attached to move (open the agents' session in a terminal first)",
      manual,
    };
  }
  // An explicit --client must actually be ATTACHED — validate BEFORE any mutation so a
  // typo can't run select-pane/select-window before switch-client -c fails (codex).
  // (An off-target but attached client is allowed — a deliberate "move that one" act.)
  if (deps.client && !clients.some((c) => c.name === deps.client)) {
    const names = clients.map((c) => c.name).join(", ");
    return { ok: false, reason: `--client '${deps.client}' is not attached (attached: ${names || "none"})` };
  }
  // With ≥2 candidate clients the choice is a guess, so refuse rather than silently
  // switch an arbitrary human's terminal — disambiguate with --client.
  const choice = chooseClient(clients, self, deps.client, loc.session);
  if (choice.ambiguous && !deps.client) {
    const cand = (choice.candidates ?? []).join(", ");
    return {
      ok: false,
      reason: `multiple terminals could be moved (${cand}); pass --client <name> to choose which one`,
    };
  }
  // A bare-terminal jump needs an EXPLICIT target client — there's no "current" client
  // to default to (oxpit isn't one). If none resolved, hand over the manual command.
  if (!inTmux && !choice.client) {
    return { ok: false, reason: "couldn't resolve which terminal to move", manual };
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
      manual: `tmux switch-client -t ${shellQuote(loc.session)} \\; select-pane -t ${pane}`,
    };
  }
  return { ok: true, pane, session: loc.session, window: loc.window, client: choice.client };
}

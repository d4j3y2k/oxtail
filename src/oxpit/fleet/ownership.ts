// Pane ownership: the additive, fail-safe basis for every fleet mutation. oxpit
// tags each pane it spawns with the `@oxpit_managed` tmux pane user-option set
// to a fleetId. Teardown only ever operates on panes carrying THIS fleet's
// marker (computed in teardown.ts) — unmarked panes (a human's editor/dev-server
// split in the same session) are structurally never targets. `respawn-pane -k`
// preserves the option, so a managed pane survives teardown+respawn still tagged.
// Probe-verified 2026-06-19.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface PaneInfo {
  pane: string; // pane_id, e.g. "%20"
  session: string; // session_name
  windowIndex: number;
  windowName: string;
  panePid: number;
  currentCommand: string; // pane_current_command, e.g. "claude" | "node" | "bash" | "zsh"
  managedBy: string | null; // @oxpit_managed value, or null when unset
}

// Unit separator — a field delimiter that cannot collide with a tmux session or
// window name (those can contain spaces and most punctuation, but not \x1f).
const FS = "\x1f";

const PANE_FORMAT = [
  "#{pane_id}",
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_pid}",
  "#{pane_current_command}",
  "#{@oxpit_managed}",
].join(FS);

function tmux(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 2000,
  });
}

export type TmuxRun = (args: string[]) => string;

// Mint a fresh fleetId for a SPAWN. RESET instead DISCOVERS the id by reading the
// marker off the running fleet's panes (markersInSession), so this only needs to
// be collision-resistant, not deterministic.
export function mintFleetId(baseName: string): string {
  const safe = baseName.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 24) || "fleet";
  return `${safe}-${randomBytes(4).toString("hex")}`;
}

// Every pane across all sessions, with its ownership marker. A pane oxpit didn't
// spawn has an empty `@oxpit_managed` → managedBy:null. Returns [] on any tmux
// error (no server, etc.). Scope to a session by filtering on PaneInfo.session.
export function listPanesWithMarkers(run: TmuxRun = tmux): PaneInfo[] {
  let out: string;
  try {
    out = run(["list-panes", "-a", "-F", PANE_FORMAT]);
  } catch {
    return [];
  }
  // tmux renders a control byte placed in the -F TEMPLATE as an OCTAL ESCAPE in
  // its output — verified on tmux 3.5a: the 0x1F (\x1f) field separator comes
  // back as the literal 4-char string "\037", NOT a raw byte. So a naive split on
  // raw 0x1F finds nothing, every row collapses to one field, and the WHOLE
  // ownership listing silently empties against a real tmux — which broke the
  // level probe (probePane → null → "unknown" → SPAWN aborts every window) and
  // RESET's fleetId discovery. The mocked unit tests fed an idealized raw-0x1F
  // payload and never saw it; the live integration test did. So undo the escape
  // (tolerating a tmux that emitted the byte raw) before splitting.
  //
  // CAVEAT (max P5): this is NOT collision-proof. tmux does NOT escape
  // backslashes, so a pane whose session/window NAME literally contains the 4
  // chars "\037" renders identically to a separator here. OUR OWN panes can't
  // carry it — spec window names reject backslash (spec.ts windowNameStr) and
  // session names are sanitized (tmuxSessionName), so nothing WE spawn is
  // poisonable. But listPanesWithMarkers reads ALL panes, and a FOREIGN (human,
  // un-spec'd) pane's name is arbitrary, so it can inject EXTRA fields. The
  // EXACT-COUNT guard below is what makes that safe: tmux always emits exactly 7
  // fields per pane (empty when unset), so a healthy row splits to length 7 and
  // any embedded separator makes it ≥8 → we SKIP the poisoned row (a foreign pane
  // reads as unowned — the safe default for a teardown control) instead of mis-
  // parsing by position, which would land a truthy field on `managedBy` and
  // fabricate a PHANTOM fleetId (false ownership, the dangerous direction — a
  // landmine for RESET).
  const normalized = out.replace(/\\037/g, FS);
  const rows: PaneInfo[] = [];
  for (const line of normalized.split("\n")) {
    if (!line) continue;
    const f = line.split(FS);
    if (f.length !== 7) continue; // exactly 7, else skip — see CAVEAT above
    const windowIndex = Number(f[2]);
    const panePid = Number(f[4]);
    rows.push({
      pane: f[0],
      session: f[1],
      windowIndex: Number.isFinite(windowIndex) ? windowIndex : -1,
      windowName: f[3],
      panePid: Number.isFinite(panePid) ? panePid : -1,
      currentCommand: f[5],
      managedBy: f[6] ? f[6] : null,
    });
  }
  return rows;
}

// The distinct fleetIds tagged on panes in a given session — for RESET to
// discover the id oxpit assigned at spawn (usually exactly one per session).
export function markersInSession(session: string, run: TmuxRun = tmux): string[] {
  const ids = new Set<string>();
  for (const p of listPanesWithMarkers(run)) {
    if (p.session === session && p.managedBy) ids.add(p.managedBy);
  }
  return [...ids];
}

// Tag a pane as managed by this fleet. Set at spawn; preserved across
// respawn-pane -k.
export function markPaneManaged(pane: string, fleetId: string, run: TmuxRun = tmux): void {
  run(["set-option", "-p", "-t", pane, "@oxpit_managed", fleetId]);
}

export function readPaneMarker(pane: string, run: TmuxRun = tmux): string | null {
  try {
    const v = run(["show-options", "-t", pane, "-pqv", "@oxpit_managed"]).trim();
    return v || null;
  } catch {
    return null;
  }
}

// Remove the tmux WINDOW containing `pane` — the cockpit's per-window kill: that one
// agent stops and its window/tab disappears, the rest of the fleet keeps running.
// Three guards, all fail-CLOSED (refuse + reason, never a destructive surprise):
//   1. OWNERSHIP — the pane must carry an @oxpit_managed marker (a human's window is
//      never ours to kill).
//   2. LAST-WINDOW — killing the session's only window COLLAPSES the session (tmux
//      closes a session with no windows). That's destroy-the-fleet, not a per-window
//      kill — refuse and point at RESET / an explicit kill-session.
//   3. UNMANAGED-SPLIT — `kill-window` takes EVERY pane in the window, so if a human
//      split a pane into our window, killing it destroys their work. The additive-
//      safety pillar is "untagged panes are NEVER touched", so refuse unless EVERY
//      pane in the window carries THIS fleet's marker. (max's stricter call over the
//      WIP's "acceptable since the window is ours" — flagged for codex review.)
// `-t <pane>` targets the window the pane belongs to (verified vs tmux 3.5a: list-panes
// -t <pane> is window-scoped; #{session_windows} is the session's window count).
export function killManagedWindow(
  pane: string,
  run: TmuxRun = tmux,
): { ok: true; fleetId: string } | { ok: false; reason: string } {
  const marker = readPaneMarker(pane, run);
  if (!marker) {
    return { ok: false, reason: `pane ${pane} is not oxpit-managed (no @oxpit_managed marker) — refusing to kill` };
  }
  // (2) LAST-WINDOW guard.
  let windowCount: number;
  try {
    windowCount = Number(run(["display-message", "-t", pane, "-p", "#{session_windows}"]).trim());
  } catch (e) {
    return { ok: false, reason: `could not read the session's window count: ${String(e)}` };
  }
  if (!Number.isFinite(windowCount) || windowCount <= 1) {
    return {
      ok: false,
      reason: `pane ${pane} is in the session's ONLY window — killing it would destroy the whole session; use RESET, or kill the session explicitly`,
    };
  }
  // (3) UNMANAGED-SPLIT guard: every pane in the window must carry THIS fleet's marker.
  // `#{pane_id}=#{@oxpit_managed}` is unambiguous — a pane_id is "%N" and a fleetId is
  // [A-Za-z0-9_-] (mintFleetId), so neither contains "=" (and no 0x1F to escape). An
  // empty marker (a human split) → mismatch → refuse.
  try {
    const out = run(["list-panes", "-t", pane, "-F", "#{pane_id}=#{@oxpit_managed}"]);
    for (const line of out.split("\n")) {
      const l = line.trim();
      if (!l) continue;
      const m = l.slice(l.indexOf("=") + 1);
      if (m !== marker) {
        return {
          ok: false,
          reason: `the window of pane ${pane} contains a pane this fleet doesn't own (${m ? `marker "${m}"` : "unmanaged — a human split"}) — refusing to kill (won't destroy unmanaged work)`,
        };
      }
    }
  } catch (e) {
    return { ok: false, reason: `could not enumerate the window's panes: ${String(e)}` };
  }
  try {
    run(["kill-window", "-t", pane]);
    return { ok: true, fleetId: marker };
  } catch (e) {
    return { ok: false, reason: `kill-window failed: ${String(e)}` };
  }
}

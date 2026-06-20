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
  // raw 0x1F finds nothing, every row collapses into one field (length < 7 →
  // skipped), and the WHOLE ownership listing silently empties against a real
  // tmux server — which breaks the level probe (probePane → null → "unknown" →
  // SPAWN aborts every window) and RESET's fleetId discovery. The mocked unit
  // tests fed an idealized raw-0x1F payload and never saw this; the live
  // integration test (spawn-tmux.test.ts) did. Undo the escape — and tolerate a
  // tmux that emitted the byte raw — before splitting. No legal field can hold a
  // real 0x1F (tmux escapes those identically; fleet/pane names forbid control
  // chars), so this can never mis-split a value.
  const normalized = out.replace(/\\037/g, FS);
  const rows: PaneInfo[] = [];
  for (const line of normalized.split("\n")) {
    if (!line) continue;
    const f = line.split(FS);
    if (f.length < 7) continue;
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

// oxpit interactive TUI — the live cockpit.
//
// Raw-ANSI, zero deps (consensus: Ink betrays the zero-dep ethos; a tmux popup
// can't be a live view). Thin over the pure snapshot/render layer:
//   - REFRESH is event-driven: fs.watch(~/.oxtail/{sessions,mailboxes,received,
//     pending-ask}) + debounce, NOT a tight poll (idle-cheap is the spirit), plus
//     a slow fallback tick so mtime-based liveness ages even with no fs events.
//   - SELECTION is sticky by session identity, never row index, so fleet churn
//     can't silently re-point a jump at the wrong agent (v0.16 lesson).
//   - the screen is ALWAYS restored — alt-screen off + cursor shown — on q, Ctrl-C,
//     SIGINT/SIGTERM, and uncaught errors, so a crash never wedges the terminal.

import { watch, type FSWatcher } from "node:fs";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildSnapshot, type FleetAgent, type FleetSnapshot } from "./snapshot.js";
import { ANIM_FRAMES, attentionLine, BACKGROUND_ROW_CAP, commsBodyLines, computeAgentLabels, renderDock, renderSnapshot, windowWithMarkers } from "./render.js";
import { buildCommsLog, type CommsMessage } from "./comms.js";
import { agentKey, capturePaneActivity, type AgentActivity, type PaneActivity } from "./activity.js";
import { clipToWidth, scrubBufferText } from "./format.js";
import { jumpToAgent, realTmux } from "./jump.js";
import { NUDGE_TEXT, sendOperatorMessage } from "./operator.js";
import { formatAttachmentNote, stageAttachment, type StagedAttachment } from "./attachments.js";
import { captureClipboardImage } from "./clipboard.js";
import { parseStatusArgs, USAGE } from "./cli.js";
import { dockPaneCommand, firstWindowOf, invokedViaOxtail, runCockpitDock, weldDockAndAttach } from "./fleet/cockpit.js";
import { loadFleetConfig, modelOptionsForAgent, validateFleetSpec, writeFleetScaffold } from "./fleet/spec.js";
import { renderSpawnPlan, spawnFleet, tmuxSessionExists, tmuxSessionName } from "./fleet/spawn.js";
import { killManagedWindow, readPaneMarker } from "./fleet/ownership.js";
import { buildResetPlan, discoverFleetId, renderResetPlan, resetFleet } from "./fleet/reset.js";
import { computeSyncPlan, renderSyncPlan, syncFleet } from "./fleet/sync.js";
import { listPanesWithMarkers } from "./fleet/ownership.js";
import type { FleetSpec } from "./fleet/types.js";
import { inferProjectRoot, safeRealpath } from "../scope.js";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
// Braille spinner frames for the live spawn-progress indicator.
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Cap for a self-sizing cockpit dock pane (header + agents + footer). A big fleet windows
// with "⋯ N more" markers beyond this rather than letting the dock eat the whole window.
const DOCK_MAX_ROWS = 12;
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";
const CLEAR_EOL = "\x1b[K";
const PASTE_ON = "\x1b[?2004h"; // enable bracketed paste (terminal wraps pastes)
const PASTE_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// Cap an in-flight bracketed paste: a terminal that emits PASTE_START but never
// PASTE_END (mis-implemented / aborted paste) would otherwise grow pasteBuf without
// bound AND swallow every key. Past this, we flush what we have and leave paste mode.
const MAX_PASTE_BYTES = 1_000_000;
const FOCUS_ON = "\x1b[?1004h"; // enable focus reporting (terminal sends \x1b[I / \x1b[O)
const FOCUS_OFF = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";

const WATCH_DIRS = ["sessions", "mailboxes", "received", "pending-ask"];
const DEBOUNCE_MS = 200;
const SLOW_TICK_MS = 1500;
const ANIM_TICK_MS = Math.round(1000 / 6); // ~6fps selected-name animation (focus-gated; SPIKE)
const MAX_WAIT_ROWS = 8;
const LOG_FETCH = 200; // comms messages pulled for the log view (windowed to fit)

function clientFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client") return argv[i + 1];
    if (argv[i].startsWith("--client=")) return argv[i].slice("--client=".length);
  }
  return undefined;
}

export type PasteState = { pasting: boolean; pasteBuf: string };
export type InputAction =
  | { t: "key"; data: string } // dispatch to handleKey
  | { t: "paste"; data: string } // dispatch to onPaste (literal compose insert)
  | { t: "quit" }; // ⌃C while pasting → tear down

// PURE bracketed-paste input FSM, extracted from onData so it is unit-testable (the
// rest of the TUI is bound to process streams). Given the carry-over paste state and
// one input chunk, returns the next state and the ordered actions to dispatch. A paste
// may span chunks (state carries across calls); PASTE_START/PASTE_END toggle paste
// mode; a ⌃C mid-paste yields a single quit (and stops — the only quit must stay live
// even when a terminal never closes a paste); an over-cap unterminated paste flushes as
// a paste and leaves paste mode rather than buffering without bound. handleKey/onPaste
// have no effect on this state, so collecting actions then dispatching ≡ the old inline
// loop.
export function stepInput(
  state: PasteState,
  chunk: string,
  maxPasteBytes: number = MAX_PASTE_BYTES,
): { state: PasteState; actions: InputAction[] } {
  let pasting = state.pasting;
  let pasteBuf = state.pasteBuf;
  const actions: InputAction[] = [];
  let s = chunk;
  while (s.length > 0) {
    if (pasting) {
      if (s.indexOf("\x03") !== -1) {
        return { state: { pasting: false, pasteBuf: "" }, actions: [...actions, { t: "quit" }] };
      }
      const end = s.indexOf(PASTE_END);
      if (end === -1) {
        pasteBuf += s;
        s = "";
        if (pasteBuf.length > maxPasteBytes) {
          actions.push({ t: "paste", data: pasteBuf });
          pasting = false;
          pasteBuf = "";
        }
      } else {
        pasteBuf += s.slice(0, end);
        s = s.slice(end + PASTE_END.length);
        actions.push({ t: "paste", data: pasteBuf });
        pasting = false;
        pasteBuf = "";
      }
    } else {
      const start = s.indexOf(PASTE_START);
      if (start === -1) {
        actions.push({ t: "key", data: s });
        s = "";
      } else {
        if (start > 0) actions.push({ t: "key", data: s.slice(0, start) });
        s = s.slice(start + PASTE_START.length);
        pasting = true;
      }
    }
  }
  return { state: { pasting, pasteBuf }, actions };
}

const DOCK_USAGE = `oxpit dock — assemble (or attach to) the fleet cockpit in one command

Spawns your fleet (each agent in a tmux window), welds the live dock strip
(oxpit --dock) as a short bottom pane in the MAIN window, and attaches you.
Re-running just attaches (it never stacks a second strip). With no fleet.json
it gives you a working shell + dock instead of spawning agents.

  oxpit dock                 spawn (if a fleet.json exists) + dock + attach
  oxpit dock --dry-run       print the exact plan, change nothing
  oxpit dock --spawn         spawn the default fleet even without a fleet.json
  oxpit dock --no-spawn      just a working shell + dock (don't spawn agents)
  oxpit dock --rows N        dock pane height (default 8)
  oxpit dock --session NAME  override the tmux session name
  oxpit dock --project PATH  scope to a specific project root
  -h, --help                 this help`;

// `oxpit dock` — the cockpit-assembly verb (distinct from the `--dock` render flag).
// Resolves the fleet spec, then spawns + docks + attaches via the cockpit engine.
async function runDockCockpit(argv: string[]): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(DOCK_USAGE + "\n");
    return 0;
  }
  const has = (name: string) => argv.includes(name);
  const valOf = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const dryRun = has("--dry-run") || has("-n");
  const rowsRaw = valOf("--rows");
  const dockRows = rowsRaw ? Math.max(4, Number.parseInt(rowsRaw, 10) || 8) : undefined;
  const projectRoot = valOf("--project") ?? process.cwd();

  const cfg = loadFleetConfig(projectRoot);
  if (!cfg.ok) {
    process.stderr.write(`oxpit dock: ${cfg.error}\n`);
    return 1;
  }
  const configured = cfg.source === "project" || cfg.source === "global";
  // --spawn forces the fleet (even from the built-in default); --no-spawn forces a bare
  // shell+dock; otherwise auto (spawn iff a real fleet.json configured it).
  const spawn = has("--spawn") ? true : has("--no-spawn") ? false : undefined;

  // Config-first (the default for any NEW session): open the fleet editor so the user
  // reviews/edits the spec, then `y` applies → spawn (or sync) → weld dock → attach.
  // This fires even with NO fleet.json — the editor is seeded with the built-in default
  // fleet (main/max/codex), so a fresh project gets the spawn-a-crew flow, not a silent
  // empty dock. Skipped for: an existing session (just dock in — the fast path), a bare
  // shell (--no-spawn), an explicit --session name, --go/-y (straight to launch),
  // --dry-run, or no TTY. Those fall through to the one-shot runCockpitDock below.
  const sessionName = valOf("--session") ?? tmuxSessionName(cfg.spec.name);
  const haveTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const editorFirst =
    !dryRun && haveTTY && !has("--go") && !has("-y") && !has("--no-spawn") &&
    valOf("--session") === undefined && !tmuxSessionExists(sessionName);
  if (editorFirst) {
    return runInteractive({
      buildOpts: { allProjects: false, projectRoot },
      color: !process.env.NO_COLOR,
      client: undefined,
      dock: false,
      openEditorOnStart: true,
      cockpitLaunch: { repoRoot: projectRoot, dockRows: dockRows ?? 8 },
    });
  }

  if (!dryRun) {
    process.stdout.write(`oxpit dock → assembling cockpit "${valOf("--session") ?? cfg.spec.name}"…\n`);
  }
  const result = await runCockpitDock(cfg.spec, projectRoot, {
    dryRun,
    sessionName: valOf("--session"),
    dockRows,
    spawn,
    configured,
    log: (m) => process.stdout.write(m + "\n"),
    binPath: process.argv[1],
    viaOxtail: invokedViaOxtail(process.argv[1]),
  });
  if (!result.ok) {
    process.stderr.write(`oxpit dock: ${result.error}\n`);
    return 1;
  }
  return 0;
}

export async function runOxpit(argv: string[]): Promise<number> {
  // `oxpit dock` SUBCOMMAND (assemble the cockpit) — intercept before the viewer flow
  // and before parseStatusArgs (whose --help would otherwise swallow `dock --help`).
  if (argv[0] === "dock") return runDockCockpit(argv.slice(1));

  const a = parseStatusArgs(argv);
  if (a.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const buildOpts = { allProjects: a.all, projectRoot: a.project };
  const dock = argv.includes("--dock");

  // No TTY (piped, CI, popup without -E pty): degrade to a one-shot snapshot
  // (dock or full, matching the requested mode).
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const snap = buildSnapshot(buildOpts);
    const ropts = { color: a.color ?? false, width: process.stdout.columns || 100 };
    const out = dock ? renderDock(snap, ropts) : renderSnapshot(snap, ropts);
    process.stdout.write(out + "\n");
    return 0;
  }

  const color = a.color ?? !process.env.NO_COLOR;
  const client = clientFlag(argv);
  return runInteractive({ buildOpts, color, client, dock });
}

// Run the cockpit as a CLI entry point: runOxpit plus a FULL terminal-restore
// backstop for any throw that escapes its own teardown (runOxpit guards setup +
// first paint, so this should be unreachable — but a terminal wedged in raw mode is
// unforgiving, so it's belt-and-suspenders). Returns the process exit code. Shared by
// the `oxtail oxpit` subcommand and the standalone `oxpit` bin so the backstop lives
// in exactly one place.
export async function runOxpitCli(argv: string[]): Promise<number> {
  try {
    return await runOxpit(argv);
  } catch (e) {
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    } catch {
      // ignore
    }
    // Order mirrors teardown: focus-off, bracketed-paste-off, cursor-show, leave alt.
    process.stdout.write("\x1b[?1004l\x1b[?2004l\x1b[?25h\x1b[?1049l");
    console.error(e);
    return 1;
  }
}

type InteractiveOpts = {
  buildOpts: { allProjects: boolean; projectRoot: string | undefined };
  color: boolean;
  client: string | undefined;
  // Dock mode (`--dock`): paint the compact one-line-per-agent strip (renderDock)
  // instead of the full table — for a short bottom tmux pane. Same data + keys.
  dock: boolean;
  // `oxpit dock` config-first flow: open the fleet editor immediately on launch, and
  // when the user's edit applies + the fleet spawns/syncs, weld the dock + attach the
  // user to the new cockpit (then this TUI tears down). Unset for the normal cockpit.
  openEditorOnStart?: boolean;
  cockpitLaunch?: { repoRoot: string; dockRows: number };
};

function runInteractive(opts: InteractiveOpts): Promise<number> {
  return new Promise<number>((resolve) => {
    let snapshot: FleetSnapshot = buildSnapshot({ ...opts.buildOpts });
    let selectedKey: string | null =
      snapshot.agents.length > 0 ? agentKey(snapshot.agents[0]) : null;
    // Last-known tool sub-state per agent. The slow tick (readActivity) refreshes it
    // for the whole fleet; the cheap 200ms fast ticks (readActivity off) reuse it so
    // the badge stays steady instead of flickering off on an unrelated mailbox event.
    let activityCache = new Map<string, AgentActivity | null>();
    // Live pane-tail for the SELECTED row only (the one exec-class signal). Captured
    // on selection-change + when the selected pane repaints; holds at most one entry.
    let paneActivity = new Map<string, PaneActivity>();
    let lastCapKey: string | null = null; // agentKey of the last pane we captured
    let lastCapAt: number | null = null; // absolute pty-activity epoch at that capture
    let status = "";
    let statusUntil = 0;
    let debounceTimer: NodeJS.Timeout | null = null;
    const watchers: FSWatcher[] = [];
    let slowTick: NodeJS.Timeout | null = null;
    let torndown = false;
    let helpOpen = false;
    let mode: "fleet" | "log" = "fleet";
    // `d` flips the whole fleet view between the full table and the compact dock
    // strip live, same process — seeded by `--dock` but mutable so the cockpit can
    // collapse to a HUD and lean back out to detail without a quit-and-relaunch.
    let dock = opts.dock;
    // Cockpit-dock self-management. When this oxpit IS a welded cockpit dock pane
    // (@oxpit_dock=1 on our own $TMUX_PANE), two behaviors kick in:
    //   • self-size: shrink our pane to fit the fleet (header + agents + footer) so it's
    //     a snug strip regardless of what proportional height tmux handed us — this runs
    //     in OUR process after the window has settled, so the agent's startup re-layout
    //     can't beat it (the bug the weld-side resize kept losing).
    //   • auto-select: highlight the agent in OUR OWN window, so jumping into a window
    //     lands with that agent selected (until you move the cursor yourself).
    const dockSelfPane = opts.dock ? process.env.TMUX_PANE ?? "" : "";
    let selfManagedDock = false;
    if (dockSelfPane) {
      try {
        selfManagedDock = realTmux(["show-options", "-t", dockSelfPane, "-pqv", "@oxpit_dock"]).trim() === "1";
      } catch {
        // not in a managed cockpit dock — leave self-management off
      }
    }
    let dockAutoSelect = selfManagedDock; // until the user moves the cursor
    // The agentKey of the agent in the SAME window as this dock pane (the window's other,
    // un-@oxpit_dock pane), matched to the live fleet. null until that agent registers.
    const dockWindowAgentKey = (): string | null => {
      if (!dockSelfPane) return null;
      try {
        for (const line of realTmux(["list-panes", "-t", dockSelfPane, "-F", "#{pane_id} #{@oxpit_dock}"]).split("\n")) {
          const [pid, mark] = line.trim().split(" ");
          if (pid && pid !== dockSelfPane && mark !== "1") {
            const a = snapshot.agents.find((ag) => ag.tmux_pane === pid);
            if (a) return agentKey(a);
          }
        }
      } catch {
        // ignore
      }
      return null;
    };
    // Snap the selection to this dock's own window-agent (re-tried each refresh until it
    // registers), unless the user has taken the cursor over.
    const applyDockAutoSelect = (): void => {
      if (!dockAutoSelect) return;
      const k = dockWindowAgentKey();
      if (k) selectedKey = k;
    };
    applyDockAutoSelect();
    let logFilterSelf = false; // scope the log to the fleet-selected agent
    // `b` expands the detached-background section into its individual rows (default
    // collapsed to a count header). Detached processes are never navigable, so this is
    // a pure view toggle — it never moves the fleet selection.
    let showBackground = false;
    let logExpanded = false; // `w` — expand the cursor'd message's full body
    let logCursorFromEnd = 0; // comms cursor: 0 = latest message, +1 = one older, …
    let logBodyOffset = 0; // when expanded: lines scrolled within the message body
    let logCursorLen = 1; // last-rendered cursor message height (for body-scroll clamp)
    let logMsgCount = 0; // last-rendered message count (for cursor clamping)
    let logAvail = 0; // last-rendered visible body lines (for cursor paging)
    let pendingNudgeKey: string | null = null; // agentKey awaiting 'y' to confirm a nudge
    let pendingKillKey: string | null = null; // agentKey awaiting a 2nd 'K' to confirm a window kill
    // SPAWN overlay (P4): a full-screen plan preview + y-confirm gate. `S` computes
    // the dry-run plan (read-only) and opens it; `y` executes the real spawn. Cached
    // so the confirm can't re-resolve against a changed fleet. spawnBusy locks the
    // overlay while a live spawn (sequential ensure_window, possibly minutes) runs.
    let spawnOpen = false;
    let spawnView:
      | { lines: string[]; canSpawn: boolean; spec: FleetSpec; sessionName: string }
      | null = null;
    let spawnBusy = false;
    // Live spawn progress: which windows have finished launching (name→ok), an animation
    // frame, and the spinner timer — so the (sequential, ~minutes) spawn shows the crew
    // coming up one by one instead of a static "spawning…" that reads as hung.
    const spawnDone = new Map<string, boolean>();
    let spawnSpinFrame = 0;
    let spawnTimer: NodeJS.Timeout | null = null;
    // SYNC overlay: the editor's `y` routes here when the target session already EXISTS
    // (converge it) vs SPAWN for a new one. Read-only preview → deliberate confirm (a
    // capital `Y` when it deletes, `y` when purely additive). syncBusy locks it in flight.
    let syncOpen = false;
    let syncView:
      | {
          lines: string[];
          canSync: boolean;
          hasDelete: boolean;
          spec: FleetSpec;
          sessionName: string;
          fleetId: string;
          confirmedRemove: string[];
          confirmedAdd: string[];
        }
      | null = null;
    let syncBusy = false;
    // Fleet config EDITOR (grid + hotkeys) — `S` opens this; edit windows in place,
    // then `y` → the plan/confirm overlay → spawn, or `w` → save .oxtail/fleet.json.
    type EditWin = {
      name: string;
      agent: "claude" | "codex";
      model: string;
      effort: string;
      role: string;
      remoteControl: boolean;
    };
    // `reset` present ⇒ the editor was opened from the RESET overlay (`R` → `e`): apply
    // (`y`) recomputes the red teardown+relaunch plan with the EDITED spec instead of
    // spawning/syncing, and esc returns to that plan. Absent ⇒ the `S` spawn/sync flow.
    let fleetEdit:
      | {
          fleetName: string;
          windows: EditWin[];
          cursor: number;
          note: string;
          reset?: { sessionName: string; repoRoot: string };
        }
      | null = null;
    // Active when typing into a text field — only NAMES are free text (window name /
    // fleet name); everything else is a pick-from-list menu (you shouldn't have to
    // know an exact model id, David).
    let fleetEditInput: { field: "name" | "fleetName"; buf: string } | null = null;
    // The pop-up selection menu for model / effort: shows the valid options to pick.
    let fleetEditPick: { field: "model" | "effort"; options: string[]; cursor: number } | null = null;
    const EFFORT_OPTIONS = ["", "low", "medium", "high", "xhigh", "max"];
    // RESET overlay (P6): a full-screen RED plan + survivors preview → DELIBERATE
    // confirm. `R` (capital, distinct from SPAWN) computes the dry-run plan for the
    // SELECTED agent's session and opens it; a SECOND `R` (NOT `y` — defeats SPAWN
    // muscle-memory) executes. The confirmed pane-ids/window-names ride into the live
    // run (confirm-fidelity: a pane that appeared since the preview is never torn down
    // unseen). resetBusy locks the overlay while the destructive run is in flight.
    let resetOpen = false;
    let resetView:
      | {
          lines: string[];
          spec: FleetSpec;
          repoRoot: string; // the SELECTED agent's project root (not the cockpit's) — --all safe
          sessionName: string;
          fleetId: string;
          confirmedTargets: string[];
          confirmedMissing: string[];
        }
      | null = null;
    let resetBusy = false;
    let composing = false; // typing a custom operator message in the TUI
    let composeBuf = ""; // the message being typed
    let composeTargetKey: string | null = null; // agentKey the message is bound to
    const COMPOSE_MAX = 7000; // generous cap; mailbox bodies are ≤8KB
    let composeAttachments: StagedAttachment[] = []; // staged files for the message
    let composeAttachSources: string[] = []; // source path per attachment (for ⌃X undo)
    let composeNote = ""; // transient composer feedback (attach result)
    let pasting = false; // inside a bracketed-paste sequence
    let pasteBuf = ""; // accumulates paste content across data chunks
    // SPIKE (item 1): per-agent BURST animation (David) — a row plays a short one-shot
    // dot/glyph burst when you MOVE to it or when its STATUS (liveness) changes, NOT a
    // continuous loop. The ~6fps timer runs ONLY while a burst is in flight AND the
    // cockpit is focused, so it's idle-cheap (zero repaint at rest / on blur). Env
    // kill-switch. bursts: agentKey → current frame; prevLiveness: change detector.
    const animEnabled = process.env.OXTAIL_OXPIT_ANIM !== "off";
    let focused = true; // assume focused until the terminal says otherwise
    let bursts = new Map<string, number>();
    let prevLiveness = new Map<string, FleetAgent["liveness"]>();
    let animTick: NodeJS.Timeout | null = null;

    const stdin = process.stdin;
    const stdout = process.stdout;

    function selectedIndex(): number {
      if (!selectedKey) return -1;
      return snapshot.agents.findIndex((a) => agentKey(a) === selectedKey);
    }

    function reconcileSelection(): void {
      if (snapshot.agents.length === 0) {
        selectedKey = null;
        return;
      }
      if (selectedIndex() < 0) {
        // selected agent churned out — clamp to the first row.
        selectedKey = agentKey(snapshot.agents[0]);
      }
    }

    // Fleet-mode footer key hints, WORD-WRAPPED to the terminal width so a narrow
    // window doesn't clip them off the right edge. Greedy-packs the items into lines
    // ≤ width; capped at 2 lines (the overflow merges onto line 2, ANSI-clip guards a
    // pathologically narrow terminal). footer() + reservedRows() share this so the
    // table windowing reserves exactly the footer's height (no cursor-home desync).
    function footerKeyLines(width: number): string[] {
      const items = [
        "↑↓ move", "⏎ jump", "n nudge", "m msg", "S fleet", "R reset", "K kill",
        "l log", "w thread", "b bg", "d dock", "r refresh", "? help", "⌃C quit",
      ];
      const maxW = Math.max(16, width - 2);
      const lines: string[] = [];
      let cur = "";
      for (const it of items) {
        const next = cur ? `${cur}  ${it}` : it;
        if (next.length > maxW && cur) {
          lines.push(cur);
          cur = it;
        } else {
          cur = next;
        }
      }
      if (cur) lines.push(cur);
      if (lines.length <= 2) return lines.map((l) => "  " + l);
      return [`  ${lines[0]}`, `  ${lines.slice(1).join("  ")}`]; // cap at 2
    }

    // Fleet-mode footer (log mode carries its own footer inside the panel). The
    // transient status rides on the last key line so it never adds a row.
    function footer(width: number): string {
      const dimmed = footerKeyLines(width).map((l) => dim(l, opts.color));
      const now = Date.now();
      if (now < statusUntil && status) dimmed[dimmed.length - 1] += "  " + status;
      return "\n" + dimmed.join("\n");
    }

    function helpFrame(width: number, rows: number): string {
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const L = [
        b("oxpit — help"),
        "",
        "  ↑/k  ↓/j      move selection (fleet & log panel)",
        "  ⏎             jump to the selected agent's tmux pane",
        "  n             nudge the selected agent (canned operator message; y to confirm)",
        "  m             compose a message (Enter send · ⌥⏎/⌃J newline · ⌃X unattach · Esc cancel)",
        "                attach: drag a file then ⌃A · ⌃V pastes a clipboard image (copy then ⌃V)",
        "  b             show/hide detached background processes (MCP children / codex exec with no tmux pane)",
        "  d             toggle dock ↔ full — collapse the fleet to a compact one-line-per-agent HUD strip (for a short pane) and back",
        "  l             toggle the comms-log bottom panel (fleet stays visible above)",
        "  w             open the selected agent's thread in the panel (per-agent)",
        "                in the panel: ↑↓ move the › cursor (or scroll an expanded msg) · w expand · j/k agents · f filter · ⏎ jump",
        "  S             configure a fleet — grid editor (n/m/f/t/r edit a window · a/d add/delete · w save · y apply: SPAWN if new, SYNC if the session exists)",
        "  R             RESET the selected agent's fleet — teardown + relaunch (red plan; R again to confirm, NOT y; e to reconfigure the relaunch first)",
        "  K             KILL the selected agent's window — removes that one window (K again to confirm; only oxpit-managed)",
        "  r             force refresh    ?  toggle help    ⌃C (Ctrl-C)  quit",
        "",
        d("  🟢 active   🟡 idle   ⚫ dead (exited / pid-reused)"),
        d("  ✉N unread   ⚑N open obligations   ⏳ awaiting a peer reply"),
        d("  ⛔ DEADLOCK (live cycle)   ⚠ stale/possible cycle   † orphaned (target dead)"),
        d("  comms: ⚑ delegation  ⚑✓ done  ⚑✗ blocked  ❓ ask  ↩ reply"),
        d("  the selected row's name twinkles while the cockpit is focused · OXTAIL_OXPIT_ANIM=off"),
        "",
        d("  press ? to return"),
      ];
      // Bound to terminal height: every other paint path windows to `rows`, and a
      // short / split-pane terminal would otherwise overflow and scroll the
      // alt-screen. Keep the cursor a spare row (rows-1); the tail is recoverable (?/r).
      const fit = L.length > rows ? L.slice(0, Math.max(1, rows - 1)) : L;
      return fit.map((l) => clipToWidth(l, width) + CLEAR_EOL).join("\n");
    }

    // Lines of fixed chrome around the agent table, so the table can be windowed to
    // fit the terminal height (paging) — a large fleet can't overflow and desync
    // the cursor-home repaint.
    function reservedRows(width: number): number {
      const waiters = snapshot.agents.filter((a) => a.waiting);
      const wgBody = snapshot.cycles.length + waiters.filter((a) => !a.waiting?.in_cycle).length;
      const wgLines =
        waiters.length || snapshot.cycles.length
          ? 2 + Math.min(wgBody, MAX_WAIT_ROWS) + (wgBody > MAX_WAIT_ROWS ? 1 : 0)
          : 0;
      // header(1) + optional attention line + column header(1) + footer(blank + wrapped
      // key lines) + wait-graph + warnings + window markers(2) + margin(1). The footer
      // height tracks the width so a wrapped footer doesn't overflow the table window.
      const attn = attentionLine(snapshot, (x) => x) ? 1 : 0;
      const footerRows = 1 + footerKeyLines(width).length;
      // The detached-background section: 0 when none; 1 (collapsed header) by default;
      // header + capped rows (+ overflow line) when expanded. Reserved so the agent
      // table windows ABOVE it instead of the section overflowing the frame.
      const bg = snapshot.background ?? [];
      const bgLines =
        bg.length === 0
          ? 0
          : showBackground
            ? 1 + Math.min(bg.length, BACKGROUND_ROW_CAP) + (bg.length > BACKGROUND_ROW_CAP ? 1 : 0)
            : 1;
      return 1 + attn + 1 + footerRows + wgLines + bgLines + snapshot.warnings.length + 2 + 1;
    }

    function fleetFrame(width: number, rows: number): string {
      const maxAgentRows = Math.max(3, rows - reservedRows(width));
      return renderSnapshot(snapshot, {
        color: opts.color,
        width,
        selected: selectedIndex(),
        maxAgentRows,
        maxWaitRows: MAX_WAIT_ROWS,
        paneActivity,
        toolActivity: activityCache, // sticky overlay — never mutates the snapshot
        burstFrames: animEnabled ? bursts : undefined, // per-agent one-shot bursts
        showBackground,
      });
    }

    // Start a one-shot burst on agent `key` (you moved to it, or its status changed).
    // EXCLUSIVE — only one row animates at a time: the new burst clears any other, so
    // you never see two at once and the row you just left never lingers (David).
    function startBurst(key: string): void {
      if (!animEnabled) return;
      bursts.clear();
      bursts.set(key, 0);
      ensureAnim();
    }
    // The burst timer runs ONLY while there's a burst in flight AND the cockpit is
    // focused — at rest (no bursts) or on blur it's stopped, so the cockpit is
    // genuinely zero-repaint when nothing's happening (idle-cheap).
    function ensureAnim(): void {
      if (!animEnabled || animTick || torndown || !focused || bursts.size === 0) return;
      animTick = setInterval(() => {
        if (torndown || !focused) return;
        for (const [key, frame] of [...bursts]) {
          const next = frame + 1;
          if (next >= ANIM_FRAMES) bursts.delete(key); // burst finished — back to static
          else bursts.set(key, next);
        }
        if (bursts.size === 0) stopAnim();
        paint();
      }, ANIM_TICK_MS);
    }
    function stopAnim(): void {
      if (animTick) {
        clearInterval(animTick);
        animTick = null;
      }
    }
    function setFocus(f: boolean): void {
      if (f === focused) return;
      focused = f;
      if (f) ensureAnim();
      else stopAnim();
    }

    // Capture the SELECTED agent's live pane bottom-line (the one exec-class signal).
    // EXEC-cheap because it's one pane, gated by a change-detector: only when the
    // selection changed (force) or the selected pane has produced new output since
    // our last capture (window_activity advanced). Skipped while typing / in an
    // overlay / log mode, and for dead·self·pane-less rows. capturePaneActivity
    // re-verifies the pane id (a recycled id never captures a stranger).
    function maybeCaptureSelected(force: boolean): void {
      if (composing || helpOpen || spawnOpen || syncOpen || resetOpen || fleetEdit || mode === "log") return;
      const idx = selectedIndex();
      const a = idx >= 0 ? snapshot.agents[idx] : undefined;
      if (!a || a.liveness === "dead" || a.is_self || !a.tmux_pane) {
        // nothing capturable selected — drop any stale tail so it can't linger.
        if (paneActivity.size) {
          paneActivity = new Map();
          lastCapKey = null;
          lastCapAt = null;
          paint();
        }
        return;
      }
      const key = agentKey(a);
      // Use the ABSOLUTE pty-activity epoch (not the clamped relative age, which a
      // future-dated/skewed timestamp would pin to nowSec → capture every tick). When
      // tmux reports NO activity time (null) we can't change-detect, so refresh each
      // tick anyway — it's one pane, cheap (max review: fixes both the skew→every-tick
      // and the null→inert edges).
      const activityAt = a.pane_activity_at;
      const changed = key !== lastCapKey;
      const newer = activityAt == null || lastCapAt == null || activityAt > lastCapAt;
      if (!force && !changed && !newer) return;
      const pa = capturePaneActivity(a);
      lastCapKey = key;
      lastCapAt = activityAt;
      paneActivity = new Map();
      if (pa && (pa.pane_tail || pa.pane_busy)) paneActivity.set(key, pa);
      paint();
    }

    // Comms panel rendered as the BOTTOM region (items 3+4): a separator, the comms
    // header, the windowed body, and a footer of panel keys — EXACTLY `rows` lines so
    // the caller can pin it to the foot with the fleet table above. A › CURSOR marks
    // the selected message (default = the latest); ↑↓ move it, the window follows, and
    // `w` expands the cursor'd message's full body (David's model). `f` filters to the
    // fleet selection (the per-agent thread, item 4).
    function logPanelLines(width: number, rows: number): string[] {
      const d = (s: string) => dim(s, opts.color);
      const sep = d("─".repeat(Math.max(4, width)));
      const footerKeys = d(
        `  ↑↓ ${logExpanded ? "scroll" : "select"} · w ${logExpanded ? "collapse" : "expand"} · jk agents · f filter${logFilterSelf ? "*" : ""} · ⏎ jump · l global · Esc close`,
      );
      // Include background (detached) peers so their fleet mail still shows with a
      // resolved label rather than vanishing / rendering as a bare hex id.
      const commsAgents = [...snapshot.agents, ...(snapshot.background ?? [])];
      const { bySession } = computeAgentLabels(commsAgents);
      let comms: CommsMessage[] = buildCommsLog(commsAgents, { limit: LOG_FETCH });
      let filterNote = "";
      if (logFilterSelf) {
        const sel = snapshot.agents[selectedIndex()];
        const sid = sel?.session_id;
        if (sid) {
          comms = comms.filter((m) => m.from_session_id === sid || m.to_session_id === sid);
          filterNote = `  [${sel.window_name ?? sel.short_id}]`;
        } else {
          filterNote = "  [no agent selected]";
        }
      }
      const n = comms.length;
      logMsgCount = n;
      // Fixed line budget: sep(1) + header(1) + up-marker(1) + body(avail) +
      // down-marker(1) + footer(1) = avail + 5 = rows (markers always emitted, blank
      // when nothing's hidden) so the panel is a constant `rows` lines — no desync.
      const avail = Math.max(1, rows - 5);
      logAvail = avail;

      let allLines: string[];
      let cursorStart = 0;
      let cursorLen = 0;
      if (n === 0) {
        allLines = [d("  no inter-agent messages yet")];
      } else {
        if (logCursorFromEnd > n - 1) logCursorFromEnd = n - 1;
        if (logCursorFromEnd < 0) logCursorFromEnd = 0;
        const cursorIdx = n - 1 - logCursorFromEnd; // absolute index (0=oldest, n-1=newest)
        const cursorId = comms[cursorIdx].message_id;
        // Render each message as its own group so we know the cursor message's line
        // span (for windowing); the cursor message is marked + expanded (if `w`).
        const groups = comms.map((m, i) =>
          commsBodyLines([m], bySession, {
            color: opts.color,
            width,
            cursorId: i === cursorIdx ? cursorId : undefined,
            expandedId: i === cursorIdx && logExpanded ? cursorId : undefined,
          }),
        );
        for (let i = 0; i < cursorIdx; i++) cursorStart += groups[i].length;
        cursorLen = groups[cursorIdx].length;
        allLines = groups.flat();
      }

      logCursorLen = cursorLen;
      const maxStart = Math.max(0, allLines.length - avail);
      let winStart: number;
      if (logExpanded && cursorLen > 0) {
        // Reading the expanded message: scroll WITHIN its body from the top (↑↓ drive
        // logBodyOffset) so a message taller than the panel can still be read fully.
        const maxBody = Math.max(0, cursorLen - avail);
        logBodyOffset = Math.max(0, Math.min(logBodyOffset, maxBody));
        winStart = Math.min(cursorStart + logBodyOffset, maxStart);
      } else {
        // Collapsed: center the cursor message and keep it fully visible.
        winStart = cursorStart - Math.floor((avail - cursorLen) / 2);
        winStart = Math.max(0, Math.min(winStart, maxStart));
        if (cursorStart < winStart) winStart = cursorStart;
        if (cursorStart + cursorLen > winStart + avail) {
          winStart = Math.max(0, cursorStart + cursorLen - avail);
        }
      }
      const winEnd = winStart + avail;

      const header =
        (opts.color ? "\x1b[1m\x1b[36mcomms\x1b[0m" : "comms") +
        d(`  ${n} msg${filterNote}`);
      const out: string[] = [sep, header];
      out.push(winStart > 0 ? d(`  ↑ ${winStart} more`) : "");
      const win = allLines.slice(winStart, winEnd);
      out.push(...win);
      for (let i = win.length; i < avail; i++) out.push(""); // pad so the footer pins
      out.push(winEnd < allLines.length ? d(`  ↓ ${allLines.length - winEnd} more`) : "");
      out.push(footerKeys);
      // Normalize to EXACTLY `rows` lines for ANY height (codex MEDIUM): trim from the
      // top while always preserving the footer, so the panel can never desync.
      if (rows <= 0) return [];
      if (out.length > rows) return [...out.slice(0, rows - 1), out[out.length - 1]];
      while (out.length < rows) out.push("");
      return out;
    }

    // Hard char-wrap a single logical line to `w` columns.
    function wrapText(s: string, w: number): string[] {
      if (w <= 0 || s.length <= w) return [s];
      const out: string[] = [];
      for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
      return out;
    }

    // WORD-wrap to `w` columns (break at spaces; char-split a token longer than w).
    // Used for the plan/confirm body so long recipe steps read cleanly instead of
    // breaking mid-word.
    function wrapWords(s: string, w: number): string[] {
      if (w <= 0 || s.length <= w) return [s];
      const out: string[] = [];
      let cur = "";
      for (const word of s.split(" ")) {
        let token = word;
        while (token.length > w) {
          if (cur) {
            out.push(cur);
            cur = "";
          }
          out.push(token.slice(0, w));
          token = token.slice(w);
        }
        if (!cur) cur = token;
        else if (cur.length + 1 + token.length <= w) cur += " " + token;
        else {
          out.push(cur);
          cur = token;
        }
      }
      if (cur) out.push(cur);
      return out.length ? out : [""];
    }

    // Compose FIELD — a compact input pinned to the bottom of the screen, with the
    // fleet/log still visible above it (paint() sizes the top region and pads so this
    // bar sits at the foot). Replaces the old full-screen modal: messaging from the
    // cockpit should feel like a chat field, not a whole-screen context switch. The
    // buffer is tail-windowed so a long multi-line message can't grow the bar without
    // bound (which would desync the cursor-home repaint).
    const MAX_FIELD_LINES = 6;
    // Build the composer (separator + ✉target header + input buffer + attachments +
    // note + key hint). `maxLines` is the pane budget: in a short dock pane the bar
    // caps itself toward that height — the separator is dropped, attachments collapse to
    // a count, the buffer tail-windows, and the hint shortens. The input/cursor line is
    // always kept; if the pane is shorter than the fixed chrome the trailing hint is
    // dropped first, and the caller's slice is the final correctness backstop.
    function composerBar(width: number, maxLines: number): string[] {
      const a = composeTargetKey
        ? snapshot.agents.find((ag) => agentKey(ag) === composeTargetKey)
        : undefined;
      const to = a ? a.window_name ?? a.short_id : "?";
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const mark = a?.is_self ? " → your primary session" : "";
      const tight = maxLines < 10;
      // Drop the separator rule in a short pane — every row counts, and the ✉target line
      // + "> " prompt already delimit the composer from the fleet above.
      const header = tight
        ? [b(`✉ ${to}`) + d(mark)]
        : [d("─".repeat(Math.max(4, width))), b(`✉ ${to}`) + d(mark)];

      // Attachments: list ≤3 (with overflow) when there's room; collapse to a single
      // count line when the pane is short so they never crowd out the input.
      const attBlock: string[] = [];
      if (composeAttachments.length) {
        if (tight) {
          attBlock.push(d(`📎 ${composeAttachments.length} attached`));
        } else {
          for (const att of composeAttachments.slice(0, 3)) attBlock.push(d(`📎 ${att.name} (${att.bytes}B)`));
          if (composeAttachments.length > 3) attBlock.push(d(`📎 …+${composeAttachments.length - 3} more`));
        }
      }
      const noteBlock = composeNote ? [d(composeNote)] : [];
      const undo = composeAttachments.length ? " · ⌃X unattach" : "";
      const hint = d(
        tight
          ? `⏎ send · ⌥⏎ nl · ⌃A attach · ⌃V img${undo} · esc`
          : `Enter send · ⌥⏎/⌃J newline · drag+⌃A attach · ⌃V image${undo} · Esc cancel`,
      );

      // Buffer: each logical line wrapped, "> " on the first SHOWN line, cursor on the
      // last. Tail-windowed first to MAX_FIELD_LINES, then to whatever the pane budget
      // leaves after the fixed chrome — but always at least the cursor line.
      const wrapped: string[] = [];
      for (const logical of composeBuf.split("\n")) {
        for (const seg of wrapText(logical, width - 2)) wrapped.push(seg);
      }
      if (wrapped.length === 0) wrapped.push("");
      wrapped[wrapped.length - 1] += "█";
      const fixed = header.length + attBlock.length + noteBlock.length + 1; // +1 = hint
      const bufBudget = Math.max(1, Math.min(MAX_FIELD_LINES, maxLines - fixed));
      const win = wrapped.length > bufBudget ? wrapped.slice(wrapped.length - bufBudget) : wrapped;
      const bufLines = win.map((seg, i) => (i === 0 ? d("> ") : "  ") + seg);

      return [...header, ...bufLines, ...attBlock, ...noteBlock, hint];
    }

    function paint(): void {
      if (torndown) return;
      const width = stdout.columns || 100;
      const rows = stdout.rows || 24;
      if (helpOpen) {
        stdout.write(HOME + helpFrame(width, rows) + CLEAR_BELOW);
        return;
      }
      if (fleetEdit) {
        stdout.write(HOME + fleetEditorFrame(width, rows) + CLEAR_BELOW);
        return;
      }
      if (spawnOpen) {
        stdout.write(HOME + spawnFrame(width, rows) + CLEAR_BELOW);
        return;
      }
      if (syncOpen) {
        stdout.write(HOME + syncFrame(width, rows) + CLEAR_BELOW);
        return;
      }
      if (resetOpen) {
        stdout.write(HOME + resetFrame(width, rows) + CLEAR_BELOW);
        return;
      }
      if (composing) {
        // Compose field at the BOTTOM; fleet/log stays visible above. The bar is
        // budgeted to `rows` so in a short dock pane it caps itself (and can take the
        // whole pane — composing is modal) instead of overflowing; the final slice is
        // the correctness backstop against any residual over-tall bar.
        const bar = composerBar(width, rows).map((l) => clipToWidth(l, width) + CLEAR_EOL);
        const avail = Math.max(0, rows - bar.length);
        const top: string[] = [];
        if (avail > 0) {
          const topStr =
            mode === "log" ? logPanelLines(width, avail).join("\n") : fleetFrame(width, avail);
          for (const l of topStr.split("\n").slice(0, avail)) top.push(clipToWidth(l, width) + CLEAR_EOL);
          while (top.length < avail) top.push(CLEAR_EOL); // pad so the bar sits at the bottom
        }
        stdout.write(HOME + [...top, ...bar].slice(0, rows).join("\n") + CLEAR_BELOW);
        return;
      }
      const clipEOL = (l: string) => clipToWidth(l, width) + CLEAR_EOL;
      if (mode === "log") {
        // Size the fleet to its NATURAL height (show all agents) and give the comms
        // panel EVERYTHING below it — no wasted middle gap (David). On a huge fleet,
        // cap the fleet so the panel keeps a minimum height. topAvail + panelRows ==
        // rows exactly (logPanelLines returns EXACTLY its requested rows); the final
        // slice only guards a degenerate tiny terminal.
        const MIN_PANEL = 6;
        const natural = fleetFrame(width, snapshot.agents.length + 24).split("\n");
        const maxTop = Math.max(3, rows - MIN_PANEL);
        const topAvail = Math.min(natural.length, maxTop);
        const top = (natural.length <= maxTop ? natural : fleetFrame(width, maxTop).split("\n"))
          .slice(0, topAvail)
          .map(clipEOL);
        while (top.length < topAvail) top.push(CLEAR_EOL);
        const panel = logPanelLines(width, rows - topAvail).map(clipEOL);
        stdout.write(HOME + [...top, ...panel].slice(0, rows).join("\n") + CLEAR_BELOW);
        return;
      }
      // Dock mode: the compact strip replaces the whole fleet view (it brings its
      // own header + footer). slice(0, rows) is the overflow backstop — a fleet
      // taller than the pane truncates rather than wrapping into a repaint desync.
      if (dock) {
        // Self-size a welded cockpit dock to fit its content (header + agents + footer),
        // capped, so it's a snug strip rather than whatever proportional height tmux gave
        // it. Runs in OUR process after the window settled, so it can't lose the race the
        // weld-side resize did. Converges: resize → SIGWINCH → repaint → rows == want.
        if (selfManagedDock && dockSelfPane) {
          const want = Math.min(Math.max(3, snapshot.agents.length + 2), DOCK_MAX_ROWS);
          // Shrink-only: pin it snug when tmux gave us too much (the half-screen bug), and
          // keep it snug if the window later grows; never fight a user who wants it taller.
          if (rows > want) {
            try {
              realTmux(["resize-pane", "-t", dockSelfPane, "-y", String(want)]);
            } catch {
              // best-effort
            }
          }
        }
        const dockBody = renderDock(snapshot, {
          color: opts.color,
          width,
          selected: selectedIndex(),
          toolActivity: activityCache,
          // Reserve the header + footer rows; renderDock windows the agents to the rest
          // (with "⋯ N more" markers) so a tall fleet doesn't silently truncate.
          maxAgentRows: Math.max(1, rows - 2),
          // Surface a live confirm/feedback line in the strip's footer (the full table
          // rides these on its own footer; the dock has no other seam).
          dockStatus: Date.now() < statusUntil && status ? status : undefined,
        })
          .split("\n")
          .slice(0, rows)
          .map(clipEOL)
          .join("\n");
        stdout.write(HOME + dockBody + CLEAR_BELOW);
        return;
      }
      // Clip every physical line to the terminal width (ANSI-aware) so none wraps —
      // a wrapped line would push the cursor-home repaint out of sync and corrupt
      // the screen. The renderers already clip their lines; this covers the footer
      // and is idempotent.
      const body = (fleetFrame(width, rows) + footer(width))
        .split("\n")
        .map(clipEOL)
        .join("\n");
      stdout.write(HOME + body + CLEAR_BELOW);
    }

    function closeLog(): void {
      mode = "fleet";
      paint();
    }

    // Move the comms cursor by `delta` messages (+ = older, − = newer); clamps to
    // [0, n-1] and repaints. logMsgCount is set by the last logPanelLines render.
    function logCursorMove(delta: number): void {
      const next = Math.max(0, Math.min(logMsgCount - 1, logCursorFromEnd + delta));
      if (next === logCursorFromEnd) return;
      logCursorFromEnd = next;
      logBodyOffset = 0; // a fresh message — start at its top if expanded
      paint();
    }

    // Scroll WITHIN the expanded message's body by `delta` lines (+ = down/later).
    // Clamps to the message's overflow; logCursorLen/logAvail are set at last render.
    function logBodyScroll(delta: number): void {
      const maxBody = Math.max(0, logCursorLen - logAvail);
      const next = Math.max(0, Math.min(maxBody, logBodyOffset + delta));
      if (next === logBodyOffset) return;
      logBodyOffset = next;
      paint();
    }

    // A "page" of messages/lines for Space/b/PgUp/PgDn — about a panel's worth.
    function logCursorPage(): number {
      return Math.max(1, Math.floor(logAvail / 2));
    }

    function refresh(full: boolean): void {
      // checkProcSig rides the `full` flag (the `ps` spawn is the costly bit — slow
      // tick / forced refresh only). readActivity is ALWAYS on: tool_running now FEEDS
      // LIVENESS (active/tool_running), and gating it to slow ticks made a silent-tool
      // row flap 🟢↔🟡 between ticks (max+codex review). scanLatestTool is 512KB-
      // bounded and stops at the first tool_use, so a per-tick read is cheap. The
      // sticky activityCache still backs the renderer's toolActivity overlay (a torn/
      // degraded read blips the badge off for one tick instead of forking truth).
      snapshot = buildSnapshot({ ...opts.buildOpts, checkProcSig: full, readActivity: true });
      applyDockAutoSelect(); // re-snap to our window-agent once it registers (until the user moves)
      activityCache = new Map(snapshot.agents.map((a) => [agentKey(a), a.activity]));
      // Burst any agent whose liveness CHANGED since the last build ("becomes awake",
      // goes idle, dies). prevLiveness starts empty so the first build never bursts.
      for (const a of snapshot.agents) {
        const key = agentKey(a);
        const prev = prevLiveness.get(key);
        if (prev !== undefined && prev !== a.liveness) startBurst(key);
      }
      prevLiveness = new Map(snapshot.agents.map((a) => [agentKey(a), a.liveness]));
      reconcileSelection();
      paint();
    }

    function scheduleRefresh(): void {
      if (torndown || debounceTimer) return;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!torndown) refresh(false);
      }, DEBOUNCE_MS);
    }

    function setStatus(msg: string): void {
      status = msg;
      statusUntil = Date.now() + 5000;
      paint();
    }

    function move(delta: number): void {
      if (snapshot.agents.length === 0) return;
      dockAutoSelect = false; // you've taken the cursor — stop snapping to the window-agent
      let idx = selectedIndex();
      if (idx < 0) idx = 0;
      idx = (idx + delta + snapshot.agents.length) % snapshot.agents.length;
      selectedKey = agentKey(snapshot.agents[idx]);
      // Walking the fleet re-points the per-agent thread → reset the comms cursor to
      // that agent's latest message + collapse (item 4 follow-selection).
      logCursorFromEnd = 0;
      logExpanded = false;
      logBodyOffset = 0;
      startBurst(selectedKey); // one burst on the agent you moved to (David)
      paint();
      maybeCaptureSelected(true); // capture the newly-selected pane immediately
    }

    function doJump(): void {
      const idx = selectedIndex();
      if (idx < 0) {
        setStatus(warn("no agent selected", opts.color));
        return;
      }
      const agent = snapshot.agents[idx];
      // In the dock (the persistent cockpit), ⏎ flips the agent's WINDOW under you and
      // keeps you in that window's dock — you never get teleported into the agent pane.
      const r = jumpToAgent(agent, { client: opts.client, dockLocal: opts.dock });
      if (r.ok) {
        setStatus(
          ok(`→ jumped to ${agent.short_id} (${r.session}${r.client ? ` · ${r.client}` : ""})`, opts.color),
        );
      } else if (r.manual) {
        setStatus(warn(`${r.reason} — run: ${r.manual}`, opts.color));
      } else {
        setStatus(warn(`jump failed: ${r.reason}`, opts.color));
      }
    }

    // Send the canned operator nudge to a SPECIFIC agent (bound at confirm time by
    // session key, never re-resolved from the live selection — so fleet churn during
    // the y-confirm can't mis-point it at a different agent).
    function doNudge(agent: FleetAgent): void {
      const label = agent.window_name ?? agent.short_id;
      setStatus(dim(`nudging ${label}…`, opts.color));
      sendOperatorMessage(
        { session_id: agent.session_id, server_pid: agent.server_pid, short_id: label },
        NUDGE_TEXT,
        {},
      )
        .then((r) => {
          if (torndown) return; // cockpit quit while the wake was in flight
          if (r.ok) setStatus(ok(`→ nudged ${r.target_short_id} (wake:${r.wake_status})`, opts.color));
          else setStatus(warn(`nudge failed: ${r.reason}`, opts.color));
        })
        .catch((e) => {
          if (torndown) return;
          setStatus(warn(`nudge error: ${e instanceof Error ? e.message : e}`, opts.color));
        });
    }

    // Remove the selected agent's WINDOW (cockpit per-window kill). killManagedWindow
    // refuses an unmarked pane (only OUR fleet windows), so a human's window is safe.
    // Bound by the pre-resolved agent (the K-again confirm can't mis-point it).
    function doKillWindow(agent: FleetAgent): void {
      const label = agent.window_name ?? agent.short_id;
      if (!agent.tmux_pane) return setStatus(warn(`no tmux pane for ${label} — can't kill`, opts.color));
      // Read the marker NOW and pass it as the EXPECTED fleet identity (codex HIGH) — a
      // direct kill has no plan→delete gap, but the primitive now requires the caller's
      // intended fleetId, and this refuses an unmarked / re-marked pane.
      const fleetId = readPaneMarker(agent.tmux_pane);
      if (!fleetId) return setStatus(warn(`"${label}" isn't oxpit-managed — can't kill`, opts.color));
      const r = killManagedWindow(agent.tmux_pane, fleetId);
      if (r.ok) {
        setStatus(ok(`✓ killed window "${label}"`, opts.color));
        refresh(true); // the window's gone — re-read the fleet
      } else {
        setStatus(warn(`kill: ${r.reason}`, opts.color));
      }
    }

    // ── SPAWN (P4): plan overlay → y-confirm → execute ───────────────────────
    // Open the READ-ONLY plan overlay for THIS project: resolve the fleet spec
    // (project>global>default), render the exact dry-run plan (tmux commands +
    // per-window recipes, incl. the --effort flags), and pre-check the session-name
    // collision so the operator sees up-front whether `y` will run or is blocked.
    // Mutates nothing — the real spawn is doSpawn, gated behind the confirm.
    // Build + open the read-only SPAWN plan/confirm overlay for a spec — the "exactly
    // what will run" screen reached from the editor's `y`. Pre-checks the collision
    // for the gate; spawnFleet re-checks refuse-to-clobber inside its lock.
    function openSpawnPlan(spec: FleetSpec, sessionName: string, sourceLine: string): void {
      if (spawnOpen || spawnBusy) return;
      const collision = tmuxSessionExists(sessionName);
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const lines: string[] = [
        b("SPAWN — review & confirm"),
        d(`  ${sourceLine}`),
        d(`  → tmux session "${sessionName}" · ${spec.windows.length} window(s): ${spec.windows.map((w) => w.name).join(", ")}`),
        "",
      ];
      if (collision) {
        lines.push(
          warn(`  ⚠ a tmux session "${sessionName}" already exists — SPAWN is blocked (it only CREATES, never clobbers).`, opts.color),
        );
        lines.push(d("    rename the fleet (F in the editor), or RESET the existing fleet."));
        lines.push("");
      }
      lines.push(d("  plan — nothing runs until you confirm:"));
      for (const pl of renderSpawnPlan(spec, "<minted@spawn>", sessionName).split("\n")) {
        lines.push("  " + pl);
      }
      spawnView = { lines, canSpawn: !collision, spec, sessionName };
      spawnOpen = true;
      paint();
    }

    // ── fleet config EDITOR (grid + hotkeys) ───────────────────────────────────
    // `S` opens this, seeded from the effective spec (project>global>default). Edit
    // the windows in place; `y` → the plan/confirm overlay → spawn; `w` → save.
    function openFleetEditor(): void {
      if (fleetEdit || spawnOpen || spawnBusy || resetOpen) return;
      const cfg = loadFleetConfig(snapshot.project_root);
      if (!cfg.ok) {
        return setStatus(warn(`config invalid (${cfg.source}: ${cfg.path}) — ${cfg.error} — fix or delete it`, opts.color));
      }
      const windows: EditWin[] = cfg.spec.windows.map((w) => ({
        name: w.name,
        agent: w.agent,
        model: w.model ?? "",
        effort: w.effort ?? "",
        role: w.role ?? "",
        remoteControl: w.remoteControl ?? false,
      }));
      fleetEdit = {
        fleetName: cfg.spec.name,
        windows,
        cursor: 0,
        note: `source: ${cfg.source}${cfg.path ? ` (${cfg.path})` : ""}`,
      };
      paint();
    }

    // The edited grid → a FleetSpec (drop empty optional fields). Pure.
    function specFromEdit(fe: NonNullable<typeof fleetEdit>): FleetSpec {
      return {
        name: fe.fleetName,
        windows: fe.windows.map((w) => ({
          name: w.name,
          agent: w.agent,
          ...(w.model.trim() ? { model: w.model.trim() } : {}),
          ...(w.effort.trim() ? { effort: w.effort.trim() } : {}),
          ...(w.role.trim() ? { role: w.role.trim() } : {}),
          ...(w.remoteControl ? { remoteControl: true } : {}),
        })),
      };
    }

    // `w` — validate the grid, then OVERWRITE .oxtail/fleet.json with it.
    function doSaveFromEdit(): void {
      if (!fleetEdit) return;
      const v = validateFleetSpec(specFromEdit(fleetEdit));
      if (!v.ok) {
        fleetEdit.note = `✗ ${v.error}`;
        return paint();
      }
      // In reset-mode save to the SELECTED agent's project (could differ from the
      // cockpit's in --all mode); the spawn flow saves to the cockpit's project.
      const root = fleetEdit.reset?.repoRoot ?? snapshot.project_root;
      const r = writeFleetScaffold(root, v.spec, { overwrite: true });
      fleetEdit.note = r.ok ? `✓ saved ${r.path}` : `✗ ${r.reason}`;
      paint();
    }

    // `y` — validate the grid, then hand the spec to the plan/confirm overlay.
    function doSpawnFromEdit(): void {
      if (!fleetEdit) return;
      const v = validateFleetSpec(specFromEdit(fleetEdit));
      if (!v.ok) {
        fleetEdit.note = `✗ cannot apply: ${v.error}`;
        return paint();
      }
      const spec = v.spec;
      const sessionName = tmuxSessionName(spec.name);
      fleetEdit = null;
      fleetEditInput = null;
      // Route by session existence: an EXISTING session → SYNC (converge — add/keep/delete
      // to match the spec, without restarting healthy agents); a NEW one → SPAWN (create).
      if (tmuxSessionExists(sessionName)) {
        openSyncPlan(spec, sessionName);
      } else {
        openSpawnPlan(spec, sessionName, "configured in oxpit (w in the editor saves it to .oxtail/fleet.json)");
      }
    }

    // The editor grid (full-screen). The cursor row is inverse-video; a text-input
    // line replaces the hotkey legend while editing name/model/fleet-name.
    function fleetEditorFrame(width: number, rows: number): string {
      if (!fleetEdit) return "";
      const fe = fleetEdit;
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const red = (s: string) => (opts.color ? `\x1b[1m\x1b[31m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const sessionName = tmuxSessionName(fe.fleetName);
      const header = fe.reset
        ? red("RESET — reconfigure") +
          d(`   fleet "${fe.fleetName}" → session "${sessionName}"  (y: preview the reset with these edits)`)
        : b("FLEET — configure") +
          d(`     fleet "${fe.fleetName}" → session "${sessionName}"  (y: spawn if new, sync if it exists)`);
      // The control footer ALWAYS stays visible — it's how you operate the editor, so
      // it must never be the row that gets clipped off in a squashed dock pane. When the
      // pane is short the verbose multi-line key hints collapse to one dense line, the
      // head sheds its spacer row, and the window grid scrolls to keep the cursor on
      // screen. An open pick/input menu replaces the hints (and windows its own options).
      const tight = rows < 16;
      const colHeader = d(
        "  " + "window".padEnd(14) + "agent".padEnd(8) + "model".padEnd(16) + "effort".padEnd(8) + "rc",
      );
      // In a very short pane drop the column-header row entirely — that one row, handed
      // back to the window grid, is what lets a small fleet (and its "⋯ N more" marker)
      // fully fit instead of clipping a window with no indicator. The note stays (it
      // carries save/error feedback); the column labels are guessable for a few windows.
      const head =
        rows < 8
          ? [header, d(`  ${fe.note}`)]
          : tight
            ? [header, d(`  ${fe.note}`), colHeader]
            : [header, d(`  ${fe.note}`), "", colHeader];

      const winRows = fe.windows.map((w, i) => {
        const rc = w.agent === "claude" ? (w.remoteControl ? "on" : "off") : "–";
        const cells =
          (w.name || "(unnamed)").padEnd(14) +
          w.agent.padEnd(8) +
          (w.model || "–").padEnd(16) +
          (w.effort || "–").padEnd(8) +
          rc;
        return i === fe.cursor
          ? opts.color
            ? `\x1b[7m▸ ${cells}\x1b[0m`
            : `▸ ${cells}`
          : `  ${cells}`;
      });

      // Window `linesIn` to keep `cursor` visible within `cap` rows, prepending/appending
      // a dim "⋯ N more above/below" marker as its OWN line (additive — never overwrites a
      // content row, so the count is exact and the bottom marker can't be dropped). A
      // cap ≤ 0 collapses the section to nothing so the footer always wins the budget.
      const fitWin = (linesIn: string[], cursor: number, cap: number): string[] => {
        if (cap <= 0) return [];
        const { start, end, above, below } = windowWithMarkers(linesIn.length, cursor, cap);
        const out: string[] = [];
        if (above > 0) out.push(d(`  ⋯ ${above} more above`));
        for (let i = start; i < end; i++) out.push(linesIn[i]);
        if (below > 0) out.push(d(`  ⋯ ${below} more below`));
        return out;
      };

      let footer: string[];
      if (fleetEditPick) {
        const pk = fleetEditPick;
        const optLines = pk.options.map((opt, i) => {
          const label = opt === "" ? "(default)" : opt;
          return i === pk.cursor
            ? opts.color
              ? `\x1b[7m  ▸ ${label}\x1b[0m`
              : `  ▸ ${label}`
            : `    ${label}`;
        });
        footer = [
          b(`  select ${pk.field} for "${fe.windows[fe.cursor].name}":`),
          // Reserve the title + hint (2) AND the non-tight spacer row so the whole frame
          // (head + this footer + sep) stays within `rows` and the pick hint survives.
          ...fitWin(optLines, pk.cursor, Math.max(1, rows - head.length - (tight ? 0 : 1) - 2)),
          d("  ↑↓ · ⏎ pick · esc cancel"),
        ];
      } else if (fleetEditInput) {
        footer = [b(`  edit ${fleetEditInput.field}: ${fleetEditInput.buf}█`), d("  ⏎ ok · esc cancel")];
      } else if (tight) {
        footer = [
          d(
            fe.reset
              ? "  ↑↓ sel · a/d add·del · n/m/f/t/r edit · w save · y PREVIEW · esc back"
              : "  ↑↓ sel · a/d add·del · n/m/f/t/r edit · w save · y apply · esc",
          ),
        ];
      } else {
        footer = [
          d("  ↑↓ select · a add window · d delete"),
          d("  n name · m model · f effort · t type · r remote-control"),
          d(
            fe.reset
              ? "  F fleet-name · w save .oxtail/fleet.json · y PREVIEW RESET (with these edits) · esc back to plan"
              : "  F fleet-name · w save .oxtail/fleet.json · y APPLY (spawn new / sync existing) · esc cancel",
          ),
        ];
      }

      const sep = tight ? [] : [""];
      const cap = rows - head.length - footer.length - sep.length;
      return [...head, ...fitWin(winRows, fe.cursor, cap), ...sep, ...footer]
        .slice(0, Math.max(1, rows))
        .map((l) => clipToWidth(l, width) + CLEAR_EOL)
        .join("\n");
    }

    // Editor key state machine. An open pick-menu (model/effort) or text-input (names
    // only) takes keys first; otherwise the grid hotkeys act on the cursor window.
    function handleFleetEditKey(s: string): void {
      const fe = fleetEdit;
      if (!fe) return;
      // The model/effort pick-menu takes keys first while open.
      if (fleetEditPick) {
        const pk = fleetEditPick;
        if (s === "\x03") return teardown(0);
        if (s === "\x1b") {
          fleetEditPick = null;
          return paint();
        }
        if (s === "\x1b[A" || s === "k") {
          pk.cursor = (pk.cursor - 1 + pk.options.length) % pk.options.length;
          return paint();
        }
        if (s === "\x1b[B" || s === "j") {
          pk.cursor = (pk.cursor + 1) % pk.options.length;
          return paint();
        }
        if (s === "\r" || s === "\n" || s === " ") {
          const val = pk.options[pk.cursor];
          if (pk.field === "model") fe.windows[fe.cursor].model = val;
          else fe.windows[fe.cursor].effort = val;
          fleetEditPick = null;
          return paint();
        }
        return; // swallow other keys while the menu is open
      }
      if (fleetEditInput) {
        const inp = fleetEditInput;
        if (s === "\x03") return teardown(0);
        if (s === "\x1b") {
          fleetEditInput = null;
          return paint();
        }
        if (s[0] === "\x1b") return; // drop arrows/other escapes
        if (s === "\r" || s === "\n") {
          const val = inp.buf.trim();
          if (inp.field === "fleetName") fe.fleetName = val || fe.fleetName;
          else fe.windows[fe.cursor][inp.field] = val;
          fleetEditInput = null;
          return paint();
        }
        if (s === "\x7f" || s === "\b") {
          inp.buf = inp.buf.slice(0, -1);
          return paint();
        }
        inp.buf = (inp.buf + scrubBufferText(s, false)).slice(0, 80);
        return paint();
      }
      const w = fe.windows[fe.cursor];
      if (s === "\x1b") {
        // esc from a reset-seeded editor returns to the (unchanged) red plan, not the
        // fleet — the operator is mid-reset, abandoning the edits, not the reset.
        const backToReset = Boolean(fe.reset);
        fleetEdit = null;
        if (backToReset) resetOpen = true;
        return paint();
      }
      if (s === "\x1b[A" || s === "k") {
        fe.cursor = (fe.cursor - 1 + fe.windows.length) % fe.windows.length;
        return paint();
      }
      if (s === "\x1b[B" || s === "j") {
        fe.cursor = (fe.cursor + 1) % fe.windows.length;
        return paint();
      }
      if (s === "n") {
        fleetEditInput = { field: "name", buf: w.name };
        return paint();
      }
      if (s === "m") {
        // Pick from the curated per-agent model list (+ a "(default)" / inherit
        // option); preserve a custom hand-edited value as a selectable entry.
        const base = [...modelOptionsForAgent(w.agent), ""];
        const options = base.includes(w.model) ? base : [w.model, ...base];
        fleetEditPick = { field: "model", options, cursor: Math.max(0, options.indexOf(w.model)) };
        return paint();
      }
      if (s === "F") {
        fleetEditInput = { field: "fleetName", buf: fe.fleetName };
        return paint();
      }
      if (s === "f") {
        fleetEditPick = {
          field: "effort",
          options: EFFORT_OPTIONS,
          cursor: Math.max(0, EFFORT_OPTIONS.indexOf(w.effort)),
        };
        return paint();
      }
      if (s === "t") {
        w.agent = w.agent === "claude" ? "codex" : "claude";
        if (w.agent === "codex") w.remoteControl = false; // /rc is claude-only
        // a model valid for the old agent may be invalid for the new one → reset to
        // the new agent's default (e.g. opus[1m] ↔ gpt-5.5); keep "" (inherit) as-is.
        const opts = modelOptionsForAgent(w.agent);
        if (w.model && !opts.includes(w.model)) w.model = opts[0];
        return paint();
      }
      if (s === "r") {
        if (w.agent !== "claude") {
          fe.note = "remote control is Claude-only";
          return paint();
        }
        w.remoteControl = !w.remoteControl;
        return paint();
      }
      if (s === "a") {
        let name = `win${fe.windows.length + 1}`;
        while (fe.windows.some((x) => x.name === name)) name += "x";
        fe.windows.push({ name, agent: "claude", model: "", effort: "", role: "", remoteControl: false });
        fe.cursor = fe.windows.length - 1;
        fe.note = `added window "${name}" — set its model/effort/type`;
        return paint();
      }
      if (s === "d") {
        if (fe.windows.length <= 1) {
          fe.note = "a fleet needs at least one window";
          return paint();
        }
        fe.windows.splice(fe.cursor, 1);
        if (fe.cursor >= fe.windows.length) fe.cursor = fe.windows.length - 1;
        return paint();
      }
      if (s === "w") return doSaveFromEdit();
      // Apply: in reset-mode → preview the reset with these edits; else spawn/sync.
      if (s === "y") return fe.reset ? doResetFromEdit() : doSpawnFromEdit();
    }

    // Execute the previewed SPAWN for real (non-dry-run). Doubly guarded: the overlay
    // only offers `y` when there's no collision, AND spawnFleet re-checks refuse-to-
    // clobber inside its lock. Additive — never attaches/switches, never touches
    // another session. The sequential ensure_window can take minutes, so the overlay
    // shows a "spawning…" line and swallows keys (spawnBusy) until it resolves; the
    // fleet then refreshes so the new session appears in the cockpit.
    function doSpawn(): void {
      if (!spawnView || spawnBusy || !spawnView.canSpawn) return;
      const { spec, sessionName } = spawnView;
      spawnBusy = true;
      // Start the live progress: clear the done-set + spin the indicator so the
      // sequential, slow spawn shows the crew coming up rather than reading as hung.
      spawnDone.clear();
      spawnSpinFrame = 0;
      if (spawnTimer) clearInterval(spawnTimer);
      spawnTimer = setInterval(() => {
        if (torndown) return;
        spawnSpinFrame++;
        paint();
      }, 120);
      paint();
      spawnFleet(spec, snapshot.project_root, {
        dryRun: false,
        sessionName,
        onWindowDone: (w, wok) => {
          spawnDone.set(w, wok);
          paint(); // tick the checklist as each agent lands
        },
      })
        .then((r) => {
          spawnBusy = false;
          spawnOpen = false;
          spawnView = null;
          if (spawnTimer) {
            clearInterval(spawnTimer);
            spawnTimer = null;
          }
          if (torndown) return;
          const up = r.results.filter((x) => x.ok).length;
          if (r.ok) {
            setStatus(ok(`✓ spawned "${r.sessionName}" — ${up}/${r.results.length} windows up [${r.fleetId}]`, opts.color));
          } else if (r.error) {
            // HARD failure (session never created — refuse-to-clobber / creation throw).
            setStatus(warn(`spawn failed: ${r.error}`, opts.color));
          } else {
            // PARTIAL: the session exists, some agents didn't launch. Still a usable cockpit.
            setStatus(warn(`spawned "${r.sessionName}" — ${up}/${r.results.length} up, some agents failed (see panes)`, opts.color));
          }
          // `oxpit dock`: a CREATED session (full OR partial) is a usable cockpit — weld +
          // attach, matching the one-shot path. Only a hard failure (no session, r.error)
          // stays in the viewer. The dock itself shows which agents came up.
          if (opts.cockpitLaunch && !r.error) {
            return enterCockpit(r.sessionName, spec.windows[0]?.name ?? "main");
          }
          refresh(true); // surface the new fleet in the cockpit
        })
        .catch((e) => {
          spawnBusy = false;
          spawnOpen = false;
          spawnView = null;
          if (spawnTimer) {
            clearInterval(spawnTimer);
            spawnTimer = null;
          }
          if (torndown) return;
          setStatus(warn(`spawn error: ${e instanceof Error ? e.message : e}`, opts.color));
        });
    }

    // The SPAWN overlay frame (full-screen, like helpFrame). Windows the plan to the
    // terminal height while ALWAYS keeping the confirm prompt on the last row (the
    // plan can run longer than a short terminal). Pure render.
    function spawnFrame(width: number, rows: number): string {
      if (!spawnView) return "";
      const d = (s: string) => dim(s, opts.color);
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const wrapW = Math.max(8, width);
      // While the (sequential, slow) spawn runs, show a LIVE checklist — the crew coming
      // up one by one (✓ done · spinner launching · ◦ pending) — so the wait reads as
      // progress, not a hang. Replaces the static plan preview until it resolves.
      if (spawnBusy) {
        const spin = SPINNER[spawnSpinFrame % SPINNER.length];
        const wins = spawnView.spec.windows;
        const upCount = [...spawnDone.values()].filter(Boolean).length;
        let activeShown = false;
        const checklist = wins.map((w) => {
          if (spawnDone.has(w.name)) {
            return spawnDone.get(w.name) ? d(`    ✓ ${w.name}`) : warn(`    ✗ ${w.name}`, opts.color);
          }
          if (!activeShown) {
            activeShown = true;
            return `    ${spin} ${w.name} — launching…`;
          }
          return d(`    ◦ ${w.name}`);
        });
        const body = [
          b(`  ${spin} spawning "${spawnView.sessionName}" — ${upCount}/${wins.length} agents up`),
          "",
          ...checklist,
          "",
          d("  working… (⌃C exits — a partial fleet may remain; re-run to finish)"),
        ];
        return body.slice(0, Math.max(1, rows)).map((l) => clipToWidth(l, wrapW) + CLEAR_EOL).join("\n");
      }
      const prompt = spawnView.canSpawn
        ? warn("  press y to SPAWN · any other key to go back", opts.color)
        : warn("  press any key to go back", opts.color);
      // WRAP the (plain) plan lines so long recipe steps aren't clipped off the right
      // edge; colored header/source lines have ANSI codes → pass them through to the
      // ANSI-aware clip (they're short and never need wrapping). Continuation lines are
      // indented so a wrapped step reads as one logical line.
      const wrapped = spawnView.lines.flatMap((l) => {
        if (l.includes("\x1b") || l.length <= wrapW) return [l];
        // wrap to width-2 so the 2-space continuation indent never pushes past the edge
        return wrapWords(l, Math.max(8, wrapW - 2)).map((seg, i) => (i ? "  " + seg : seg));
      });
      const budget = Math.max(1, rows - 1); // reserve the prompt row
      let shown = wrapped;
      if (shown.length > budget) {
        shown = [
          ...wrapped.slice(0, budget - 1),
          d(`  … +${wrapped.length - (budget - 1)} more (full plan via the CLI --dry-run)`),
        ];
      }
      return [...shown, prompt].map((l) => clipToWidth(l, wrapW) + CLEAR_EOL).join("\n");
    }

    // ── SYNC: converge an EXISTING session to the spec (the editor's `y` routes here
    // when the session already exists; SPAWN handles a new one). ADD windows the spec
    // gained, KEEP healthy ones running, DELETE windows it lost. Read-only preview →
    // doSync executes. A red DESTRUCTIVE confirm when anything is deleted; a light
    // confirm when purely additive. Captures confirmedRemove/confirmedAdd so the live
    // run can only touch what the operator SAW (confirm-fidelity).
    function openSyncPlan(spec: FleetSpec, sessionName: string): void {
      if (syncOpen || syncBusy || spawnOpen || resetOpen) return;
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const red = (s: string) => (opts.color ? `\x1b[1m\x1b[31m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const disc = discoverFleetId(sessionName);
      if (!disc.ok) {
        // The session exists but isn't a single oxpit-managed fleet — not ours to converge.
        syncView = {
          lines: [
            red("SYNC — can't converge this session"),
            d(`  "${sessionName}" exists but isn't a single oxpit-managed fleet:`),
            d(`    ${disc.reason}`),
            d("  SYNC converges an oxpit-SPAWNed fleet; an unmanaged/foreign session isn't ours to touch."),
          ],
          canSync: false,
          hasDelete: false,
          spec,
          sessionName,
          fleetId: "",
          confirmedRemove: [],
          confirmedAdd: [],
        };
        syncOpen = true;
        return paint();
      }
      const fleetId = disc.fleetId;
      const panes = listPanesWithMarkers().filter((p) => p.session === sessionName);
      const plan = computeSyncPlan(spec, fleetId, panes);
      const hasDelete = plan.remove.length > 0;
      const lines: string[] = [
        hasDelete ? red("SYNC — converge (DESTRUCTIVE: removes window(s))") : b("SYNC — converge to spec"),
        d(`  fleet "${spec.name}" → session "${sessionName}" [${fleetId}]`),
        "",
        d("  plan — nothing runs until you confirm:"),
        ...renderSyncPlan(spec, fleetId, sessionName, plan).split("\n").map((l) => "  " + l),
      ];
      syncView = {
        lines,
        canSync: true,
        hasDelete,
        spec,
        sessionName,
        fleetId,
        confirmedRemove: plan.remove.map((p) => p.pane),
        confirmedAdd: plan.add.map((w) => w.name),
      };
      syncOpen = true;
      paint();
    }

    // Execute the previewed SYNC. Passes confirmedRemove/confirmedAdd so the live
    // (fresh-locked) run acts ONLY on what the operator saw; healthy windows are NOT
    // restarted. Busy-locked while in flight; the fleet refreshes on completion.
    function doSync(): void {
      if (!syncView || syncBusy || !syncView.canSync) return;
      const { spec, sessionName, fleetId, confirmedRemove, confirmedAdd } = syncView;
      syncBusy = true;
      syncView = {
        ...syncView,
        lines: [...syncView.lines, "", dim(`  syncing "${sessionName}"… adding, keeping, removing`, opts.color)],
      };
      paint();
      syncFleet(spec, snapshot.project_root, sessionName, { dryRun: false, fleetId, confirmedRemove, confirmedAdd })
        .then((r) => {
          syncBusy = false;
          syncOpen = false;
          syncView = null;
          if (torndown) return;
          const added = r.added.filter((x) => x.ok).length;
          const removed = r.removed.filter((x) => x.ok).length;
          const drift = (r.unconfirmed?.remove.length ?? 0) + (r.unconfirmed?.add.length ?? 0);
          const driftMsg = drift ? ` · ${drift} appeared-since, skipped (re-run)` : "";
          if (r.ok) {
            setStatus(ok(`✓ synced "${sessionName}" — +${added} added · ~${r.kept.length} kept · -${removed} removed${driftMsg}`, opts.color));
          } else {
            // codex: surface the degraded/skip reason, not just "failed".
            const firstBad =
              r.added.find((x) => !x.ok)?.reason ?? // the ROOT cause (a failed ADD/KEEP)…
              r.kept.find((x) => !x.ok)?.reason ?? // …surfaces before…
              r.removed.find((x) => !x.ok)?.reason ?? // …the CONSEQUENCE (a skipped DELETE). codex.
              r.error ??
              "see results";
            setStatus(warn(`sync incomplete: ${firstBad}${driftMsg}`, opts.color));
          }
          // `oxpit dock`: the session ALREADY exists for a sync (we're converging it), so
          // it's a usable cockpit on full OR partial — weld + attach either way.
          if (opts.cockpitLaunch) return enterCockpit(sessionName, spec.windows[0]?.name ?? "main");
          refresh(true); // surface the converged (or partial) fleet
        })
        .catch((e) => {
          syncBusy = false;
          syncOpen = false;
          syncView = null;
          if (torndown) return;
          setStatus(warn(`sync error: ${e instanceof Error ? e.message : e}`, opts.color));
        });
    }

    // The SYNC overlay frame. Mirrors spawnFrame; the confirm scales to RISK — a DELETE
    // needs a deliberate capital `Y` (a reflexive `y` cancels), purely-additive takes `y`.
    function syncFrame(width: number, rows: number): string {
      if (!syncView) return "";
      const d = (s: string) => dim(s, opts.color);
      const red = (s: string) => (opts.color ? `\x1b[1m\x1b[31m${s}\x1b[0m` : s);
      const prompt = syncBusy
        ? d("  working… (Ctrl-C aborts the cockpit)")
        : !syncView.canSync
          ? warn("  press any key to go back", opts.color)
          : syncView.hasDelete
            ? red("  press Y to SYNC (REMOVES window(s) + converges) · any other key cancels")
            : warn("  press y to SYNC (add / converge) · any other key to go back", opts.color);
      const wrapW = Math.max(8, width);
      const wrapped = syncView.lines.flatMap((l) => {
        if (l.includes("\x1b") || l.length <= wrapW) return [l];
        return wrapWords(l, Math.max(8, wrapW - 2)).map((seg, i) => (i ? "  " + seg : seg));
      });
      const budget = Math.max(1, rows - 1);
      let shown = wrapped;
      if (shown.length > budget) {
        shown = [...wrapped.slice(0, budget - 1), d(`  … +${wrapped.length - (budget - 1)} more (resize the terminal taller to see the full plan)`)];
      }
      return [...shown, prompt].map((l) => clipToWidth(l, wrapW) + CLEAR_EOL).join("\n");
    }

    // ── RESET (P6): RED plan overlay → deliberate confirm → destructive execute ──
    // Open the READ-ONLY reset plan for the SELECTED agent's tmux session: discover
    // the fleetId from its markers, compute the teardown plan + the survivors (the
    // unmarked human splits that will NOT be touched), and capture the confirmed target
    // pane-ids / missing window-names. Mutates nothing — doReset is the gated
    // destructive execute, and it passes the captured set so the live run can only
    // touch what the operator SAW (confirm-fidelity).
    // Build the RESET preview (red plan + survivors + confirmed targets) for a given
    // spec against a live session. Pure-ish (reads tmux); shared by the initial `R`
    // (on-disk spec) and the `R`→`e` editor apply (edited spec), so the red preview the
    // operator confirms ALWAYS reflects the spec that will actually relaunch. Returns
    // the resetView payload, or a reason string when discovery fails.
    function resetViewFromSpec(
      spec: FleetSpec,
      sessionName: string,
      repoRoot: string,
    ): { ok: true; view: NonNullable<typeof resetView> } | { ok: false; reason: string } {
      const disc = discoverFleetId(sessionName);
      if (!disc.ok) return { ok: false, reason: disc.reason };
      const fleetId = disc.fleetId;
      const plan = buildResetPlan(spec, fleetId, sessionName);
      const survivors = listPanesWithMarkers().filter((p) => p.session === sessionName && p.managedBy !== fleetId);
      const red = (s: string) => (opts.color ? `\x1b[1m\x1b[31m${s}\x1b[0m` : s);
      const lines: string[] = [
        red("RESET — tear down + relaunch this fleet (DESTRUCTIVE)"),
        ...renderResetPlan(spec, fleetId, sessionName, plan, survivors).split("\n").map((l) => "  " + l),
      ];
      return {
        ok: true,
        view: {
          lines,
          spec,
          repoRoot,
          sessionName,
          fleetId,
          confirmedTargets: plan.targets.map((t) => t.pane.pane),
          confirmedMissing: plan.missing.map((w) => w.name),
        },
      };
    }

    function openReset(): void {
      if (resetOpen || resetBusy || spawnOpen) return;
      const idx = selectedIndex();
      const agent = idx >= 0 ? snapshot.agents[idx] : undefined;
      if (!agent?.tmux_session) {
        return setStatus(warn("reset: select an agent that's in a tmux session first", opts.color));
      }
      const sessionName = agent.tmux_session;
      // Derive the SELECTED agent's OWN project root (not the cockpit's) so an --all
      // cross-project row resets + relaunches in ITS project with ITS spec (codex P6).
      // Single-project mode already matched (project_root === the agent's project).
      const repoRoot = safeRealpath(inferProjectRoot(agent.cwd));
      const cfg = loadFleetConfig(repoRoot);
      if (!cfg.ok) {
        return setStatus(warn(`reset: fleet config invalid (${cfg.source}) — ${cfg.error}`, opts.color));
      }
      const built = resetViewFromSpec(cfg.spec, sessionName, repoRoot);
      if (!built.ok) return setStatus(warn(`reset: ${built.reason}`, opts.color));
      resetView = built.view;
      resetOpen = true;
      paint();
    }

    // `e` on the RESET overlay → open the SAME grid editor seeded from the reset's spec,
    // so the operator can reconfigure what the fleet relaunches as (model/effort/type,
    // add/remove windows) before the destroy. resetView is kept as the cancel fallback.
    function openResetEditor(): void {
      if (!resetView || resetBusy) return;
      const { spec, sessionName, repoRoot } = resetView;
      fleetEdit = {
        fleetName: spec.name,
        windows: spec.windows.map((w) => ({
          name: w.name,
          agent: w.agent,
          model: w.model ?? "",
          effort: w.effort ?? "",
          role: w.role ?? "",
          remoteControl: w.remoteControl ?? false,
        })),
        cursor: 0,
        note: "RESET config — y previews the reset with these settings · w saves to .oxtail/fleet.json",
        reset: { sessionName, repoRoot },
      };
      resetOpen = false; // the editor takes the screen; resetView stays as the esc fallback
      paint();
    }

    // `y` in the reset-seeded editor → recompute the red plan with the EDITED spec and
    // return to the confirm overlay (the destructive trigger stays the deliberate 2nd R).
    function doResetFromEdit(): void {
      if (!fleetEdit?.reset) return;
      const v = validateFleetSpec(specFromEdit(fleetEdit));
      if (!v.ok) {
        fleetEdit.note = `✗ cannot apply: ${v.error}`;
        return paint();
      }
      const { sessionName, repoRoot } = fleetEdit.reset;
      const built = resetViewFromSpec(v.spec, sessionName, repoRoot);
      if (!built.ok) {
        fleetEdit.note = `✗ ${built.reason}`;
        return paint();
      }
      fleetEdit = null;
      fleetEditInput = null;
      resetView = built.view;
      resetOpen = true;
      paint();
    }

    // Execute the previewed RESET. Passes confirmedTargets/confirmedMissing so the live
    // (fresh-locked) run acts ONLY on what the operator saw — a pane that appeared since
    // the preview is surfaced, not torn down unseen. Per-pane respawn-k (kill-session
    // never); the unmarked survivors are structurally untouched. Busy-locked while the
    // destructive run is in flight; the fleet refreshes on completion.
    function doReset(): void {
      if (!resetView || resetBusy) return;
      const { spec, repoRoot, sessionName, fleetId, confirmedTargets, confirmedMissing } = resetView;
      resetBusy = true;
      resetView = {
        ...resetView,
        lines: [...resetView.lines, "", dim(`  resetting "${sessionName}"… tearing down, relaunching`, opts.color)],
      };
      paint();
      resetFleet(spec, repoRoot, sessionName, { dryRun: false, fleetId, confirmedTargets, confirmedMissing })
        .then((r) => {
          resetBusy = false;
          resetOpen = false;
          resetView = null;
          if (torndown) return;
          if (r.ok) {
            const up = r.relaunches.filter((x) => x.ok).length;
            const skipped = (r.unconfirmed?.targets.length ?? 0) + (r.unconfirmed?.missing.length ?? 0);
            const drift = skipped ? ` · ${skipped} appeared-since, skipped (re-run to include)` : "";
            setStatus(ok(`✓ reset "${r.sessionName}" — ${up}/${r.relaunches.length} relaunched${drift}`, opts.color));
            refresh(true);
          } else if (r.error) {
            // discovery-level failure — nothing was torn down.
            setStatus(warn(`reset failed: ${r.error}`, opts.color));
          } else {
            // per-pane partial failure (max): surface the count + first CONCRETE reason
            // (not "see results" pointing nowhere), and refresh so the resulting
            // half-reset state shows immediately — for a destroy, the post-failure state
            // is exactly what the operator needs to see.
            const torn = r.teardowns.filter((t) => t.ok).length;
            const why =
              r.teardowns.find((t) => !t.ok)?.reason ?? r.relaunches.find((x) => !x.ok)?.reason ?? "see results";
            setStatus(warn(`reset: ${torn}/${r.teardowns.length} torn down — ${why}`, opts.color));
            refresh(true);
          }
        })
        .catch((e) => {
          resetBusy = false;
          resetOpen = false;
          resetView = null;
          if (torndown) return;
          setStatus(warn(`reset error: ${e instanceof Error ? e.message : e}`, opts.color));
        });
    }

    // The RESET overlay frame. Like spawnFrame, but the confirm is a DELIBERATE re-press
    // of `R` (NOT `y`), default-cancel, so SPAWN muscle-memory can't fire a destroy.
    function resetFrame(width: number, rows: number): string {
      if (!resetView) return "";
      const d = (s: string) => dim(s, opts.color);
      const red = (s: string) => (opts.color ? `\x1b[1m\x1b[31m${s}\x1b[0m` : s);
      const prompt = resetBusy
        ? d("  working… (Ctrl-C aborts the cockpit)")
        : red("  press R again to RESET (destroy + relaunch)") +
          d(" · e edit config · any other key cancels");
      const wrapW = Math.max(8, width);
      const wrapped = resetView.lines.flatMap((l) => {
        if (l.includes("\x1b") || l.length <= wrapW) return [l];
        return wrapWords(l, Math.max(8, wrapW - 2)).map((seg, i) => (i ? "  " + seg : seg));
      });
      const budget = Math.max(1, rows - 1);
      let shown = wrapped;
      if (shown.length > budget) {
        shown = [
          ...wrapped.slice(0, budget - 1),
          d(`  … +${wrapped.length - (budget - 1)} more (full plan via the CLI --dry-run)`),
        ];
      }
      return [...shown, prompt].map((l) => clipToWidth(l, wrapW) + CLEAR_EOL).join("\n");
    }

    // Send the composed custom message to the bound agent (resolved by session key,
    // so churn can't re-point it), then leave compose mode.
    function sendCompose(): void {
      const body = composeBuf.trim();
      const atts = composeAttachments;
      const key = composeTargetKey;
      composing = false;
      composeBuf = "";
      composeTargetKey = null;
      composeAttachments = [];
      composeAttachSources = [];
      composeNote = "";
      // Attach-only sends are allowed (drag a file, hit Enter) — but a wholly empty
      // composer (no text, no files) is a cancel, not a send.
      if (!body && atts.length === 0) return setStatus(warn("empty message — cancelled", opts.color));
      const agent = key ? snapshot.agents.find((a) => agentKey(a) === key) : undefined;
      if (!agent) return setStatus(warn("agent gone — message cancelled", opts.color));
      const label = agent.window_name ?? agent.short_id;
      const full = body + formatAttachmentNote(atts);
      setStatus(dim(`sending to ${label}…`, opts.color));
      sendOperatorMessage(
        { session_id: agent.session_id, server_pid: agent.server_pid, short_id: label },
        full,
        {},
      )
        .then((r) => {
          if (torndown) return;
          if (r.ok) setStatus(ok(`→ sent to ${r.target_short_id} (wake:${r.wake_status})`, opts.color));
          else setStatus(warn(`send failed: ${r.reason}`, opts.color));
        })
        .catch((e) => {
          if (torndown) return;
          setStatus(warn(`send error: ${e instanceof Error ? e.message : e}`, opts.color));
        });
    }

    function composeInsert(t: string): void {
      if (!t) return;
      composeNote = ""; // typing dismisses any attach feedback
      composeBuf = (composeBuf + t).slice(0, COMPOSE_MAX);
      paint();
    }

    function cancelCompose(): void {
      composing = false;
      composeBuf = "";
      composeTargetKey = null;
      composeAttachments = [];
      composeAttachSources = [];
      composeNote = "";
      paint();
    }

    function attachPath(p: string): boolean {
      const r = stageAttachment(p);
      if (!r.ok) return false; // caller decides what to show (may try a fallback)
      composeAttachments.push(r.attachment);
      composeAttachSources.push(p); // remember the source so ⌃X can restore it as text
      composeNote = `📎 ${r.attachment.name} (${r.attachment.bytes}B) — ⌃X to undo`;
      paint();
      return true;
    }

    // ⌃A attach. Two cases: (1) the whole buffer is a path (drag into an empty
    // composer, or a typed path). (2) a path got APPENDED to typed text — many
    // terminals inject a drag-and-drop as plain keystrokes (NOT a bracketed paste),
    // so onPaste never sees it and the path lands in the buffer as text. So also
    // extract a trailing absolute path token (backslash-escaped spaces included),
    // attach it, and keep the rest of the message. stageAttachment unescapes.
    function attachFromBuffer(): void {
      const whole = composeBuf.trim();
      if (!whole) {
        composeNote = "✗ drag a file or type a path, then ⌃A";
        return paint();
      }
      if (attachPath(whole)) {
        composeBuf = "";
        return paint();
      }
      const m = composeBuf.match(/(\/(?:\\ |\S)+)\s*$/); // trailing /abs/path (esc spaces)
      if (m && attachPath(m[1])) {
        composeBuf = composeBuf.slice(0, m.index).replace(/\s+$/, "");
        return paint();
      }
      composeNote = "✗ no attachable file found (drag a file, then ⌃A)";
      paint();
    }

    // ⌃V paste a clipboard IMAGE. A terminal can't deliver image bytes over stdin, so
    // we grab the clipboard out-of-band (macOS osascript) to a temp file and stage
    // that by reference — same copy-to-attachments path as a drag. The temp dir is
    // removed once stageAttachment has frozen its own copy.
    function pasteClipboardImage(): void {
      composeNote = "reading clipboard image…";
      paint();
      const c = captureClipboardImage();
      if (!c.ok) {
        composeNote = `✗ ${c.reason}`;
        return paint();
      }
      const r = stageAttachment(c.path);
      try {
        rmSync(dirname(c.path), { recursive: true, force: true });
      } catch {
        // temp cleanup is best-effort
      }
      if (!r.ok) {
        composeNote = `✗ ${r.reason}`;
        return paint();
      }
      composeAttachments.push(r.attachment);
      composeAttachSources.push(""); // no meaningful source path to restore on ⌃X
      composeNote = `📎 ${r.attachment.name} (${r.attachment.bytes}B) — ⌃X to undo`;
      paint();
    }

    // Undo the last attachment and restore its source path into the buffer as text —
    // the safety net for the paste-auto-attach ambiguity (max review): "I meant that
    // path as text, not a file."
    function unattachLast(): void {
      if (composeAttachments.length === 0) {
        composeNote = "✗ no attachment to remove";
        return paint();
      }
      composeAttachments.pop();
      const src = composeAttachSources.pop();
      if (src) {
        // Scrub the restored path: this is the ONE buffer-input path that doesn't go
        // through composeKey/onPaste, so without this a hostile filename's control/
        // bidi bytes would land in the buffer and reach the peer (compile-sim F2).
        const restored = scrubBufferText(src, false);
        const sep = composeBuf && !composeBuf.endsWith(" ") ? " " : "";
        composeBuf = (composeBuf + sep + restored).slice(0, COMPOSE_MAX);
        composeNote = "↩ removed attachment — path restored as text";
      } else {
        composeNote = "↩ removed attachment";
      }
      paint();
    }

    // Bracketed-paste content. A single-line paste of an ABSOLUTE path that resolves
    // to a stageable file = drag-to-attach (a Finder/terminal drag is always
    // absolute). A relative paste ("README.md"), a code snippet, or a URL inserts as
    // TEXT — so a path-shaped string can't be silently swallowed (max review); use ⌃A
    // to attach those deliberately. Multi-line pastes are always text (newlines kept,
    // control stripped, so a paste never fires-send or corrupts the screen).
    function onPaste(content: string): void {
      if (!composing) return; // paste only meaningful in the composer
      const single = content.trim();
      if (single && !single.includes("\n")) {
        const unq = single.replace(/^['"]/, "").replace(/['"]$/, "");
        if (unq.startsWith("/") && attachPath(unq)) return; // absolute + stageable → attach
        // not absolute, or not a stageable file → fall through and insert as text
      }
      const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      composeInsert(scrubBufferText(norm, true));
    }

    // Raw-mode line editing for the composer (one keystroke chunk).
    //   Enter (\r) = send · Ctrl-J (\n) or Alt+Enter (ESC+CR/LF) = newline ·
    //   Esc = cancel · Ctrl-C = quit · Backspace = delete.
    function composeKey(s: string): void {
      if (s === "\x03") return teardown(0);
      if (s === "\x1b") return cancelCompose(); // lone ESC
      if (s === "\x1b\r" || s === "\x1b\n") return composeInsert("\n"); // Alt+Enter
      // Any OTHER escape sequence (arrows, Home/End, PgUp/Dn, F-keys) must be
      // dropped, not typed: without this its CSI tail ("[A","[B"…) leaks into the
      // buffer as text (max review — verified composer bug).
      if (s[0] === "\x1b") return;
      if (s === "\x18") return unattachLast(); // Ctrl-X: undo last attachment
      if (s === "\x01") return attachFromBuffer(); // Ctrl-A: attach a path from the buffer
      if (s === "\x16") return pasteClipboardImage(); // Ctrl-V: paste a clipboard image
      if (s === "\r") return sendCompose(); // Enter sends
      if (s === "\n") return composeInsert("\n"); // Ctrl-J newline
      if (s === "\x7f" || s === "\b") {
        composeBuf = composeBuf.slice(0, -1);
        return paint();
      }
      // Printable typed input; strip control + stray escapes (newlines come via the
      // explicit branches above or via onPaste).
      composeInsert(scrubBufferText(s, false));
    }

    // `afterRestore` runs AFTER the terminal is restored (alt-screen off, raw mode off)
    // but BEFORE the promise resolves — the seam the cockpit handoff uses to attach
    // from a clean terminal (a bare `tmux attach` blocks here until the user detaches).
    function teardown(code: number, afterRestore?: () => void): void {
      if (torndown) return;
      torndown = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (slowTick) clearInterval(slowTick);
      if (spawnTimer) clearInterval(spawnTimer);
      stopAnim();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // already closed
        }
      }
      stdin.removeListener("data", onData);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGHUP", onSignal);
      process.removeListener("SIGWINCH", onResize);
      process.removeListener("uncaughtException", onFatal);
      process.removeListener("unhandledRejection", onFatal);
      try {
        if (stdin.isTTY) stdin.setRawMode(false);
      } catch {
        // ignore
      }
      stdin.pause();
      stdout.write(FOCUS_OFF + PASTE_OFF + CURSOR_SHOW + ALT_OFF);
      if (afterRestore) {
        try {
          afterRestore();
        } catch {
          // a failed handoff must not wedge the exit — the terminal is already restored
        }
      }
      resolve(code);
    }

    // `oxpit dock` handoff: after the editor-driven spawn/sync succeeds, tear this TUI
    // down (clean terminal) and — in the post-restore seam — weld the dock onto the new
    // session's main window and move the user into it. The dock pane re-invokes this
    // same binary with --dock; the main window is resolved live (spawn names it from the
    // spec, sync keeps the session's own first window).
    function enterCockpit(sessionName: string, fallbackWindow = "main"): void {
      const cl = opts.cockpitLaunch;
      if (!cl) return refresh(true);
      // Resolve the main window live; the fallback (only used if list-windows throws —
      // a vanished session) is the spec's first window so the dock targets a real name.
      const firstWindow = firstWindowOf(realTmux, sessionName, fallbackWindow);
      const dockCmd = dockPaneCommand({
        execPath: process.execPath,
        binPath: process.argv[1] ?? "",
        viaOxtail: invokedViaOxtail(process.argv[1]),
      });
      teardown(0, () => {
        // The terminal is restored here, so a weld/attach failure is surfaced on stderr
        // (never swallowed — the one-shot path does the same; v0.25.0 silent-drift lesson).
        const w = weldDockAndAttach(sessionName, firstWindow, cl.repoRoot, { run: realTmux, dockRows: cl.dockRows, dockCmd });
        if (w.error) process.stderr.write(`oxpit dock: ${w.error}\n`);
      });
    }

    // Last line of defense: ANY uncaught throw/rejection (a render edge case, an
    // fs hiccup in a watch/timer callback) restores the terminal before the process
    // dies — otherwise the operator is wedged in alt-screen + raw mode with no
    // cursor. Print the error AFTER teardown so it lands on the normal screen.
    function onFatal(err: unknown): void {
      teardown(1);
      // eslint-disable-next-line no-console
      console.error(err);
    }

    // One keystroke chunk → action. (Compose mode swallows all keys so 'q','?' type
    // as text; composeKey handles its own Ctrl-C/Esc.)
    function handleKey(s: string): void {
      // Terminal focus reports (gate the animation) — handled in every mode, before
      // anything else, so they never reach the composer or a key action.
      if (s === FOCUS_IN) return setFocus(true);
      if (s === FOCUS_OUT) return setFocus(false);
      if (composing) return composeKey(s);
      if (s === "\x03") return teardown(0); // Ctrl-C only — `q` is intentionally NOT a
      // quit (too easy to fat-finger next to the nav keys; David 2026-06-17). It falls
      // through to a harmless no-op in every mode.
      if (fleetEdit) return handleFleetEditKey(s); // the config editor owns all keys while open
      if (spawnOpen) {
        // SPAWN confirm gate: while a spawn is in flight, swallow keys (Ctrl-C above
        // still aborts the cockpit); `y` (only when not collision-blocked) executes;
        // ANY other key cancels back to the cockpit (re-open with S to reconfigure).
        if (spawnBusy) return;
        if (spawnView?.canSpawn && s === "y") return doSpawn();
        spawnOpen = false;
        spawnView = null;
        return paint();
      }
      if (syncOpen) {
        // SYNC confirm gate: swallow keys while in flight (Ctrl-C above still aborts the
        // cockpit); a DELETE needs a deliberate capital `Y` (a reflexive `y` cancels),
        // purely-additive takes `y`; the can't-sync message dismisses on any key; ANY
        // other key cancels back to the cockpit.
        if (syncBusy) return;
        if (syncView?.canSync && s === (syncView.hasDelete ? "Y" : "y")) return doSync();
        syncOpen = false;
        syncView = null;
        return paint();
      }
      if (resetOpen) {
        // RESET confirm gate (DESTRUCTIVE): while a reset is in flight, swallow keys
        // (Ctrl-C above still aborts); a DELIBERATE re-press of `R` executes — NOT `y`,
        // so a reflexive SPAWN-muscle-memory `y` CANCELS instead of destroying. ANY
        // other key closes the overlay.
        if (resetBusy) return;
        if (s === "R") return doReset();
        // `e` → reconfigure the post-reset fleet in the grid editor, then come back to
        // the red plan recomputed with those edits (the 2nd-R confirm is unchanged).
        if (s === "e") return openResetEditor();
        resetOpen = false;
        resetView = null;
        return paint();
      }
      if (s === "?") {
        helpOpen = !helpOpen;
        return paint();
      }
      if (helpOpen) return; // swallow other keys while the help overlay is up
      if (pendingNudgeKey !== null) {
        const key = pendingNudgeKey;
        pendingNudgeKey = null;
        if (s === "y") {
          const agent = snapshot.agents.find((a) => agentKey(a) === key);
          if (!agent) return setStatus(warn("selection changed — nudge cancelled", opts.color));
          return doNudge(agent);
        }
        return paint(); // any other key cancels the pending nudge
      }
      if (pendingKillKey !== null) {
        const key = pendingKillKey;
        pendingKillKey = null;
        if (s === "K") {
          // a 2nd deliberate K confirms (destructive) — resolve THIS bound agent.
          const agent = snapshot.agents.find((a) => agentKey(a) === key);
          if (!agent) return setStatus(warn("selection changed — kill cancelled", opts.color));
          return doKillWindow(agent);
        }
        return paint(); // any other key cancels the pending kill
      }
      // `l` = the GLOBAL feed (max review): always predictable — opens/switches to
      // the unfiltered panel, and closes only when already showing global. `w`
      // (below) is the per-agent counterpart. So l/w read as "everything vs this one".
      if (s === "l") {
        if (mode === "log" && !logFilterSelf) mode = "fleet"; // already global → close
        else {
          mode = "log";
          logFilterSelf = false;
          logCursorFromEnd = 0; // start on the latest message
          logExpanded = false;
        }
        return paint();
      }
      if (s === "r") return refresh(true);
      if (mode === "log") {
        if (s === "\x1b") return closeLog(); // Esc → close the panel (lone ESC, not an arrow)
        // ↑↓ — when COLLAPSED, move the › message cursor (↑ older / ↓ newer); when a
        // message is EXPANDED, scroll WITHIN its body (↑ up / ↓ down) so a message
        // taller than the panel can be read fully. Plain arrows (macOS Terminal eats
        // Shift+arrows). Space/b + PgUp/PgDn page; j/k WALK the fleet. w expand/collapse.
        if (s === "\x1b[A") return logExpanded ? logBodyScroll(-1) : logCursorMove(1); // ↑
        if (s === "\x1b[B") return logExpanded ? logBodyScroll(1) : logCursorMove(-1); // ↓
        if (s === "k") return move(-1); // walk the fleet up (panel follows when filtered)
        if (s === "j") return move(1); // walk the fleet down
        if (s === " " || s === "\x1b[6~") {
          return logExpanded ? logBodyScroll(logCursorPage()) : logCursorMove(-logCursorPage());
        }
        if (s === "b" || s === "\x1b[5~") {
          return logExpanded ? logBodyScroll(-logCursorPage()) : logCursorMove(logCursorPage());
        }
        if (s === "\r" || s === "\n") return doJump(); // jump to the selected agent
        if (s === "w") {
          logExpanded = !logExpanded; // expand/collapse the cursor'd message's full body
          logBodyOffset = 0; // start reading from the top
          return paint();
        }
        if (s === "f") {
          logFilterSelf = !logFilterSelf;
          logCursorFromEnd = 0; // re-anchor on the latest of the new view
          logExpanded = false;
          return paint();
        }
        if (s === "m") return startCompose(); // compose to the selected agent
        return; // ignore other keys in log mode
      }
      // fleet mode
      if (s === "\x1b[A" || s === "k") return move(-1);
      if (s === "\x1b[B" || s === "j") return move(1);
      if (s === "\r" || s === "\n") return doJump();
      if (s === "d") {
        // Flip full table ↔ dock strip in place. Same data + selection; the next
        // paint() picks the matching renderer (and the dock brings its own footer).
        dock = !dock;
        return paint();
      }
      if (s === "b") {
        // Expand/collapse the detached-background section. A no-op view toggle when
        // there are none — say so rather than silently doing nothing.
        if ((snapshot.background ?? []).length === 0) {
          return setStatus(dim("no detached background processes", opts.color));
        }
        showBackground = !showBackground;
        return paint();
      }
      if (s === "n") {
        const idx = selectedIndex();
        if (idx < 0) return;
        const agent = snapshot.agents[idx];
        pendingNudgeKey = agentKey(agent); // bind identity now; confirm resolves THIS key
        const tag = agent.is_self ? " (your primary session)" : "";
        return setStatus(
          warn(`nudge ${agent.window_name ?? agent.short_id}${tag}? press y to confirm`, opts.color),
        );
      }
      if (s === "m") return startCompose();
      if (s === "S") return openFleetEditor(); // capital-S: open the fleet config editor → spawn
      if (s === "R") return openReset(); // capital-R: RESET the selected agent's fleet (red plan)
      if (s === "K") {
        // capital-K: remove the selected agent's WINDOW (destructive; K-again confirms).
        const idx = selectedIndex();
        if (idx < 0) return;
        const agent = snapshot.agents[idx];
        if (!agent.tmux_pane) {
          return setStatus(warn(`no tmux pane for ${agent.window_name ?? agent.short_id}`, opts.color));
        }
        pendingKillKey = agentKey(agent);
        const selfTag = agent.is_self ? " — THIS IS YOUR OWN SESSION" : "";
        return setStatus(
          warn(`KILL window "${agent.window_name ?? agent.short_id}"${selfTag}? press K again to confirm`, opts.color),
        );
      }
      if (s === "w") {
        // item 4: open the selected agent's thread (filtered) in the bottom panel,
        // cursor on its latest message. ↑↓ then move the cursor; w expands it.
        if (selectedIndex() < 0) return;
        logFilterSelf = true;
        logCursorFromEnd = 0;
        logExpanded = false;
        mode = "log";
        return paint();
      }
      // ignore everything else
    }

    // Open the composer for the selected agent (messaging main IS allowed now — the
    // compose frame marks it "→ your primary session" and Enter is the confirm).
    function startCompose(): void {
      const idx = selectedIndex();
      if (idx < 0) return;
      composing = true;
      composeBuf = "";
      composeTargetKey = agentKey(snapshot.agents[idx]); // bind by session key
      paint();
    }

    // Bracketed-paste-aware input: split each chunk on the paste markers, route paste
    // content to onPaste (literal insert) and the rest to the key dispatch. A paste
    // may span multiple data chunks — pasting/pasteBuf carry the state across them.
    function onData(buf: Buffer | string): void {
      const { state, actions } = stepInput({ pasting, pasteBuf }, buf.toString());
      pasting = state.pasting;
      pasteBuf = state.pasteBuf;
      for (const a of actions) {
        if (a.t === "quit") return handleKey("\x03"); // teardown; abandon the rest
        if (a.t === "key") handleKey(a.data);
        else onPaste(a.data);
      }
    }

    function onSignal(): void {
      teardown(0);
    }

    function onResize(): void {
      paint();
    }

    // Everything from raw-mode entry through the FIRST paint runs inside this guard.
    // A synchronous throw here (e.g. buildSnapshot hitting a deleted cwd, or a render
    // edge in the first paint) would otherwise escape the Promise executor and REJECT
    // the promise — which server.ts "handles" via .catch, so unhandledRejection (and
    // thus onFatal) never fires and the terminal is left WEDGED in raw mode. Routing
    // it through onFatal runs the full teardown (raw-mode off, paste/focus/cursor/alt
    // restored) before the error propagates. teardown is idempotent (torndown guard).
    try {
      // ── enter raw mode + alt screen + bracketed paste + focus reporting ─────
      stdout.write(ALT_ON + CURSOR_HIDE + PASTE_ON + (animEnabled ? FOCUS_ON : ""));
      try {
        stdin.setRawMode(true);
      } catch {
        // some environments can't; input just won't work, view still renders
      }
      stdin.resume();
      stdin.on("data", onData);
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      process.on("SIGHUP", onSignal);
      process.on("SIGWINCH", onResize);
      process.on("uncaughtException", onFatal);
      process.on("unhandledRejection", onFatal);

      // ── watch ~/.oxtail subdirs (debounced) ────────────────────────────────
      const base = join(homedir(), ".oxtail");
      for (const sub of WATCH_DIRS) {
        const dir = join(base, sub);
        if (!existsSync(dir)) continue;
        try {
          watchers.push(watch(dir, { persistent: true }, () => scheduleRefresh()));
        } catch {
          // watch unsupported for this dir — slow tick still refreshes
        }
      }

      // ── slow fallback tick (ages mtime liveness; full proc_sig check; refreshes
      // tool badges; change-detected selected-pane capture) ───────────────────
      slowTick = setInterval(() => {
        if (torndown) return;
        refresh(true);
        maybeCaptureSelected(false);
      }, SLOW_TICK_MS);

      // First paint is read-only (instant startup, C7); the first slow tick ~1.5s
      // later does the first selected-pane capture. Bursts start on events (move /
      // status change), so there's no continuous animation timer running at rest.
      refresh(true);
      // `oxpit dock` config-first: drop straight into the fleet editor so the user
      // reviews/edits the spec, then `y` applies → spawn/sync → enterCockpit.
      if (opts.openEditorOnStart) openFleetEditor();
    } catch (e) {
      onFatal(e);
    }
  });
}

// Tiny color helpers (kept local so render.ts stays a pure snapshot→string fn).
function dim(s: string, color: boolean): string {
  return color ? `\x1b[2m${s}\x1b[0m` : s;
}
function ok(s: string, color: boolean): string {
  return color ? `\x1b[32m${s}\x1b[0m` : s;
}
function warn(s: string, color: boolean): string {
  return color ? `\x1b[33m${s}\x1b[0m` : s;
}

// `oxpit dock` — assemble (or attach to) the fleet COCKPIT in one command.
//
// The cockpit = a tmux session with each agent in its own window, PLUS the live dock
// strip (`oxpit --dock`) welded as a short bottom pane in the MAIN window, with your
// client attached to it. One command turns a bare terminal into "you're driving the
// main agent, the fleet HUD is the strip below, jump to any peer with ⏎".
//
// Layering: this VERB orchestrates tmux (spawn + split + attach); `oxpit --dock` (the
// FLAG) is the pure renderer the bottom pane runs. The verb is the only thing a user
// learns; the flag is plumbing.
//
// Safety mirrors the rest of the fleet lifecycle: dry-run previews the exact plan and
// mutates nothing; the real run reuses spawnFleet (refuse-to-clobber + lock) for the
// agents, marks the dock pane `@oxpit_dock` so re-running is idempotent (it attaches
// instead of stacking a second strip), and never touches a session it didn't create
// beyond adding the one dock pane.

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { spawnFleet as realSpawnFleet, tmuxSessionExists, tmuxSessionName } from "./spawn.js";
import type { FleetSpec } from "./types.js";
import type { TmuxRun } from "./ownership.js";

function defaultRun(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
}

// Single-quote for the POSIX shell tmux runs a pane command through (paths may carry
// spaces). `'` is closed, escaped, reopened — the standard safe form.
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The command the dock pane runs: re-invoke THIS binary with --dock, so the cockpit
// uses the same install (global / local / dev) that launched it — no PATH assumption.
// oxpit-bin → `node <oxpit-bin> --dock`; oxtail server → `node <server> oxpit --dock`.
export function dockPaneCommand(opts: { execPath: string; binPath: string; viaOxtail: boolean }): string {
  const parts = [shq(opts.execPath), shq(opts.binPath)];
  if (opts.viaOxtail) parts.push("oxpit");
  parts.push("--dock");
  return parts.join(" ");
}

// Did the running entry come in via the `oxtail` server bin (needs the `oxpit`
// subcommand re-inserted) vs the standalone `oxpit` bin? Basename heuristic on argv[1].
export function invokedViaOxtail(binPath: string | undefined): boolean {
  return basename(binPath ?? "").startsWith("server");
}

export interface CockpitOptions {
  dryRun?: boolean;
  run?: TmuxRun;
  inTmux?: boolean;
  sessionName?: string;
  dockRows?: number; // bottom dock pane height; default 8
  // Whether to spawn the fleet. undefined = auto: spawn iff the spec came from a real
  // config file (project/global), NOT the built-in default — so `oxpit dock` in a repo
  // with no fleet.json gives you a working shell + dock, not three agents you didn't ask
  // for. `--spawn` forces the default fleet; `--no-spawn` forces layout-only.
  spawn?: boolean;
  configured?: boolean; // spec.source is "project" | "global" (a real file)
  log?: (msg: string) => void;
  // Re-invocation handle for the dock pane command.
  execPath?: string;
  binPath?: string;
  viaOxtail?: boolean;
  // Injectable seams for tests.
  spawnFleetFn?: typeof realSpawnFleet;
  sessionExistsFn?: (run: TmuxRun, name: string) => boolean;
  attachFn?: (session: string) => void; // blocking bare-terminal attach
}

export interface CockpitResult {
  ok: boolean;
  sessionName: string;
  sessionExisted: boolean;
  spawned: boolean;
  dockAdded: boolean;
  dryRun: boolean;
  attachMode: "attach" | "switch" | "none";
  plan: string[];
  error?: string;
}

// Resolve whether the fleet should be spawned, given the explicit flag and whether the
// spec is a real config vs the built-in default.
export function shouldSpawn(opts: Pick<CockpitOptions, "spawn" | "configured">): boolean {
  if (opts.spawn !== undefined) return opts.spawn;
  return Boolean(opts.configured);
}

// Human-readable plan (dry-run + the leading summary of a real run).
function buildPlan(args: {
  spec: FleetSpec;
  sessionName: string;
  sessionExisted: boolean;
  willSpawn: boolean;
  firstWindow: string;
  dockRows: number;
  dockCmd: string;
  inTmux: boolean;
  repoRoot: string;
}): string[] {
  const { spec, sessionName, sessionExisted, willSpawn, firstWindow, dockRows, dockCmd, inTmux, repoRoot } = args;
  const lines: string[] = [`oxpit dock → cockpit session "${sessionName}"  [${repoRoot}]`];
  if (sessionExisted) {
    lines.push(`  • session exists → reuse it (no re-spawn)`);
  } else if (willSpawn) {
    lines.push(`  • spawn fleet "${spec.name}" — windows: ${spec.windows.map((w) => w.name).join(", ")}`);
  } else {
    lines.push(`  • create a working shell session (window "${firstWindow}") — no fleet spawned`);
  }
  lines.push(`  • dock: split "${sessionName}:${firstWindow}" → bottom pane (${dockRows} rows): ${dockCmd}`);
  lines.push(`  • land on the top pane (the agent), dock strip below`);
  lines.push(`  • ${inTmux ? "switch-client to the cockpit session" : "attach this terminal to the cockpit"}`);
  return lines;
}

// All window names of a session, in index order. Targeted by `session:window` (window
// names are unique within an oxpit-spawned fleet — one per spec entry).
export function windowNamesOf(run: TmuxRun, sessionName: string): string[] {
  try {
    return run(["list-windows", "-t", sessionName, "-F", "#{window_name}"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Resolve the first (main) window name of an existing session — the dock's home.
export function firstWindowOf(run: TmuxRun, sessionName: string, fallback: string): string {
  return windowNamesOf(run, sessionName)[0] || fallback;
}

// Does the window already carry an oxpit dock pane (so re-running just attaches)?
function dockPresent(run: TmuxRun, target: string): boolean {
  try {
    const out = run(["list-panes", "-t", target, "-F", "#{pane_id}=#{@oxpit_dock}"]);
    return out.split("\n").some((l) => l.trim().endsWith("=1"));
  } catch {
    return false;
  }
}

// Top (first) pane id of a window — the agent pane the dock splits beneath.
function topPaneOf(run: TmuxRun, target: string): string | null {
  try {
    const out = run(["list-panes", "-t", target, "-F", "#{pane_id}"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
}

export async function runCockpitDock(
  spec: FleetSpec,
  repoRoot: string,
  opts: CockpitOptions = {},
): Promise<CockpitResult> {
  const run = opts.run ?? defaultRun;
  const inTmux = opts.inTmux ?? Boolean(process.env.TMUX);
  const dockRows = opts.dockRows ?? 8;
  const sessionName = opts.sessionName ?? tmuxSessionName(spec.name);
  const sessionExistsFn = opts.sessionExistsFn ?? ((r: TmuxRun, name: string) => tmuxSessionExists(name, r));
  const spawnFleetFn = opts.spawnFleetFn ?? realSpawnFleet;
  const willSpawn = shouldSpawn(opts);
  const dockCmd = dockPaneCommand({
    execPath: opts.execPath ?? process.execPath,
    binPath: opts.binPath ?? process.argv[1] ?? "",
    viaOxtail: opts.viaOxtail ?? invokedViaOxtail(opts.binPath ?? process.argv[1]),
  });

  const existed = sessionExistsFn(run, sessionName);
  const firstWindow = existed
    ? firstWindowOf(run, sessionName, spec.windows[0]?.name ?? "main")
    : willSpawn
      ? spec.windows[0]?.name ?? "main"
      : "main";

  const plan = buildPlan({ spec, sessionName, sessionExisted: existed, willSpawn, firstWindow, dockRows, dockCmd, inTmux, repoRoot });

  const base: CockpitResult = {
    ok: true,
    sessionName,
    sessionExisted: existed,
    spawned: false,
    dockAdded: false,
    dryRun: Boolean(opts.dryRun),
    attachMode: "none",
    plan,
  };

  if (opts.dryRun) {
    opts.log?.(plan.join("\n"));
    return base;
  }

  let spawned = false;
  // 1. Stand up the session (unless it already exists).
  if (!existed) {
    if (willSpawn) {
      // Transparency, not a gate: say what's about to launch (real agents, takes a
      // beat) and the escape — so the spawn never LOOKS hung (→ a panic re-run that
      // collides on the repo lock) and an unexpected fleet is never a silent surprise.
      const names = spec.windows.map((w) => w.name).join(", ");
      opts.log?.(`  spawning ${spec.windows.length} agents (${names}) — real agent launches, ~${spec.windows.length * 8}s. ⌃C exits · --no-spawn for just the dock`);
      // spawnFleet can THROW (FleetBusyError when another op holds this repo's fleet
      // lock — e.g. a second `oxpit dock` while the first is still launching agents —
      // or a tmux failure). Catch it so the verb reports a clean line, never a raw
      // stack trace. The lock is per-REPO, so concurrent spawns in the same repo
      // serialize; the loser retries once the other finishes (or a stale lock clears).
      let r: Awaited<ReturnType<typeof spawnFleetFn>>;
      try {
        r = await spawnFleetFn(spec, repoRoot, { dryRun: false, run, sessionName, log: opts.log });
      } catch (e) {
        return { ...base, ok: false, error: `${e instanceof Error ? e.message : String(e)} — wait for it to finish (or the lock to clear), then re-run` };
      }
      if (!sessionExistsFn(run, sessionName)) {
        return { ...base, ok: false, error: `fleet spawn did not create session "${sessionName}": ${r.error ?? "see results"}` };
      }
      spawned = true; // session is up; per-window agent failures still leave a usable cockpit
    } else {
      try {
        run(["new-session", "-d", "-s", sessionName, "-n", firstWindow, "-c", repoRoot]);
      } catch (e) {
        return { ...base, ok: false, error: `could not create session "${sessionName}": ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }

  // 2+3. Weld the dock onto the main window and land the user on the cockpit.
  const weld = weldDockAndAttach(sessionName, firstWindow, repoRoot, { run, inTmux, dockRows, dockCmd, attachFn: opts.attachFn, log: opts.log });
  if (weld.error) return { ...base, spawned, ok: false, error: weld.error };
  return { ...base, ok: true, spawned, dockAdded: weld.dockAdded, attachMode: weld.attachMode };
}

export interface WeldOptions {
  run?: TmuxRun;
  inTmux?: boolean;
  dockRows?: number;
  dockCmd: string;
  attachFn?: (session: string) => void;
  // The REAL terminal size (defaults to process.stdout). Used to pin the dock height:
  // the split happens on a detached session at tmux's default ~80x24, and attaching
  // scales panes proportionally to the terminal — so a fixed-row dock would balloon.
  termRows?: number;
  termCols?: number;
  // Surface non-fatal weld notes (e.g. the flip-key clobber warning) to the user.
  log?: (m: string) => void;
}

export interface WeldResult {
  dockAdded: boolean;
  attachMode: "attach" | "switch" | "none";
  error?: string;
}

// ── the agent↔dock FLIP KEY (C-]) ───────────────────────────────────────────────
// One no-prefix root-table binding that toggles focus between the agent pane (top) and
// the dock pane (bottom) of a cockpit window — the single-keystroke nav David wanted, in
// macOS Terminal.app, with zero per-user config. Design verified end-to-end on tmux
// 3.5a / Terminal.app (max): C-] is the right key — Terminal.app delivers the 0x1d byte
// cleanly, macOS doesn't grab it, and nothing in the claude/codex TUIs binds it (Option
// isn't Meta in Terminal.app, so M- bindings are dead; F-keys are a media-key landmine).
// The root table intercepts C-] BEFORE either pane's app, so the same binding flips both
// directions and the dock TUI needs no key handling. Installed at runtime (never written
// to ~/.tmux.conf); the if-shell gate makes it a no-op outside cockpit windows, so it's
// harmless to the user's other sessions on the server even though `bind -n` is global.
export const FLIP_KEY = "C-]";
// The toggle: ON the dock (@oxpit_dock pane) → select the pane UP (the agent above);
// anywhere else in a cockpit window → select the pane DOWN (the dock below). DIRECTIONAL
// `-U`/`-D`, NOT `select-pane -t {top}`/`{bottom}`: tmux's command parser treats `{...}` as
// a command BLOCK when it RE-PARSES this binding string, so `{bottom}` ran as the command
// "bottom" ("unknown command: bottom") and the flip silently did nothing — the v0.29.0 bug.
// `-U`/`-D` are brace-free and verified to toggle through the re-parse. The dock is the
// bottom split, so for the 2-pane cockpit window this is exactly agent↔dock; if the agent
// pane is split it steps toward the dock/agent. The else-branch re-sends C-] so a NON-cockpit
// window's app receives the byte untouched (passthrough). Each nested if-shell sub-command is
// ONE argv element — no shell, so the quotes are literal bytes tmux re-parses.
const FLIP_THEN = `if-shell -F "#{@oxpit_dock}" "select-pane -U" "select-pane -D"`;
export const FLIP_BIND_ARGV = [
  "bind-key", "-n", FLIP_KEY,
  "if-shell", "-F", "#{@oxpit_cockpit}", FLIP_THEN, `send-keys ${FLIP_KEY}`,
];

// The flip key is on unless OXTAIL_OXPIT_FLIP=off. Read where the binding is INSTALLED
// (the `oxpit dock` process); the dock TUI can't see this env (it's a tmux-spawned child
// with the server's env), so it gates its footer hint on the @oxpit_cockpit window option
// instead — which weld sets only when this is on, keeping them a single source of truth.
export function flipKeyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OXTAIL_OXPIT_FLIP !== "off";
}

// Classify the root-table binding for `key` so we NEVER clobber a foreign one. Lists
// `list-keys -T root` UNFILTERED — the per-key form `list-keys -T root C-]` ERRORS on an
// unbound key (tmux 3.5a: "unknown key", exit 1; codex), so the full table cleanly returns
// "unbound" in the common case — and matches FLAG-ORDER-INSENSITIVELY: tmux can emit flags
// before the table (`bind-key -r -T root C-] copy-mode`), which an anchored regex misses and
// then clobbers (codex HIGH). "ours" requires BOTH our private option names in the command
// (a foreign binding can't carry them; every version of our binding does). An unreadable
// list-keys returns "unreadable" so the caller FAILS CLOSED instead of treating a transient
// failure as "unbound" and overwriting whatever was there.
export type RootBindingState =
  | { state: "unbound" }
  | { state: "foreign"; command: string }
  | { state: "ours"; command: string }
  | { state: "unreadable" };
export function rootBinding(run: TmuxRun, key: string): RootBindingState {
  let out: string;
  try {
    out = run(["list-keys", "-T", "root"]);
  } catch {
    return { state: "unreadable" };
  }
  for (const line of out.split("\n")) {
    // bind-key [<flags>] -T root <key> <command> — `.*?` skips any flags before `-T root`.
    const m = line.match(/^\s*bind-key\b.*?\s-T\s+root\s+(\S+)\s+(.+)$/);
    if (m && m[1] === key) {
      const command = m[2].trim();
      const ours = command.includes("@oxpit_cockpit") && command.includes("@oxpit_dock");
      return ours ? { state: "ours", command } : { state: "foreign", command };
    }
  }
  return { state: "unbound" };
}

// Resolve the flip key for this weld and report whether it is AVAILABLE — so the per-window
// @oxpit_cockpit mark and the dock's footer hint track the binding's REAL state (a mark on a
// window where C-] isn't our flip would render a hint that lies; codex MED). Effects by case:
//   • flip ON  + unbound/ours  → (re)install our binding → available
//   • flip ON  + FOREIGN       → leave it + warn → unavailable (never clobber; codex HIGH)
//   • flip ON  + unreadable    → fail closed + warn → unavailable
//   • flip OFF                 → a REAL kill switch: unbind OUR binding if present (a foreign
//                                one is left alone) → unavailable; the caller then UNSETS the
//                                window marks, so a re-weld with =off fully disables (codex LOW)
// Best-effort throughout: a tmux that rejects a verb just leaves prefix-nav (C-b ↑/↓) working.
export function resolveFlipKey(run: TmuxRun, flipOn: boolean, log?: (m: string) => void): boolean {
  const b = rootBinding(run, FLIP_KEY);
  if (!flipOn) {
    if (b.state === "ours") {
      try {
        run(["unbind-key", "-n", FLIP_KEY]);
      } catch {
        // best-effort
      }
    }
    return false;
  }
  if (b.state === "foreign") {
    log?.(
      `oxpit dock: Ctrl-] is already bound in tmux — leaving it, so the agent↔dock flip key is off. ` +
        `Unbind it, or run with OXTAIL_OXPIT_FLIP=off to silence this.`,
    );
    return false;
  }
  if (b.state === "unreadable") {
    log?.(`oxpit dock: couldn't read tmux key bindings — skipping the Ctrl-] flip key rather than risk clobbering an existing binding.`);
    return false;
  }
  try {
    run(FLIP_BIND_ARGV); // unbound or ours → (re)install
    return true;
  } catch (e) {
    log?.(`oxpit dock: couldn't install the Ctrl-] flip key (${e instanceof Error ? e.message : String(e)}) — prefix nav (C-b ↑/↓) still flips panes`);
    return false;
  }
}

// Weld the dock strip onto `sessionName:firstWindow` (idempotent via @oxpit_dock) and
// land the user on the cockpit — move the current client (inside tmux) or block-attach
// the terminal (bare). The shared tail of `oxpit dock`: used both by the one-shot
// runCockpitDock AND by the TUI's config-editor → spawn → cockpit handoff (which runs
// it AFTER tearing the TUI down, so the terminal is clean before a bare attach).
export function weldDockAndAttach(
  sessionName: string,
  firstWindow: string,
  repoRoot: string,
  opts: WeldOptions,
): WeldResult {
  const run = opts.run ?? defaultRun;
  const inTmux = opts.inTmux ?? Boolean(process.env.TMUX);
  const dockRows = opts.dockRows ?? 8;
  const termRows = opts.termRows ?? process.stdout.rows;
  const termCols = opts.termCols ?? process.stdout.columns;

  // Pre-size the detached session to the size it will ACTUALLY be when shown, BEFORE
  // splitting — for a bare attach that's this terminal (process.stdout); inside tmux it's
  // the current client (which can be bigger than our pane if oxpit ran in a split). When
  // the splits happen at the final absolute size, attach/switch-client never scales the
  // dock proportionally (the ballooning was worst on the ACTIVE window, where the agent's
  // startup re-layout fought a post-attach resize). The resize-pane below is then just
  // belt-and-suspenders.
  let sizeRows = termRows;
  let sizeCols = termCols;
  if (inTmux) {
    try {
      const [h, w] = run(["display-message", "-p", "#{client_height}\t#{client_width}"]).trim().split("\t");
      const ph = Number.parseInt(h ?? "", 10);
      const pw = Number.parseInt(w ?? "", 10);
      if (ph > 0 && pw > 0) {
        sizeRows = ph;
        sizeCols = pw;
      }
    } catch {
      // fall back to process.stdout dims
    }
  }
  if (sizeRows && sizeCols) {
    try {
      run(["resize-window", "-t", sessionName, "-x", String(sizeCols), "-y", String(sizeRows)]);
    } catch {
      // older tmux without resize-window — the post-attach resize-pane is the fallback
    }
  }

  // Weld a dock strip into EVERY window so the cockpit HUD is OMNIPRESENT — switch to any
  // agent's window and the fleet dock is right below it (oxpit's whole point: a persistent
  // cockpit, not a strip you lose the moment you tab away). Idempotent per-window via
  // @oxpit_dock; best-effort — one window failing to split doesn't abort the rest.
  // Resolve the flip key ONCE up front (install / skip-foreign / fail-closed / kill-switch)
  // BEFORE marking any window, so @oxpit_cockpit tracks the binding's REAL availability.
  const flipAvailable = resolveFlipKey(run, flipKeyEnabled(), opts.log);
  const dockPaneIds: string[] = [];
  let anyDock = false;
  let firstErr: unknown = null;
  for (const w of windowNamesOf(run, sessionName)) {
    const target = `${sessionName}:${w}`;
    // @oxpit_cockpit marks a window where the C-] flip key is LIVE — the if-shell gate AND the
    // dock's footer hint both read it, so it must track the binding's real availability (a mark
    // without the binding renders a hint that lies; codex MED). SET when available, UNSET
    // otherwise (off / foreign / failed) so a re-weld can't strand a stale mark (codex LOW). On
    // EVERY window BEFORE the dock-present early-out (a re-weld of an older dock converges) and
    // BEFORE the split (so the dock TUI reads it the moment it boots — no marker boot race).
    try {
      if (flipAvailable) run(["set-option", "-w", "-t", target, "@oxpit_cockpit", "1"]);
      else run(["set-option", "-w", "-u", "-t", target, "@oxpit_cockpit"]);
    } catch {
      // best-effort — a tmux that rejects the window option just skips the hint there
    }
    if (dockPresent(run, target)) {
      anyDock = true; // already docked (re-run) — leave it
      continue;
    }
    const topPane = topPaneOf(run, target);
    try {
      // -d keeps the ORIGINAL (agent) pane active so each window lands on its agent, dock
      // below. The trailing string is the shell command tmux runs in the new pane.
      const dp = run(["split-window", "-v", "-d", "-l", String(dockRows), "-t", target, "-c", repoRoot, "-P", "-F", "#{pane_id}", opts.dockCmd]).trim();
      if (dp) {
        run(["set-option", "-p", "-t", dp, "@oxpit_dock", "1"]);
        dockPaneIds.push(dp);
        anyDock = true;
      }
      if (topPane) run(["select-pane", "-t", topPane]);
    } catch (e) {
      firstErr ??= e; // record, but keep docking the other windows
    }
  }
  if (!anyDock && firstErr) {
    return { dockAdded: false, attachMode: "none", error: `dock split failed: ${firstErr instanceof Error ? firstErr.message : String(firstErr)}` };
  }
  const dockAdded = dockPaneIds.length > 0;

  // Land on the main window (each window's agent pane is already active from above).
  try {
    run(["select-window", "-t", `${sessionName}:${firstWindow}`]);
  } catch {
    // non-fatal — attach still lands on the session's active window
  }

  if (inTmux) {
    try {
      run(["switch-client", "-t", sessionName]);
      // Windows are now at the client's REAL size — pin EVERY dock to dockRows (each was
      // split relative to tmux's ~24-row default and got scaled up proportionally on attach).
      for (const dp of dockPaneIds) {
        try {
          run(["resize-pane", "-t", dp, "-y", String(dockRows)]);
        } catch {
          // best-effort — a tmux that rejects resize-pane -y leaves the proportional size
        }
      }
      return { dockAdded, attachMode: "switch" };
    } catch (e) {
      return { dockAdded, attachMode: "none", error: `switch-client failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const attach = opts.attachFn ?? ((s: string) => execFileSync("tmux", ["attach-session", "-t", s], { stdio: "inherit" }));
  try {
    attach(sessionName); // blocks until the user detaches
  } catch {
    // tmux attach returning non-zero (e.g. detached) is normal; not an error.
  }
  return { dockAdded, attachMode: "attach" };
}

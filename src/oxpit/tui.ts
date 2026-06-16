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
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, type FleetAgent, type FleetSnapshot } from "./snapshot.js";
import { commsBodyLines, computeAgentLabels, renderSnapshot } from "./render.js";
import { buildCommsLog, type CommsMessage } from "./comms.js";
import { clipToWidth } from "./format.js";
import { jumpToAgent } from "./jump.js";
import { NUDGE_TEXT, sendOperatorMessage } from "./operator.js";
import { parseStatusArgs, USAGE } from "./cli.js";

const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const HOME = "\x1b[H";
const CLEAR_BELOW = "\x1b[J";
const CLEAR_EOL = "\x1b[K";
const PASTE_ON = "\x1b[?2004h"; // enable bracketed paste (terminal wraps pastes)
const PASTE_OFF = "\x1b[?2004l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const WATCH_DIRS = ["sessions", "mailboxes", "received", "pending-ask"];
const DEBOUNCE_MS = 200;
const SLOW_TICK_MS = 1500;
const MAX_WAIT_ROWS = 8;
const LOG_FETCH = 200; // comms messages pulled for the log view (windowed to fit)

function agentKey(a: FleetAgent): string {
  return a.session_id ?? `pid:${a.server_pid}`;
}

function clientFlag(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--client") return argv[i + 1];
    if (argv[i].startsWith("--client=")) return argv[i].slice("--client=".length);
  }
  return undefined;
}

export async function runOxpit(argv: string[]): Promise<number> {
  const a = parseStatusArgs(argv);
  if (a.help) {
    process.stdout.write(USAGE + "\n");
    return 0;
  }
  const buildOpts = { allProjects: a.all, projectRoot: a.project };

  // No TTY (piped, CI, popup without -E pty): degrade to a one-shot snapshot.
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    const snap = buildSnapshot(buildOpts);
    const out = renderSnapshot(snap, {
      color: a.color ?? false,
      width: process.stdout.columns || 100,
    });
    process.stdout.write(out + "\n");
    return 0;
  }

  const color = a.color ?? !process.env.NO_COLOR;
  const client = clientFlag(argv);
  return runInteractive({ buildOpts, color, client });
}

type InteractiveOpts = {
  buildOpts: { allProjects: boolean; projectRoot: string | undefined };
  color: boolean;
  client: string | undefined;
};

function runInteractive(opts: InteractiveOpts): Promise<number> {
  return new Promise<number>((resolve) => {
    let snapshot: FleetSnapshot = buildSnapshot({ ...opts.buildOpts });
    let selectedKey: string | null =
      snapshot.agents.length > 0 ? agentKey(snapshot.agents[0]) : null;
    let status = "";
    let statusUntil = 0;
    let debounceTimer: NodeJS.Timeout | null = null;
    const watchers: FSWatcher[] = [];
    let slowTick: NodeJS.Timeout | null = null;
    let torndown = false;
    let helpOpen = false;
    let mode: "fleet" | "log" = "fleet";
    let logOffset = 0; // LINES scrolled up from the newest (0 = tail/live)
    let logFilterSelf = false; // scope the log to the fleet-selected agent
    let logFull = false; // word-wrap full message bodies (vs one-line snippets)
    let logTotalLines = 0; // last-rendered total body lines (for scroll clamping)
    let logAvail = 0; // last-rendered visible body lines
    let pendingNudgeKey: string | null = null; // agentKey awaiting 'y' to confirm a nudge
    let composing = false; // typing a custom operator message in the TUI
    let composeBuf = ""; // the message being typed
    let composeTargetKey: string | null = null; // agentKey the message is bound to
    const COMPOSE_MAX = 7000; // generous cap; mailbox bodies are ≤8KB
    let pasting = false; // inside a bracketed-paste sequence
    let pasteBuf = ""; // accumulates paste content across data chunks

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

    function footer(): string {
      let keys: string;
      if (mode === "log") {
        const pos = logOffset === 0 ? "live" : `↑${logOffset}`;
        const filt = logFilterSelf ? " (on)" : "";
        keys = `↑↓ scroll  w ${logFull ? "snippet" : "full"}  f filter${filt}  l/Esc fleet  q quit  [${pos}]`;
      } else {
        keys = "↑↓ move  ⏎ jump  n nudge  m message  l log  r refresh  ? help  q quit";
      }
      const now = Date.now();
      const msg = now < statusUntil && status ? "  " + status : "";
      return "\n" + dim("  " + keys, opts.color) + msg;
    }

    function helpFrame(width: number): string {
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const L = [
        b("oxpit — help"),
        "",
        "  ↑/k  ↓/j      move selection (fleet) / scroll (log)",
        "  ⏎             jump to the selected agent's tmux pane",
        "  n             nudge the selected agent (canned operator message; y to confirm)",
        "  m             compose a message (Enter send · ⌥⏎/⌃J newline · paste ok · Esc cancel)",
        "  l             comms-log (fleet ⇄ log); in log: w full-text · f filter · ↑↓ scroll",
        "  r             force refresh    ?  toggle help    q / Ctrl-C  quit",
        "",
        d("  🟢 active   🟡 idle   ⚫ dead (exited / pid-reused)"),
        d("  ✉N unread   ⚑N open obligations   ⏳ awaiting a peer reply"),
        d("  ⛔ DEADLOCK (live cycle)   ⚠ stale/possible cycle   † orphaned (target dead)"),
        d("  comms: ⚑ delegation  ⚑✓ done  ⚑✗ blocked  ❓ ask  ↩ reply"),
        "",
        d("  press ? or q to return"),
      ];
      return L.map((l) => clipToWidth(l, width) + CLEAR_EOL).join("\n");
    }

    // Lines of fixed chrome around the agent table, so the table can be windowed to
    // fit the terminal height (paging) — a large fleet can't overflow and desync
    // the cursor-home repaint.
    function reservedRows(): number {
      const waiters = snapshot.agents.filter((a) => a.waiting);
      const wgBody = snapshot.cycles.length + waiters.filter((a) => !a.waiting?.in_cycle).length;
      const wgLines =
        waiters.length || snapshot.cycles.length
          ? 2 + Math.min(wgBody, MAX_WAIT_ROWS) + (wgBody > MAX_WAIT_ROWS ? 1 : 0)
          : 0;
      // header(1) + column header(1) + footer(2) + wait-graph + warnings + window
      // markers(2) + margin(1)
      return 1 + 1 + 2 + wgLines + snapshot.warnings.length + 2 + 1;
    }

    function fleetFrame(width: number, rows: number): string {
      const maxAgentRows = Math.max(3, rows - reservedRows());
      return renderSnapshot(snapshot, {
        color: opts.color,
        width,
        selected: selectedIndex(),
        maxAgentRows,
        maxWaitRows: MAX_WAIT_ROWS,
      });
    }

    // Comms-log body, LINE-windowed to terminal height and scroll-positioned by
    // logOffset (lines from the newest; 0 = tail/live). `w` toggles full word-wrap
    // (readable) vs one-line snippets; `f` filters to the fleet-selected agent.
    function logFrame(width: number, rows: number): string {
      const { bySession } = computeAgentLabels(snapshot.agents);
      let comms: CommsMessage[] = buildCommsLog(snapshot.agents, { limit: LOG_FETCH });
      let filterNote = "";
      if (logFilterSelf) {
        const sel = snapshot.agents[selectedIndex()];
        const sid = sel?.session_id;
        if (sid) {
          comms = comms.filter((m) => m.from_session_id === sid || m.to_session_id === sid);
          filterNote = `  [${sel.window_name ?? sel.short_id}]`;
        } else {
          filterNote = "  [filter: no agent selected]";
        }
      }
      const bodyLines = commsBodyLines(comms, bySession, {
        color: opts.color,
        width,
        full: logFull,
      });
      logTotalLines = bodyLines.length;
      const avail = Math.max(3, rows - 5); // header(1) + footer(2) + 2 scroll markers
      logAvail = avail;
      const maxOffset = Math.max(0, bodyLines.length - avail);
      if (logOffset > maxOffset) logOffset = maxOffset;
      const end = bodyLines.length - logOffset;
      const start = Math.max(0, end - avail);

      const header =
        (opts.color ? "\x1b[1m\x1b[36mcomms\x1b[0m" : "comms") +
        dim(`  recent tail${logFull ? " · full" : ""}${filterNote}`, opts.color);
      const out: string[] = [header];
      if (start > 0) out.push(dim(`  ↑ ${start} more line${start === 1 ? "" : "s"}`, opts.color));
      out.push(...bodyLines.slice(start, end));
      if (end < bodyLines.length) {
        out.push(dim(`  ↓ ${bodyLines.length - end} more`, opts.color));
      }
      return out.join("\n");
    }

    // Hard char-wrap a single logical line to `w` columns.
    function wrapText(s: string, w: number): string[] {
      if (w <= 0 || s.length <= w) return [s];
      const out: string[] = [];
      for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
      return out;
    }

    // Full-screen compose modal: target + multi-line wrapped buffer + cursor + hint.
    // Full-screen (not overlaid on the fleet) so a long multi-line message has room
    // and can't overflow/desync the fleet repaint.
    function composeFrame(width: number, rows: number): string {
      const a = composeTargetKey
        ? snapshot.agents.find((ag) => agentKey(ag) === composeTargetKey)
        : undefined;
      const to = a ? a.window_name ?? a.short_id : "?";
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const mark = a?.is_self ? d("  → your primary session") : "";
      const lines: string[] = [b(`✉ message to ${to}`) + mark, ""];
      // Render the buffer: each logical line (\n-split) wrapped; cursor on the last.
      const body: string[] = [];
      for (const logical of composeBuf.split("\n")) {
        for (const seg of wrapText(logical, width - 2)) body.push("  " + seg);
      }
      if (body.length === 0) body.push("  ");
      body[body.length - 1] += "█";
      // Keep the tail visible if the message is taller than the screen.
      const avail = Math.max(3, rows - 5);
      lines.push(...(body.length > avail ? body.slice(body.length - avail) : body));
      lines.push("");
      lines.push(d("  Enter send · ⌥⏎ / ⌃J newline · Esc cancel"));
      return lines.map((l) => clipToWidth(l, width) + CLEAR_EOL).join("\n");
    }

    function paint(): void {
      if (torndown) return;
      const width = stdout.columns || 100;
      if (helpOpen) {
        stdout.write(HOME + helpFrame(width) + CLEAR_BELOW);
        return;
      }
      const rows = stdout.rows || 24;
      if (composing) {
        stdout.write(HOME + composeFrame(width, rows) + CLEAR_BELOW);
        return;
      }
      const frame = (mode === "log" ? logFrame(width, rows) : fleetFrame(width, rows)) + footer();
      // Clip every physical line to the terminal width (ANSI-aware) so none wraps —
      // a wrapped line would push the cursor-home repaint out of sync and corrupt
      // the screen. The renderers already clip their lines; this covers the footer
      // and is idempotent.
      const body = frame
        .split("\n")
        .map((l) => clipToWidth(l, width) + CLEAR_EOL)
        .join("\n");
      stdout.write(HOME + body + CLEAR_BELOW);
    }

    function logScroll(delta: number): void {
      const maxOffset = Math.max(0, logTotalLines - logAvail);
      const next = Math.min(maxOffset, Math.max(0, logOffset + delta));
      if (next === logOffset) return;
      logOffset = next;
      paint();
    }

    function toggleLog(): void {
      mode = mode === "log" ? "fleet" : "log";
      logOffset = 0;
      paint();
    }

    function refresh(full: boolean): void {
      snapshot = buildSnapshot({ ...opts.buildOpts, checkProcSig: full });
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
      let idx = selectedIndex();
      if (idx < 0) idx = 0;
      idx = (idx + delta + snapshot.agents.length) % snapshot.agents.length;
      selectedKey = agentKey(snapshot.agents[idx]);
      paint();
    }

    function doJump(): void {
      const idx = selectedIndex();
      if (idx < 0) {
        setStatus(warn("no agent selected", opts.color));
        return;
      }
      const agent = snapshot.agents[idx];
      const r = jumpToAgent(agent, { client: opts.client });
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

    // Send the composed custom message to the bound agent (resolved by session key,
    // so churn can't re-point it), then leave compose mode.
    function sendCompose(): void {
      const body = composeBuf.trim();
      const key = composeTargetKey;
      composing = false;
      composeBuf = "";
      composeTargetKey = null;
      if (!body) return setStatus(warn("empty message — cancelled", opts.color));
      const agent = key ? snapshot.agents.find((a) => agentKey(a) === key) : undefined;
      if (!agent) return setStatus(warn("agent gone — message cancelled", opts.color));
      const label = agent.window_name ?? agent.short_id;
      setStatus(dim(`sending to ${label}…`, opts.color));
      sendOperatorMessage(
        { session_id: agent.session_id, server_pid: agent.server_pid, short_id: label },
        body,
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
      composeBuf = (composeBuf + t).slice(0, COMPOSE_MAX);
      paint();
    }

    function cancelCompose(): void {
      composing = false;
      composeBuf = "";
      composeTargetKey = null;
      paint();
    }

    // Bracketed-paste content: insert literally, newlines preserved (normalized),
    // control chars stripped — so a multi-line paste never fires-send or corrupts.
    function onPaste(content: string): void {
      if (!composing) return; // paste only meaningful in the composer
      const norm = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      let clean = "";
      for (const ch of norm) if (ch === "\n" || (ch >= " " && ch !== "\x7f" && ch !== "\x1b")) clean += ch;
      composeInsert(clean);
    }

    // Raw-mode line editing for the composer (one keystroke chunk).
    //   Enter (\r) = send · Ctrl-J (\n) or Alt+Enter (ESC+CR/LF) = newline ·
    //   Esc = cancel · Ctrl-C = quit · Backspace = delete.
    function composeKey(s: string): void {
      if (s === "\x03") return teardown(0);
      if (s === "\x1b") return cancelCompose(); // lone ESC
      if (s === "\x1b\r" || s === "\x1b\n") return composeInsert("\n"); // Alt+Enter
      if (s === "\r") return sendCompose(); // Enter sends
      if (s === "\n") return composeInsert("\n"); // Ctrl-J newline
      if (s === "\x7f" || s === "\b") {
        composeBuf = composeBuf.slice(0, -1);
        return paint();
      }
      // Printable typed input; strip control + stray escapes (newlines come via the
      // explicit branches above or via onPaste).
      let printable = "";
      for (const ch of s) if (ch >= " " && ch !== "\x7f" && ch !== "\x1b") printable += ch;
      composeInsert(printable);
    }

    function teardown(code: number): void {
      if (torndown) return;
      torndown = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (slowTick) clearInterval(slowTick);
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
      process.removeListener("SIGWINCH", onResize);
      process.removeListener("uncaughtException", onFatal);
      process.removeListener("unhandledRejection", onFatal);
      try {
        if (stdin.isTTY) stdin.setRawMode(false);
      } catch {
        // ignore
      }
      stdin.pause();
      stdout.write(PASTE_OFF + CURSOR_SHOW + ALT_OFF);
      resolve(code);
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
      if (composing) return composeKey(s);
      if (s === "\x03" || s === "q") return teardown(0); // Ctrl-C / q
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
      if (s === "l") return toggleLog();
      if (s === "r") return refresh(true);
      if (mode === "log") {
        if (s === "\x1b") return toggleLog(); // Esc → back to fleet (lone ESC, not an arrow)
        if (s === "\x1b[A" || s === "k") return logScroll(1); // older
        if (s === "\x1b[B" || s === "j") return logScroll(-1); // newer
        if (s === "w") {
          logFull = !logFull; // toggle full word-wrap vs snippet
          logOffset = 0;
          return paint();
        }
        if (s === "f") {
          logFilterSelf = !logFilterSelf;
          logOffset = 0;
          return paint();
        }
        if (s === "m") return startCompose(); // compose to the filtered/selected agent
        return; // ignore other keys in log mode
      }
      // fleet mode
      if (s === "\x1b[A" || s === "k") return move(-1);
      if (s === "\x1b[B" || s === "j") return move(1);
      if (s === "\r" || s === "\n") return doJump();
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
      let s = buf.toString();
      while (s.length > 0) {
        if (pasting) {
          const end = s.indexOf(PASTE_END);
          if (end === -1) {
            pasteBuf += s;
            s = "";
          } else {
            pasteBuf += s.slice(0, end);
            s = s.slice(end + PASTE_END.length);
            pasting = false;
            onPaste(pasteBuf);
            pasteBuf = "";
          }
        } else {
          const start = s.indexOf(PASTE_START);
          if (start === -1) {
            handleKey(s);
            s = "";
          } else {
            if (start > 0) handleKey(s.slice(0, start));
            s = s.slice(start + PASTE_START.length);
            pasting = true;
          }
        }
      }
    }

    function onSignal(): void {
      teardown(0);
    }

    function onResize(): void {
      paint();
    }

    // ── enter raw mode + alt screen + bracketed paste ────────────────────────
    stdout.write(ALT_ON + CURSOR_HIDE + PASTE_ON);
    try {
      stdin.setRawMode(true);
    } catch {
      // some environments can't; input just won't work, view still renders
    }
    stdin.resume();
    stdin.on("data", onData);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGWINCH", onResize);
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);

    // ── watch ~/.oxtail subdirs (debounced) ──────────────────────────────────
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

    // ── slow fallback tick (ages mtime liveness; full proc_sig check) ─────────
    slowTick = setInterval(() => {
      if (!torndown) refresh(true);
    }, SLOW_TICK_MS);

    refresh(true);
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

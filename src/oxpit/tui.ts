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
import { attentionLine, commsBodyLines, computeAgentLabels, renderSnapshot } from "./render.js";
import { buildCommsLog, type CommsMessage } from "./comms.js";
import { agentKey, capturePaneActivity, type AgentActivity, type PaneActivity } from "./activity.js";
import { clipToWidth, scrubBufferText } from "./format.js";
import { jumpToAgent } from "./jump.js";
import { NUDGE_TEXT, sendOperatorMessage } from "./operator.js";
import { formatAttachmentNote, stageAttachment, type StagedAttachment } from "./attachments.js";
import { captureClipboardImage } from "./clipboard.js";
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
    let composeAttachments: StagedAttachment[] = []; // staged files for the message
    let composeAttachSources: string[] = []; // source path per attachment (for ⌃X undo)
    let composeNote = ""; // transient composer feedback (attach result)
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

    // Fleet-mode footer keys (log mode carries its own footer inside the panel).
    function footer(): string {
      const keys = "↑↓ move  ⏎ jump  n nudge  m msg  l log  w thread  r refresh  ? help  q quit";
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
        "  m             compose a message (Enter send · ⌥⏎/⌃J newline · ⌃X unattach · Esc cancel)",
        "                attach: drag a file then ⌃A · ⌃V pastes a clipboard image (copy then ⌃V)",
        "  l             toggle the comms-log bottom panel (fleet stays visible above)",
        "  w             open the selected agent's full thread in the panel (per-agent)",
        "                in the panel: ↑↓ walk agents · [ ] scroll · w full · f filter · ⏎ jump",
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
      // header(1) + optional attention line + column header(1) + footer(2) +
      // wait-graph + warnings + window markers(2) + margin(1)
      const attn = attentionLine(snapshot, (x) => x) ? 1 : 0;
      return 1 + attn + 1 + 2 + wgLines + snapshot.warnings.length + 2 + 1;
    }

    function fleetFrame(width: number, rows: number): string {
      const maxAgentRows = Math.max(3, rows - reservedRows());
      return renderSnapshot(snapshot, {
        color: opts.color,
        width,
        selected: selectedIndex(),
        maxAgentRows,
        maxWaitRows: MAX_WAIT_ROWS,
        paneActivity,
        toolActivity: activityCache, // sticky overlay — never mutates the snapshot
      });
    }

    // Capture the SELECTED agent's live pane bottom-line (the one exec-class signal).
    // EXEC-cheap because it's one pane, gated by a change-detector: only when the
    // selection changed (force) or the selected pane has produced new output since
    // our last capture (window_activity advanced). Skipped while typing / in an
    // overlay / log mode, and for dead·self·pane-less rows. capturePaneActivity
    // re-verifies the pane id (a recycled id never captures a stranger).
    function maybeCaptureSelected(force: boolean): void {
      if (composing || helpOpen || mode === "log") return;
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

    // Comms panel rendered as the BOTTOM region (item 3): a separator, the comms
    // header, the windowed body (scroll-positioned by logOffset), and a footer of
    // panel keys — EXACTLY `rows` lines so the caller can pin it to the foot with the
    // fleet table above. `w`/`f` toggle full-text / selected-agent filter; when
    // filtered it follows the live fleet selection (the per-agent thread, item 4).
    function logPanelLines(width: number, rows: number): string[] {
      const d = (s: string) => dim(s, opts.color);
      const sep = d("─".repeat(Math.max(4, width)));
      const footerKeys = d(
        `  ↑↓ move · [ ] scroll · w ${logFull ? "snippet" : "full"} · f filter${logFilterSelf ? "*" : ""} · ⏎ jump · l/Esc close`,
      );
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
          filterNote = "  [no agent selected]";
        }
      }
      const bodyLines = commsBodyLines(comms, bySession, { color: opts.color, width, full: logFull });
      logTotalLines = bodyLines.length;
      // Fixed line budget: sep(1) + header(1) + up-marker(1) + body(avail) +
      // down-marker(1) + footer(1) = avail + 5. Markers are always emitted (blank
      // when nothing's hidden) so the panel is a constant `rows` lines — no desync.
      const avail = Math.max(1, rows - 5);
      logAvail = avail;
      const maxOffset = Math.max(0, bodyLines.length - avail);
      if (logOffset > maxOffset) logOffset = maxOffset;
      const end = bodyLines.length - logOffset;
      const start = Math.max(0, end - avail);
      const header =
        (opts.color ? "\x1b[1m\x1b[36mcomms\x1b[0m" : "comms") +
        d(`  recent tail${logFull ? " · full" : ""}${filterNote}`);
      const out: string[] = [sep, header];
      out.push(start > 0 ? d(`  ↑ ${start} more`) : "");
      const window = bodyLines.slice(start, end);
      out.push(...window);
      // pad the body region to `avail` so the footer pins to the bottom
      for (let i = window.length; i < avail; i++) out.push("");
      out.push(end < bodyLines.length ? d(`  ↓ ${bodyLines.length - end} more`) : "");
      out.push(footerKeys);
      return out;
    }

    // Hard char-wrap a single logical line to `w` columns.
    function wrapText(s: string, w: number): string[] {
      if (w <= 0 || s.length <= w) return [s];
      const out: string[] = [];
      for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w));
      return out;
    }

    // Compose FIELD — a compact input pinned to the bottom of the screen, with the
    // fleet/log still visible above it (paint() sizes the top region and pads so this
    // bar sits at the foot). Replaces the old full-screen modal: messaging from the
    // cockpit should feel like a chat field, not a whole-screen context switch. The
    // buffer is tail-windowed so a long multi-line message can't grow the bar without
    // bound (which would desync the cursor-home repaint).
    const MAX_FIELD_LINES = 6;
    function composerBar(width: number): string[] {
      const a = composeTargetKey
        ? snapshot.agents.find((ag) => agentKey(ag) === composeTargetKey)
        : undefined;
      const to = a ? a.window_name ?? a.short_id : "?";
      const b = (s: string) => (opts.color ? `\x1b[1m\x1b[36m${s}\x1b[0m` : s);
      const d = (s: string) => dim(s, opts.color);
      const mark = a?.is_self ? " → your primary session" : "";
      const lines: string[] = [d("─".repeat(Math.max(4, width))), b(`✉ ${to}`) + d(mark)];
      // Buffer: each logical line wrapped, a "> " prompt on the first, cursor on the
      // last, tail-windowed to MAX_FIELD_LINES.
      const wrapped: string[] = [];
      for (const logical of composeBuf.split("\n")) {
        for (const seg of wrapText(logical, width - 2)) wrapped.push(seg);
      }
      if (wrapped.length === 0) wrapped.push("");
      wrapped[wrapped.length - 1] += "█";
      const shown =
        wrapped.length > MAX_FIELD_LINES ? wrapped.slice(wrapped.length - MAX_FIELD_LINES) : wrapped;
      shown.forEach((seg, i) => lines.push((i === 0 ? d("> ") : "  ") + seg));
      // Attachments (capped) + transient note.
      for (const att of composeAttachments.slice(0, 3)) {
        lines.push(d(`📎 ${att.name} (${att.bytes}B)`));
      }
      if (composeAttachments.length > 3) {
        lines.push(d(`📎 …+${composeAttachments.length - 3} more`));
      }
      if (composeNote) lines.push(d(composeNote));
      const undo = composeAttachments.length ? " · ⌃X unattach" : "";
      lines.push(d(`Enter send · ⌥⏎/⌃J newline · drag+⌃A attach · ⌃V image${undo} · Esc cancel`));
      return lines;
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
        // Compose field at the BOTTOM; fleet/log stays visible above. Size the top
        // region to the remaining rows and pad so the field is pinned to the foot.
        const bar = composerBar(width).map((l) => clipToWidth(l, width) + CLEAR_EOL);
        const avail = Math.max(1, rows - bar.length);
        const topStr = mode === "log" ? logFrame(width, avail) : fleetFrame(width, avail);
        const top = topStr
          .split("\n")
          .slice(0, avail)
          .map((l) => clipToWidth(l, width) + CLEAR_EOL);
        while (top.length < avail) top.push(CLEAR_EOL); // pad so the bar sits at the bottom
        stdout.write(HOME + [...top, ...bar].join("\n") + CLEAR_BELOW);
        return;
      }
      const clipEOL = (l: string) => clipToWidth(l, width) + CLEAR_EOL;
      if (mode === "log") {
        // item 3: comms as a BOTTOM PANEL with the fleet table still visible above
        // (the selection up top is the agent the per-agent thread follows). The panel
        // is a constant height; the fleet gets the rest. Whole frame clamped to `rows`.
        const panelRows = Math.max(7, Math.min(Math.floor(rows * 0.55), rows - 6));
        const topAvail = Math.max(3, rows - panelRows);
        const top = fleetFrame(width, topAvail).split("\n").slice(0, topAvail).map(clipEOL);
        while (top.length < topAvail) top.push(CLEAR_EOL);
        const panel = logPanelLines(width, rows - topAvail).map(clipEOL);
        stdout.write(HOME + [...top, ...panel].slice(0, rows).join("\n") + CLEAR_BELOW);
        return;
      }
      // Clip every physical line to the terminal width (ANSI-aware) so none wraps —
      // a wrapped line would push the cursor-home repaint out of sync and corrupt
      // the screen. The renderers already clip their lines; this covers the footer
      // and is idempotent.
      const body = (fleetFrame(width, rows) + footer())
        .split("\n")
        .map(clipEOL)
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
      // readActivity rides the same `full` flag as checkProcSig: ON for the slow
      // tick / forced refresh, OFF for the 200ms fast fs-debounce. On a full build we
      // refresh the sticky tool-badge cache from the fresh reads. Fast builds do NOT
      // recompute it and do NOT mutate the snapshot — the cache is handed to the
      // renderer as an overlay (toolActivity) so badges persist between slow ticks
      // without forking buildSnapshot's truth (max review).
      snapshot = buildSnapshot({ ...opts.buildOpts, checkProcSig: full, readActivity: full });
      if (full) {
        activityCache = new Map(snapshot.agents.map((a) => [agentKey(a), a.activity]));
      }
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
      logOffset = 0; // tail the newly-selected agent's thread (item 4 follow-selection)
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
        if (s === "\x1b") return toggleLog(); // Esc → close the panel (lone ESC, not an arrow)
        // ↑↓ still MOVE the fleet selection (panel follows it when filtered, item 4);
        // history scrolls with [ / ] so navigation and scrolling don't fight.
        if (s === "\x1b[A" || s === "k") return move(-1);
        if (s === "\x1b[B" || s === "j") return move(1);
        if (s === "[") return logScroll(1); // older
        if (s === "]") return logScroll(-1); // newer
        if (s === "\r" || s === "\n") return doJump(); // jump to the selected agent
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
        if (s === "m") return startCompose(); // compose to the selected agent
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
      if (s === "w") {
        // item 4: open the selected row's full per-agent thread (filtered + full
        // bodies) in the bottom log panel. ↑↓ then walks agents, the panel follows.
        if (selectedIndex() < 0) return;
        logFilterSelf = true;
        logFull = true;
        logOffset = 0;
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

    // ── slow fallback tick (ages mtime liveness; full proc_sig check; refreshes
    // tool badges; change-detected selected-pane capture) ─────────────────────
    slowTick = setInterval(() => {
      if (torndown) return;
      refresh(true);
      maybeCaptureSelected(false);
    }, SLOW_TICK_MS);

    // First paint is read-only (instant startup, C7); the first slow tick ~1.5s
    // later does the first selected-pane capture.
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

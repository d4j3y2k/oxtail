// oxpit renderer — pure (FleetSnapshot → string). Shared by `oxtail status`
// (one-shot) and the TUI frame body, so what you see live matches what you script.
// Color is injected (gated on TTY / NO_COLOR by the caller), never auto-detected
// here, so tests get deterministic plain output.

import { cell, clip, clipToWidth, displayWidth, fmtAge, scrubBufferText } from "./format.js";
import type { FleetAgent, FleetSnapshot, Liveness } from "./snapshot.js";
import { agentKey, type AgentActivity, type PaneActivity, type ToolKind } from "./activity.js";
import type { CommsMessage } from "./comms.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

export type RenderOptions = {
  color?: boolean;
  width?: number;
  // Index of the selected row (TUI); -1/undefined = none. Selected row gets a ›.
  selected?: number;
  // Max agent rows to render. When the fleet is larger, a window that always keeps
  // the selected row visible is shown, with "⋯ N more above/below" markers — so a
  // big fleet can't overflow the terminal and desync the TUI repaint. Unset (or
  // <=0) = render all (the `oxtail status` one-shot default).
  maxAgentRows?: number;
  // Max wait-graph body lines (cycles + non-cycle waiters) to render; extras are
  // summarized as "⋯ N more waits". Unset = render all.
  maxWaitRows?: number;
  // Live pane bottom-line per agent (keyed by agentKey), from capture-pane. When an
  // agent has one it becomes the row's trailing detail, beating a stale purpose.
  paneActivity?: Map<string, PaneActivity>;
  // Tool sub-state OVERLAY (keyed by agentKey). When a key is present it overrides
  // FleetAgent.activity (an explicit null = "known to have no tool") — lets the TUI
  // supply a sticky last-known badge on fast ticks WITHOUT mutating the snapshot
  // (don't fork buildSnapshot's truth; max review).
  toolActivity?: Map<string, AgentActivity | null>;
  // Per-agent BURST animation (TUI only), keyed by agentKey → the current frame index
  // (0..ANIM_FRAMES-1) of a one-shot burst. A row plays a short burst when you move to
  // it OR when its status changes (backlog item 1 — event-driven, not a loop).
  burstFrames?: Map<string, number>;
  // Expand the detached-background section into its individual rows (TUI `b` toggle).
  // Default false: the section renders as a single collapsed count header.
  showBackground?: boolean;
  // DOCK mode only: a transient operator status/confirm line (already styled). When
  // set it REPLACES the dock footer key-hints, so confirms ("press y", "press K
  // again") and feedback are visible in the strip — the full table rides these on its
  // footer, but the dock has no other seam to surface them.
  dockStatus?: string;
  // DOCK mode only: surface the "⌃] flip" hint in the footer — the agent↔dock flip key
  // the cockpit installs. The TUI passes this from a show-options read of @oxpit_cockpit
  // (a tmux-spawned dock child can't see the install-side OXTAIL_OXPIT_FLIP env), so the
  // hint shows iff the binding was actually installed.
  flipHint?: boolean;
};

// Cap on background rows rendered when the section is expanded, so a runaway process
// leak can't overflow the frame. Shared with the TUI's height reservation so the two
// agree on how many lines the expanded section occupies.
export const BACKGROUND_ROW_CAP = 8;

// Window `total` items around `cursor` into at most `budget` DISPLAY rows, RESERVING
// rows for the "⋯ N more above/below" markers so the markers are always shown (and
// counted accurately) when items are hidden, and the rendered section — content rows
// PLUS markers — never exceeds `budget`. Returns the content slice [start, end) and the
// EXACT hidden counts above/below (0 when that edge isn't clipped). This is the one
// shared windowing idiom behind the dock strip's agent rows AND the fleet editor's grid
// (an earlier marker-OVERLAY variant silently dropped the bottom marker and undercounted
// hidden rows by one when the cursor sat on the window's edge — compile-sim, 3 lenses).
export function windowWithMarkers(
  total: number,
  cursor: number,
  budget: number,
): { start: number; end: number; above: number; below: number } {
  if (budget >= total || total <= 0) return { start: 0, end: Math.max(0, total), above: 0, below: 0 };
  const c = Math.max(0, Math.min(cursor, total - 1));
  if (budget <= 2) {
    // No room for a marker row — show a bare cursor-visible window (markers suppressed
    // because there's physically nowhere to put one; the section is exactly `budget`).
    const start = Math.max(0, Math.min(c - Math.floor(budget / 2), total - budget));
    return { start, end: start + budget, above: 0, below: 0 };
  }
  // Reserve BOTH marker rows up front, then reclaim one when an edge isn't actually
  // hidden — so content + markers == budget when clipped on both sides, and budget-1
  // (one spare) when clipped on only one. Never exceeds budget.
  const contentCap = budget - 2;
  let start = Math.max(0, Math.min(c - Math.floor(contentCap / 2), total - contentCap));
  let end = start + contentCap;
  if (start === 0 && end < total) end = Math.min(total, end + 1); // no "above" marker → grow content down
  else if (end === total && start > 0) start = Math.max(0, start - 1); // no "below" marker → grow content up
  return { start, end, above: start, below: total - end };
}

type Paint = (s: string, ...codes: string[]) => string;

function makePaint(color: boolean): Paint {
  if (!color) return (s) => s;
  return (s, ...codes) => `${codes.join("")}${s}${C.reset}`;
}

// Selected-row emphasis: a soft gray BACKGROUND chip on just the agent-name cell
// (not a full-row reverse bar — that inverted the emoji/badges into harsh blocks).
// 256-color shade; bump it lighter/darker to taste.
const SELECT_BG = "\x1b[48;5;238m";

// SPIKE (backlog item 1): animated frame around the SELECTED agent's name, advanced
// by the TUI's focus-gated animation timer (animFrame, ~6fps). The frame morphs
// through David's chosen sequence (currently ⋄ → ⋇ → ⚙ → ◌) around the selected
// name. One sequence for any liveness (David wanted a
// single dance). Each entry is [left, right]; phase = animFrame % length. (These are
// EAW-Ambiguous → 1-col here / maybe 2-col on a CJK terminal; it's only the selected
// NAME cell, so a CJK mis-measure is cosmetic, never a wrap.) The cute knob — riff away.
const FRAME_SEQ: [string, string][] = [
  ["⋄", "⋄"],
  ["⋇", "⋇"],
  ["⚙", "⚙"],
  ["◌", "◌"],
];
// Number of frames in one burst (the whole sequence plays once). Exported so the TUI
// knows how long a burst lasts before it ends the agent's animation.
export const ANIM_FRAMES = FRAME_SEQ.length;
function nameFrame(frame: number): [string, string] {
  const i = ((frame % FRAME_SEQ.length) + FRAME_SEQ.length) % FRAME_SEQ.length;
  return FRAME_SEQ[i];
}

const GLYPH: Record<Liveness, string> = {
  active: "🟢",
  idle: "🟡",
  dead: "⚫",
};

function livenessColor(l: Liveness): string {
  return l === "active" ? C.green : l === "idle" ? C.yellow : C.gray;
}

// Tool-family glyphs for the live activity badge. All VERIFIED 1-column against
// EastAsianWidth-17: the four that were EAW-Ambiguous (↔ ▤ ↗ •, which mis-measure 2-col
// on a CJK/ambiguous-wide terminal) were swapped to genuinely-Neutral text-presentation
// lookalikes (⇄ ▭ ⇗ ∙ — NOT the EAW-Neutral dingbat arrows ➜➝➞, which carry emoji
// presentation and render 2-col). ☰plan is EAW-Wide and handled by WIDE_GLYPHS (so it's
// counted 2, not under-measured); ⚙ ✎ ⌕ ⎇ are Neutral. clipToWidth stays the backstop.
const TOOL_GLYPH: Record<ToolKind, string> = {
  oxtail: "⇄",
  bash: "⚙",
  edit: "✎",
  read: "▭",
  search: "⌕",
  web: "⇗",
  task: "⎇",
  plan: "☰",
  tool: "∙",
};

function toolColor(k: ToolKind): string {
  switch (k) {
    case "oxtail":
      return C.cyan;
    case "bash":
      return C.blue;
    case "edit":
      return C.magenta;
    case "search":
      return C.yellow;
    case "web":
      return C.green;
    case "task":
      return C.cyan;
    default:
      return C.gray;
  }
}

// Display label for the "tool" (unknown family) bucket: strip an mcp__ prefix and
// take the last path segment so a raw "mcp__foo__do_thing" reads as "thing".
function shortRawTool(raw: string): string {
  const tail = raw.replace(/^mcp__/, "").split(/[._]/).filter(Boolean).pop() ?? raw;
  return tail.length > 12 ? tail.slice(0, 12) : tail;
}

// "active 4s" / "idle 3m" / "dead·pid-reused". Raw age always shown — the glyph is
// never the only signal.
function statusText(a: FleetAgent): string {
  if (a.liveness === "dead") {
    return a.liveness_reason === "pid_reused" ? "dead·reused" : "dead·gone";
  }
  if (a.liveness === "active") {
    // Each of the 3 active reasons is legible from the status cell ALONE (not only via
    // the badge cluster): pane_fresh → ✻pane-age (the transcript can be minutes stale
    // mid-turn, so show the live pane-repaint age, not "active 2m"); tool_running →
    // ⧖tx-age (a tool is in flight while tx+pane are both quiet — the transcript mtime
    // is the unclosed tool_use write, i.e. the practical tool-call age, bounded by
    // STALL_WINDOW_S); else transcript_fresh → plain tx-age. Both markers are VERIFIED
    // EAW-Neutral against EastAsianWidth-17 so displayWidth's 1-col count is correct on
    // every locale: ⧖ U+29D6 (range 2999..29D7) — and it doesn't collide with the ⚙bash
    // badge; ✻ U+273B (range 2729..273C) — swapped from ✽ U+273D, which is Ambiguous and
    // could mis-measure in this fixed STATUS_W=13 cell (codex review).
    if (a.liveness_reason === "pane_fresh") return `active ✻${fmtAge(a.pane_activity_age_s)}`;
    if (a.liveness_reason === "tool_running") return `active ⧖${fmtAge(a.transcript_age_s)}`;
    return `active ${fmtAge(a.transcript_age_s)}`;
  }
  if (a.liveness_reason === "no_transcript") return "idle·no-tx";
  return `idle ${fmtAge(a.transcript_age_s)}`;
}

// Free-form badge cluster: ✉ unread, ⚑ open-work, ⏳ waiting (with deadlock/orphan
// flags). Returns the painted string (already colored) plus its visible length so
// the caller can budget the trailing purpose column.
function badges(
  a: FleetAgent,
  paint: Paint,
  labels: Map<string, string>, // short_id → display label
  act: AgentActivity | null, // resolved tool sub-state (overlay ?? a.activity)
): { text: string; len: number } {
  const parts: string[] = [];
  let len = 0;
  const add = (raw: string, painted: string) => {
    parts.push(painted);
    len += displayWidth(raw) + 1; // +1 for the joining space; width-aware (emoji=2)
  };
  // (The pane-recent signal now folds straight into liveness as pane_fresh ⇒ active
  // — see snapshot.ts buildAgent — so the old "idle-but-✽" badge is gone; statusText
  // renders the pane age behind the active glyph instead.)
  // Live tool sub-state FIRST — "what it's doing right now". Bright (family color +
  // bold) while the call is in-flight; dim once it has returned ("last did X").
  if (act) {
    const label = act.tool === "tool" ? shortRawTool(act.tool_raw) : act.tool;
    const raw = `${TOOL_GLYPH[act.tool]}${label}${act.tool_running ? "…" : ""}`;
    add(raw, paint(raw, ...(act.tool_running ? [toolColor(act.tool), C.bold] : [C.dim])));
  }
  if (a.unread > 0) {
    const raw = `✉${a.unread}${a.unread_confidence === "low" ? "?" : ""}`;
    add(raw, paint(raw, C.cyan, C.bold));
  }
  if (a.open_work > 0) {
    const raw = `⚑${a.open_work}`;
    add(raw, paint(raw, C.magenta, C.bold));
  }
  if (a.waiting) {
    const w = a.waiting;
    const tgt =
      (w.target_short_id && labels.get(w.target_short_id)) || w.target_short_id || "?";
    // Default framing is "awaiting reply" — a timed-out ask_peer is parked for a
    // late reply, NOT synchronously blocked. Hard DEADLOCK only for a live cycle.
    let raw = `⏳${tgt} ${fmtAge(w.age_s)}`;
    let codes = [C.yellow];
    if (w.in_cycle && w.cycle_all_live) {
      raw = `⛔DEADLOCK ${tgt}`;
      codes = [C.red, C.bold];
    } else if (w.in_cycle) {
      raw = `⚠cycle? ${tgt}`;
      codes = [C.yellow];
    } else if (w.orphaned) {
      raw = `⛔${tgt}†`;
      codes = [C.red, C.bold];
    }
    add(raw, paint(raw, ...codes));
  }
  if (a.possibly_stalled) {
    const raw = "⚠stalled?";
    add(raw, paint(raw, C.dim)); // neutral dim hint, never a red alarm (max M1)
  }
  return { text: parts.join(" "), len: len > 0 ? len - 1 : 0 };
}

// The trouble conditions the attention line / `--check` probe key on. Computed once
// from the snapshot (pure VIEW — every field already exists) so the render line and
// the exit-code probe can never disagree about what "trouble" means.
export type FleetTrouble = {
  deadlocks: number; // live wait cycles (every member alive) — credible deadlock
  staleCycles: number; // wait cycles with a dead/aged-out member — "possible"
  orphaned: number; // agents awaiting a reply from a target that is itself dead
  stranded: number; // open obligations whose OWNER is dead — will never be done
  strandedOwners: number; // how many dead agents hold that stranded work
  strandedMail: number; // unread messages whose RECIPIENT is dead — may never be read
  strandedMailOwners: number; // how many dead agents hold that undrained mail
  stalled: number; // possibly-stalled agents (soft hint, never an alarm)
  awaiting: number; // idle agents sitting at their prompt = "awaiting you" (worklist)
  active: number;
};

export function fleetTrouble(s: FleetSnapshot): FleetTrouble {
  const strandedAgents = s.agents.filter((a) => a.liveness === "dead" && a.open_work > 0);
  // A message undrained in a DEAD recipient's mailbox: the owner won't read it again,
  // and (unless a live same-session sibling drains it) nothing will. Softer than a
  // stranded obligation — session-keyed mail is recoverable if the session resumes —
  // so it renders yellow, but it IS the "silent message loss" the cockpit exists to
  // surface, so it still trips --check.
  const strandedMailAgents = s.agents.filter((a) => a.liveness === "dead" && a.unread > 0);
  return {
    deadlocks: s.cycles.filter((c) => c.all_live).length,
    staleCycles: s.cycles.filter((c) => !c.all_live).length,
    orphaned: s.agents.filter((a) => a.waiting?.orphaned).length,
    stranded: strandedAgents.reduce((n, a) => n + a.open_work, 0),
    strandedOwners: strandedAgents.length,
    strandedMail: strandedMailAgents.reduce((n, a) => n + a.unread, 0),
    strandedMailOwners: strandedMailAgents.length,
    stalled: s.agents.filter((a) => a.possibly_stalled).length,
    awaiting: s.agents.filter((a) => a.awaiting_human).length,
    active: s.agents.filter((a) => a.liveness === "active").length,
  };
}

// Fleet-level attention summary — the "do I even need to look?" line. Aggregates
// the trouble signals oxpit ALREADY computes into one severity-ordered line at the
// very top, so the operator catches fleet trouble without scanning every row or the
// wait-graph. Pure VIEW; forks no truth. Returns null only for an empty fleet (the
// "no agents" line covers that); a healthy fleet still renders a dim "✓ nominal" so
// the absence of alarms reads as "checked & fine", not "feature didn't render"
// (max review). RED is reserved for the ⛔ classes; possibly-stalled stays a DIM
// soft hint (never a red fleet alarm — the M1 posture). Crucially it does NOT flag
// raw open_work: an open obligation on a LIVE agent is the NORMAL state of a working
// fleet — only work STRANDED on a dead owner is the high-signal "will never finish".
export function attentionLine(s: FleetSnapshot, paint: Paint): string | null {
  if (s.agents.length === 0) return null;
  const plural = (n: number, one: string, many = one + "s") => (n === 1 ? one : many);
  const t = fleetTrouble(s);
  const segs: string[] = [];
  if (t.deadlocks)
    segs.push(paint(`⛔ ${t.deadlocks} live ${plural(t.deadlocks, "deadlock")}`, C.red, C.bold));
  if (t.orphaned)
    segs.push(paint(`⛔ ${t.orphaned} orphaned ${plural(t.orphaned, "wait")}`, C.red, C.bold));
  if (t.stranded)
    segs.push(
      paint(`⚑ ${t.stranded} stranded (dead ${plural(t.strandedOwners, "owner")})`, C.red),
    );
  if (t.strandedMail)
    segs.push(
      paint(
        `✉ ${t.strandedMail} stranded mail (dead ${plural(t.strandedMailOwners, "owner")})`,
        C.yellow,
      ),
    );
  if (t.staleCycles)
    segs.push(paint(`⚠ ${t.staleCycles} possible ${plural(t.staleCycles, "cycle")}`, C.yellow));
  if (t.stalled) segs.push(paint(`⚠ ${t.stalled} possibly stalled`, C.dim));
  // The WORKLIST segment: who is idle at their prompt waiting for YOU. Appended AFTER
  // the trouble segs (it's not an alarm), NAMED rather than counted (for a small fleet a
  // name is strictly more actionable than a number), capped like the wait-graph. Painted
  // cyan — the operator/"you" accent (ties to the › cursor + column headers): not red
  // (not trouble), not dim (it IS actionable, unlike nominal/stalled). When there's no
  // trouble it REPLACES "✓ nominal" — you're not "nothing to see" if someone needs you.
  const awaiting = s.agents.filter((a) => a.awaiting_human);
  if (awaiting.length > 0) {
    const { byShortId } = computeAgentLabels(s.agents);
    const names = awaiting.map((a) => byShortId.get(a.short_id) ?? a.short_id);
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? ` +${names.length - 3} more` : "";
    segs.push(paint(`🙋 awaiting you: ${shown}${more}`, C.cyan));
  }
  if (segs.length === 0) {
    return paint(`  ✓ fleet nominal · ${t.active} active`, C.dim);
  }
  return paint("  attention:", C.bold) + " " + segs.join(paint(" · ", C.dim));
}

const ID_W = 14;
const TYPE_W = 7;
const STATUS_W = 13;

function agentLabel(t: string): string {
  // claude-code → claude; codex → codex; unknown → "?"
  if (t === "claude-code") return "claude";
  if (t === "unknown") return "?";
  return t;
}

function renderAgentRow(
  a: FleetAgent,
  i: number,
  paint: Paint,
  width: number,
  selected: number,
  label: string,
  labels: Map<string, string>,
  paneAct: PaneActivity | undefined,
  act: AgentActivity | null, // resolved tool sub-state (overlay-aware)
  burstFrame: number | undefined, // this row's one-shot burst frame (TUI), else static
): string {
  const marker = i === selected ? paint("›", C.cyan, C.bold) : " ";
  const glyph = GLYPH[a.liveness];
  const idText = label + (a.is_self ? "*" : "");
  // Selection emphasis is confined to the AGENT column (David): a soft gray bg chip +
  // a one-space indent on each side of the name (no underline). The rest of the row
  // renders exactly as an unselected one. paint() drops the codes in no-color mode, so
  // the › marker alone carries the cue there.
  let id: string;
  if (burstFrame !== undefined || i === selected) {
    // Selected OR mid-burst: the name sits in a FRAMED cell. The frame glyph cycles
    // while a burst is playing; otherwise it's a SPACE on each side — the "space-width
    // indent" that holds the name in the SAME spot whether or not it's bursting (no
    // jitter), and no underline (David). The selected row carries the soft bg chip; an
    // un-selected burst is just a brief cyan flourish.
    const [lb, rb] = burstFrame !== undefined ? nameFrame(burstFrame) : [" ", " "];
    const inner = clip(idText, ID_W - 2); // 2 cols reserved for the frame pair
    const framed = `${lb}${inner}${rb}`;
    const pad = " ".repeat(Math.max(0, ID_W - displayWidth(framed)));
    const codes =
      i === selected ? [SELECT_BG, ...(a.is_self ? [C.bold] : [])] : [C.cyan, ...(a.is_self ? [C.bold] : [])];
    id = paint(framed + pad, ...codes);
  } else {
    id = paint(cell(idText, ID_W), a.is_self ? C.bold : C.reset);
  }
  const type = paint(cell(agentLabel(a.client_type), TYPE_W), C.dim);
  const status = paint(cell(statusText(a), STATUS_W), livenessColor(a.liveness));
  const b = badges(a, paint, labels, act);

  // Fixed prefix visible width: marker(1) sp glyph(2) sp id sp type sp status sp
  const prefixLen = 1 + 1 + 2 + 1 + ID_W + 1 + TYPE_W + 1 + STATUS_W + 1;
  let line = `${marker} ${glyph} ${id} ${type} ${status} ${b.text}`;

  // Trailing detail, clipped to remaining width. A LIVE pane line (the spinner /
  // "working…") beats the self-reported purpose — observed > declared. Falls back to
  // the purpose caption (grayed when stale) when there's no live capture.
  let detailText: string | null = null;
  let detailColor: string = C.dim;
  if (paneAct?.pane_tail) {
    detailText = paneAct.pane_tail;
    detailColor = C.cyan;
  } else if (paneAct?.pane_busy) {
    detailText = "working…";
    detailColor = C.cyan;
  } else if (a.purpose) {
    // purpose is UNTRUSTED peer text (set_my_state, arbitrary ≤200 chars). Scrub the
    // ESC/C0/C1/bidi injection vector before it reaches the operator's terminal —
    // the same bar as captured pane text (codex). clip() only collapses whitespace.
    detailText = scrubBufferText(a.purpose, false);
    detailColor = a.purpose_stale ? C.gray : C.dim;
  }
  if (detailText) {
    const used = prefixLen + b.len + (b.len > 0 ? 1 : 0);
    const remaining = width - used - 2;
    if (remaining >= 6) {
      line += "  " + paint(clip(detailText, remaining), detailColor);
    }
  }
  return line;
}

function renderWaitGraph(
  s: FleetSnapshot,
  paint: Paint,
  labels: Map<string, string>, // short_id → display label
  maxWaitRows?: number,
): string[] {
  const waiters = s.agents.filter((a) => a.waiting);
  if (waiters.length === 0 && s.cycles.length === 0) return [];
  const lbl = (shortId: string): string => labels.get(shortId) ?? shortId;
  const body: string[] = [];
  for (const c of s.cycles) {
    const named = c.members.map(lbl);
    const chain = named.concat(named[0] ?? "").join(" → ");
    // Only a cycle whose members are ALL alive is a credible deadlock; a stale
    // cycle (a member exited / ask aged toward the 1h GC) is shown as "possible"
    // so the cockpit never cries a false DEADLOCK (max H1).
    if (c.all_live) {
      body.push("  " + paint(`⛔ DEADLOCK: ${chain}`, C.red, C.bold));
    } else {
      body.push("  " + paint(`⚠ possible wait cycle (stale): ${chain}`, C.yellow));
    }
  }
  for (const a of waiters) {
    if (a.waiting!.in_cycle) continue; // shown in the cycle line above
    const who = lbl(a.short_id);
    const tgt = a.waiting!.target_short_id ? lbl(a.waiting!.target_short_id) : "?";
    const age = fmtAge(a.waiting!.age_s);
    if (a.waiting!.orphaned) {
      body.push(
        "  " + paint(`⛔ ${who} awaiting reply from ${tgt} (${age}) — target is dead`, C.red),
      );
    } else if (a.waiting!.target_short_id) {
      body.push("  " + paint(`⏳ ${who} awaiting reply from ${tgt} (${age})`, C.yellow));
    } else {
      body.push("  " + paint(`⏳ ${who} awaiting reply (${age}, peer unresolved)`, C.yellow));
    }
  }
  const out: string[] = ["", paint("wait-graph", C.bold)];
  const cap = maxWaitRows && maxWaitRows > 0 ? maxWaitRows : body.length;
  if (body.length <= cap) {
    out.push(...body);
  } else {
    out.push(...body.slice(0, cap));
    out.push("  " + paint(`⋯ ${body.length - cap} more waits`, C.dim));
  }
  return out;
}

// Human-facing labels for a fleet, shared by every renderer so an agent reads the
// same everywhere. Label = the agent's tmux window name when present and unique;
// collisions (or auto-named windows like "node") disambiguate with the short id;
// no window name falls back to the short id. Returned keyed by both short_id (table
// rows, wait-graph, badges) and session_id (comms-log from/to).
export function computeAgentLabels(agents: ReadonlyArray<FleetAgent>): {
  byShortId: Map<string, string>;
  bySession: Map<string, string>;
} {
  // window_name is UNTRUSTED — a tmux window name is arbitrary bytes (ESC/C0/newline/
  // bidi/zero-width). Scrub it ONCE here at the label boundary so EVERY consumer — table
  // rows, the wait-graph, comms from/to, AND the new 🙋 worklist — renders the same
  // terminal-safe label and the collision count keys on the scrubbed form (codex MEDIUM:
  // ddbbafa added a prominent new top-line path for these labels). A name that scrubs to
  // empty falls back to the short_id. clip/cell/clipToWidth downstream remain the width
  // backstop; full 1-col sanitizeCaptured would over-strip legitimate non-ASCII names.
  const safeName = (a: FleetAgent): string | null =>
    a.window_name ? scrubBufferText(a.window_name, false).trim() || null : null;
  const nameCount = new Map<string, number>();
  for (const a of agents) {
    const wn = safeName(a);
    if (wn) nameCount.set(wn, (nameCount.get(wn) ?? 0) + 1);
  }
  const byShortId = new Map<string, string>();
  const bySession = new Map<string, string>();
  for (const a of agents) {
    const wn = safeName(a);
    const l =
      wn && nameCount.get(wn) === 1
        ? wn
        : wn
          ? `${wn}·${a.short_id.slice(0, 4)}`
          : a.short_id;
    byShortId.set(a.short_id, l);
    if (a.session_id) bySession.set(a.session_id, l);
  }
  return { byShortId, bySession };
}

export type CommsRenderOptions = RenderOptions & {
  nowSec?: number; // for relative ages; defaults to the wall clock
  expandedId?: string; // message_id to render with its FULL body (single expand)
  full?: boolean; // render EVERY message's body word-wrapped (TUI `w` toggle)
  cursorId?: string; // message_id to mark with a › cursor + brightened head (TUI nav)
};

// The per-message comms lines (NO header). Each message is one snippet line by
// default; FULL (head line + word-wrapped body) when opts.full or its id matches
// opts.expandedId. Every line is width-clipped (ANSI-aware) so none wraps the
// terminal. Returned as a line array so the TUI can line-window/scroll it.
export function commsBodyLines(
  messages: ReadonlyArray<CommsMessage>,
  bySession: Map<string, string>,
  opts: CommsRenderOptions = {},
): string[] {
  const color = opts.color ?? false;
  const width = Math.max(40, opts.width ?? 100);
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const paint = makePaint(color);
  const name = (sid: string): string => bySession.get(sid) ?? sid.slice(0, 8);
  // null sender is "operator" ONLY when origin says so (a human cockpit send), else
  // "unknown" (unclaimed/anon peer) — origin is the discriminator (codex review #3).
  const fromLabel = (m: CommsMessage): string =>
    m.from_session_id ? name(m.from_session_id) : m.origin === "operator" ? "operator" : "unknown";

  const out: string[] = [];
  for (const m of messages) {
    const age = fmtAge(Math.max(0, nowSec - m.at));
    let mark = "";
    if (m.action_required) mark = m.closed === "done" ? "⚑✓" : m.closed === "blocked" ? "⚑✗" : "⚑";
    else if (m.reply_to) mark = "↩";
    else if (m.request_id) mark = "❓";
    const markStr = mark ? ` ${mark}` : "";
    // Operator messages are ONE-WAY directives from the human cockpit (no agent
    // identity, can't be replied to) — render them with a ⇒ arrow so they read as a
    // directive-in, not a missing half of a two-way exchange (the recipient never
    // sends back an "agent→operator").
    const isOperator = m.from_session_id == null && m.origin === "operator";
    // → (U+2192) and ⇒ (U+21D2) are EAW-Ambiguous (also the wait-graph chain join +
    // the TUI compose marker). KEPT AS-IS BY DELIBERATE CHOICE (David, 2026-06-17):
    // they're flawless 1-col on a US terminal and there is no clean 1-col Neutral arrow
    // (the alternatives are long ⟶/⟹, decorated ↦, or the emoji-presentation dingbat
    // arrows ➜➝ that render 2-col). The residual is CJK-portability only — do NOT
    // "fix" these to chase the audit; it was weighed and declined.
    const arrow = isOperator ? "⇒" : "→";
    // The cursor'd message (TUI nav) gets a › marker in place of the leading space +
    // a brightened (non-dim) head so the eye lands on the selected message.
    const isCursor = opts.cursorId != null && m.message_id === opts.cursorId;
    const head = `${isCursor ? "›" : " "} ${cell(age, 4)} ${fromLabel(m)} ${arrow} ${name(m.to_session_id)}${markStr}: `;
    // The agent↔agent traffic is the interesting part, so operator directives are
    // SHADED (grey head + grey preview) to recede — the peer messages stay full
    // brightness and stand out. The cursor'd message always brightens (you're reading
    // it). (head dim / body full = the default peer look.)
    const headCodes: string[] = isCursor ? [C.cyan, C.bold] : isOperator ? [C.gray] : [C.dim];
    // Message bodies are UNTRUSTED peer text — scrub the ESC/C0/C1/bidi injection
    // vector before render (clip/clipToWidth only handle whitespace + width).
    const safeBody = scrubBufferText(m.body, false);
    if (opts.full || m.message_id === opts.expandedId) {
      const body = safeBody.replace(/\s+/g, " ").trim();
      out.push(clipToWidth(paint(head, ...headCodes), width));
      for (const seg of wrap(body, width - 4)) out.push(clipToWidth("    " + seg, width));
    } else {
      const remaining = width - head.length - 1;
      const snippet = remaining >= 8 ? clip(safeBody, remaining) : "";
      // Shade the operator preview too (so the whole directive line recedes); a peer
      // body stays default-bright; the cursor'd row reads as selected.
      const snip = isOperator && !isCursor ? paint(snippet, C.gray) : snippet;
      out.push(clipToWidth(paint(head, ...headCodes) + snip, width));
    }
  }
  return out;
}

// Render the comms-log feed (oldest→newest): header + body lines. (`oxtail status
// --log`; the TUI uses commsBodyLines directly so it can line-window/scroll.)
export function renderCommsLog(
  messages: ReadonlyArray<CommsMessage>,
  bySession: Map<string, string>,
  opts: CommsRenderOptions = {},
): string {
  const color = opts.color ?? false;
  const width = Math.max(40, opts.width ?? 100);
  const paint = makePaint(color);
  const header = clipToWidth(
    paint("comms", C.bold) + paint("  recent message tail (not a full audit log)", C.dim),
    width,
  );
  if (messages.length === 0) {
    return [
      header,
      clipToWidth(paint("  no inter-agent messages in ledgers yet", C.dim), width),
    ].join("\n");
  }
  return [header, ...commsBodyLines(messages, bySession, opts)].join("\n");
}

// Greedy word-wrap to `w` columns (full-body expand). Falls back to hard slices for
// a single over-long token.
function wrap(s: string, w: number): string[] {
  if (w <= 0) return [s];
  const out: string[] = [];
  let line = "";
  for (const word of s.split(" ")) {
    if (word.length > w) {
      if (line) {
        out.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += w) out.push(word.slice(i, i + w));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= w) line += " " + word;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [""];
}

// One row in the expanded "background" section: a detached process you can SEE but
// not drive from the cockpit. Deliberately DISTINCT from a fleet row — extra indent, a
// dim `·` marker instead of the liveness glyph + › cursor, and the whole line dimmed —
// so it never reads as a navigable fleet member. Shows identity + status + the real
// server pid (so "is this real?" is answerable) and any unread/open-work it still holds.
function renderBackgroundRow(a: FleetAgent, paint: Paint, label: string): string {
  const id = cell(label, ID_W);
  const type = cell(agentLabel(a.client_type), TYPE_W);
  const status = cell(statusText(a), STATUS_W);
  const bits = [`pid ${a.server_pid}`];
  if (a.unread > 0) bits.push(`✉${a.unread}`);
  if (a.open_work > 0) bits.push(`⚑${a.open_work}`);
  return paint(`     · ${id} ${type} ${status} ${bits.join("  ")}`, C.dim);
}

// Render the full snapshot to a string. `selected` highlights a TUI row.
export function renderSnapshot(s: FleetSnapshot, opts: RenderOptions = {}): string {
  const color = opts.color ?? false;
  const width = Math.max(40, opts.width ?? 100);
  const selected = opts.selected ?? -1;
  const paint = makePaint(color);
  const lines: string[] = [];

  // Header.
  const projName = s.project_root.split("/").filter(Boolean).pop() ?? s.project_root;
  const active = s.agents.filter((a) => a.liveness === "active").length;
  // A live ⛔ condition (deadlock or orphaned wait) tints the title red — a
  // peripheral cue that registers before the operator reads the attention line.
  const alarm = s.cycles.some((c) => c.all_live) || s.agents.some((a) => a.waiting?.orphaned);
  const background = s.background ?? [];
  const head =
    paint("oxpit", C.bold, alarm ? C.red : C.cyan) +
    paint(`  ${projName}`, C.dim) +
    `  ${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}` +
    paint(` (${active} active)`, C.green) +
    (background.length > 0 ? paint(`  +${background.length} bg`, C.dim) : "");
  lines.push(head);

  // Top attention line — only present when the fleet has trouble worth a glance.
  const attn = attentionLine(s, paint);
  if (attn) lines.push(attn);

  // Labels over foreground + background so a wait-graph target or comms peer that got
  // collapsed into the background still resolves to its window name, not a bare hex id.
  const { byShortId: labels } = computeAgentLabels([...s.agents, ...background]);
  const rowLabel = (a: FleetAgent): string => labels.get(a.short_id) ?? a.short_id;
  const paneAct = (a: FleetAgent): PaneActivity | undefined => opts.paneActivity?.get(agentKey(a));
  // Resolve the tool sub-state: when the overlay HAS the key it wins (an explicit
  // null = "known to have no tool" genuinely suppresses, matching the contract);
  // otherwise fall back to the snapshot's own activity.
  const resolveAct = (a: FleetAgent): AgentActivity | null => {
    const m = opts.toolActivity;
    if (m) {
      const k = agentKey(a);
      if (m.has(k)) return m.get(k) ?? null;
    }
    return a.activity;
  };

  if (s.agents.length === 0) {
    lines.push(paint("  no agents registered in this project scope", C.dim));
  } else {
    // Column header.
    lines.push(
      paint(
        `  ${"   "}${cell("agent", ID_W)} ${cell("type", TYPE_W)} ${cell("status", STATUS_W)} work / purpose`,
        C.dim,
      ),
    );
    const total = s.agents.length;
    const cap = opts.maxAgentRows && opts.maxAgentRows > 0 ? opts.maxAgentRows : total;
    if (total <= cap) {
      for (let i = 0; i < total; i++) {
        const a = s.agents[i];
        lines.push(renderAgentRow(a, i, paint, width, selected, rowLabel(a), labels, paneAct(a), resolveAct(a), opts.burstFrames?.get(agentKey(a))));
      }
    } else {
      // Window that always keeps the selected row visible (centered when possible).
      const sel = selected >= 0 ? selected : 0;
      const start = Math.max(0, Math.min(sel - Math.floor(cap / 2), total - cap));
      const end = start + cap;
      if (start > 0) lines.push(paint(`  ⋯ ${start} more above`, C.dim));
      for (let i = start; i < end; i++) {
        const a = s.agents[i];
        lines.push(renderAgentRow(a, i, paint, width, selected, rowLabel(a), labels, paneAct(a), resolveAct(a), opts.burstFrames?.get(agentKey(a))));
      }
      if (end < total) lines.push(paint(`  ⋯ ${total - end} more below`, C.dim));
    }
  }

  // Detached background processes get their OWN section below the fleet — distinct from
  // the real, jumpable windows. Collapsed by default to a count header; the TUI's `b`
  // expands it to the individual (dim) rows so they stay inspectable ("are these real?")
  // without ever cluttering the navigable list. Count is also echoed in the header.
  if (background.length > 0) {
    const n = background.length;
    const noun = n === 1 ? "process" : "processes";
    const desc = `${n} background ${noun} (detached — no tmux pane, not jumpable)`;
    if (opts.showBackground) {
      lines.push(paint(`  ▾ ${desc} · b to hide`, C.dim));
      for (const a of background.slice(0, BACKGROUND_ROW_CAP)) {
        lines.push(renderBackgroundRow(a, paint, rowLabel(a)));
      }
      if (n > BACKGROUND_ROW_CAP) lines.push(paint(`     ⋯ ${n - BACKGROUND_ROW_CAP} more`, C.dim));
    } else {
      lines.push(paint(`  ▸ ${desc} · b to show`, C.dim));
    }
  }

  lines.push(...renderWaitGraph(s, paint, labels, opts.maxWaitRows));

  for (const w of s.warnings) {
    lines.push(paint(`  ⚠ ${w}`, C.yellow));
  }

  // Clip EVERY line to the terminal width so nothing wraps — an over-width line
  // would wrap to a second physical row and desync the TUI's cursor-home repaint
  // (and just looks broken in one-shot mode). ANSI-aware (max M3).
  return lines.map((l) => clipToWidth(l, width)).join("\n");
}

// ── DOCK mode ────────────────────────────────────────────────────────────────
// A compact, one-line-per-agent render for a SHORT bottom tmux pane — David's
// "oxpit as a navigation dock" idea. Same liveness / status / badge TRUTH as
// renderSnapshot (it reuses the very same helpers), but drops the table chrome,
// the wait-graph block, the background section, and the multi-line purpose so a
// header + ~6 agents + a footer fit in ~8-10 rows. Jump/message keys still drive
// it — this is a denser VIEW, not a different data path.
const DOCK_NAME_W = 8;
const DOCK_STATUS_W = 13;

// One-line fleet header: liveness counts + the operator signal a dock exists for
// (🙋 who's awaiting YOU) + any hard trouble. A clean fleet still shows ✓ so the
// absence of alarms reads as "checked & fine", matching attentionLine's posture.
function dockHeader(s: FleetSnapshot, paint: Paint, width: number): string {
  const t = fleetTrouble(s);
  const idle = s.agents.filter((a) => a.liveness === "idle").length;
  const dead = s.agents.filter((a) => a.liveness === "dead").length;
  const counts: string[] = [];
  if (t.active) counts.push(paint(`${GLYPH.active}${t.active}`, C.green));
  if (idle) counts.push(paint(`${GLYPH.idle}${idle}`, C.yellow));
  if (dead) counts.push(paint(`${GLYPH.dead}${dead}`, C.gray));
  const segs: string[] = [paint("oxpit", C.cyan, C.bold)];
  if (counts.length) segs.push(counts.join(" "));
  if (t.awaiting) segs.push(paint(`🙋${t.awaiting} awaiting you`, C.yellow, C.bold));
  if (t.deadlocks) segs.push(paint(`⛔${t.deadlocks} deadlock`, C.red, C.bold));
  if (t.orphaned) segs.push(paint(`⛔${t.orphaned} orphaned`, C.red, C.bold));
  if (t.stranded) segs.push(paint(`⚑${t.stranded} stranded`, C.red));
  if (!t.awaiting && !t.deadlocks && !t.orphaned && !t.stranded) segs.push(paint("✓", C.dim));
  return clipToWidth(segs.join(paint(" · ", C.dim)), width);
}

export function renderDock(s: FleetSnapshot, opts: RenderOptions = {}): string {
  const color = opts.color ?? true;
  const width = opts.width ?? 80;
  const paint = makePaint(color);
  if (s.agents.length === 0) {
    return [
      dockHeader(s, paint, width),
      clipToWidth(paint("  no agents in this project yet", C.dim), width),
    ].join("\n");
  }
  const labels = computeAgentLabels(s.agents).byShortId;
  const sel = opts.selected ?? -1;
  const lines: string[] = [dockHeader(s, paint, width)];
  const rowFor = (a: FleetSnapshot["agents"][number], i: number): string => {
    const k = agentKey(a);
    const act = opts.toolActivity?.has(k) ? opts.toolActivity.get(k) ?? null : a.activity;
    const b = badges(a, paint, labels, act);
    const name = labels.get(a.short_id) ?? a.short_id;
    const selected = i === sel;
    const marker = selected ? paint("›", C.cyan, C.bold) : " ";
    const nameCell =
      selected && color
        ? `${SELECT_BG}${cell(name, DOCK_NAME_W)}${C.reset}`
        : cell(name, DOCK_NAME_W);
    const status = paint(cell(statusText(a), DOCK_STATUS_W), livenessColor(a.liveness));
    const self = a.is_self ? paint("◂you", C.dim) : "";
    return clipToWidth(`${marker}${GLYPH[a.liveness]} ${nameCell} ${status} ${b.text} ${self}`.trimEnd(), width);
  };
  // Window the agent rows to the pane budget (maxAgentRows) so a fleet taller than a
  // short dock pane shows a "⋯ N more" marker instead of silently truncating off the
  // bottom — the same idiom as the full table. windowWithMarkers reserves the marker
  // rows WITHIN the budget, so header + this section + footer never exceeds the pane and
  // the footer (which carries dockStatus confirms) is never the line that gets clipped.
  const total = s.agents.length;
  const cap = opts.maxAgentRows && opts.maxAgentRows > 0 ? opts.maxAgentRows : total;
  const { start, end, above, below } = windowWithMarkers(total, sel >= 0 ? sel : 0, cap);
  if (above > 0) lines.push(clipToWidth(paint(`  ⋯ ${above} more above`, C.dim), width));
  for (let i = start; i < end; i++) lines.push(rowFor(s.agents[i], i));
  if (below > 0) lines.push(clipToWidth(paint(`  ⋯ ${below} more below`, C.dim), width));
  // The footer is the dock's only seam for transient feedback: when the TUI hands us a
  // status/confirm line, show it INSTEAD of the key hints (it expires back to the hints
  // on the next tick) so "press y"/"press K again" prompts aren't invisible in the strip.
  lines.push(
    opts.dockStatus
      ? clipToWidth("  " + opts.dockStatus, width)
      : clipToWidth(
          paint(
            `  ⏎ jump${opts.flipHint ? " · ⌃] flip" : ""} · m msg · n nudge · l log · d full · ⌃C quit`,
            C.dim,
          ),
          width,
        ),
  );
  return lines.join("\n");
}

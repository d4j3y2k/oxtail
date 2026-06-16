// oxpit renderer — pure (FleetSnapshot → string). Shared by `oxtail status`
// (one-shot) and the TUI frame body, so what you see live matches what you script.
// Color is injected (gated on TTY / NO_COLOR by the caller), never auto-detected
// here, so tests get deterministic plain output.

import { cell, clip, clipToWidth, displayWidth, fmtAge } from "./format.js";
import type { FleetAgent, FleetSnapshot, Liveness } from "./snapshot.js";
import type { CommsMessage } from "./comms.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
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
};

type Paint = (s: string, ...codes: string[]) => string;

function makePaint(color: boolean): Paint {
  if (!color) return (s) => s;
  return (s, ...codes) => `${codes.join("")}${s}${C.reset}`;
}

// Selected-row emphasis: a soft gray BACKGROUND chip on just the agent-name cell
// (not a full-row reverse bar — that inverted the emoji/badges into harsh blocks).
// 256-color shade; bump it lighter/darker to taste.
const SELECT_BG = "\x1b[48;5;238m";

const GLYPH: Record<Liveness, string> = {
  active: "🟢",
  idle: "🟡",
  dead: "⚫",
};

function livenessColor(l: Liveness): string {
  return l === "active" ? C.green : l === "idle" ? C.yellow : C.gray;
}

// "active 4s" / "idle 3m" / "dead·pid-reused". Raw age always shown — the glyph is
// never the only signal.
function statusText(a: FleetAgent): string {
  if (a.liveness === "dead") {
    return a.liveness_reason === "pid_reused" ? "dead·reused" : "dead·gone";
  }
  if (a.liveness === "active") return `active ${fmtAge(a.transcript_age_s)}`;
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
): { text: string; len: number } {
  const parts: string[] = [];
  let len = 0;
  const add = (raw: string, painted: string) => {
    parts.push(painted);
    len += displayWidth(raw) + 1; // +1 for the joining space; width-aware (emoji=2)
  };
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
  stalled: number; // possibly-stalled agents (soft hint, never an alarm)
  active: number;
};

export function fleetTrouble(s: FleetSnapshot): FleetTrouble {
  const strandedAgents = s.agents.filter((a) => a.liveness === "dead" && a.open_work > 0);
  return {
    deadlocks: s.cycles.filter((c) => c.all_live).length,
    staleCycles: s.cycles.filter((c) => !c.all_live).length,
    orphaned: s.agents.filter((a) => a.waiting?.orphaned).length,
    stranded: strandedAgents.reduce((n, a) => n + a.open_work, 0),
    strandedOwners: strandedAgents.length,
    stalled: s.agents.filter((a) => a.possibly_stalled).length,
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
  if (t.staleCycles)
    segs.push(paint(`⚠ ${t.staleCycles} possible ${plural(t.staleCycles, "cycle")}`, C.yellow));
  if (t.stalled) segs.push(paint(`⚠ ${t.stalled} possibly stalled`, C.dim));
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
): string {
  const marker = i === selected ? paint("›", C.cyan, C.bold) : " ";
  const glyph = GLYPH[a.liveness];
  const idText = label + (a.is_self ? "*" : "");
  // Selection emphasis is confined to the AGENT column (David): a soft gray bg chip
  // across just the padded name cell. The rest of the row renders exactly as an
  // unselected one. paint() drops the codes in no-color mode, so the ❯/› marker
  // alone carries the cue there.
  const idCell = cell(idText, ID_W);
  const id =
    i === selected
      ? paint(idCell, SELECT_BG, ...(a.is_self ? [C.bold] : []))
      : paint(idCell, a.is_self ? C.bold : C.reset);
  const type = paint(cell(agentLabel(a.client_type), TYPE_W), C.dim);
  const status = paint(cell(statusText(a), STATUS_W), livenessColor(a.liveness));
  const b = badges(a, paint, labels);

  // Fixed prefix visible width: marker(1) sp glyph(2) sp id sp type sp status sp
  const prefixLen = 1 + 1 + 2 + 1 + ID_W + 1 + TYPE_W + 1 + STATUS_W + 1;
  let line = `${marker} ${glyph} ${id} ${type} ${status} ${b.text}`;

  // Trailing purpose caption, clipped to remaining width. Grayed when stale.
  if (a.purpose) {
    const used = prefixLen + b.len + (b.len > 0 ? 1 : 0);
    const remaining = width - used - 2;
    if (remaining >= 6) {
      const cap = clip(a.purpose, remaining);
      line += "  " + paint(cap, a.purpose_stale ? C.gray : C.dim);
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
  const nameCount = new Map<string, number>();
  for (const a of agents) {
    if (a.window_name) nameCount.set(a.window_name, (nameCount.get(a.window_name) ?? 0) + 1);
  }
  const byShortId = new Map<string, string>();
  const bySession = new Map<string, string>();
  for (const a of agents) {
    const l =
      a.window_name && nameCount.get(a.window_name) === 1
        ? a.window_name
        : a.window_name
          ? `${a.window_name}·${a.short_id.slice(0, 4)}`
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
    const head = `  ${cell(age, 4)} ${fromLabel(m)} → ${name(m.to_session_id)}${markStr}: `;
    if (opts.full || m.message_id === opts.expandedId) {
      const body = m.body.replace(/\s+/g, " ").trim();
      out.push(clipToWidth(paint(head, C.dim), width));
      for (const seg of wrap(body, width - 4)) out.push(clipToWidth("    " + seg, width));
    } else {
      const remaining = width - head.length - 1;
      const snippet = remaining >= 8 ? clip(m.body, remaining) : "";
      out.push(clipToWidth(paint(head, C.dim) + snippet, width));
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
  const head =
    paint("oxpit", C.bold, alarm ? C.red : C.cyan) +
    paint(`  ${projName}`, C.dim) +
    `  ${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}` +
    paint(` (${active} active)`, C.green);
  lines.push(head);

  // Top attention line — only present when the fleet has trouble worth a glance.
  const attn = attentionLine(s, paint);
  if (attn) lines.push(attn);

  const { byShortId: labels } = computeAgentLabels(s.agents);
  const rowLabel = (a: FleetAgent): string => labels.get(a.short_id) ?? a.short_id;

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
        lines.push(renderAgentRow(s.agents[i], i, paint, width, selected, rowLabel(s.agents[i]), labels));
      }
    } else {
      // Window that always keeps the selected row visible (centered when possible).
      const sel = selected >= 0 ? selected : 0;
      const start = Math.max(0, Math.min(sel - Math.floor(cap / 2), total - cap));
      const end = start + cap;
      if (start > 0) lines.push(paint(`  ⋯ ${start} more above`, C.dim));
      for (let i = start; i < end; i++) {
        lines.push(renderAgentRow(s.agents[i], i, paint, width, selected, rowLabel(s.agents[i]), labels));
      }
      if (end < total) lines.push(paint(`  ⋯ ${total - end} more below`, C.dim));
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

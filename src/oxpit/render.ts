// oxpit renderer — pure (FleetSnapshot → string). Shared by `oxtail status`
// (one-shot) and the TUI frame body, so what you see live matches what you script.
// Color is injected (gated on TTY / NO_COLOR by the caller), never auto-detected
// here, so tests get deterministic plain output.

import { cell, clip, clipToWidth, displayWidth, fmtAge } from "./format.js";
import type { FleetAgent, FleetSnapshot, Liveness } from "./snapshot.js";

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
function badges(a: FleetAgent, paint: Paint): { text: string; len: number } {
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
    const tgt = w.target_short_id ?? "?";
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

const ID_W = 9;
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
): string {
  const marker = i === selected ? paint("›", C.cyan, C.bold) : " ";
  const glyph = GLYPH[a.liveness];
  const idText = a.short_id + (a.is_self ? "*" : "");
  const id = paint(cell(idText, ID_W), a.is_self ? C.bold : C.reset);
  const type = paint(cell(agentLabel(a.client_type), TYPE_W), C.dim);
  const status = paint(cell(statusText(a), STATUS_W), livenessColor(a.liveness));
  const b = badges(a, paint);

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

function renderWaitGraph(s: FleetSnapshot, paint: Paint, maxWaitRows?: number): string[] {
  const waiters = s.agents.filter((a) => a.waiting);
  if (waiters.length === 0 && s.cycles.length === 0) return [];
  const body: string[] = [];
  for (const c of s.cycles) {
    const chain = c.members.concat(c.members[0] ?? "").join(" → ");
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
    const tgt = a.waiting!.target_short_id ?? "?";
    const age = fmtAge(a.waiting!.age_s);
    if (a.waiting!.orphaned) {
      body.push(
        "  " + paint(`⛔ ${a.short_id} awaiting reply from ${tgt} (${age}) — target is dead`, C.red),
      );
    } else if (a.waiting!.target_short_id) {
      body.push("  " + paint(`⏳ ${a.short_id} awaiting reply from ${tgt} (${age})`, C.yellow));
    } else {
      body.push("  " + paint(`⏳ ${a.short_id} awaiting reply (${age}, peer unresolved)`, C.yellow));
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
  const head =
    paint("oxpit", C.bold, C.cyan) +
    paint(`  ${projName}`, C.dim) +
    `  ${s.agents.length} agent${s.agents.length === 1 ? "" : "s"}` +
    paint(` (${active} active)`, C.green);
  lines.push(head);

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
        lines.push(renderAgentRow(s.agents[i], i, paint, width, selected));
      }
    } else {
      // Window that always keeps the selected row visible (centered when possible).
      const sel = selected >= 0 ? selected : 0;
      const start = Math.max(0, Math.min(sel - Math.floor(cap / 2), total - cap));
      const end = start + cap;
      if (start > 0) lines.push(paint(`  ⋯ ${start} more above`, C.dim));
      for (let i = start; i < end; i++) {
        lines.push(renderAgentRow(s.agents[i], i, paint, width, selected));
      }
      if (end < total) lines.push(paint(`  ⋯ ${total - end} more below`, C.dim));
    }
  }

  lines.push(...renderWaitGraph(s, paint, opts.maxWaitRows));

  for (const w of s.warnings) {
    lines.push(paint(`  ⚠ ${w}`, C.yellow));
  }

  // Clip EVERY line to the terminal width so nothing wraps — an over-width line
  // would wrap to a second physical row and desync the TUI's cursor-home repaint
  // (and just looks broken in one-shot mode). ANSI-aware (max M3).
  return lines.map((l) => clipToWidth(l, width)).join("\n");
}

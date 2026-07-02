// oxpit activity — the real-time "what is each agent doing NOW" layer.
//
// TWO COST CLASSES (max's B2 re-cut — by exec-vs-read, not display-vs-liveness):
//   • READ class (this file's Slice-1 surface): scanLatestTool() reads the BOUNDED
//     tail of a transcript and returns the latest tool the agent invoked + whether
//     it is still running. Same cost class as the per-agent statSync buildSnapshot
//     already does, so it folds INTO the snapshot under a flag. Structured + version-
//     stable — the ROBUST sub-state signal (vs fragile terminal chrome).
//   • EXEC class (Slice 2, added later): capture-pane — the only process fork — for
//     the live pane bottom-line. Selected-row only, pane re-verified before capture.
//
// VIEW discipline: read-only + lock-free; the result is a DISPLAY HINT, never
// authority over liveness. We RIDE the canonical reverse-tail reader
// (transcripts.scanTailLines) — no second byte reader, no hand-rolled openSync,
// and the backward chunk-scan stopping at the first tool call IS a geometric
// expansion (a huge tool output can't hide the preceding call). No tool found
// before the line cap / BOF ⇒ null (honest unknown, never a faked "idle").

import type { ClientType } from "../clients.js";
import { scanTailLines } from "../transcripts.js";
import { chooseVerifiedWakePane, readAllPassive, type RegistryEntry } from "../registry.js";
import { freshEntry, realTmux, type TmuxRunner } from "./jump.js";
import { sanitizeCaptured } from "./format.js";

// Normalized tool family. The badge maps this → glyph/color in render.ts; the raw
// name is kept for unknown tools + debugging.
export type ToolKind =
  | "oxtail"
  | "bash"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "task"
  | "plan"
  | "tool";

// The read-class activity attached to a FleetAgent (the per-row tool badge).
export type AgentActivity = {
  tool: ToolKind;
  tool_raw: string; // namespace-joined raw name (e.g. "mcp__oxtail.read_my_messages")
  tool_running: boolean; // latest tool call has no matching result yet ⇒ in-flight
};

// Stable identity key for an agent across snapshot rebuilds — session_id when
// claimed, else the server pid. Shared by the snapshot, the renderer, the TUI's
// sticky selection, and the activity caches so a key never means two things.
export function agentKey(a: { session_id: string | null; server_pid: number }): string {
  return a.session_id ?? `pid:${a.server_pid}`;
}

// Backstops on the newest-first scan before giving up (→ honest null). The latest
// tool call is almost always within the last handful of lines; these only bound the
// pathological "huge transcript with no recent tool" case. BOTH a line cap and a
// byte cap (the generic reverse reader is otherwise unbounded once maxBytes-less).
const MAX_SCAN_LINES = 2000;
const MAX_SCAN_BYTES = 512 * 1024;

const OXTAIL_VERBS = new Set([
  "claim_session",
  "register_my_session",
  "get_my_session",
  "list_project_sessions",
  "read_session",
  "send_message",
  "reply_to_message",
  "ask_peer",
  "read_my_messages",
  "set_my_state",
  "message_status",
  "my_open_work",
  "complete_work",
  "block_work",
]);

// Map a raw tool name (Claude `tool_use.name` like "Bash"/"mcp__oxtail__ask_peer",
// or Codex `namespace.name` like "mcp__oxtail.read_my_messages"/"exec_command")
// onto a small, trustworthy family set. oxtail is checked FIRST so an oxtail verb
// is never mis-bucketed by a substring (e.g. read_session → oxtail, not read);
// plan/task before edit/read so "TodoWrite" doesn't fall into "write"→edit.
export function normalizeTool(raw: string): ToolKind {
  const n = raw.toLowerCase();
  if (n.includes("oxtail") || OXTAIL_VERBS.has(n)) return "oxtail";
  if (/(update_plan|todo|\bplan\b)/.test(n)) return "plan";
  if (/(task|subagent|dispatch|spawn)/.test(n)) return "task";
  if (/(web|fetch|url|http|browser|navigate)/.test(n)) return "web";
  if (/(grep|glob|search|find|ripgrep|codebase|list_dir)/.test(n)) return "search";
  if (/(bash|shell|exec|run_command|terminal|local_shell|container)/.test(n)) return "bash";
  if (/(edit|write|apply_patch|str_replace|create_file|insert|notebook)/.test(n)) return "edit";
  if (/(read|cat|view|open_file)/.test(n)) return "read";
  return "tool";
}

// Find the latest tool call in a transcript tail. Rides scanTailLines (newest-first
// reverse chunk walk); collects the newer tool-result/output ids FIRST, then stops
// at the first tool call and reports running = its id has no later result. Returns
// null when no tool call is found within MAX_SCAN_LINES / BOF (honest unknown), or
// the file is unreadable. `scan` is injectable for tests.
export function scanLatestTool(
  path: string,
  clientType: ClientType,
  scan: typeof scanTailLines = scanTailLines,
): AgentActivity | null {
  const isCodex = clientType === "codex";
  const outputIds = new Set<string>();
  let found: { name: string; running: boolean } | null = null;
  let scanned = 0;

  try {
    scan(path, (line) => {
      if (++scanned > MAX_SCAN_LINES) return "stop";
      let o: unknown;
      try {
        o = JSON.parse(line);
      } catch {
        return "continue"; // torn/partial JSON line — skip
      }
      if (isCodex) {
        const rec = o as { type?: string; payload?: Record<string, unknown> };
        if (rec.type !== "response_item" || !rec.payload) return "continue";
        const p = rec.payload;
        if (p.type === "function_call_output") {
          if (typeof p.call_id === "string") outputIds.add(p.call_id);
          return "continue";
        }
        if (p.type === "function_call" && typeof p.name === "string") {
          const ns = typeof p.namespace === "string" && p.namespace ? `${p.namespace}.` : "";
          const id = typeof p.call_id === "string" ? p.call_id : null;
          found = { name: ns + p.name, running: id ? !outputIds.has(id) : true };
          return "stop";
        }
        return "continue";
      }
      // Claude: assistant tool_use / user tool_result both live in message.content.
      const content = (o as { message?: { content?: unknown } })?.message?.content;
      if (!Array.isArray(content)) return "continue";
      for (const it of content) {
        if (it && it.type === "tool_result" && typeof it.tool_use_id === "string") {
          outputIds.add(it.tool_use_id);
        }
      }
      for (let j = content.length - 1; j >= 0; j--) {
        const it = content[j];
        if (it && it.type === "tool_use" && typeof it.name === "string") {
          const id = typeof it.id === "string" ? it.id : null;
          found = { name: it.name, running: id ? !outputIds.has(id) : true };
          return "stop";
        }
      }
      return "continue";
    }, { maxBytes: MAX_SCAN_BYTES });
  } catch {
    return null; // fd/read error — honest unknown
  }

  if (!found) return null;
  const f = found as { name: string; running: boolean };
  return { tool: normalizeTool(f.name), tool_raw: f.name, tool_running: f.running };
}

// ── EXEC class: live pane bottom-line via capture-pane ──────────────────────────
// The only process fork in the activity layer. The agent's CURRENT pane chrome —
// catches the think-before-output window the transcript can't. Fragile (client-
// specific chrome that changes between versions), so it's best-effort: the robust
// core is the binary "esc to interrupt" present/absent; the spinner line is gravy,
// degrading to null (never garbage). Captured text is UNTRUSTED — every line is
// scrubbed + allowlist-sanitized before it can reach the screen or a width budget.

export type PaneActivity = {
  pane_tail: string | null; // the spinner / working line, sanitized; null when unextractable
  pane_busy: boolean; // pane chrome says actively processing ("esc to interrupt")
};

type AgentRef = { session_id: string | null; server_pid: number; client_type: ClientType };

export type CaptureDeps = {
  runTmux?: TmuxRunner;
  // Re-resolve the agent's fresh registry entry (default: jump.freshEntry).
  resolveEntry?: (a: { session_id: string | null; server_pid: number }) => RegistryEntry | null;
  // Verify+resolve the pane that PROVABLY still hosts this agent (default:
  // chooseVerifiedWakePane — proc_sig ok + current-pane-for-pid == target).
  verifyPane?: (e: RegistryEntry) => string | null;
};

// Pull a peer's live pane bottom-line. CRITICAL (codex #1 / max C1, HIGH): never
// capture-pane a stored pane id blind — re-resolve the FRESH registry entry and run
// it through the same proc_sig + current-pane verifier the jump/wake path uses, so a
// recycled pane id can't make us render a STRANGER's terminal as this agent. Returns
// null (no pane shown) on any verification/exec failure — fail closed.
export function capturePaneActivity(agent: AgentRef, deps: CaptureDeps = {}): PaneActivity | null {
  const run = deps.runTmux ?? realTmux;
  // VIEW discipline: re-resolve via readAllPassive (NOT readAll) — a passive capture
  // must never reap dead registry entries as a side effect.
  const resolveEntry = deps.resolveEntry ?? ((a) => freshEntry(a, readAllPassive));
  const verifyPane =
    deps.verifyPane ??
    ((e: RegistryEntry) =>
      // No proc_sig (legacy/unclaimed entry) ⇒ identity unprovable ⇒ refuse. Capture
      // is stricter than wake: a missed capture is a harmless null; a wrong one leaks
      // a stranger's pane (compile-sim/codex — close the fail-open on legacy entries).
      e.proc_sig
        ? chooseVerifiedWakePane({
            tmux_pane: e.tmux_pane,
            server_pid: e.server_pid,
            proc_sig: e.proc_sig,
          })
        : null);

  const entry = resolveEntry(agent);
  if (!entry) return null;
  const pane = verifyPane(entry);
  if (!pane) return null; // recycled / dead / pid-reused / no proc_sig — refuse

  let raw: string;
  try {
    raw = run(["capture-pane", "-p", "-J", "-t", pane]); // -J joins wrapped lines (parity w/ wake)
  } catch {
    return null;
  }

  // TOCTOU guard (codex): the agent could have exited / the pane been repurposed
  // BETWEEN verify and the capture exec. Re-resolve + re-verify; if the pane no
  // longer provably hosts this agent, DISCARD the captured bytes rather than render
  // a stranger's terminal. (Can't stop bytes briefly entering memory, but never
  // displays wrong-pane content.)
  const entry2 = resolveEntry(agent);
  if (!entry2 || verifyPane(entry2) !== pane) return null;

  const lines = raw
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/u, ""))
    .filter((l) => l.length > 0);
  return extractPaneActivity(lines, agent.client_type);
}

// Client-aware extraction from captured pane lines (scanned bottom-up — the spinner
// sits just above the input box, NOT on the last line, which is the persistent mode
// chrome). Robust core = "esc to interrupt" ⇒ busy. Spinner line is best-effort:
//   Claude: "<glyph> Gerund… (2m 2s · ↓ 7.4k tokens)"
//   Codex:  "• Working (38s · esc to interrupt)"
// Anything matched is sanitized (untrusted) → provably 1-column.
export function extractPaneActivity(lines: string[], _clientType: ClientType): PaneActivity {
  const busy = lines.some((l) => /esc to interrupt/i.test(l));
  // Gate the tail on busy (codex): an IDLE pane still showing old text like "Working
  // (notes)" / "Gallivanting… (eg)" would otherwise match and — since renderAgentRow
  // prefers pane_tail over purpose — masquerade as live activity. Only a pane that is
  // actively processing ("esc to interrupt") gets a live tail.
  if (!busy) return { pane_tail: null, pane_busy: false };
  let tail: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Claude spinner: a gerund ending in "…" followed by a parenthetical.
    const g = line.match(/([A-Za-z][A-Za-z'-]*…)\s*(\([^)]*\))/);
    if (g) {
      tail = `${g[1]} ${g[2]}`;
      break;
    }
    // Codex (or Claude) working line: a verb + parenthetical, optional leading bullet.
    const w = line.match(/(?:Working|Thinking|Running|Generating|Processing)\b[^()]*\([^)]*\)/i);
    if (w) {
      tail = w[0].trim();
      break;
    }
  }
  const cleaned = tail ? sanitizeCaptured(tail).trim() : ""; // sanitizeCaptured scrubs first
  return { pane_tail: cleaned ? cleaned : null, pane_busy: true };
}

// Fields capturePaneActivity + the skip rules need — a structural subset of
// FleetAgent so callers pass agents directly without an import cycle.
type CapturableAgent = AgentRef & {
  liveness: "active" | "idle" | "dead";
  tmux_pane: string | null;
  is_self: boolean;
};

// Soft cap on exec-class pane captures in a single `status` pass — a backstop so
// `status --all` across many projects can't fork dozens of capture-panes (max).
export const CAPTURE_FLEET_CAP = 16;

// Project a captured pane-activity map down to the busy signal buildSnapshot needs for
// liveness: agentKey → true where the pane shows "esc to interrupt" (a turn in flight).
// Only truthy entries are kept — an absent key means "not busy" (buildAgent treats a
// missing key as not-busy), so idle/uncaptured agents fall through to the read signals.
export function busyMapFromPanes(panes: Map<string, PaneActivity>): Map<string, boolean> {
  const busy = new Map<string, boolean>();
  for (const [key, pa] of panes) if (pa.pane_busy) busy.set(key, true);
  return busy;
}

// Capture EVERY eligible agent's pane (one exec each, up to CAPTURE_FLEET_CAP) — for
// the one-shot `oxtail status`, where on-demand exec cost is acceptable. The TUI does
// NOT use this (it captures the selected row only). Skips dead (nothing to show),
// is_self (the cockpit's own pane — a hall of mirrors), and pane-less agents. Returns
// a sparse map keyed by agentKey (only agents with something live to show).
export function captureFleetPanes(
  agents: ReadonlyArray<CapturableAgent>,
  deps: CaptureDeps = {},
): Map<string, PaneActivity> {
  const out = new Map<string, PaneActivity>();
  let captured = 0;
  for (const a of agents) {
    if (a.liveness === "dead" || a.is_self || !a.tmux_pane) continue;
    if (captured >= CAPTURE_FLEET_CAP) break; // bound the fork count
    captured++;
    const pa = capturePaneActivity(a, deps);
    if (pa && (pa.pane_tail || pa.pane_busy)) out.set(agentKey(a), pa);
  }
  return out;
}

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

// Safety cap on lines scanned newest-first before giving up. The latest tool call
// is almost always within the last handful of lines; this only bounds the
// pathological "huge transcript with no recent tool" case (→ honest null).
const MAX_SCAN_LINES = 2000;

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
    });
  } catch {
    return null; // fd/read error — honest unknown
  }

  if (!found) return null;
  const f = found as { name: string; running: boolean };
  return { tool: normalizeTool(f.name), tool_raw: f.name, tool_running: f.running };
}

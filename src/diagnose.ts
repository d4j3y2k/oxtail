// Issue #7 — `oxtail diagnose`.
//
// The wake mechanism is environment-sensitive (tmux present? peer in a pane?
// Codex paste-burst gap still sufficient?). When it silently doesn't work, a
// user otherwise has to spelunk MCP_TRACE_FILE by hand. This summarizes the
// `wake_outcome` trace events oxtail emits — counts by wake_status, broken down
// by which tool drove the wake — so "is wake working here?" is one command.

import { readFileSync } from "node:fs";

export type TraceRecord = { event?: string; [k: string]: unknown };

export type WakeOutcomeSummary = {
  total: number;
  considered: number; // wake_outcome events found (before the recency cap)
  byStatus: Record<string, number>;
  byVia: Record<string, Record<string, number>>; // via → status → count
};

// Keep only `wake_outcome` events, newest `limit`, and tally them. Malformed
// JSONL lines are skipped (a trace file can be concurrently appended).
export function summarizeWakeOutcomes(lines: string[], limit = 200): WakeOutcomeSummary {
  const outcomes: TraceRecord[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: TraceRecord;
    try {
      rec = JSON.parse(line) as TraceRecord;
    } catch {
      continue;
    }
    if (rec.event === "wake_outcome") outcomes.push(rec);
  }
  const recent = limit > 0 ? outcomes.slice(-limit) : outcomes;
  const byStatus: Record<string, number> = {};
  const byVia: Record<string, Record<string, number>> = {};
  for (const r of recent) {
    const status = String(r.wake_status ?? "unknown");
    const via = String(r.via ?? "unknown");
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const viaBucket = (byVia[via] ??= {});
    viaBucket[status] = (viaBucket[status] ?? 0) + 1;
  }
  return { total: recent.length, considered: outcomes.length, byStatus, byVia };
}

function sortedCounts(counts: Record<string, number>): Array<[string, number]> {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function formatWakeSummary(s: WakeOutcomeSummary): string {
  if (s.total === 0) {
    return "oxtail diagnose: no wake_outcome events in the trace yet (no ask_peer / wake:auto / reply-default wakes recorded).";
  }
  const lines: string[] = [];
  const capped = s.considered > s.total ? ` (newest ${s.total} of ${s.considered})` : ` (${s.total})`;
  lines.push(`oxtail diagnose — wake outcomes${capped}:`);
  for (const [status, n] of sortedCounts(s.byStatus)) {
    lines.push(`  ${status}: ${n}`);
  }
  lines.push("by tool:");
  for (const [via, counts] of Object.entries(s.byVia).sort()) {
    const parts = sortedCounts(counts).map(([st, n]) => `${st} ${n}`);
    lines.push(`  ${via}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

// CLI entry. Returns a process exit code; `out` is injectable for tests.
export function runDiagnose(
  traceFile: string | undefined,
  out: (line: string) => void = console.log,
): number {
  if (!traceFile) {
    out("oxtail diagnose: MCP_TRACE_FILE is not set, so there is no trace data to summarize.");
    out(
      "Set MCP_TRACE_FILE=/path/to/oxtail-trace.jsonl in the oxtail MCP server's env (e.g. in .mcp.json / ~/.claude.json / ~/.codex/config.toml), reproduce some wakes, then re-run `oxtail diagnose`.",
    );
    return 0;
  }
  let content: string;
  try {
    content = readFileSync(traceFile, "utf8");
  } catch {
    out(`oxtail diagnose: could not read trace file ${traceFile} (set MCP_TRACE_FILE and reproduce some wakes first).`);
    return 1;
  }
  out(formatWakeSummary(summarizeWakeOutcomes(content.split("\n"))));
  return 0;
}

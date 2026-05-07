import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TRACE_FILE = process.env.MCP_TRACE_FILE || null;
let dirEnsured = false;

// Append a JSON record to MCP_TRACE_FILE if set; silent no-op otherwise.
// Tracing must never affect normal operation, so all errors are swallowed.
export function trace(event: string, data: Record<string, unknown>): void {
  if (!TRACE_FILE) return;
  if (!dirEnsured) {
    try {
      mkdirSync(dirname(TRACE_FILE), { recursive: true });
    } catch {
      // best effort
    }
    dirEnsured = true;
  }
  let line: string;
  try {
    line =
      JSON.stringify({
        ts: new Date().toISOString(),
        server_pid: process.pid,
        event,
        ...data,
      }) + "\n";
  } catch {
    return;
  }
  try {
    appendFileSync(TRACE_FILE, line);
  } catch {
    // ignore
  }
}

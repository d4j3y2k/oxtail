import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { formatWakeSummary, runDiagnose, summarizeWakeOutcomes } from "./diagnose.js";

function lines(records: object[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

test("summarizeWakeOutcomes: tallies by status and by tool, ignoring other events", () => {
  const s = summarizeWakeOutcomes(
    lines([
      { event: "ask_peer_start", request_id: "x" }, // unrelated → ignored
      { event: "wake_outcome", via: "ask_peer", wake_status: "fired" },
      { event: "wake_outcome", via: "ask_peer", wake_status: "fired" },
      { event: "wake_outcome", via: "ask_peer", wake_status: "skipped_busy" },
      { event: "wake_outcome", via: "reply_default", wake_status: "skipped_no_fresh_idle" },
    ]),
  );
  assert.equal(s.total, 4);
  assert.equal(s.considered, 4);
  assert.deepEqual(s.byStatus, { fired: 2, skipped_busy: 1, skipped_no_fresh_idle: 1 });
  assert.deepEqual(s.byVia, {
    ask_peer: { fired: 2, skipped_busy: 1 },
    reply_default: { skipped_no_fresh_idle: 1 },
  });
});

test("summarizeWakeOutcomes: skips malformed JSONL lines and blanks", () => {
  const s = summarizeWakeOutcomes([
    "",
    "not json at all",
    JSON.stringify({ event: "wake_outcome", via: "send_message", wake_status: "fired" }),
    "{ truncated",
  ]);
  assert.equal(s.total, 1);
  assert.deepEqual(s.byStatus, { fired: 1 });
});

test("summarizeWakeOutcomes: recency cap keeps the newest `limit`", () => {
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push({ event: "wake_outcome", via: "ask_peer", wake_status: "fired" });
  recs.push({ event: "wake_outcome", via: "ask_peer", wake_status: "skipped_no_target" });
  const s = summarizeWakeOutcomes(lines(recs), 3);
  assert.equal(s.total, 3, "only the newest 3 counted");
  assert.equal(s.considered, 11, "but all 11 reported as considered");
  assert.deepEqual(s.byStatus, { fired: 2, skipped_no_target: 1 });
});

test("formatWakeSummary: empty summary explains there's nothing yet", () => {
  const out = formatWakeSummary(summarizeWakeOutcomes([]));
  assert.match(out, /no wake_outcome events/);
});

test("formatWakeSummary: renders status counts and a by-tool breakdown", () => {
  const out = formatWakeSummary(
    summarizeWakeOutcomes(
      lines([
        { event: "wake_outcome", via: "ask_peer", wake_status: "fired" },
        { event: "wake_outcome", via: "send_message", wake_status: "skipped_no_target" },
      ]),
    ),
  );
  assert.match(out, /wake outcomes/);
  assert.match(out, /fired: 1/);
  assert.match(out, /skipped_no_target: 1/);
  assert.match(out, /by tool:/);
  assert.match(out, /ask_peer: fired 1/);
});

test("runDiagnose: no MCP_TRACE_FILE → exit 0 with a how-to-enable hint", () => {
  const printed: string[] = [];
  const code = runDiagnose(undefined, (l) => printed.push(l));
  assert.equal(code, 0);
  assert.match(printed.join("\n"), /MCP_TRACE_FILE is not set/);
});

test("runDiagnose: unreadable trace file → exit 1", () => {
  const printed: string[] = [];
  const code = runDiagnose(join(tmpdir(), "oxtail-no-such-trace-xyz.jsonl"), (l) => printed.push(l));
  assert.equal(code, 1);
  assert.match(printed.join("\n"), /could not read trace file/);
});

test("runDiagnose: reads a real trace file and prints the summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-diag-"));
  try {
    const f = join(dir, "trace.jsonl");
    writeFileSync(
      f,
      lines([
        { event: "ask_peer_start" },
        { event: "wake_outcome", via: "ask_peer", wake_status: "fired" },
        { event: "wake_outcome", via: "send_message", wake_status: "skipped_debounced" },
      ]).join("\n") + "\n",
    );
    const printed: string[] = [];
    const code = runDiagnose(f, (l) => printed.push(l));
    assert.equal(code, 0);
    const out = printed.join("\n");
    assert.match(out, /fired: 1/);
    assert.match(out, /skipped_debounced: 1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

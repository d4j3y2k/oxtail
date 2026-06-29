// `oxtail token-budget` — the measurement foundation for token-efficiency work.
//
// oxtail spends model tokens in three distinct places, with very different
// scaling:
//   1. STANDING   — the MCP tool schemas (name + description + inputSchema) that
//                   sit in every session's system prompt. Paid once per session,
//                   then prompt-cached (~10% on later turns). This is the biggest
//                   single number and the one that silently grows as tool
//                   descriptions get edited — so it gets a CI regression ceiling
//                   (see token-budget.test.ts), like a bundle-size budget.
//   2. PER-DELIVERY — the PreToolUse/Stop hook envelope wrapped around each
//                   delivered message batch (receiver input). Measured by
//                   rendering the REAL hook-drain code, so it tracks the envelope
//                   if the preamble ever changes.
//   3. PER-CALL   — the response payload each oxtail tool hands back into the
//                   caller's context (sender input). Illustrative samples only:
//                   exact bytes are runtime-dependent.
//
// A turn with NO peer traffic costs ZERO oxtail tokens beyond the cached schemas:
// the SessionStart / UserPromptSubmit hooks never print, and the PreToolUse hook
// fast-path exits silent when the mailbox is empty. So "standing + envelope when
// used" is the whole static model.
//
// Token figures use a chars/token proxy (Claude's tokenizer is not exposed
// offline). BYTE counts are exact; token counts are ±~10%. Treat the proxy as a
// stable yardstick for measuring DELTAS, not an exact billing number.

import { renderPreToolUse, renderStop } from "./hook-drain.js";
import type { Mailbox } from "./mailbox.js";

// Mixed JSON + English prose. ~3.5 chars/tok for dense JSON, ~4.5 for prose;
// 3.7 is a conservative blend that matches the tool-schema/envelope mix.
// CAVEAT (codex review): one ratio is fine for a WITHIN-SAME-SURFACE delta
// (description vs the same description shortened) but NOT for ranking ACROSS
// surfaces — JSON-heavy schemas, prose-heavy hooks, and natural-language message
// bodies tokenize differently, so absolute cross-surface comparisons can rank the
// wrong target. Use it for "did this edit shrink?", not "which surface is biggest
// in true tokens?". For real economics, measure from a tokenizer/usage, not this.
export const CHARS_PER_TOKEN = 3.7;

export function estTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

// ── 1. STANDING: tool schemas ────────────────────────────────────────────────

// The minimal shape of an MCP tool as returned by tools/list — what the client
// actually serializes into the model's context.
export type ToolDef = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type ToolMeasure = {
  name: string;
  totalChars: number; // full serialized tool entry (what the client carries)
  descChars: number;
  schemaChars: number;
};

export type SchemaBudget = {
  tools: ToolMeasure[]; // sorted heaviest-first
  totalChars: number;
  totalTokensEst: number;
  count: number;
};

export function measureToolSchemas(tools: ToolDef[]): SchemaBudget {
  const measured: ToolMeasure[] = tools.map((t) => ({
    name: t.name,
    totalChars: JSON.stringify(t).length,
    descChars: (t.description ?? "").length,
    schemaChars: JSON.stringify(t.inputSchema ?? {}).length,
  }));
  measured.sort((a, b) => b.totalChars - a.totalChars);
  const totalChars = measured.reduce((s, m) => s + m.totalChars, 0);
  return {
    tools: measured,
    totalChars,
    totalTokensEst: estTokens(totalChars),
    count: measured.length,
  };
}

// ── 2. PER-DELIVERY: hook envelope ───────────────────────────────────────────

// Build a throwaway Mailbox for measurement. We only need the fields the
// renderer reads; the rest is cast away (this never touches the wire).
function fauxMsg(body: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id: "m_measure",
    from_session_id: "00000000-0000-0000-0000-000000000000",
    body,
    enqueued_at: 0,
    ...extra,
  } as Mailbox;
}

// Extract the bytes that actually land in the model's context from a rendered
// hook result (PreToolUse wraps it in hookSpecificOutput.additionalContext;
// Stop puts it in reason).
function injectedChars(rendered: string): number {
  const o = JSON.parse(rendered) as {
    hookSpecificOutput?: { additionalContext?: string };
    reason?: string;
  };
  return (o.hookSpecificOutput?.additionalContext ?? o.reason ?? "").length;
}

export type EnvelopeBudget = {
  // Fixed bytes added around a single ordinary message body, per event type.
  preToolUseOverheadChars: number;
  stopOverheadChars: number;
  // Marginal bytes for each additional message in the same delivered batch.
  perExtraMessageChars: number;
  // Marginal bytes when the batch carries an action_required obligation.
  obligationSteerChars: number;
  preToolUseOverheadTokensEst: number;
  stopOverheadTokensEst: number;
};

// Measured by rendering the live hook-drain code, so these self-update if the
// envelope wording changes — and the test asserts they stay in band.
export function measureEnvelopes(): EnvelopeBudget {
  const body = "x".repeat(64);
  const one = [fauxMsg(body)];
  const two = [fauxMsg(body), fauxMsg(body)];
  const oblig = [fauxMsg(body, { action_required: true, request_id: "req_x" })];

  const preOne = injectedChars(renderPreToolUse(one, 4000)) - body.length;
  const stopOne = injectedChars(renderStop(one, 4000)) - body.length;
  const preTwo = injectedChars(renderPreToolUse(two, 4000)) - body.length * 2;
  const preOblig = injectedChars(renderPreToolUse(oblig, 4000)) - body.length;

  return {
    preToolUseOverheadChars: preOne,
    stopOverheadChars: stopOne,
    perExtraMessageChars: preTwo - preOne,
    obligationSteerChars: preOblig - preOne,
    preToolUseOverheadTokensEst: estTokens(preOne),
    stopOverheadTokensEst: estTokens(stopOne),
  };
}

// ── 3. PER-CALL: representative response payloads ─────────────────────────────

// Exact bytes depend on runtime, but every sample below is a SHAPE verified
// against a live call or the handler source (server.ts / wake.ts) — NOT invented.
// The enum-bearing fields (wake_status, delivery_outlook) are additionally
// cross-checked against the live wake.ts unions by the test, so a sample can
// never drift back to teaching vocabulary the protocol doesn't use. (An
// illustrative-but-false sample is worse than none: byte-true, protocol-false —
// it teaches stale vocabulary while the byte tests pass. Found by codex review.)
const SID = "b7f3e2a1-0c4d-4e5f-8a9b-1c2d3e4f5a6b";
const MID = "656ddfdf447e3f6c";
export const RESPONSE_SAMPLES: Array<{ label: string; payload: unknown }> = [
  { label: "read_my_messages  count:0 (empty poll)", payload: { schema_version: 1, ok: true, drained: true, count: 0, messages: [] } },
  { label: "send_message  idle hooked peer (wake:auto → fired)", payload: { schema_version: 1, ok: true, message_id: MID, target_session_id: SID, target_server_pid: 48213, wake_status: "fired" } },
  { label: "send_message  hookless peer (wake → fired_unconfirmed)", payload: { schema_version: 1, ok: true, message_id: MID, target_session_id: SID, target_server_pid: 48213, wake_status: "fired_unconfirmed" } },
  { label: "send_message  plain send strands (delivery_outlook)", payload: { schema_version: 1, ok: true, message_id: MID, target_session_id: SID, target_server_pid: 48213, delivery_outlook: "stranded_until_read", hint: "Peer isn't actively reading right now — it reads this at its next turn. If this is context/FYI, that's fine, leave it. If it must ACT: ask_peer (you need an answer this turn / will block on it), action_required:true (a durable task you track via my_open_work), or wake:\"auto\" (just nudge it to read now)." } },
  { label: "ask_peer  reply received", payload: { schema_version: 1, ok: true, message_id: MID, request_id: "req_99", wake_status: "fired", reply: { id: "a1b2c3d4e5f60718", body: "Looks right. Ship it — but gate the publish on my explicit ok first.", enqueued_at: 1782663600, from_session_id: SID, reply_to: "req_99", correlation: "correlated" }, correlation: "correlated", timeout_ms: 60000, timed_out: false } },
  { label: "ask_peer  timed_out (durable pending pull-back)", payload: { schema_version: 1, ok: true, message_id: MID, request_id: "req_99", wake_status: "fired_unconfirmed", reply: null, correlation: "none", timeout_ms: 60000, timed_out: true } },
];

export type ResponseMeasure = { label: string; chars: number; tokensEst: number };
export function measureResponses(): ResponseMeasure[] {
  return RESPONSE_SAMPLES.map((s) => {
    const chars = JSON.stringify(s.payload).length;
    return { label: s.label, chars, tokensEst: estTokens(chars) };
  });
}

// ── Telemetry (Phase 1.5): real oxtail spend from a Claude transcript ─────────

// Reliable signal: oxtail tool_use blocks and their tool_result blocks are
// always logged in the transcript JSONL (linked by tool_use_id). We sum the
// bytes each oxtail tool spent on the wire this session — arg bytes are model
// OUTPUT (composing the call), result bytes are model INPUT (the response lands
// back in context). NOTE: the hook ENVELOPE (per-delivery injection) is NOT
// reliably present as plain text in the transcript — that accounting belongs to
// the MCP_TRACE_FILE delivery events and is a deliberate follow-up.
export type ToolTraffic = { calls: number; argChars: number; resultChars: number };
export type SpendSummary = {
  byTool: Record<string, ToolTraffic>;
  totals: ToolTraffic;
  outputTokensEst: number; // from argChars (composing calls)
  inputTokensEst: number; // from resultChars (responses returning to context)
};

// CI regression ceiling for the standing schema (chars). RATCHET: lowered from
// 27,000 to 25,500 once the send_message audit landed (~24,717 measured), so the
// realized win is locked in and silent regrowth past it trips CI. The headroom
// absorbs small description edits; a deliberate jump (a new tool, a big guidance
// rewrite) must bump this in the same PR — that review friction is the whole
// point: every byte here is paid by every session. Each accepted audit round
// ratchets this DOWN; it should never drift up without a named reason.
//
// HONEST LIMITS (max + codex review): this is an anti-GROWTH brake, NOT the
// optimization objective. It guards the FIXED, prompt-cached cost (~14 tok/turn
// after turn 1) and is partially gameable — a risky addition can hide under the
// headroom, and a harmful deletion can "buy budget" for unrelated growth (the
// 10k floor only catches catastrophic deletion, not loss of one load-bearing
// clause). The cost that actually SCALES with collaboration is the per-exchange
// envelope + response payload (see summarizeOxtailToolTraffic / the trace
// envelope accounting); that — tokens-per-peer-exchange — is the budget worth
// tracking, not this ceiling. Keep this as a brake; don't mistake it for a goal.
export const BUDGET_CEILING_CHARS = 25_500;

function isOxtailTool(name: string | undefined): boolean {
  return !!name && name.includes("oxtail");
}

function bump(map: Record<string, ToolTraffic>, name: string): ToolTraffic {
  return (map[name] ??= { calls: 0, argChars: 0, resultChars: 0 });
}

export function summarizeOxtailToolTraffic(lines: string[]): SpendSummary {
  const byTool: Record<string, ToolTraffic> = {};
  const idToName = new Map<string, string>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec: { message?: { content?: unknown } };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<Record<string, unknown>>) {
      if (c.type === "tool_use" && isOxtailTool(c.name as string)) {
        const name = c.name as string;
        idToName.set(c.id as string, name);
        const t = bump(byTool, name);
        t.calls++;
        t.argChars += JSON.stringify(c.input ?? {}).length;
      } else if (c.type === "tool_result") {
        const name = idToName.get(c.tool_use_id as string);
        if (!name) continue;
        const raw = c.content;
        const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
        bump(byTool, name).resultChars += text.length;
      }
    }
  }
  const totals: ToolTraffic = { calls: 0, argChars: 0, resultChars: 0 };
  for (const t of Object.values(byTool)) {
    totals.calls += t.calls;
    totals.argChars += t.argChars;
    totals.resultChars += t.resultChars;
  }
  return {
    byTool,
    totals,
    outputTokensEst: estTokens(totals.argChars),
    inputTokensEst: estTokens(totals.resultChars),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

function comma(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function rpad(s: string | number, w: number): string {
  return String(s).padStart(w);
}

export function formatBudget(
  schema: SchemaBudget,
  env: EnvelopeBudget,
  responses: ResponseMeasure[],
): string {
  const L: string[] = [];
  L.push(
    `oxtail token budget   (proxy ~${CHARS_PER_TOKEN} chars/tok; standing cost is prompt-cached after turn 1)`,
  );
  L.push("");
  L.push(`STANDING — MCP tool schemas (every session's system prompt, ${schema.count} tools)`);
  const status = schema.totalChars <= BUDGET_CEILING_CHARS ? "ok" : "OVER";
  L.push(
    `  total   ${comma(schema.totalChars)} chars   ~${comma(schema.totalTokensEst)} tok   ` +
      `[ceiling ${comma(BUDGET_CEILING_CHARS)} chars — ${status}]`,
  );
  for (const t of schema.tools) {
    L.push(`    ${rpad(comma(t.totalChars), 7)}  ~${rpad(comma(estTokens(t.totalChars)), 5)} tok   ${t.name}`);
  }
  L.push("");
  L.push("PER-DELIVERY — hook envelope (receiver input, wrapped around the body)");
  L.push(`  PreToolUse fixed overhead   ${rpad(env.preToolUseOverheadChars, 4)} chars  ~${rpad(env.preToolUseOverheadTokensEst, 4)} tok`);
  L.push(`  Stop fixed overhead         ${rpad(env.stopOverheadChars, 4)} chars  ~${rpad(env.stopOverheadTokensEst, 4)} tok`);
  L.push(`  + per extra message         ${rpad(env.perExtraMessageChars, 4)} chars  ~${rpad(estTokens(env.perExtraMessageChars), 4)} tok`);
  L.push(`  + obligation steer          ${rpad(env.obligationSteerChars, 4)} chars  ~${rpad(estTokens(env.obligationSteerChars), 4)} tok   (action_required only)`);
  L.push("");
  L.push("PER-CALL — response payloads (sender input; illustrative shapes)");
  for (const r of responses) {
    L.push(`  ${rpad(comma(r.chars), 5)} chars  ~${rpad(comma(r.tokensEst), 4)} tok   ${r.label}`);
  }
  L.push("");
  L.push("QUIET TURN — 0 tok: SessionStart/UserPromptSubmit hooks never print and");
  L.push("the PreToolUse hook exits silent when the mailbox is empty.");
  return L.join("\n");
}

export function formatSpend(s: SpendSummary, path: string): string {
  const L: string[] = [];
  L.push(`REAL oxtail tool traffic — ${path}`);
  L.push(
    `  ${s.totals.calls} calls   output ~${comma(s.outputTokensEst)} tok (args)   ` +
      `input ~${comma(s.inputTokensEst)} tok (results)`,
  );
  const rows = Object.entries(s.byTool).sort(
    (a, b) => b[1].argChars + b[1].resultChars - (a[1].argChars + a[1].resultChars),
  );
  for (const [name, t] of rows) {
    L.push(
      `    ${rpad(t.calls, 3)}x  out ~${rpad(comma(estTokens(t.argChars)), 5)}  ` +
        `in ~${rpad(comma(estTokens(t.resultChars)), 6)} tok   ${name}`,
    );
  }
  L.push("  (envelope-delivery accounting is a follow-up — it lives in MCP_TRACE_FILE, not the transcript.)");
  return L.join("\n");
}

// ── Live introspection: measure exactly what a client sees ───────────────────

export type SpawnToolsOpts = { command?: string; args?: string[]; timeoutMs?: number };

// Spawn a throwaway probe server (its own temp HOME so it pollutes nothing) and
// ask it for tools/list — the ground truth, version-independent of the SDK. The
// CLI default spawns the currently-running entry (`node dist/server.js`); tests
// pass an explicit tsx + server.ts command.
export async function listToolsViaSpawn(opts: SpawnToolsOpts = {}): Promise<ToolDef[]> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const command = opts.command ?? process.execPath;
  const args = opts.args ?? [process.argv[1]];
  const home = mkdtempSync(join(tmpdir(), "oxtail-budget-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NODE_PATH: process.env.NODE_PATH ?? "",
  };
  const transport = new StdioClientTransport({ command, args, env, stderr: "ignore" });
  const client = new Client({ name: "oxtail-token-budget", version: "probe" }, { capabilities: {} });
  const timeoutMs = opts.timeoutMs ?? 15_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("timed out connecting to probe server")), timeoutMs);
      }),
    ]);
    const res = await client.listTools();
    return res.tools as ToolDef[];
  } finally {
    if (timer) clearTimeout(timer);
    try {
      await client.close();
    } catch {
      // best effort
    }
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// ── CLI entry: `oxtail token-budget [--transcript <path>] [--json] ───────────

export async function runTokenBudget(
  argv: string[],
  out: (line: string) => void = console.log,
): Promise<number> {
  const tIdx = argv.indexOf("--transcript");
  const transcriptPath = tIdx >= 0 ? argv[tIdx + 1] : undefined;
  const asJson = argv.includes("--json");

  let tools: ToolDef[];
  try {
    tools = await listToolsViaSpawn();
  } catch (e) {
    out(`token-budget: could not introspect tools via a probe server: ${(e as Error).message}`);
    return 1;
  }
  const schema = measureToolSchemas(tools);
  const env = measureEnvelopes();
  const responses = measureResponses();

  let spend: SpendSummary | undefined;
  if (transcriptPath) {
    try {
      const { readFileSync } = await import("node:fs");
      spend = summarizeOxtailToolTraffic(readFileSync(transcriptPath, "utf8").split("\n"));
    } catch (e) {
      out(`token-budget: could not read transcript ${transcriptPath}: ${(e as Error).message}`);
    }
  }

  if (asJson) {
    out(JSON.stringify({ schema, envelope: env, responses, spend }, null, 2));
    return schema.totalChars <= BUDGET_CEILING_CHARS ? 0 : 1;
  }

  out(formatBudget(schema, env, responses));
  if (spend) out("\n" + formatSpend(spend, transcriptPath!));
  return schema.totalChars <= BUDGET_CEILING_CHARS ? 0 : 1;
}

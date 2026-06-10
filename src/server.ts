#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import {
  clientFromHandshake,
  detectClient,
  enrichWithDiagnosis,
  transcriptPathFor,
  type ClientInfo,
  type ClientType,
} from "./clients.js";
import { diagnoseDetect, isAbstain, type DetectDiagnosis } from "./detect/index.js";
import { trace } from "./trace.js";
import {
  buildEntry,
  findByTmuxSession,
  readAll,
  refreshTmuxBinding,
  register,
  sessionPidsForId,
  unregister,
  type RegistryEntry,
  type StateCard,
} from "./registry.js";
import * as mailbox from "./mailbox.js";
import * as received from "./received.js";
import {
  deliverExistingToPeer,
  deliverToPeer,
  type DeliveryRoute,
} from "./delivery.js";
import { recoverClaim, resolveAncestors, writeClaim } from "./claims.js";
import {
  consumePendingAsk,
  defaultPendingAskDir,
  gcPendingAsk,
  recordPendingAsk,
} from "./pending-ask.js";
import {
  inferProjectRoot,
  pathBelongsToProjectScope,
  safeRealpath,
  UUID_RE,
} from "./scope.js";
import {
  peerSupportsReplyTo,
  resolveErrorWakeStatus,
  resolveTarget,
} from "./resolve-target.js";
import {
  replyAutoWakeTriggered,
  resolveSendWake,
  wakeForSend,
  type WakeStatus,
} from "./wake.js";

// CLI subcommand dispatch must run before any MCP setup so that
// `npx oxtail install-hook` doesn't open an MCP transport or register a
// session. Use named exports and await them; calling `await import(...)`
// alone resolves at module-evaluation but would let process.exit(0) race
// the script's async work.
{
  const sub = process.argv[2];
  if (sub === "install-hook") {
    const url = new URL("../scripts/install-hook.mjs", import.meta.url).href;
    const mod = (await import(url)) as { install: () => Promise<void> };
    await mod.install();
    process.exit(0);
  }
  if (sub === "uninstall-hook") {
    const url = new URL("../scripts/uninstall-hook.mjs", import.meta.url).href;
    const mod = (await import(url)) as { uninstall: () => Promise<void> };
    await mod.uninstall();
    process.exit(0);
  }
  if (sub === "diagnose") {
    const { runDiagnose } = await import("./diagnose.js");
    process.exit(runDiagnose(process.env.MCP_TRACE_FILE));
  }
}
import {
  readClaudeTranscript,
  readCodexTranscript,
  type ReadTranscriptOptions,
  type TranscriptMessage,
} from "./transcripts.js";

export type Session = {
  name: string;
  path: string;
  attached: boolean;
  created_at: number;
  windows: number;
  client_type: ClientType | null;
  client_session_id: string | null;
  state: StateCard | null;
};

type ListResult = {
  schema_version: 1;
  project_root: string;
  inferred: boolean;
  sessions: Session[];
  error: string | null;
};

type ReadResult = {
  schema_version: 1;
  session: string;
  mode: "transcript" | "pane" | "none";
  client_type: ClientType | null;
  messages: TranscriptMessage[] | null;
  pane_text: string | null;
  truncated: boolean;
  count_truncated: boolean;
  bytes_truncated: boolean;
  total_messages: number | null;
  total_messages_exact: boolean;
  // Freshness/provenance of the read so a caller can tell a genuinely-quiet peer
  // from a STALE/rotated thread (the silent-staleness false-negative: a
  // sticky-recovered identity pinned to an old transcript reads as "no reply"
  // while the peer is live elsewhere). Null on out-of-scope/unknown/ambiguous
  // exits; in-scope errors may still carry provenance (resolved_session_id +
  // session_id_source). transcript_mtime/age are transcript-read-only.
  resolved_session_id: string | null;
  session_id_source: string | null;
  transcript_mtime: string | null;
  transcript_age_seconds: number | null;
  project_root: string;
  inferred: boolean;
  error: string | null;
};

// Single builder for every readSession return so the field set (including the
// truncation flags) is always complete and consistent across the ~9 exit paths.
// Callers pass only what differs from the defaults.
function makeReadResult(o: {
  session: string;
  project_root: string;
  inferred: boolean;
  mode?: ReadResult["mode"];
  client_type?: ClientType | null;
  messages?: TranscriptMessage[] | null;
  pane_text?: string | null;
  truncated?: boolean;
  count_truncated?: boolean;
  bytes_truncated?: boolean;
  total_messages?: number | null;
  total_messages_exact?: boolean;
  resolved_session_id?: string | null;
  session_id_source?: string | null;
  transcript_mtime?: string | null;
  transcript_age_seconds?: number | null;
  error?: string | null;
}): ReadResult {
  return {
    schema_version: 1,
    session: o.session,
    mode: o.mode ?? "none",
    client_type: o.client_type ?? null,
    messages: o.messages ?? null,
    pane_text: o.pane_text ?? null,
    truncated: o.truncated ?? false,
    count_truncated: o.count_truncated ?? false,
    bytes_truncated: o.bytes_truncated ?? false,
    total_messages: o.total_messages ?? null,
    total_messages_exact: o.total_messages_exact ?? false,
    resolved_session_id: o.resolved_session_id ?? null,
    session_id_source: o.session_id_source ?? null,
    transcript_mtime: o.transcript_mtime ?? null,
    transcript_age_seconds: o.transcript_age_seconds ?? null,
    project_root: o.project_root,
    inferred: o.inferred,
    error: o.error ?? null,
  };
}

const TMUX_LIST_FORMAT =
  "#{session_name}|#{session_path}|#{session_created}|#{session_attached}|#{session_windows}";

const TMUX_PANES_FORMAT = "#{session_name}|#{pane_current_path}";

function listTmuxSessionsRaw(): {
  rows: Array<Omit<Session, "client_type" | "client_session_id" | "state">>;
  error: string | null;
} {
  let raw: string;
  try {
    raw = execFileSync("tmux", ["list-sessions", "-F", TMUX_LIST_FORMAT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === "ENOENT") return { rows: [], error: "tmux not found" };
    const stderr = e.stderr ? e.stderr.toString() : "";
    if (stderr.includes("no server running")) return { rows: [], error: null };
    return { rows: [], error: stderr.trim() || e.message || "tmux failed" };
  }

  const rows: Array<Omit<Session, "client_type" | "client_session_id" | "state">> = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [name, path, created, attached, windows] = line.split("|");
    if (!name || !path) continue;
    rows.push({
      name,
      path,
      attached: attached === "1",
      created_at: Number(created) || 0,
      windows: Number(windows) || 0,
    });
  }
  return { rows, error: null };
}

function listTmuxPaneCwds(): Map<string, string[]> {
  let raw: string;
  try {
    raw = execFileSync("tmux", ["list-panes", "-a", "-F", TMUX_PANES_FORMAT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return new Map();
  }
  const out = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [name, path] = line.split("|");
    if (!name || !path) continue;
    const arr = out.get(name);
    if (arr) arr.push(path);
    else out.set(name, [path]);
  }
  return out;
}

// Pure join: matched tmux rows × registry entries → one Session row per agent.
// Extracted from buildListResult so it can be unit-tested without invoking
// tmux. When N agents share a tmux session, N rows are emitted with identical
// tmux fields and distinct client_session_id. Tmux sessions with no matching
// registry entry get a single null-client row so unclaimed peers (Codex
// pre-claim, stale sessions) remain discoverable.
export function joinSessionsWithRegistry(
  matched: Omit<Session, "client_type" | "client_session_id" | "state">[],
  registry: RegistryEntry[],
): Session[] {
  const regsByTmux = new Map<string, RegistryEntry[]>();
  for (const e of registry) {
    if (!e.tmux_session) continue;
    const arr = regsByTmux.get(e.tmux_session);
    if (arr) arr.push(e);
    else regsByTmux.set(e.tmux_session, [e]);
  }
  return matched.flatMap((s): Session[] => {
    const regs = regsByTmux.get(s.name) ?? [];
    if (regs.length === 0) {
      return [{ ...s, client_type: null, client_session_id: null, state: null }];
    }
    return regs.map((reg) => ({
      ...s,
      client_type: reg.client.type ?? null,
      client_session_id: reg.client.session_id ?? null,
      state: reg.state ?? null,
    }));
  });
}

export function buildListResult(input: { project_root?: string }): ListResult {
  const explicit = typeof input.project_root === "string" && input.project_root.length > 0;
  const root = explicit ? input.project_root! : inferProjectRoot(process.cwd());
  const resolvedRoot = safeRealpath(root);

  const { rows, error } = listTmuxSessionsRaw();
  const paneCwds = listTmuxPaneCwds();
  const matched = rows.filter((s) => {
    if (pathBelongsToProjectScope(s.path, resolvedRoot)) return true;
    const cwds = paneCwds.get(s.name);
    if (!cwds) return false;
    return cwds.some((p) => pathBelongsToProjectScope(p, resolvedRoot));
  });

  const sessions = joinSessionsWithRegistry(matched, readAll());
  return { schema_version: 1, project_root: resolvedRoot, inferred: !explicit, sessions, error };
}

type CompactAgent = {
  client_type: ClientType | null;
  client_session_id: string | null;
  state: StateCard | null;
};
type CompactTmuxSession = {
  name: string;
  path: string;
  attached: boolean;
  created_at: number;
  windows: number;
  agents: CompactAgent[];
};
type ListCompactResult = {
  schema_version: 1;
  project_root: string;
  inferred: boolean;
  tmux_sessions: CompactTmuxSession[];
  error: string | null;
};

// Opt-in compact shape: hoist the tmux fields that are byte-identical across
// every agent sharing a session (name/path/attached/created_at/windows) into one
// group, with the per-agent fields nested under `agents`. Kills the per-row
// duplication that grows with the agent matrix (and the redundant per-row `path`
// that usually equals project_root). The DEFAULT response keeps the flat
// `sessions[]` shape — backward compatible; callers ask for this with
// compact:true. An unclaimed tmux session (no oxtail-aware agent) becomes a group
// with an empty `agents` array.
export function toCompactList(r: ListResult): ListCompactResult {
  const groups = new Map<string, CompactTmuxSession>();
  const order: string[] = [];
  for (const s of r.sessions) {
    let g = groups.get(s.name);
    if (!g) {
      g = {
        name: s.name,
        path: s.path,
        attached: s.attached,
        created_at: s.created_at,
        windows: s.windows,
        agents: [],
      };
      groups.set(s.name, g);
      order.push(s.name);
    }
    // joinSessionsWithRegistry emits a single all-null row for a tmux session
    // with no registry match; don't materialize that as a phantom agent.
    if (s.client_type !== null || s.client_session_id !== null || s.state !== null) {
      g.agents.push({
        client_type: s.client_type,
        client_session_id: s.client_session_id,
        state: s.state,
      });
    }
  }
  return {
    schema_version: 1,
    project_root: r.project_root,
    inferred: r.inferred,
    tmux_sessions: order.map((n) => groups.get(n)!),
    error: r.error,
  };
}

function capturePane(target: string, lines: number): string {
  const safe = Math.max(20, Math.min(2000, Math.floor(lines)));
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-J", "-t", target, "-S", `-${safe}`, "-E", "-"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

// pane_lines bounds how many ROWS tmux captures, but a single row can be
// arbitrarily wide, so the joined blob is still unbounded by characters. This
// caps the returned text and is tail-preserving — the most recent terminal
// output is at the bottom, which is what a peer-watcher actually wants.
const DEFAULT_PANE_MAX_CHARS = 20_000;
const MIN_PANE_MAX_CHARS = 500;
const MAX_PANE_MAX_CHARS = 200_000;

export function tailChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  // Fast path: code-unit length is an upper bound on code-point count, so if it
  // already fits there's nothing to do (and we skip the Array.from allocation).
  if (text.length <= maxChars) return { text, truncated: false };
  // Slice by code points so we never split a surrogate pair at the boundary.
  const cps = Array.from(text);
  if (cps.length <= maxChars) return { text, truncated: false };
  const tail = cps.slice(cps.length - maxChars).join("");
  return { text: `…[pane truncated to last ${maxChars} chars]\n${tail}`, truncated: true };
}

type ScopeResolution = {
  inScope: boolean;
  canonicalName: string | null;
  sessionPath: string | null;
  registryEntry: RegistryEntry | null;
  ambiguousCandidates?: string[];
  // A UUID target that matches no currently-claimed registry entry — distinct
  // from "out of project scope". Lets the caller report the real condition
  // (re-claim / retry) instead of a misleading scope error.
  unknownSession?: boolean;
};

function anyPaneInScope(canonical: string, resolvedRoot: string): boolean {
  let raw: string;
  try {
    raw = execFileSync(
      "tmux",
      ["list-panes", "-t", canonical, "-F", "#{pane_current_path}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    const p = line.trim();
    if (p && pathBelongsToProjectScope(p, resolvedRoot)) return true;
  }
  return false;
}

// Registry-first fast path: oxtail-aware peers register at startup, so we can
// scope-check from the entry's client.cwd without spending tmux execs on every
// read. Falls through to tmux for unregistered peers, mirroring the
// session_path + pane_current_path matching list_project_sessions does — a
// session whose starting dir is outside the root but whose pane has cd'd
// inside should be readable, just like it's listable.
//
// Returning the canonical session_name (not the caller's input) prevents
// targets like "session:window.pane" or aliases from passing scope and then
// being read under a different lookup key.
function resolveSessionInScope(name: string, resolvedRoot: string): ScopeResolution {
  // UUID lookup: directly disambiguates when peers share a tmux session.
  if (UUID_RE.test(name)) {
    const matched = readAll().filter((e) => e.client.session_id === name);
    if (matched.length === 1) {
      const reg = matched[0];
      return {
        inScope: pathBelongsToProjectScope(reg.client.cwd, resolvedRoot),
        canonicalName: reg.tmux_session,
        sessionPath: reg.client.cwd,
        registryEntry: reg,
      };
    }
    // A UUID that resolves to no live registry entry is NOT a tmux session
    // name; don't fall through to the tmux lookup (which yields a misleading
    // "not in project scope"). Surface the real condition — unknown/unclaimed
    // session — so the caller re-claims or retries instead of hunting for a
    // project boundary. session_id is unique by construction, so >1 can't occur.
    return {
      inScope: false,
      canonicalName: null,
      sessionPath: null,
      registryEntry: null,
      unknownSession: true,
    };
  }

  const regs = findByTmuxSession(name);
  if (regs.length > 1) {
    return {
      inScope: false,
      canonicalName: null,
      sessionPath: null,
      registryEntry: null,
      ambiguousCandidates: regs
        .map((e) => e.client.session_id)
        .filter((s): s is string => s != null),
    };
  }
  const reg = regs[0];
  if (reg) {
    return {
      inScope: pathBelongsToProjectScope(reg.client.cwd, resolvedRoot),
      canonicalName: reg.tmux_session,
      sessionPath: reg.client.cwd,
      registryEntry: reg,
    };
  }
  let raw: string;
  try {
    raw = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", name, "#{session_name}|#{session_path}"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    return { inScope: false, canonicalName: null, sessionPath: null, registryEntry: null };
  }
  const [canonical, path] = raw.trim().split("|");
  if (!canonical || !path) {
    return { inScope: false, canonicalName: null, sessionPath: null, registryEntry: null };
  }
  const sessionInScope = pathBelongsToProjectScope(path, resolvedRoot);
  const inScope = sessionInScope || anyPaneInScope(canonical, resolvedRoot);
  return {
    inScope,
    canonicalName: canonical,
    sessionPath: path,
    registryEntry: null,
  };
}

// Best-effort freshness of the transcript file backing a transcript read. Lets a
// caller distinguish a genuinely-quiet peer from a stale/rotated thread: a
// sticky-recovered identity (session_id_source:"sticky-claim") whose transcript
// is hours old is the silent-staleness shape. stat failure yields nulls and must
// NEVER demote a readable transcript to an error. Age is floored at 0 so clock
// skew can't surface a nonsensical negative.
function transcriptFreshness(path: string): {
  mtime: string | null;
  ageSeconds: number | null;
} {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    return {
      mtime: new Date(mtimeMs).toISOString(),
      ageSeconds: Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000)),
    };
  } catch {
    return { mtime: null, ageSeconds: null };
  }
}

function readSession(input: {
  name: string;
  project_root?: string;
  mode?: "auto" | "transcript" | "pane";
  limit?: number;
  max_bytes?: number;
  include_timestamps?: boolean;
  tail_scan?: boolean;
  pane_lines?: number;
  pane_max_chars?: number;
}): ReadResult {
  const mode = input.mode ?? "auto";
  const paneLines = input.pane_lines ?? 240;
  // Mirror the transcript budgets' finite-number hardening: a non-finite
  // pane_max_chars (only reachable via a direct call, never through zod) coerces
  // to the default rather than producing a NaN cap. Per Codex Phase-C note.
  const paneMaxChars = Math.max(
    MIN_PANE_MAX_CHARS,
    Math.min(
      MAX_PANE_MAX_CHARS,
      Math.floor(
        Number.isFinite(input.pane_max_chars)
          ? (input.pane_max_chars as number)
          : DEFAULT_PANE_MAX_CHARS,
      ),
    ),
  );
  const explicit = typeof input.project_root === "string" && input.project_root.length > 0;
  const resolvedRoot = safeRealpath(
    explicit ? input.project_root! : inferProjectRoot(process.cwd()),
  );
  // The reader applies its own conservative defaults (DEFAULT_LIMIT /
  // DEFAULT_MAX_BYTES) and clamps; we just forward whatever the caller set.
  const readerOpts: ReadTranscriptOptions = {
    limit: input.limit,
    maxBytes: input.max_bytes,
    includeTimestamps: input.include_timestamps,
    tailScan: input.tail_scan,
  };

  const scope = resolveSessionInScope(input.name, resolvedRoot);
  if (scope.ambiguousCandidates) {
    const cands = scope.ambiguousCandidates;
    const detail = cands.length
      ? `pass a client_session_id (UUID) instead. candidates: ${cands.join(", ")}`
      : `all agents sharing it are unclaimed — have them run claim_session so they're addressable by UUID`;
    return makeReadResult({
      session: input.name,
      project_root: resolvedRoot,
      inferred: !explicit,
      error: `ambiguous-target: multiple agents share tmux session '${input.name}'; ${detail}`,
    });
  }
  if (scope.unknownSession) {
    return makeReadResult({
      session: input.name,
      project_root: resolvedRoot,
      inferred: !explicit,
      error: `unknown-or-unclaimed-session: '${input.name}' is not a currently claimed session in this project. If it is a peer that restarted its MCP server, it must re-run claim_session; if it just rotated, retry shortly.`,
    });
  }
  if (!scope.inScope) {
    return makeReadResult({
      session: input.name,
      project_root: resolvedRoot,
      inferred: !explicit,
      error: `session '${input.name}' not in project scope`,
    });
  }

  const canonical = scope.canonicalName;
  const reg = scope.registryEntry;
  const clientType = reg?.client.type ?? null;
  const transcriptPath = reg?.client.transcript_path ?? null;
  // Provenance of the resolved entry, carried on EVERY in-scope exit below so a
  // caller can always tell WHICH identity/thread answered and how it was derived
  // — a "sticky-claim" source is the stale-thread tell. null when we resolved a
  // bare tmux session with no registry entry. Deliberately NOT emitted on the
  // out-of-scope / unknown / ambiguous exits above (they return before this):
  // surfacing an out-of-project session_id would leak across the scope boundary.
  const provenance = {
    resolved_session_id: reg?.client.session_id ?? null,
    session_id_source: reg?.client.session_id_source ?? null,
  };

  // A tmux session name (canonical) is only needed to capture pane text.
  // Transcript reads work from the registry entry's transcript_path alone, so a
  // transcript-capable peer with no tmux binding (e.g. Codex running outside
  // tmux) is still readable. Bail only when there's neither a transcript to
  // read nor a tmux session to capture — previously a null canonicalName alone
  // (an in-scope, transcript-capable, tmux-less peer) was wrongly rejected as
  // "not in project scope".
  if (!canonical && !transcriptPath) {
    return makeReadResult({
      session: input.name,
      project_root: resolvedRoot,
      inferred: !explicit,
      client_type: clientType,
      ...provenance,
      error: `session '${input.name}' is in scope but has no transcript and no tmux session to read`,
    });
  }

  const wantTranscript = mode === "transcript" || (mode === "auto" && transcriptPath);
  if (wantTranscript) {
    if (!transcriptPath) {
      if (mode === "transcript") {
        return makeReadResult({
          session: canonical ?? input.name,
          project_root: resolvedRoot,
          inferred: !explicit,
          client_type: clientType,
          ...provenance,
          error: "no registry entry with transcript path; agent may not be oxtail-aware",
        });
      }
      // fall through to pane
    } else {
      const reader = clientType === "codex" ? readCodexTranscript : readClaudeTranscript;
      const fresh = transcriptFreshness(transcriptPath);
      let result: ReturnType<typeof reader>;
      try {
        result = reader(transcriptPath, readerOpts);
      } catch (err) {
        // The reader guards a missing file (returns empty), but the file can be
        // deleted/rotated in the existsSync->read gap, or be present-but-
        // unreadable (EISDIR/EACCES). A rotated transcript is exactly the
        // staleness shape these fields exist for, so mirror the pane catch
        // below: return a structured result (mode:"none" + error) carrying
        // provenance + best-effort freshness rather than throwing out of the
        // tool and denying the caller any signal.
        const msg = (err as Error)?.message ?? "read failed";
        return makeReadResult({
          session: canonical ?? input.name,
          project_root: resolvedRoot,
          inferred: !explicit,
          client_type: clientType,
          ...provenance,
          transcript_mtime: fresh.mtime,
          transcript_age_seconds: fresh.ageSeconds,
          error: `transcript read failed (rotated or unreadable?): ${msg}`,
        });
      }
      return makeReadResult({
        session: canonical ?? input.name,
        project_root: resolvedRoot,
        inferred: !explicit,
        mode: "transcript",
        client_type: clientType,
        messages: result.messages,
        truncated: result.truncated,
        count_truncated: result.count_truncated,
        bytes_truncated: result.bytes_truncated,
        total_messages: result.total_messages,
        total_messages_exact: result.total_messages_exact,
        ...provenance,
        transcript_mtime: fresh.mtime,
        transcript_age_seconds: fresh.ageSeconds,
      });
    }
  }

  // Pane fallback needs a tmux session to capture from. Reachable only when a
  // caller forces mode:"pane" on a transcript-only peer (no tmux binding).
  if (!canonical) {
    return makeReadResult({
      session: input.name,
      project_root: resolvedRoot,
      inferred: !explicit,
      client_type: clientType,
      ...provenance,
      error: `session '${input.name}' has no tmux pane to capture (transcript-only peer)`,
    });
  }

  try {
    const captured = tailChars(capturePane(canonical, paneLines), paneMaxChars);
    return makeReadResult({
      session: canonical,
      project_root: resolvedRoot,
      inferred: !explicit,
      mode: "pane",
      client_type: clientType,
      pane_text: captured.text,
      // Pane mode has no message-count/byte-budget split; `truncated` is the
      // catch-all signal that the char cap shortened the captured text.
      truncated: captured.truncated,
      // Provenance still applies in pane mode (reg is resolved); transcript
      // freshness does not — there's no transcript backing a pane capture.
      ...provenance,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    return makeReadResult({
      session: canonical,
      project_root: resolvedRoot,
      inferred: !explicit,
      client_type: clientType,
      ...provenance,
      error: stderr.trim() || e.message || "pane capture failed",
    });
  }
}

const client = detectClient();
const entry = buildEntry(client);
{
  const { client: enriched, diagnosis } = enrichWithDiagnosis(entry.client, entry.started_at);
  emitDetectTrace("startup", diagnosis);
  entry.client = enriched;
}
maybeRecoverStickyClaim();
register(entry);

const cleanup = (): void => {
  unregister(entry.server_pid);
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

const pkgVersion = (
  JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string }
).version;

const server = new McpServer({ name: "oxtail", version: pkgVersion });

// All MCP tool responses are JSON-encoded text that lands directly in a peer
// agent's context window. They are minified, never pretty-printed: indentation
// is pure whitespace cost that recurs on every call for the life of a session,
// and every consumer (tests, hooks) parses structurally — none depend on the
// indented form. On-disk registry/claim writes stay pretty (human-debuggable
// artifacts, not agent context). Single source of truth for response encoding.
// `payload` is constrained to object/array (never a bare primitive) so the
// encoder can't silently yield a non-string — JSON.stringify(undefined) returns
// undefined, which would violate the text-content contract. Per Codex review.
function jsonResult(
  payload: Record<string, unknown> | unknown[],
): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const LATE_REDETECT_DELAYS_MS = [1_000, 5_000, 30_000, 5 * 60_000];
let lateRedetectScheduled = false;

function emitDetectTrace(trigger: string, diagnosis: ReturnType<typeof diagnoseDetect> | null): void {
  if (!diagnosis) return;
  trace("detect_run", {
    trigger,
    winning_strategy: diagnosis.winning?.strategy ?? null,
    session_id: diagnosis.winning?.session_id ?? null,
    per_strategy: diagnosis.per_strategy,
    next_step: diagnosis.next_step,
  });
}

function scheduleLateRedetect(): void {
  if (lateRedetectScheduled) return;
  lateRedetectScheduled = true;
  LATE_REDETECT_DELAYS_MS.forEach((delay) => {
    // unref so these never keep the process alive past its natural lifetime
    setTimeout(() => {
      if (entry.client.session_id) return;
      const { client: refined, diagnosis } = enrichWithDiagnosis(entry.client, entry.started_at);
      emitDetectTrace(`retry+${delay}ms`, diagnosis);
      if (refined.session_id && refined.session_id !== entry.client.session_id) {
        entry.client = refined;
        register(entry);
      }
    }, delay).unref();
  });
}

// True only when every strategy that ran abstained for a structural reason —
// i.e. retries cannot recover this state (Claude env-stripped + 2+ agents).
function allAbstentionsStructural(diagnosis: DetectDiagnosis | null): boolean {
  if (!diagnosis) return false;
  const outcomes = Object.values(diagnosis.per_strategy);
  if (outcomes.length === 0) return false;
  return outcomes.every((o) => isAbstain(o) && o.structural === true);
}

function clientInfoEqual(a: ClientInfo, b: ClientInfo): boolean {
  return (
    a.type === b.type &&
    a.session_id === b.session_id &&
    a.transcript_path === b.transcript_path &&
    a.session_id_source === b.session_id_source &&
    a.cwd === b.cwd
  );
}

function mergeDetectedClient(current: ClientInfo, detected: ClientInfo): ClientInfo {
  // Session identity is monotonic after the first non-null value. Detection is
  // a bootstrap mechanism, not authority over an explicit claim or an already
  // adopted sticky claim. A stale MCP env var must not make get_my_session
  // rewrite a claimed session_id.
  if (!current.session_id) return detected;

  const type = detected.type !== "unknown" ? detected.type : current.type;
  const cwd = detected.cwd || current.cwd;
  const recomputedTranscript =
    type === "unknown" ? null : transcriptPathFor(type, current.session_id, cwd);

  return {
    ...detected,
    type,
    cwd,
    session_id: current.session_id,
    session_id_source: current.session_id_source,
    transcript_path: recomputedTranscript ?? current.transcript_path,
  };
}

function refineFromHandshake(trigger: string): ReturnType<typeof diagnoseDetect> | null {
  const info = server.server.getClientVersion();
  if (!info) return null;
  const { client: refined, diagnosis } = enrichWithDiagnosis(
    clientFromHandshake(info),
    entry.started_at,
  );
  emitDetectTrace(trigger, diagnosis);
  const merged = mergeDetectedClient(entry.client, refined);
  if (
    entry.client.session_id &&
    refined.session_id &&
    refined.session_id !== entry.client.session_id
  ) {
    trace("detect_preserved_existing_session_id", {
      trigger,
      existing_session_id: entry.client.session_id,
      existing_source: entry.client.session_id_source,
      detected_session_id: refined.session_id,
      detected_source: refined.session_id_source,
    });
  }
  if (!clientInfoEqual(merged, entry.client)) {
    entry.client = merged;
    register(entry);
  }
  // The handshake may have just revealed the client type (e.g. unknown→codex);
  // sticky recovery can apply now even if it couldn't at startup.
  maybeRecoverStickyClaim();
  return diagnosis;
}

server.server.oninitialized = (): void => {
  // Sweep pending-ask records orphaned by a prior session (an ask that timed out,
  // was never answered, and whose owner went away). gcPendingAsk otherwise only
  // runs on a later ask_peer timeout, so this startup sweep keeps the dir from
  // accumulating stale records. Best-effort; never throws.
  gcPendingAsk(defaultPendingAskDir(), Date.now());
  const diagnosis = refineFromHandshake("oninitialized");
  // After type is known via handshake, schedule retries to catch transcript files
  // that don't exist yet at handshake time. No-op if session_id is already set.
  if (!entry.client.session_id && entry.client.type !== "unknown") {
    if (allAbstentionsStructural(diagnosis)) {
      trace("detect_skip_retries", { reason: "all-structural" });
      return;
    }
    scheduleLateRedetect();
  }
};

server.registerTool(
  "list_project_sessions",
  {
    description:
      "List agent sessions in or under a project root, enriched with client_type, client_session_id, and each peer's `state` card (see set_my_state) — the cheapest way to see what peers are doing. Default shape: one `sessions[]` row per agent; key on `client_session_id`, not `name` (rows can share a name when peers share a tmux session). Pass `compact:true` for a de-duplicated shape that groups co-located agents under one `tmux_sessions[]` entry (smaller when several agents share a session). Pass project_root when known; omitted = best-effort inference from cwd.",
    inputSchema: {
      project_root: z
        .string()
        .optional()
        .describe(
          "Absolute path to the project root. Recommended. If omitted, the server walks up from its own cwd to the nearest .git ancestor.",
        ),
      compact: z
        .boolean()
        .optional()
        .describe(
          "When true, return the grouped `tmux_sessions[]` shape (shared tmux fields hoisted, agents nested) instead of the flat `sessions[]` rows. Default false keeps the backward-compatible flat shape.",
        ),
    },
  },
  async ({ project_root, compact }) => {
    const result = buildListResult({ project_root });
    return jsonResult(compact ? toCompactList(result) : result);
  },
);

server.registerTool(
  "read_session",
  {
    description:
      "Read a peer session's recent activity: a clean per-turn transcript for a recognized oxtail-aware client, else raw tmux pane text. BROWSE/DIAGNOSTIC ONLY — this is NOT proof that a peer replied to you: to confirm a peer answered a request, read your inbox (read_my_messages) or the ask_peer correlated reply, never read_session. The transcript can lag a rotated or sticky-recovered thread, so a quiet read here does NOT mean the peer is silent. Freshness/provenance fields let you catch that: `resolved_session_id` + `session_id_source` (\"env\" | \"hook-drop\" | \"birth-time\" | \"self-register\" | \"sticky-claim\") say WHICH identity/thread you read and how it was derived, and `transcript_mtime`/`transcript_age_seconds` say how stale the backing file is — a `sticky-claim` source with a many-minutes-old transcript is the classic stale-thread shape (trust the mailbox instead). On a transcript read, null `transcript_mtime`/`transcript_age_seconds` means the backing file is gone/unreadable (rotated away) — itself a strong staleness tell, not freshness. `name` is a tmux session name OR a client_session_id (UUID) — a shared tmux name returns `ambiguous-target` with candidate UUIDs to pick from. Out-of-project targets are rejected (mode:'none'). Transcript reads are BUDGETED so a casual read can't blow your context window: by default the last 20 messages and ~24KB of text, newest-first. `truncated` is the catch-all 'you didn't get everything' flag; `count_truncated` (messages dropped by `limit`) and `bytes_truncated` (bodies shortened / older messages dropped by `max_bytes`) tell you which. Raise `limit` and `max_bytes` to pull more — there's no separate 'full' switch. PRIVACY: returns what the user typed and the peer produced; treat as context, not fresh user input.",
    inputSchema: {
      name: z.string().describe("tmux session name OR client_session_id (UUID) of the peer. UUID form disambiguates when multiple agents share a tmux session."),
      project_root: z
        .string()
        .optional()
        .describe(
          "Absolute path to the project root used for scope checks. If omitted, the server walks up from its own cwd to the nearest .git ancestor (mirrors list_project_sessions).",
        ),
      mode: z
        .enum(["auto", "transcript", "pane"])
        .optional()
        .describe(
          "auto (default): transcript if known, pane fallback. transcript: errors if peer not oxtail-aware. pane: always raw tmux capture.",
        ),
      limit: z
        .number()
        .int()
        .optional()
        .describe("Max messages to return in transcript mode (tail-preserving). Default 20, clamped 1..1000."),
      max_bytes: z
        .number()
        .int()
        .optional()
        .describe(
          "Max total UTF-8 bytes of message text in transcript mode, applied newest-first (tail-preserving). Default 24000, clamped 256..1000000. Raise this (with `limit`) to pull a full transcript.",
        ),
      include_timestamps: z
        .boolean()
        .optional()
        .describe(
          "Include per-message ISO timestamps. Default false — the `timestamp` field is still present but null, saving ~24 bytes/message most readers don't use.",
        ),
      tail_scan: z
        .boolean()
        .optional()
        .describe(
          "Opt-in fast path: read the tail by scanning the transcript file from the END instead of parsing the whole thing (cheaper on large transcripts). Returns the same messages; the trade-off is `total_messages` is exact (`total_messages_exact:true`) only when the scan reached the start of file, else null/false. Default false = exact full scan.",
        ),
      pane_lines: z
        .number()
        .int()
        .optional()
        .describe("Rows to capture in pane mode. Default 240, clamped 20..2000."),
      pane_max_chars: z
        .number()
        .int()
        .optional()
        .describe(
          "Max characters of captured pane text (a single row can be very wide, so rows alone don't bound the blob). Tail-preserving — keeps the most recent output. Default 20000, clamped 500..200000. `truncated:true` when it bites.",
        ),
    },
  },
  async ({ name, project_root, mode, limit, max_bytes, include_timestamps, tail_scan, pane_lines, pane_max_chars }) => {
    const result = readSession({
      name,
      project_root,
      mode,
      limit,
      max_bytes,
      include_timestamps,
      tail_scan,
      pane_lines,
      pane_max_chars,
    });
    return jsonResult(result);
  },
);

// Pin a session_id onto our own registry entry and persist it. Shared by
// register_my_session (full entry dump in response) and claim_session (compact
// response). Re-derives tmux binding too: hosts that strip TMUX_PANE (e.g.
// Codex) leave the entry without tmux linkage at startup, which breaks peer
// discovery via list_project_sessions. Resolving here lets a self-heal happen
// on the same call the agent is already making.
function pinSessionId(sessionId: string): void {
  entry.client = {
    ...entry.client,
    session_id: sessionId,
    session_id_source: "self-register",
    transcript_path:
      entry.client.type === "unknown"
        ? entry.client.transcript_path
        : transcriptPathFor(entry.client.type, sessionId, entry.client.cwd),
  };
  refreshTmuxBinding(entry);
  register(entry);
  persistStickyClaim();
}

// Persist (or refresh) a sticky-claim record for the current entry, keyed by
// client_type + cwd + the MCP server's parent-host identity. Lets a restarted
// MCP child recover this session_id without the agent re-running claim_session.
// Best-effort: never let claim-store I/O block or fail a claim.
function persistStickyClaim(): void {
  const sid = entry.client.session_id;
  if (!sid || entry.client.type === "unknown") return;
  try {
    writeClaim({
      client_type: entry.client.type,
      cwd: entry.client.cwd,
      ancestors: resolveAncestors(),
      session_id: sid,
      transcript_path: entry.client.transcript_path,
      server_pid: entry.server_pid,
      claimed_at: Math.floor(Date.now() / 1000),
    });
  } catch {
    // best-effort
  }
}

// Startup recovery: when env- and birth-time detection both abstain (the
// common case for a restarted Codex MCP child — its session-id env var is
// stripped and its transcript predates this child's started_at), try to adopt
// the previously-claimed session_id for this exact (client_type, cwd, live
// parent). Conservative: recoverClaim only returns a record when it's
// unambiguously safe — exactly one matching claim whose transcript still exists.
// A live same-session_id sibling is NOT a conflict (it's the same agent's other
// MCP child), so recovery proceeds alongside it; otherwise we leave session_id
// null and the caller's next_step points at explicit claim_session.
function maybeRecoverStickyClaim(): void {
  if (entry.client.session_id || entry.client.type === "unknown") return;
  let rec: ReturnType<typeof recoverClaim> = null;
  try {
    rec = recoverClaim(entry.client.type, entry.client.cwd, resolveAncestors());
  } catch {
    return;
  }
  if (!rec) return;
  entry.client = {
    ...entry.client,
    session_id: rec.session_id,
    session_id_source: "sticky-claim",
    transcript_path: rec.transcript_path,
  };
  trace("sticky_claim_recovered", {
    session_id: rec.session_id,
    cwd: entry.client.cwd,
  });
  // Refresh the record so it carries our new server_pid going forward.
  persistStickyClaim();
  // Recovery mutates the in-memory registry entry. When recovery happens after
  // the MCP initialize handshake revealed the client type, we may already have
  // written a null-session entry; publish the recovered id immediately so peers
  // do not see this agent as unclaimed until another write happens.
  register(entry);
}

server.registerTool(
  "register_my_session",
  {
    description:
      "Pin this MCP server's session_id directly (registry entry updated in place + persisted). Escape hatch for when auto-detection can't resolve the id; get the value via `echo $CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID`) in a Bash tool subshell. Prefer `claim_session` for routine use — this stays for debugging.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .describe("The session id to record for this MCP server's owning agent."),
    },
  },
  async ({ session_id }) => {
    pinSessionId(session_id);
    return jsonResult({
      schema_version: 1,
      ok: true,
      entry: {
        server_pid: entry.server_pid,
        started_at: entry.started_at,
        tmux_session: entry.tmux_session,
        client: entry.client,
      },
    });
  },
);

server.registerTool(
  "claim_session",
  {
    description:
      "Single-shot replacement for register_my_session + get_my_session. Pins the session_id and returns the compact verification: { ok, session_id, transcript_path }. Use this in slash commands and skills; the routine ceremony is `Bash echo $CLAUDE_CODE_SESSION_ID` (or `$CODEX_THREAD_ID`) → claim_session. Saves a round-trip and avoids dumping the full entry into the agent's context.",
    inputSchema: {
      session_id: z
        .string()
        .min(1)
        .describe("The session id to record for this MCP server's owning agent."),
    },
  },
  async ({ session_id }) => {
    pinSessionId(session_id);
    return jsonResult({
      schema_version: 1,
      ok: true,
      session_id: entry.client.session_id,
      transcript_path: entry.client.transcript_path,
    });
  },
);

server.registerTool(
  "get_my_session",
  {
    description:
      "Returns this MCP server's own registry entry plus a per-strategy detection diagnosis. Each strategy returns either a hit ({session_id, source, confidence}) or an abstention ({abstain: true, reason}); the reason explains *why* the strategy didn't fire so you don't have to guess. When `winning` is null, follow `next_step` (which gives you the exact bash command to read your session id and the tool to call with it) — do not investigate each strategy individually. Both env and birth-time can be designed-null in normal operation: env is structurally null on Claude Code, and birth-time is null whenever 2+ agents share a project — hook-drop (the SessionStart auto-join, v0.17) covers exactly that gap when the hooks are installed.",
    inputSchema: {},
  },
  async () => {
    // Some MCP clients make getClientVersion available before the oninitialized
    // callback has run. Refining here makes the first explicit self-check repair
    // type/session state instead of returning a transient unknown/null registry
    // entry.
    refineFromHandshake("get_my_session");
    let diagnosis;
    if (entry.client.session_id) {
      // Registry is authoritative. Skip detection I/O entirely and surface
      // cached state — agents shouldn't be pushed toward re-registering. The
      // strategy mirrors session_id_source so callers can still see whether
      // env / birth-time / self-register resolved this entry.
      const source = entry.client.session_id_source ?? "self-register";
      // Report confidence honestly per source: env and explicit self-register
      // (claim_session) are authoritative ("high"); inferred sources (birth-time,
      // sticky-claim) are "medium" — matching what the detect strategies return.
      const confidence: "high" | "medium" =
        source === "env" || source === "self-register" ? "high" : "medium";
      diagnosis = {
        per_strategy: {},
        winning: {
          session_id: entry.client.session_id,
          source,
          confidence,
          strategy: source,
        },
        next_step: null,
      };
    } else {
      // Unresolved: run the same detection path oninitialized uses, then
      // persist if a late win materialized so the next call takes the cached
      // path above.
      const { client: refined, diagnosis: live } = enrichWithDiagnosis(
        entry.client,
        entry.started_at,
      );
      if (refined.session_id && refined.session_id !== entry.client.session_id) {
        entry.client = refined;
        register(entry);
      }
      diagnosis = live ?? { per_strategy: {}, winning: null, next_step: null };
    }
    return jsonResult({
      schema_version: 1,
      entry: {
        server_pid: entry.server_pid,
        started_at: entry.started_at,
        tmux_pane: entry.tmux_pane,
        tmux_session: entry.tmux_session,
        client: entry.client,
        state: entry.state,
      },
      detect_diagnosis: diagnosis,
    });
  },
);

server.registerTool(
  "set_my_state",
  {
    description:
      "Write a small state card onto this MCP server's registry entry so peers can see what we're doing without reading our transcript. Currently surfaces a single field, `purpose` (≤200 chars) — a one-sentence \"what is this agent working on right now\" line. Other fields will be added if real friction surfaces. State is visible in `list_project_sessions` rows. Calling with no fields is a touch: bumps `updated_at` without changing content.",
    inputSchema: {
      purpose: z
        .string()
        .max(200)
        .optional()
        .describe(
          "One-sentence description of what this agent is currently working on. ≤200 chars. Omit to leave existing purpose unchanged.",
        ),
    },
  },
  async ({ purpose }) => {
    const next: StateCard = {
      purpose: purpose !== undefined ? purpose : (entry.state?.purpose ?? null),
      updated_at: Math.floor(Date.now() / 1000),
    };
    entry.state = next;
    register(entry);
    return jsonResult({ schema_version: 1, ok: true, state: next });
  },
);

// ────────────────────────────────────────────────────────────────────────────
// send_message / read_my_messages (v0.5)
// ────────────────────────────────────────────────────────────────────────────

// Where to deliver to this peer. Routing keys on the peer's ADVERTISED
// session_keyed capability: a pre-v0.17 reader only drains pid boxes, so
// session-box mail would never reach it (see delivery.ts).
function routeFor(peer: RegistryEntry): DeliveryRoute {
  return {
    session_id: peer.client.session_id,
    server_pid: peer.server_pid,
    session_keyed: peer.capabilities?.mailbox?.session_keyed === true,
  };
}

// Our own inbox route, for self re-delivery (ask_peer abort recovery). We are
// by definition session_keyed-capable when claimed.
function selfRoute(): DeliveryRoute {
  return {
    session_id: entry.client.session_id,
    server_pid: entry.server_pid,
    session_keyed: !!entry.client.session_id,
  };
}

// The union of boxes this session's inbound mail can live in: the SESSION box
// (canonical v0.17+ inbox, what capable senders write), plus every sibling/
// previous MCP-child pid box still holding legacy traffic, plus our own pid as
// a floor (pre-claim sends land there). Order matters for the legacy ask_peer
// fallback: own pid first among the numeric boxes.
function inboxBoxes(ownPid: number, sessionId: string | null | undefined): mailbox.BoxId[] {
  if (!sessionId) return [ownPid];
  return [
    mailbox.mailboxSessionKey(sessionId),
    ownPid,
    ...sessionPidsForId(sessionId).filter((p) => p !== ownPid),
  ];
}

server.registerTool(
  "send_message",
  {
    description: [
      "Fire-and-forget message to a peer in the same project root. Target: a tmux session name OR a client_session_id (UUID). Async via the peer's mailbox — delivered mid-turn (PreToolUse hook) or next-turn (read_my_messages); cross-project targets are rejected.",
      "A plain message does NOT wake an idle peer. Pass wake:\"auto\" to nudge one via per-client send-keys, state-gated (skipped if the peer is mid-turn). EXCEPTION (wake-on-reply): when you set reply_to, this auto-wakes the requester by default so your answer doesn't strand them idle — pass wake:\"off\" to suppress. The reply-default wake is strictly gated: it fires only for a FRESHLY-IDLE requester (one whose Claude Code hooks maintain a fresh idle marker), with a per-target rate limit and a one-wake dedupe; env kill-switch OXTAIL_AUTOWAKE=off. A requester with no idle marker (Codex, or Claude without the hooks) returns skipped_no_fresh_idle and is NOT auto-woken — use explicit wake:\"auto\" for those. Response carries wake_status (\"fired\" | \"skipped_busy\" | \"skipped_debounced\" | \"skipped_no_fresh_idle\" | \"skipped_rate_limited\" | \"skipped_deduped\" | \"skipped_store_error\" | \"skipped_no_target\" | \"disabled\") and, on the reply path, wake_reason:\"reply_to_default\" — or wake_reason:\"late_reply_to_pending\" when this reply answers an ask_peer that had timed out (durably pulls the requester back regardless of the fresh-idle window; \"late_reply_to_pending_suppressed\" if you passed wake:\"off\").",
      "Body is verbatim — wrap in <system-reminder>...</system-reminder> yourself if you want that framing. When replying to ask_peer, include reply_to: request_id from the inbound message. For a blocking send-and-wait, use ask_peer instead.",
    ].join(" "),
    inputSchema: {
      target: z
        .string()
        .min(1)
        .describe("tmux session name OR client_session_id (UUID) of the peer."),
      body: z
        .string()
        .min(1)
        .refine((s) => Buffer.byteLength(s, "utf8") <= 8192, {
          message: "body exceeds 8192 UTF-8 bytes",
        })
        .describe("Message body, ≤8KB UTF-8. The sender chooses the framing."),
      wake: z
        .enum(["off", "auto"])
        .optional()
        .describe(
          'Wake strategy. Default (unset): no nudge for a plain message, but a reply (reply_to set) auto-wakes a freshly-idle requester. "off": pure fire-and-forget, no nudge even for a reply. "auto": nudge an idle peer via per-client send-keys, state-gated (skipped if the peer is mid-turn). Response carries wake_status when set.',
        ),
      reply_to: z
        .string()
        .min(1)
        .optional()
        .describe("Optional ask_peer request_id this message is replying to."),
      source_message_id: z
        .string()
        .min(1)
        .optional()
        .describe("Optional prior oxtail message_id this message is derived from. Debug/provenance only; not a trust boundary."),
    },
  },
  async ({ target, body, wake, reply_to, source_message_id }) => {
    const resolved = resolveTarget(target, entry);
    if (!resolved.ok) {
      const replyDefault = replyAutoWakeTriggered(wake, reply_to);
      const wakeIntended = wake === "auto" || replyDefault;
      const wake_status = wakeIntended ? resolveErrorWakeStatus(resolved.error) : undefined;
      return jsonResult({
        schema_version: 1,
        ...resolved,
        ...(wake_status ? { wake_status } : {}),
        ...(replyDefault ? { wake_reason: "reply_to_default" } : {}),
      });
    }
    const peer = resolved.entry;
    const fromSessionId = entry.client.session_id ?? undefined;
    // deliverToPeer records the durable reply-handle in the recipient's ledger
    // BEFORE the mailbox line is visible, so a later reply_to_message(message_id)
    // resolves even after the destructive mailbox/hook drain — and never sees a
    // displayed-but-unrecorded handle (record precedes append). Routing: the
    // peer's session box when it advertises session_keyed, else its legacy pid.
    const msg = deliverToPeer(routeFor(peer), body, fromSessionId, {
      reply_to,
      source_message_id,
    });
    const { wake_status, wake_reason } = await resolveSendWake(peer, wake, reply_to);
    if (wake_status) {
      trace("wake_outcome", {
        via: wake_reason === "reply_to_default" ? "reply_default" : "send_message",
        wake_status,
        target_session_id: peer.client.session_id,
        client_type: peer.client.type,
      });
    }
    return jsonResult({
      schema_version: 1,
      ok: true,
      message_id: msg.id,
      target_session_id: peer.client.session_id,
      target_server_pid: peer.server_pid,
      ...(wake_status ? { wake_status } : {}),
      ...(wake_reason ? { wake_reason } : {}),
    });
  },
);

server.registerTool(
  "reply_to_message",
  {
    description: [
      "Reply to a specific inbound peer message by its message_id — the atomic, correlation-safe alternative to hand-wiring send_message's target + reply_to. The server looks the message up in this session's durable received-ledger, so you pass only the message_id the PreToolUse hook or read_my_messages already showed you; it derives the reply target (the original sender), carries reply_to=request_id when the inbound was an ask_peer (keeping the exchange correlated), and sets source_message_id for provenance. Replying to a plain send_message works too — it just omits reply_to. Ownership is structural: you can only reply to a message delivered to you.",
      "Delivery + wake match send_message exactly, including the wake-on-reply default: when the inbound carried a request_id and you leave wake unset, a freshly-idle requester is auto-woken; pass wake:\"auto\" to nudge any idle peer, or wake:\"off\" to suppress. If the inbound ask_peer had since timed out, this reply durably pulls the requester back (wake_reason late_reply_to_pending) regardless of the fresh-idle window. Fail-closed: an unknown or aged-out message_id returns error message-not-found instead of guessing a target.",
    ].join(" "),
    inputSchema: {
      message_id: z
        .string()
        .min(1)
        .describe(
          "The message_id of the inbound peer message you are replying to, as shown by the PreToolUse hook or read_my_messages.",
        ),
      body: z
        .string()
        .min(1)
        .refine((s) => Buffer.byteLength(s, "utf8") <= 8192, {
          message: "body exceeds 8192 UTF-8 bytes",
        })
        .describe("Reply body, ≤8KB UTF-8. Verbatim."),
      wake: z
        .enum(["off", "auto"])
        .optional()
        .describe(
          'Wake strategy, same semantics as send_message. Unset: wake-on-reply default (auto-wakes a freshly-idle requester when the inbound was an ask_peer). "auto": nudge any idle peer. "off": no nudge.',
        ),
    },
  },
  async ({ message_id, body, wake }) => {
    const myId = entry.client.session_id;
    if (!myId) {
      return jsonResult({
        schema_version: 1,
        ok: false,
        error: "no-session-id",
        message:
          "This session has not claimed a session_id, so it has no received-ledger to reply from. Call claim_session first.",
      });
    }
    const inbound = received.lookupReceived(myId, message_id);
    if (!inbound) {
      return jsonResult({
        schema_version: 1,
        ok: false,
        error: "message-not-found",
        message: `No received message ${message_id} in this session's ledger (it may have aged out of retention, or predates reply_to_message). Fall back to send_message with an explicit target.`,
      });
    }
    const targetSid = inbound.from_session_id;
    if (!targetSid) {
      return jsonResult({
        schema_version: 1,
        ok: false,
        error: "no-reply-target",
        message: `Inbound message ${message_id} has no from_session_id, so there is no peer to reply to.`,
      });
    }
    const replyTo = inbound.request_id; // undefined when the inbound was a plain send_message
    const resolved = resolveTarget(targetSid, entry);
    if (!resolved.ok) {
      const replyDefault = replyAutoWakeTriggered(wake, replyTo);
      const wakeIntended = wake === "auto" || replyDefault;
      const wake_status = wakeIntended ? resolveErrorWakeStatus(resolved.error) : undefined;
      return jsonResult({
        schema_version: 1,
        ...resolved,
        in_reply_to_message_id: message_id,
        original_from_session_id: targetSid,
        ...(wake_status ? { wake_status } : {}),
        ...(replyDefault ? { wake_reason: "reply_to_default" } : {}),
      });
    }
    const peer = resolved.entry;
    const fromSessionId = entry.client.session_id ?? undefined;
    // Record the reply itself into the original asker's ledger (record-before-
    // append) so replies can be replied to in turn — chained correlation.
    const msg = deliverToPeer(routeFor(peer), body, fromSessionId, {
      reply_to: replyTo,
      source_message_id: message_id,
    });
    const { wake_status, wake_reason } = await resolveSendWake(peer, wake, replyTo);
    if (wake_status) {
      trace("wake_outcome", {
        via: wake_reason === "reply_to_default" ? "reply_default" : "reply_to_message",
        wake_status,
        target_session_id: peer.client.session_id,
        client_type: peer.client.type,
      });
    }
    return jsonResult({
      schema_version: 1,
      ok: true,
      message_id: msg.id,
      in_reply_to_message_id: message_id,
      target_session_id: peer.client.session_id,
      target_server_pid: peer.server_pid,
      correlation: replyTo ? "correlated" : "uncorrelated",
      ...(wake_status ? { wake_status } : {}),
      ...(wake_reason ? { wake_reason } : {}),
    });
  },
);

// read_my_messages budget. A session's union drain can return a backlog; cap
// how much one call hands back so a flood (or a peer spamming near-8KB bodies)
// can't blow the caller's context in a single drain. Overflow is NOT dropped or
// body-truncated — whole messages beyond the budget are re-queued to the
// caller's own mailbox and delivered on the next call/hook (lossless). At least
// one message is always returned so the queue makes progress.
const READ_MAX_MESSAGES = (() => {
  const n = Number(process.env.OXTAIL_READ_MAX_MESSAGES);
  return Number.isFinite(n) && n > 0 ? n : 50;
})();
const READ_MAX_BODY_BYTES = (() => {
  const n = Number(process.env.OXTAIL_READ_MAX_BODY_BYTES);
  return Number.isFinite(n) && n > 0 ? n : 65_536;
})();

function budgetMessages(all: mailbox.Mailbox[]): {
  messages: mailbox.Mailbox[];
  deferred: mailbox.Mailbox[];
} {
  const messages: mailbox.Mailbox[] = [];
  const deferred: mailbox.Mailbox[] = [];
  let bytes = 0;
  for (const m of all) {
    const b = m.body_bytes ?? Buffer.byteLength(m.body, "utf8");
    const wouldOverflow =
      messages.length >= READ_MAX_MESSAGES ||
      (messages.length > 0 && bytes + b > READ_MAX_BODY_BYTES);
    if (wouldOverflow) {
      deferred.push(m);
    } else {
      messages.push(m);
      bytes += b;
    }
  }
  return { messages, deferred };
}

server.registerTool(
  "read_my_messages",
  {
    description:
      "Drain this session's mailbox and return any messages peers have sent via send_message. Codex peers (and any Claude Code peer without the PreToolUse hook) receive messages through this tool rather than auto-injection — but do NOT idle-poll it in a sleep loop, and do NOT fire a blocking ask_peer just to provoke traffic. Delivery is sender-driven: for anything needing prompt action the SENDER must wake you (ask_peer, or send_message/reply_to_message with wake:auto); a wake that reaches your idle, resolvable pane send-keys-re-invokes you, and you call this once at the start of that turn, act, then end your turn. The wake is best-effort, not guaranteed: if a message arrives while you are mid-turn the wake is skipped (skipped_busy) and it waits in your mailbox — so one read at a turn boundary (your manual equivalent of the Claude Stop hook) is reasonable to catch what landed while you were busy; a tight idle loop is not. A plain wake-less send_message is passive inbox traffic: don't stay alive to watch for it — you'll see it the next time you're invoked for any reason. Claude Code peers with the hooks installed will see messages mid-turn or at turn end instead, so after hook delivery this tool may return count:0 because the hook already drained and injected those messages. Drains the UNION of this session's sibling/previous MCP-child mailboxes (keyed by session_id, mirroring the hook) so a message sent to a prior pid survives a restart. Budgeted: a large backlog is returned in chunks (overflow is re-queued losslessly, never dropped), reported via deferred_count. Always safe to call — returns an empty list when the mailbox is empty.",
    inputSchema: {},
  },
  async () => {
    const sid = entry.client.session_id;
    // Union by identity: the session box (canonical v0.17+ inbox) plus every
    // sibling/previous pid box still holding legacy traffic, plus our own pid
    // as a guaranteed floor. Mirrors the hook. Unclaimed child: own pid only.
    const boxes = inboxBoxes(entry.server_pid, sid);
    const { messages: drained, skipped } = mailbox.drainMany(boxes);
    // Merge chronologically; stable sort keeps drainMany's session-box-first /
    // oldest-pid-first order for same-second ties.
    drained.sort((a, b) => a.enqueued_at - b.enqueued_at);
    const { messages: budgeted, deferred } = budgetMessages(drained);
    // Lossless overflow: re-home deferred whole messages to our own inbox for
    // the next drain/hook in one atomic append — the session box when claimed
    // (so they survive a pid rotation while parked), else our own pid box. If
    // THAT fails (the originals are already drained off disk), fall back to
    // returning the overflow inline this once — exceeding the budget beats
    // dropping messages. Bodies never truncated.
    let messages = budgeted;
    let deferredCount = deferred.length;
    if (deferred.length > 0) {
      try {
        mailbox.requeueMany(
          sid ? mailbox.mailboxSessionKey(sid) : entry.server_pid,
          deferred,
        );
      } catch {
        messages = [...budgeted, ...deferred];
        deferredCount = 0;
      }
    }
    return jsonResult({
      schema_version: 1,
      ok: true,
      drained: true,
      count: messages.length,
      messages,
      ...(deferredCount ? { deferred_count: deferredCount, budget_truncated: true } : {}),
      ...(skipped ? { mailboxes_skipped: skipped } : {}),
    });
  },
);

// ask_peer (v0.6, hardened in v0.10): blocking send + wait-for-reply. Builds on
// send_message's mailbox path: enqueue a message to the target peer with a
// request_id, wake them, then poll until a correlated reply lands or the timeout
// elapses. Reply-to-capable peers must reply with reply_to=request_id; legacy
// peers fall back to the original from_session_id-only matching.
//
// User-tunable override via OXTAIL_ASK_PEER_TIMEOUT_MS; defaults to 60000ms.
// 60s covers a slower multi-tool-call peer reply (a Codex peer composing
// set_my_state + reply_to_message + a report was observed at ~46s and falsely
// timed out under the old 45s default) while staying under both known callers'
// tool-call abort windows: Claude Code is clean to ~60s, Codex aborts ~120s.
// Set to a lower value if your client aborts before our timeout fires.
const ASK_PEER_TIMEOUT_MS = (() => {
  const env = process.env.OXTAIL_ASK_PEER_TIMEOUT_MS;
  if (!env) return 60_000;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();
const ASK_PEER_GRACE_MS = 500;
const ASK_PEER_POLL_MS = 200;
// Ceiling for the per-call `timeout_ms` override. A server-side wait longer
// than the CLIENT's own tool-call abort window makes the client kill the
// tools/call (a hard error: "tool call failed after Ns") instead of letting
// ask_peer return its graceful {reply:null, timed_out:true}. Observed: Codex
// aborts around 120s. 100s stays safely under common client limits. Raise via
// OXTAIL_ASK_PEER_MAX_TIMEOUT_MS only if your client tolerates longer waits.
const ASK_PEER_MAX_TIMEOUT_MS = (() => {
  const env = process.env.OXTAIL_ASK_PEER_MAX_TIMEOUT_MS;
  if (!env) return 100_000;
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : 100_000;
})();
function askPeerDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Poll my inbox at ASK_PEER_POLL_MS until a matching reply lands or the
// deadline elapses. Each tick checks mtime first and only acquires the
// mailbox lock when there's a probable hit. The lock is held only inside
// drainMatchingSession (sub-10ms) — never across the poll interval, so the
// PreToolUse hook on subsequent caller tool calls is never starved.
// The requester's inbox union (session box + own pid + siblings) is recomputed
// at the final drain so a sibling that appeared DURING the wait is covered.
async function askPeerPoll(
  boxes: mailbox.BoxId[],
  ownPid: number,
  from_session_id: string,
  request_id: string,
  require_reply_to: boolean,
  deadlineMs: number,
  signal: AbortSignal,
): Promise<mailbox.Mailbox | null> {
  // Watch the mtime of EVERY inbox box (the reply's landing box depends on the
  // REPLIER's version: a v0.17+ peer writes our session box, an old peer writes
  // a sibling pid), draining only when a file that exists has changed — so the
  // lock is acquired on a probable hit, never every tick.
  const lastMtimes = new Map<mailbox.BoxId, number>();
  while (Date.now() < deadlineMs) {
    if (signal.aborted) throw new Error("aborted");
    let changed = false;
    for (const box of boxes) {
      let m = -1;
      try {
        m = statSync(mailbox.mailboxFilePath(box)).mtimeMs;
      } catch {
        // ENOENT: mailbox file not created yet
      }
      if (m !== -1 && lastMtimes.get(box) !== m) changed = true;
      lastMtimes.set(box, m);
    }
    if (changed) {
      const reply = drainAskPeerReply(boxes, ownPid, from_session_id, request_id, require_reply_to);
      if (reply) return reply;
    }
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    await askPeerDelay(Math.min(ASK_PEER_POLL_MS, remaining), signal);
  }
  return null;
}

function drainAskPeerReply(
  boxes: mailbox.BoxId[],
  ownPid: number,
  from_session_id: string,
  request_id: string,
  require_reply_to: boolean,
): mailbox.Mailbox | null {
  // Correlated peers: union-drain by reply_to across the requester's inbox.
  // Legacy/uncorrelated peers: keep the best-effort own-pid session match (no
  // request_id to correlate the union safely — and a legacy peer's server only
  // ever enqueues to pid boxes anyway).
  return require_reply_to
    ? mailbox.drainMatchingReplyMany(boxes, from_session_id, request_id)
    : mailbox.drainMatchingSession(ownPid, from_session_id);
}

server.registerTool(
  "ask_peer",
  {
    description: [
      "Delegate-and-wait: enqueue a message to a peer in the same project root, wake them, and block until they reply (via send_message) or the timeout elapses. Use this for back-and-forth; use send_message for fire-and-forget.",
      "Wakes the peer via per-client tmux send-keys (Codex gets a paste-burst-aware gap, Claude Code doesn't), then polls for a reply. For reply_to-capable peers, only from_session_id + reply_to == request_id satisfies the wait; legacy peers fall back to best-effort from_session_id matching and the response reports correlation:\"uncorrelated\". Response carries wake_status: \"fired\" | \"skipped_busy\" | \"skipped_no_target\" | \"disabled\" (skipped_unsupported is reserved). A peer that is mid-turn is NOT keystroke-woken (skipped_busy) — its hook/poll delivers the enqueued message and we still poll for the reply. Returns reply: null, timed_out: true on timeout (default 60000ms, override per call with timeout_ms, or set OXTAIL_ASK_PEER_TIMEOUT_MS at startup). timeout_ms is clamped to a safe ceiling (default 100000ms, env OXTAIL_ASK_PEER_MAX_TIMEOUT_MS) so the wait can't outlast the client's tool-call abort window — exceeding it makes the client hard-fail the call instead of returning graceful timed_out; the response reports timeout_clamped_from_ms when clamped. DURABLE DELEGATION: on timeout (correlated peers, claimed requester), the request is recorded as a pending obligation, so when the peer's reply finally arrives — minutes or hours later — it WAKES you back (wake_reason late_reply_to_pending), not just landing silently in read_my_messages. So ask_peer is safe for long tasks: let it time out, end your turn, get pulled back when the work is done.",
      "Target must have a registered client.session_id (Codex peers call claim_session first). Body is verbatim — frame it as an assignment (objective + requested action) so it reads as delegation, not chat. Wake overridable via OXTAIL_ASK_PEER_WAKE_STRATEGY=auto|legacy|off.",
    ].join(" "),
    inputSchema: {
      target: z
        .string()
        .min(1)
        .describe("tmux session name OR client_session_id (UUID) of the peer."),
      body: z
        .string()
        .min(1)
        .refine((s) => Buffer.byteLength(s, "utf8") <= 8192, {
          message: "body exceeds 8192 UTF-8 bytes",
        })
        .describe("Message body, ≤8KB UTF-8."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(300_000)
        .optional()
        .describe(
          "Optional per-call timeout in milliseconds. Clamped to a safe ceiling " +
            "(default 100000ms, env OXTAIL_ASK_PEER_MAX_TIMEOUT_MS) so the wait can't " +
            "outlast the client's tool-call abort window; the response reports " +
            "timeout_clamped_from_ms when clamped.",
        ),
    },
  },
  async ({ target, body, timeout_ms }, extra) => {
    const resolved = resolveTarget(target, entry);
    if (!resolved.ok) {
      const wake_status = resolveErrorWakeStatus(resolved.error);
      return jsonResult({
        schema_version: 1,
        ...resolved,
        ...(wake_status ? { wake_status } : {}),
      });
    }
    const peer = resolved.entry;
    const expectedSessionId = peer.client.session_id;
    if (!expectedSessionId) {
      return jsonResult({
        schema_version: 1,
        ok: false,
        error: "peer-has-no-session-id",
        message:
          "Target peer has no registered client.session_id. Ask the peer to call register_my_session before retrying ask_peer.",
      });
    }

    const requestId = randomBytes(8).toString("hex");
    const requireReplyTo = peerSupportsReplyTo(peer);
    const fromSessionId = entry.client.session_id ?? undefined;
    // The reply is addressed to OUR session_id; which box it lands in depends
    // on the REPLIER's version (session box from v0.17+ peers, a sibling pid
    // from older ones). Watch/drain the whole inbox union, mirroring
    // read_my_messages.
    const myBoxes = inboxBoxes(entry.server_pid, fromSessionId);
    // Record-before-append (mirrors send_message): lets the peer answer with
    // reply_to_message(message_id) instead of hand-wiring target + reply_to.
    const msg = deliverToPeer(routeFor(peer), body, fromSessionId, {
      request_id: requestId,
    });
    const startedAt = Date.now();
    const requestedTimeoutMs = timeout_ms ?? ASK_PEER_TIMEOUT_MS;
    // Clamp below the client tool-call abort window: a longer wait would make
    // the client hard-fail the tools/call instead of receiving our graceful
    // timed_out response. Surface the clamp so the caller isn't surprised.
    const effectiveTimeoutMs = Math.min(requestedTimeoutMs, ASK_PEER_MAX_TIMEOUT_MS);
    const timeoutClamped = effectiveTimeoutMs < requestedTimeoutMs;
    const deadlineMs = startedAt + effectiveTimeoutMs;
    trace("ask_peer_start", {
      target_session_id: expectedSessionId,
      message_id: msg.id,
      request_id: requestId,
      require_reply_to: requireReplyTo,
    });

    let reply: mailbox.Mailbox | null = null;
    let aborted = false;
    let wakeStatus: WakeStatus = "skipped_no_target";
    try {
      // Grace window: rare hook-delivery path. If peer was mid-tool-call when
      // our outbound arrived, their hook delivered it as additionalContext and
      // their response may already be in our mailbox.
      await askPeerDelay(ASK_PEER_GRACE_MS, extra.signal);
      reply = drainAskPeerReply(
        myBoxes,
        entry.server_pid,
        expectedSessionId,
        requestId,
        requireReplyTo,
      );

      if (!reply) {
        // Common path: peer was idle. Route the wake per client_type, but skip
        // the keystroke if the peer is FRESHLY busy (mid-turn): typing into a
        // busy composer is noise — its hook/poll will deliver the message we
        // already enqueued, and we still poll for the reply below. Mirrors
        // send_message wake:auto. (Codex has no activity file, so it is never
        // detected busy and still fires — unchanged for that client.)
        wakeStatus = await wakeForSend(peer);
        trace("wake_outcome", {
          via: "ask_peer",
          wake_status: wakeStatus,
          target_session_id: peer.client.session_id,
          client_type: peer.client.type,
        });
        if (wakeStatus === "skipped_unsupported") {
          // Reserved branch. No client currently returns skipped_unsupported
          // in auto mode (Codex and Claude Code both wake via send-keys).
          // Kept in the type for forward compat: if a future client_type
          // lands that genuinely cannot be woken externally, wakePeer() can
          // return this and the caller fail-fasts instead of polling.
        } else {
          reply = await askPeerPoll(
            myBoxes,
            entry.server_pid,
            expectedSessionId,
            requestId,
            requireReplyTo,
            deadlineMs,
            extra.signal,
          );
        }
      } else {
        // Reply arrived during grace window — peer was already mid-turn and
        // the hook delivered the outbound to it as additionalContext.
        wakeStatus = "fired";
      }
    } catch (e) {
      if ((e as Error).message === "aborted") {
        aborted = true;
      } else {
        throw e;
      }
    }

    // Abort recovery: if the client aborted us between drain and response
    // delivery, the reply is in memory but has been removed from the mailbox.
    // Re-enqueue so it's not lost.
    if (aborted && reply) {
      try {
        // Re-deliver the EXISTING reply: preserve reply.id and (re)write the
        // requester's received-ledger entry so reply_to_message against the
        // displayed id still resolves. mailbox.enqueue would mint a NEW id and
        // skip the ledger, breaking the reply handle on the abort path.
        deliverExistingToPeer(selfRoute(), reply);
        trace("ask_peer_abort_reenqueue", { message_id: reply.id });
      } catch (e) {
        trace("ask_peer_abort_reenqueue_failed", {
          message_id: reply.id,
          error: String(e),
        });
      }
      // Throw to signal the framework that the request did not complete.
      throw new Error("ask_peer aborted by client");
    }

    // timed_out is reserved for "we waited and got nothing" — i.e. we actually
    // polled to the deadline. A fail-fast for an unwakeable client (no poll
    // attempted) is NOT a timeout; the message has been enqueued and will be
    // delivered when the peer next enters a turn.
    const polled = wakeStatus !== "skipped_unsupported";

    // Durable delegation: we polled to the deadline with no reply. Record a
    // pending obligation FIRST, then do one final authoritative UNION drain —
    // write-before-final-drain closes the poll-vs-deadline TOCTOU. A reply that
    // landed in the gap is caught here and returned now; a reply that arrives
    // AFTER finds the persisted record and pulls us back via resolveSendWake's
    // late_reply_to_pending path — even minutes/hours later, and even for a
    // markerless idle Codex requester. Correlated peers + claimed requester only.
    if (polled && reply === null && !aborted && requireReplyTo) {
      if (fromSessionId) {
        const dir = defaultPendingAskDir();
        // Opportunistic sweep so abandoned records (a reply that never came)
        // can't accumulate — mirrors gcAutowake inside decideReplyAutoWake.
        gcPendingAsk(dir, Date.now());
        // Write the pending obligation BEFORE the final drain (write-before-
        // final-drain): a reply that lands after the drain finds this record and
        // wakes us via resolveSendWake; one that landed before is caught below.
        if (!recordPendingAsk(dir, fromSessionId, requestId, Date.now())) {
          // Store unwritable → silently degrades to the read_my_messages path
          // (no durable pull-back). Surface it so the degradation is observable.
          trace("ask_peer_pending_record_failed", { request_id: requestId });
        }
        // Authoritative final drain. Recompute the inbox union NOW — a sibling
        // MCP child may have appeared during the wait. Use the CHECKED variant
        // and retry any box we couldn't inspect (transient lock): silently
        // treating "couldn't read" as "no reply" would leave the record with no
        // later event to consume it → a stranded pull-back.
        const finalBoxes = inboxBoxes(entry.server_pid, fromSessionId);
        let drained = mailbox.drainMatchingReplyManyChecked(finalBoxes, expectedSessionId, requestId);
        if (drained.skipped.length > 0) {
          // A box we couldn't inspect might hold either the already-landed reply
          // (if we have none yet) OR a migrate-crash duplicate of the reply we DID
          // pull (which a later read_my_messages would re-deliver). Retry once
          // after a brief delay for the lock to clear.
          try {
            await askPeerDelay(ASK_PEER_POLL_MS, extra.signal);
            if (!drained.reply) {
              drained = mailbox.drainMatchingReplyManyChecked(
                drained.skipped,
                expectedSessionId,
                requestId,
              );
              if (!drained.reply && drained.skipped.length > 0) {
                // Still un-inspectable after the retry: a lock held past the
                // acquire budget + retry (SIGSTOP-class / long holder). diagnose
                // can use this to tell "no reply" from "a reply may sit behind a
                // locked pid" — the record persists, so a later send still wakes.
                trace("ask_peer_skipped_after_final_retry", {
                  request_id: requestId,
                  skipped: drained.skipped,
                });
              }
            } else {
              // We have the reply — sweep only its exact id from the skipped pids
              // (a distinct second reply, different id, is left for read_my_messages).
              mailbox.sweepMessageId(drained.skipped, drained.reply.id);
            }
          } catch {
            // aborted during the brief retry delay — leave the record; we return
            // timed_out and the reply still delivers via read_my_messages.
          }
        }
        if (drained.reply) {
          consumePendingAsk(dir, fromSessionId, requestId);
          reply = drained.reply;
          trace("ask_peer_late_catch", { request_id: requestId, message_id: drained.reply.id });
        }
      } else {
        // Unclaimed requester: a peer can't correlate/reply_to_message back to
        // us, so there's nothing to durably wake — surface it rather than guess.
        trace("ask_peer_pending_skipped_unclaimed", { request_id: requestId });
      }
    }

    const timedOut = polled && reply === null;
    trace("ask_peer_end", {
      target_session_id: expectedSessionId,
      message_id: msg.id,
      request_id: requestId,
      duration_ms: Date.now() - startedAt,
      wake_status: wakeStatus,
      timed_out: timedOut,
      correlation: reply ? (requireReplyTo ? "correlated" : "uncorrelated") : "none",
    });

    return jsonResult({
      schema_version: 1,
      ok: true,
      message_id: msg.id,
      request_id: requestId,
      wake_status: wakeStatus,
      reply: reply
        ? {
            id: reply.id,
            body: reply.body,
            enqueued_at: reply.enqueued_at,
            from_session_id: reply.from_session_id ?? null,
            reply_to: reply.reply_to ?? null,
            correlation: requireReplyTo ? "correlated" : "uncorrelated",
          }
        : null,
      correlation: reply ? (requireReplyTo ? "correlated" : "uncorrelated") : "none",
      timeout_ms: effectiveTimeoutMs,
      ...(timeoutClamped ? { timeout_clamped_from_ms: requestedTimeoutMs } : {}),
      timed_out: timedOut,
    });
  },
);

// Hook-install hint, emitted once per server startup. Warns in two cases:
//   - absent: no `_oxtailHook` marker → hooks never installed.
//   - stale:  marker present but an installed hook's hash drifted from what
//             this package version ships (i.e. the user upgraded oxtail but
//             never re-ran install-hook, so the OLD script keeps running).
// The stale case is the one that bit v0.10.1: a present-but-outdated
// pretooluse.sh silently strips request_id and breaks correlated ask/reply,
// and the old presence-only check never noticed. Stderr surfacing in Claude
// Code is a soft assumption; a missed hint just degrades to polling.
async function maybeHookHint(): Promise<void> {
  if (entry.client.type !== "claude-code") return;
  try {
    const url = new URL("../scripts/hook-constants.mjs", import.meta.url).href;
    const { assessHookFreshness } = (await import(url)) as {
      assessHookFreshness: () => {
        status: "ok" | "absent" | "stale" | "unknown";
        driftedHooks: string[];
        versionMismatch: boolean;
      };
    };
    const fresh = assessHookFreshness();
    if (fresh.status === "absent") {
      process.stderr.write(
        "[oxtail] PreToolUse hook not installed — run `npx oxtail install-hook` to enable mid-turn peer messaging.\n",
      );
    } else if (fresh.status === "stale") {
      process.stderr.write(
        `[oxtail] installed hooks are out of date (${fresh.driftedHooks.join(", ")} drifted from this version) — ` +
          "run `npx oxtail install-hook` to upgrade. A pre-v8 hook only drains the legacy pid mailboxes, " +
          "so it can MISS session-box mail from v0.17+ peers entirely (delivery degrades to read_my_messages " +
          "until you re-install).\n",
      );
    }
    // "ok" / "unknown" → stay silent.
  } catch {
    // Best-effort hint; never block or crash startup on a freshness-check error.
  }
}

// Importing server.ts (e.g. from a test that needs an exported helper) used
// to await server.connect(transport) at module load — which never resolves
// without stdin EOF and hung `npm test` indefinitely. Gate the transport
// behind a direct-invocation check, mirroring scripts/install-hook.mjs.
const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(process.argv[1], "file:").href;

if (invokedDirectly) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await maybeHookHint();
}

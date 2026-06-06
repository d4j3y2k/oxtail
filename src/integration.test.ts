import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readAll, register, type RegistryEntry } from "./registry.js";
import { drain, enqueue } from "./mailbox.js";
import { recordReceived } from "./received.js";
import { recordPendingAsk } from "./pending-ask.js";

const SERVER_ENTRY = resolve(import.meta.dirname, "server.ts");
const TSX_BIN = resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

type SpawnedServer = {
  client: Client;
  transport: StdioClientTransport;
  home: string;
  cwd: string;
  cleanup: () => Promise<void>;
};

async function spawnServer(opts?: {
  cwd?: string;
  clientName?: string;
  extraEnv?: Record<string, string>;
}): Promise<SpawnedServer> {
  const home = mkdtempSync(join(tmpdir(), "oxtail-int-"));
  const cwd = opts?.cwd ?? home;

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NODE_PATH: process.env.NODE_PATH ?? "",
    ...(opts?.extraEnv ?? {}),
  };

  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [SERVER_ENTRY],
    env,
    cwd,
    stderr: "pipe",
  });

  const client = new Client(
    { name: opts?.clientName ?? "claude-code", version: "test" },
    { capabilities: {} },
  );

  await client.connect(transport);

  return {
    client,
    transport,
    home,
    cwd,
    cleanup: async () => {
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
    },
  };
}

async function callTool<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text) as T;
}

type GetMySessionResponse = {
  schema_version: 1;
  entry: {
    server_pid: number;
    started_at: number;
    client: {
      type: string;
      session_id: string | null;
      transcript_path: string | null;
      session_id_source: string | null;
      cwd: string;
    };
    state: { purpose: string | null; updated_at: number } | null;
  };
  detect_diagnosis: {
    winning: { strategy: string; source?: string } | null;
    next_step: { tool: string; bash_command: string } | null;
  };
};

test("integration: register_my_session round-trips through get_my_session", async () => {
  const server = await spawnServer();
  try {
    const before = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(before.entry.client.type, "claude-code", "type resolved from handshake");
    assert.equal(before.entry.client.session_id, null, "no session_id before register");

    const reg = (await callTool<{ ok: boolean; entry: { client: { session_id: string } } }>(
      server.client,
      "register_my_session",
      { session_id: "manually-pinned-uuid" },
    ));
    assert.equal(reg.ok, true);
    assert.equal(reg.entry.client.session_id, "manually-pinned-uuid");

    const after = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(after.entry.client.session_id, "manually-pinned-uuid");
    assert.equal(after.entry.client.session_id_source, "self-register");
    assert.ok(
      after.entry.client.transcript_path?.endsWith("manually-pinned-uuid.jsonl"),
      `transcript_path should end with the session id: ${after.entry.client.transcript_path}`,
    );
    // After registration, the diagnosis should report already-resolved (or whatever
    // live detection finds) and next_step should be null — agents already have a
    // session id, no need to nudge them toward register again.
    assert.equal(after.detect_diagnosis.next_step, null, "next_step suppressed when already resolved");
    assert.ok(after.detect_diagnosis.winning, "winning should not be null when registry has session_id");
  } finally {
    await server.cleanup();
  }
});

type ReadSessionResponse = {
  schema_version: 1;
  session: string;
  mode: "transcript" | "pane" | "none";
  client_type: string | null;
  resolved_session_id: string | null;
  session_id_source: string | null;
  transcript_mtime: string | null;
  transcript_age_seconds: number | null;
  project_root: string;
  inferred: boolean;
  error: string | null;
};

test("integration: claim_session pins session id and returns compact response", async () => {
  const server = await spawnServer();
  try {
    type ClaimResponse = {
      schema_version: 1;
      ok: boolean;
      session_id: string;
      transcript_path: string | null;
    };
    const claim = await callTool<ClaimResponse>(server.client, "claim_session", {
      session_id: "claim-session-uuid",
    });
    assert.equal(claim.ok, true);
    assert.equal(claim.session_id, "claim-session-uuid");
    assert.ok(
      claim.transcript_path?.endsWith("claim-session-uuid.jsonl"),
      `transcript_path should end with the session id: ${claim.transcript_path}`,
    );
    // Compact response shape: no `entry` field, no `client` dump.
    assert.equal(
      (claim as Record<string, unknown>).entry,
      undefined,
      "claim_session must not return the full entry",
    );

    // Pin should be reflected through get_my_session.
    const after = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(after.entry.client.session_id, "claim-session-uuid");
    assert.equal(after.entry.client.session_id_source, "self-register");
  } finally {
    await server.cleanup();
  }
});

test("integration: explicit claim is not clobbered by stale env on get_my_session", async () => {
  const staleEnvId = "476241e9-d65e-4bc2-81b0-c48305298c8b";
  const realId = "889d00f2-5cfa-4e19-a28f-38b914c6f499";
  const server = await spawnServer({
    clientName: "claude-code",
    extraEnv: { CLAUDE_CODE_SESSION_ID: staleEnvId },
  });
  try {
    const before = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(before.entry.client.session_id, staleEnvId, "stale env id is detectable before claim");

    await callTool(server.client, "claim_session", { session_id: realId });

    const after = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(after.entry.client.session_id, realId, "claimed id must survive get_my_session refinement");
    assert.equal(after.entry.client.session_id_source, "self-register");
    assert.ok(after.entry.client.transcript_path?.endsWith(`${realId}.jsonl`));

    const staleSend = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: staleEnvId,
      body: "should not route",
    });
    assert.equal(staleSend.ok, false);
    assert.equal((staleSend as SendErr).error, "target-not-found");

    const realSend = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: realId,
      body: "self route check",
    });
    assert.equal(realSend.ok, false);
    assert.equal((realSend as SendErr).error, "self-send");
  } finally {
    await server.cleanup();
  }
});

test("integration: set_my_state stores purpose and bumps updated_at on touch", async () => {
  const server = await spawnServer();
  try {
    type SetStateResponse = {
      schema_version: 1;
      ok: boolean;
      state: { purpose: string | null; updated_at: number };
    };

    const first = await callTool<SetStateResponse>(server.client, "set_my_state", {
      purpose: "wiring up state cards",
    });
    assert.equal(first.ok, true);
    assert.equal(first.state.purpose, "wiring up state cards");
    assert.ok(first.state.updated_at > 0, "updated_at should be set");

    // Touch with no fields preserves purpose, bumps timestamp.
    await new Promise((r) => setTimeout(r, 1100));
    const touched = await callTool<SetStateResponse>(server.client, "set_my_state", {});
    assert.equal(touched.state.purpose, "wiring up state cards", "touch preserves purpose");
    assert.ok(
      touched.state.updated_at >= first.state.updated_at,
      `touched.updated_at (${touched.state.updated_at}) should be >= first.updated_at (${first.state.updated_at})`,
    );

    // State should be visible on the entry returned by get_my_session, which is
    // what list_project_sessions enrichment also reads from.
    const own = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(own.entry.state?.purpose, "wiring up state cards");
    assert.ok((own.entry.state?.updated_at ?? 0) > 0);
  } finally {
    await server.cleanup();
  }
});

test("integration: set_my_state rejects over-length purpose at the zod boundary", async () => {
  const server = await spawnServer();
  try {
    const tooLong = "x".repeat(201);
    const result = await server.client.callTool({
      name: "set_my_state",
      arguments: { purpose: tooLong },
    });
    assert.equal(result.isError, true, "201-char purpose should error at the zod boundary");
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    assert.match(text, /200|max|too_big|Too big/i, `error text should reference the size cap: ${text}`);
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session rejects out-of-scope peer entry", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // Hand-place a fake peer registry record whose cwd is outside the project.
    // server_pid points at the test runner so isAlive() in readAll() keeps it.
    const fakePeer = {
      server_pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      client: {
        type: "claude-code",
        session_id: "fake-out-of-scope-session",
        transcript_path: null,
        session_id_source: "self-register",
        cwd: "/var/some/other/project",
      },
      tmux_pane: null,
      tmux_session: "fake-peer",
    };
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify(fakePeer, null, 2),
    );

    const result = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: "fake-peer",
      project_root: projectRoot,
    });

    assert.equal(result.mode, "none", "out-of-scope read should not return a transcript or pane");
    assert.match(result.error ?? "", /not in project scope/);
    assert.equal(result.project_root, projectRoot);
    assert.equal(result.inferred, false);
    // Freshness/provenance fields must be present (schema stability) and null on
    // an error exit — clients can rely on the shape across every path.
    assert.equal(result.resolved_session_id, null);
    assert.equal(result.session_id_source, null);
    assert.equal(result.transcript_mtime, null);
    assert.equal(result.transcript_age_seconds, null);
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session accepts in-scope peer entry", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    const inScopePeer = {
      server_pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      client: {
        type: "claude-code",
        session_id: "in-scope-session",
        transcript_path: null,
        session_id_source: "self-register",
        cwd: projectRoot,
      },
      tmux_pane: null,
      tmux_session: "in-scope-peer",
    };
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify(inScopePeer, null, 2),
    );

    // Even with no transcript file, a registered in-scope peer should pass
    // scope and reach the transcript-mode error path (not the scope rejection).
    const result = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: "in-scope-peer",
      mode: "transcript",
      project_root: projectRoot,
    });

    assert.equal(result.mode, "none");
    assert.doesNotMatch(result.error ?? "", /not in project scope/);
    assert.equal(result.project_root, projectRoot);
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session reads a transcript-capable peer with no tmux session (Codex)", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // A Codex-style peer: in scope, has a transcript_path, but NO tmux binding
    // (it runs outside tmux, so tmux_session is null). Before the fix this was
    // wrongly rejected as "not in project scope" because canonicalName was null
    // even though the transcript is perfectly readable without a tmux pane.
    const transcriptPath = join(server.home, "codex-rollout.jsonl");
    const rollout = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello from codex peer" }],
        },
      },
    ];
    writeFileSync(transcriptPath, rollout.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const codexUuid = "019e7d25-bdb4-7f90-a422-795f18cbd07e";
    const peer = {
      server_pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      client: {
        type: "codex",
        session_id: codexUuid,
        transcript_path: transcriptPath,
        session_id_source: "self-register",
        cwd: projectRoot,
      },
      tmux_pane: null,
      tmux_session: null,
    };
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify(peer, null, 2),
    );

    const result = await callTool<
      ReadSessionResponse & { messages: Array<{ role: string; text: string }> | null }
    >(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
    });

    assert.equal(
      result.mode,
      "transcript",
      `expected transcript read, got mode=${result.mode} error=${result.error}`,
    );
    assert.equal(result.client_type, "codex");
    assert.equal(result.error, null);
    assert.doesNotMatch(result.error ?? "", /not in project scope/);
    assert.ok(
      result.messages && result.messages.some((m) => m.text.includes("hello from codex peer")),
      "transcript messages should include the peer's user turn",
    );
    // Freshness/provenance: a transcript read surfaces which identity/thread it
    // resolved, how it was derived, and how stale the backing file is — so a
    // caller can tell a quiet peer from a stale rotated thread.
    assert.equal(result.resolved_session_id, codexUuid);
    assert.equal(result.session_id_source, "self-register");
    assert.match(result.transcript_mtime ?? "", /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(typeof result.transcript_age_seconds, "number");
    assert.ok((result.transcript_age_seconds ?? -1) >= 0, "age is non-negative");
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session surfaces sticky-claim + stale transcript age (the incident shape)", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // The silent-staleness incident: a Codex peer whose registry identity was
    // sticky-RECOVERED (env stripped on MCP-child restart) and is pinned to an
    // OLD thread. read_session reads that stale transcript; the freshness fields
    // must make the staleness visible — session_id_source "sticky-claim" plus a
    // large transcript_age_seconds — so a reader knows to trust the mailbox.
    const transcriptPath = join(server.home, "codex-stale-rollout.jsonl");
    const rollout = [
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "old testflight thread turn" }],
        },
      },
    ];
    writeFileSync(transcriptPath, rollout.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // Backdate the file ~1 hour so age clearly reads as stale, deterministically.
    const hourAgoSec = Math.floor(Date.now() / 1000) - 3600;
    utimesSync(transcriptPath, hourAgoSec, hourAgoSec);

    const codexUuid = "019e7d25-aaaa-7f90-a422-795f18cbd07e";
    const peer = {
      server_pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      client: {
        type: "codex",
        session_id: codexUuid,
        transcript_path: transcriptPath,
        session_id_source: "sticky-claim",
        cwd: projectRoot,
      },
      tmux_pane: null,
      tmux_session: null,
    };
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify(peer, null, 2));

    const result = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
    });

    assert.equal(result.mode, "transcript", `expected transcript read, error=${result.error}`);
    assert.equal(result.resolved_session_id, codexUuid);
    assert.equal(result.session_id_source, "sticky-claim");
    assert.ok(
      (result.transcript_age_seconds ?? 0) >= 3000,
      `stale transcript should read as old, got age=${result.transcript_age_seconds}`,
    );
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session returns a structured result (not a throw) when the transcript is unreadable/rotated", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // The reader guards a *missing* file (returns empty), but a transcript that
    // exists yet can't be read — rotated into a directory, EISDIR/EACCES, or
    // deleted in the existsSync->read gap — used to throw out of readSession and
    // surface as an MCP error, denying the caller any signal. A directory at the
    // transcript_path deterministically makes readFileSync throw EISDIR. The
    // tool must now return a structured ReadResult that still carries provenance.
    const transcriptPath = join(server.home, "rotated-into-a-directory");
    mkdirSync(transcriptPath, { recursive: true });

    const codexUuid = "019e7d25-bbbb-7f90-a422-795f18cbd07e";
    const peer = {
      server_pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      client: {
        type: "codex",
        session_id: codexUuid,
        transcript_path: transcriptPath,
        session_id_source: "sticky-claim",
        cwd: projectRoot,
      },
      tmux_pane: null,
      tmux_session: null,
    };
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify(peer, null, 2));

    // callTool would THROW (MCP isError) if readSession threw; reaching the
    // assertions at all proves the read failure was caught and structured.
    const result = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
    });

    assert.match(result.error ?? "", /transcript read failed/, "unreadable transcript → structured error, not a throw");
    // Provenance survives the read failure so the caller can still see it was a
    // stale sticky-claim identity rather than getting an opaque exception.
    assert.equal(result.resolved_session_id, codexUuid);
    assert.equal(result.session_id_source, "sticky-claim");
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session carries provenance on the in-scope no-transcript error path", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // A registered, in-scope peer whose registry entry has neither a transcript
    // nor a tmux session (e.g. a sticky-claim identity not yet resolved to a
    // transcript). This hits the in-scope "nothing to read" error exit — but the
    // provenance is on the registry entry and must ride along, so a staleness-
    // aware caller can still distinguish a sticky-claim peer from a genuinely
    // unknown target. (The out-of-scope/unknown/ambiguous exits intentionally
    // leave it null — emitting an out-of-project id would leak across scope.)
    const codexUuid = "019e7d25-cccc-7f90-a422-795f18cbd07e";
    const peer = {
      server_pid: process.pid,
      started_at: Math.floor(Date.now() / 1000),
      client: {
        type: "codex",
        session_id: codexUuid,
        transcript_path: null,
        session_id_source: "sticky-claim",
        cwd: projectRoot,
      },
      tmux_pane: null,
      tmux_session: null,
    };
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${process.pid}.json`), JSON.stringify(peer, null, 2));

    const result = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
    });

    assert.equal(result.mode, "none");
    assert.match(result.error ?? "", /no transcript and no tmux session/);
    assert.equal(result.resolved_session_id, codexUuid);
    assert.equal(result.session_id_source, "sticky-claim");
    // Transcript freshness genuinely doesn't apply here (no transcript) → null.
    assert.equal(result.transcript_mtime, null);
    assert.equal(result.transcript_age_seconds, null);
  } finally {
    await server.cleanup();
  }
});

test("integration: list_project_sessions compact:true returns grouped shape; default stays flat", async () => {
  const server = await spawnServer();
  try {
    // Default shape: flat sessions[] (backward compatible).
    const flat = JSON.parse(await callToolRaw(server.client, "list_project_sessions")) as Record<string, unknown>;
    assert.ok("sessions" in flat, "default response carries sessions[]");
    assert.ok(!("tmux_sessions" in flat), "default response has no tmux_sessions");
    assert.ok(Array.isArray(flat.sessions));

    // compact:true flips to the grouped tmux_sessions[] shape and drops the flat
    // rows. (Empty arrays here since the temp cwd matches no tmux session — we're
    // asserting the wiring/shape, which is what the compact branch controls.)
    const compact = JSON.parse(
      await callToolRaw(server.client, "list_project_sessions", { compact: true }),
    ) as Record<string, unknown>;
    assert.ok("tmux_sessions" in compact, "compact response carries tmux_sessions[]");
    assert.ok(!("sessions" in compact), "compact response drops the flat sessions[]");
    assert.ok(Array.isArray(compact.tmux_sessions));
    assert.equal(compact.schema_version, 1);
    assert.equal(typeof compact.project_root, "string");
  } finally {
    await server.cleanup();
  }
});

type ReadSessionTranscript = ReadSessionResponse & {
  messages: Array<{ role: string; text: string; timestamp: string | null }> | null;
  truncated: boolean;
  count_truncated: boolean;
  bytes_truncated: boolean;
  total_messages: number | null;
  total_messages_exact: boolean;
};

test("integration: read_session applies count + byte budgets through the tool boundary", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // 8 sizeable user turns (~1KB each) so both the count cap and the byte cap
    // engage on a single read.
    const transcriptPath = join(server.home, "codex-rollout-budget.jsonl");
    const lines = Array.from({ length: 8 }, (_, i) => ({
      type: "response_item",
      timestamp: `2026-05-08T13:28:0${i}.000Z`,
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `m${i}-${"z".repeat(1000)}` }],
      },
    }));
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const codexUuid = "019e7d25-bdb4-7f90-a422-795f18cbd222";
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify(
        {
          server_pid: process.pid,
          started_at: Math.floor(Date.now() / 1000),
          client: {
            type: "codex",
            session_id: codexUuid,
            transcript_path: transcriptPath,
            session_id_source: "self-register",
            cwd: projectRoot,
          },
          tmux_pane: null,
          tmux_session: null,
        },
        null,
        2,
      ),
    );

    // limit 3 (count cap) + max_bytes 2500 (byte cap). Tail of 3 is ~3KB > 2500,
    // so the oldest of the three gets head-truncated; the newest stays intact.
    const r = await callTool<ReadSessionTranscript>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
      limit: 3,
      max_bytes: 2500,
    });

    assert.equal(r.mode, "transcript", `expected transcript, got ${r.mode} err=${r.error}`);
    assert.equal(r.total_messages, 8, "total reflects all 8 turns");
    assert.equal(r.messages!.length, 3, "count cap returns at most 3");
    assert.equal(r.count_truncated, true, "8 > limit 3 → count_truncated");
    assert.equal(r.bytes_truncated, true, "tail exceeds max_bytes → bytes_truncated");
    assert.equal(r.truncated, true, "catch-all truncated flag set");
    // Tail-preserving: the newest message is present and intact.
    const newest = r.messages![r.messages!.length - 1]!;
    assert.ok(newest.text.startsWith("m7-"), "newest turn is the last one in the file");
    assert.ok(!newest.text.includes("truncated]"), "newest turn is not byte-truncated");
    // Oldest returned message is the one head-truncated by the byte budget.
    assert.match(r.messages![0]!.text, /truncated\]$/, "boundary message carries the marker");
    // Timestamps gated off by default.
    assert.equal(newest.timestamp, null, "timestamps null unless include_timestamps");

    // Opt back in: timestamps surface.
    const withTs = await callTool<ReadSessionTranscript>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
      limit: 1,
      include_timestamps: true,
    });
    assert.equal(withTs.messages![0]!.timestamp, "2026-05-08T13:28:07.000Z");
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session tail_scan path returns newest turns and qualifies total", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    const transcriptPath = join(server.home, "codex-rollout-tail.jsonl");
    const lines = Array.from({ length: 10 }, (_, i) => ({
      type: "response_item",
      timestamp: `2026-05-08T13:30:0${i}.000Z`,
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `turn ${i}` }] },
    }));
    writeFileSync(transcriptPath, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const codexUuid = "019e7d25-bdb4-7f90-a422-795f18cbd333";
    const sessionsDir = join(server.home, ".oxtail", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify(
        {
          server_pid: process.pid,
          started_at: Math.floor(Date.now() / 1000),
          client: { type: "codex", session_id: codexUuid, transcript_path: transcriptPath, session_id_source: "self-register", cwd: projectRoot },
          tmux_pane: null,
          tmux_session: null,
        },
        null,
        2,
      ),
    );

    // tail_scan with a small limit: newest turns, total qualified as inexact.
    const capped = await callTool<ReadSessionTranscript>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
      tail_scan: true,
      limit: 2,
    });
    assert.equal(capped.mode, "transcript", `err=${capped.error}`);
    assert.deepEqual(capped.messages!.map((m) => m.text), ["turn 8", "turn 9"], "newest two turns");
    assert.equal(capped.count_truncated, true);
    assert.equal(capped.total_messages, null, "total unknown when tail scan stops early");
    assert.equal(capped.total_messages_exact, false);

    // tail_scan with a high limit reaches start → exact total, all messages.
    const whole = await callTool<ReadSessionTranscript>(server.client, "read_session", {
      name: codexUuid,
      project_root: projectRoot,
      tail_scan: true,
      limit: 1000,
    });
    assert.equal(whole.messages!.length, 10);
    assert.equal(whole.total_messages, 10);
    assert.equal(whole.total_messages_exact, true);
    assert.equal(whole.count_truncated, false);
  } finally {
    await server.cleanup();
  }
});

test("integration: read_session ambiguous tmux name returns candidates", async () => {
  const server = await spawnServer();
  try {
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const projectRoot = me.entry.client.cwd;

    // Two peers share the same tmux session name — Terminator-style.
    // resolveSessionInScope must refuse to silently pick one.
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: "33333333-1111-1111-1111-111111111111",
      tmux_session: "shared-tmux",
      cwd: projectRoot,
    });
    seedPeerEntry(server.home, {
      server_pid: process.ppid,
      session_id: "44444444-2222-2222-2222-222222222222",
      tmux_session: "shared-tmux",
      cwd: projectRoot,
    });

    // Tmux-name form returns ambiguous-target.
    const ambiguous = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: "shared-tmux",
      mode: "transcript",
      project_root: projectRoot,
    });
    assert.equal(ambiguous.mode, "none");
    assert.match(ambiguous.error ?? "", /ambiguous-target/);
    assert.match(
      ambiguous.error ?? "",
      /33333333-1111-1111-1111-111111111111/,
      "first candidate UUID listed in error",
    );
    assert.match(
      ambiguous.error ?? "",
      /44444444-2222-2222-2222-222222222222/,
      "second candidate UUID listed in error",
    );

    // UUID form disambiguates: caller gets the specific agent's scope decision
    // (here, mode: "none" but with a transcript-not-found error, not ambiguity).
    const disambiguated = await callTool<ReadSessionResponse>(server.client, "read_session", {
      name: "33333333-1111-1111-1111-111111111111",
      mode: "transcript",
      project_root: projectRoot,
    });
    assert.equal(disambiguated.mode, "none");
    assert.doesNotMatch(disambiguated.error ?? "", /ambiguous-target/);
    assert.doesNotMatch(disambiguated.error ?? "", /not in project scope/);
  } finally {
    await server.cleanup();
  }
});

test("integration: birth-time match resolves session_id via late re-detect", async () => {
  const server = await spawnServer();
  try {
    // At handshake time the transcript dir is empty, so detection fails
    // (winning === null) and the server schedules late re-detect.
    const initial = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(initial.entry.client.session_id, null);
    assert.equal(initial.detect_diagnosis.winning, null);

    // Create a transcript with birth_ms > started_at_ms (file is being created
    // right now, server registered ~50ms ago).
    const cwd = initial.entry.client.cwd;
    const encodedCwd = cwd.replace(/\//g, "-");
    const transcriptDir = join(server.home, ".claude", "projects", encodedCwd);
    mkdirSync(transcriptDir, { recursive: true });
    const sessionId = "birth-time-resolved-uuid";
    writeFileSync(
      join(transcriptDir, `${sessionId}.jsonl`),
      JSON.stringify({ sessionId, type: "user", timestamp: new Date().toISOString() }) + "\n",
    );

    // Wait for the +1s late re-detect fire
    await new Promise((r) => setTimeout(r, 1500));

    const resolved = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    assert.equal(
      resolved.entry.client.session_id,
      sessionId,
      "session_id should be resolved by birth-time match after late re-detect",
    );
    assert.equal(resolved.detect_diagnosis.winning?.strategy, "birth-time");
  } finally {
    await server.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// v0.5 messaging — send_message / read_my_messages
// ────────────────────────────────────────────────────────────────────────────

type SendOk = {
  schema_version: 1;
  ok: true;
  message_id: string;
  target_session_id: string | null;
  target_server_pid: number;
  wake_status?: string;
  wake_reason?: string;
};

type SendErr = {
  schema_version: 1;
  ok: false;
  error: "target-not-found" | "ambiguous-target" | "cross-project" | "self-send";
  candidates?: string[];
  wake_status?: string;
};

type ReadMyMessagesResponse = {
  schema_version: 1;
  ok: true;
  drained: true;
  count: number;
  messages: Array<{
    schema_version: 1;
    id: string;
    body: string;
    enqueued_at: number;
    body_bytes?: number;
    origin?: "peer";
    from_session_id?: string;
    request_id?: string;
    reply_to?: string;
    source_message_id?: string;
  }>;
};

// Seed a fake peer registry entry via register() — same writer as production.
// The captain wants register() over hand-rolled writeFileSync to keep the test
// faithful to whatever register() actually produces. Caller must temporarily
// point HOME at the spawned server's HOME so registryDir() lazy-resolves into
// the right place; the helper saves/restores HOME.
function seedPeerEntry(home: string, partial: {
  server_pid: number;
  started_at?: number;
  session_id?: string | null;
  tmux_session?: string | null;
  cwd?: string;
  type?: "claude-code" | "codex";
  replyToCapable?: boolean;
}): RegistryEntry {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const entry: RegistryEntry = {
      server_pid: partial.server_pid,
      started_at: partial.started_at ?? Math.floor(Date.now() / 1000),
      client: {
        type: partial.type ?? "claude-code",
        session_id: partial.session_id ?? null,
        transcript_path: null,
        session_id_source: "self-register",
        cwd: partial.cwd ?? home,
      },
      tmux_pane: null,
      tmux_session: partial.tmux_session ?? null,
      state: null,
      ...(partial.replyToCapable
        ? { capabilities: { mailbox: { reply_to: true, provenance: true, push_budget: true } } }
        : {}),
    };
    register(entry);
    return entry;
  } finally {
    process.env.HOME = prev;
  }
}

test("messaging: send_message by tmux name lands in peer mailbox; read_my_messages drains it", async () => {
  const server = await spawnServer();
  try {
    // The peer here is the test runner's pid — that pid is alive (it's us),
    // so isAlive() in resolveTarget keeps the entry. We then read the mailbox
    // from the test runner side using drain(my_pid) with HOME swapped.
    const peerPid = process.pid;
    const peerSessionId = "11111111-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: peerPid,
      session_id: peerSessionId,
      tmux_session: "peer-by-name",
      cwd: server.home,
    });

    // The MCP server's cwd is server.home, same as the peer cwd → in-scope.
    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "peer-by-name",
      body: "hi from sender",
    });
    assert.equal(sent.ok, true, `send must succeed: ${JSON.stringify(sent)}`);
    assert.equal((sent as SendOk).target_server_pid, peerPid);

    // Read the peer's mailbox directly from the test runner; HOME-swap so
    // mailbox.drain() resolves to the spawned server's HOME.
    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      const drained = drain(peerPid);
      assert.equal(drained.length, 1);
      assert.equal(drained[0].body, "hi from sender");
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message by session_id (UUID) resolves to the same peer", async () => {
  const server = await spawnServer();
  try {
    const peerPid = process.pid;
    const peerSessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    seedPeerEntry(server.home, {
      server_pid: peerPid,
      session_id: peerSessionId,
      tmux_session: "peer-by-uuid",
      cwd: server.home,
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: peerSessionId,
      body: "via uuid",
    });
    assert.equal(sent.ok, true, `send must succeed: ${JSON.stringify(sent)}`);
    assert.equal((sent as SendOk).target_session_id, peerSessionId);

    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      const drained = drain(peerPid);
      assert.equal(drained.length, 1);
      assert.equal(drained[0].body, "via uuid");
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

type ReplyOk = {
  schema_version: 1;
  ok: true;
  message_id: string;
  in_reply_to_message_id: string;
  target_session_id: string | null;
  target_server_pid: number;
  correlation: "correlated" | "uncorrelated";
  wake_status?: string;
  wake_reason?: string;
};

type ReplyErr = {
  schema_version: 1;
  ok: false;
  error: string;
  message?: string;
};

// Seed an inbound envelope into a receiver's ledger the way production does:
// at enqueue time. Returns the minted message_id the receiver would later pass
// to reply_to_message. HOME-swapped so both the mailbox and ledger resolve into
// the spawned server's HOME.
function seedInbound(
  home: string,
  receiverSid: string,
  fromSid: string,
  body: string,
  opts: { request_id?: string } = {},
): string {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const msg = enqueue(99999, body, fromSid, opts);
    recordReceived(receiverSid, msg);
    return msg.id;
  } finally {
    process.env.HOME = prev;
  }
}

test("reply_to_message: correlated — derives target + carries reply_to=request_id", async () => {
  const server = await spawnServer();
  try {
    const callerSid = "ca11e700-0000-0000-0000-000000000001";
    const senderSid = "5e0de700-0000-0000-0000-000000000002";
    await callTool(server.client, "register_my_session", { session_id: callerSid });
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: senderSid,
      tmux_session: "the-asker",
      cwd: server.home,
    });

    const inboundId = seedInbound(server.home, callerSid, senderSid, "original ask", {
      request_id: "req-correlated-1",
    });

    const reply = await callTool<ReplyOk | ReplyErr>(server.client, "reply_to_message", {
      message_id: inboundId,
      body: "here is my answer",
    });
    assert.equal(reply.ok, true, `reply must succeed: ${JSON.stringify(reply)}`);
    const ok = reply as ReplyOk;
    assert.equal(ok.target_session_id, senderSid, "target derived from from_session_id");
    assert.equal(ok.in_reply_to_message_id, inboundId);
    assert.equal(ok.correlation, "correlated");

    // The reply must land in the original asker's mailbox, correlated.
    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      const drained = drain(process.pid);
      assert.equal(drained.length, 1);
      assert.equal(drained[0].body, "here is my answer");
      assert.equal(drained[0].reply_to, "req-correlated-1", "reply_to derived from request_id");
      assert.equal(drained[0].from_session_id, callerSid, "from is the replier");
      assert.equal(drained[0].source_message_id, inboundId, "provenance set");
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

test("reply_to_message: uncorrelated — replying to a plain send_message omits reply_to", async () => {
  const server = await spawnServer();
  try {
    const callerSid = "ca11e700-0000-0000-0000-000000000003";
    const senderSid = "5e0de700-0000-0000-0000-000000000004";
    await callTool(server.client, "register_my_session", { session_id: callerSid });
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: senderSid,
      tmux_session: "plain-sender",
      cwd: server.home,
    });

    // No request_id → the inbound was a plain send_message.
    const inboundId = seedInbound(server.home, callerSid, senderSid, "fyi, plain message");

    const reply = await callTool<ReplyOk | ReplyErr>(server.client, "reply_to_message", {
      message_id: inboundId,
      body: "got it",
    });
    assert.equal(reply.ok, true, `reply must succeed: ${JSON.stringify(reply)}`);
    assert.equal((reply as ReplyOk).correlation, "uncorrelated");

    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      const drained = drain(process.pid);
      assert.equal(drained.length, 1);
      assert.equal(drained[0].body, "got it");
      assert.equal(drained[0].reply_to, undefined, "no reply_to for a plain inbound");
      assert.equal(drained[0].source_message_id, inboundId);
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

test("reply_to_message: fail-closed on an unknown message_id", async () => {
  const server = await spawnServer();
  try {
    const callerSid = "ca11e700-0000-0000-0000-000000000005";
    await callTool(server.client, "register_my_session", { session_id: callerSid });

    const reply = await callTool<ReplyOk | ReplyErr>(server.client, "reply_to_message", {
      message_id: "ffffffffffffffff",
      body: "into the void",
    });
    assert.equal(reply.ok, false);
    assert.equal((reply as ReplyErr).error, "message-not-found");
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message cross-project rejected", async () => {
  const server = await spawnServer();
  try {
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: "12345678-1234-1234-1234-123456789012",
      tmux_session: "cross-project-peer",
      cwd: "/var/some/other/project",
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "cross-project-peer",
      body: "should be rejected",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "cross-project");
  } finally {
    await server.cleanup();
  }
});

test("messaging: nested git repository is cross-project, not descendant scope", async () => {
  const parent = mkdtempSync(join(tmpdir(), "oxtail-parent-project-"));
  const nested = join(parent, "nested");
  mkdirSync(join(parent, ".git"), { recursive: true });
  mkdirSync(join(nested, ".git"), { recursive: true });

  const server = await spawnServer({ cwd: parent });
  try {
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: "abababab-abab-abab-abab-abababababab",
      tmux_session: "nested-project-peer",
      cwd: nested,
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "nested-project-peer",
      body: "should not cross nested project boundary",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "cross-project");
  } finally {
    await server.cleanup();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("messaging: send_message to unknown target returns target-not-found", async () => {
  const server = await spawnServer();
  try {
    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "no-such-peer",
      body: "into the void",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "target-not-found");
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message to ambiguous tmux name returns candidates", async () => {
  const server = await spawnServer();
  try {
    // Two peer entries sharing the same tmux_session name. Both alive,
    // both in scope. resolveTarget must surface candidates and refuse to
    // pick one.
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: "11111111-1111-1111-1111-111111111111",
      tmux_session: "twin",
      cwd: server.home,
    });
    // A second entry with a DIFFERENT pid. To make isAlive() accept it,
    // point it at the parent of the test runner (a guaranteed-alive ancestor).
    seedPeerEntry(server.home, {
      server_pid: process.ppid,
      session_id: "22222222-2222-2222-2222-222222222222",
      tmux_session: "twin",
      cwd: server.home,
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "twin",
      body: "to ambiguous twin",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "ambiguous-target");
    assert.ok(Array.isArray((sent as SendErr).candidates));
    assert.equal((sent as SendErr).candidates!.length, 2);
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message to self by pid returns self-send", async () => {
  const server = await spawnServer();
  try {
    // Get the server's own pid via get_my_session, then send to self by UUID.
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    // The server's session_id is unresolved until claim — pin it first.
    const myUuid = "fefefefe-fefe-fefe-fefe-fefefefefefe";
    await callTool(server.client, "claim_session", { session_id: myUuid });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: myUuid,
      body: "echo",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "self-send");
    // Sanity: the server pid we read above stayed in scope (cwd is the temp HOME).
    assert.ok(me.entry.server_pid > 0);
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message to same agent session_id through a sibling MCP child is self-send", async () => {
  const server = await spawnServer();
  try {
    const myUuid = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await callTool(server.client, "claim_session", { session_id: myUuid });

    // Simulate a fresher live sibling from a dual-scope MCP setup. readAll()
    // collapses duplicate session_ids to this sibling, so pid-only self-send
    // detection would incorrectly enqueue to our own other MCP child.
    seedPeerEntry(server.home, {
      server_pid: process.ppid,
      started_at: Math.floor(Date.now() / 1000) + 10,
      session_id: myUuid,
      tmux_session: "self-sibling",
      cwd: server.home,
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: myUuid,
      body: "echo through sibling",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "self-send");
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message to stale registry entry (dead pid) returns target-not-found", async () => {
  const server = await spawnServer();
  try {
    // Pick a pid extremely unlikely to be in use. process.kill(pid, 0) on a
    // dead pid raises ESRCH which isAlive() interprets as "not alive."
    const deadPid = 999_999_999;
    seedPeerEntry(server.home, {
      server_pid: deadPid,
      session_id: "deaddead-dead-dead-dead-deaddeaddead",
      tmux_session: "ghost-peer",
      cwd: server.home,
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "ghost-peer",
      body: "anyone home?",
    });
    assert.equal(sent.ok, false);
    assert.equal((sent as SendErr).error, "target-not-found");
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message body cap — 8192 bytes succeeds, 8193 fails at zod boundary", async () => {
  const server = await spawnServer();
  try {
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: "feedface-feed-face-feed-facefeedface",
      tmux_session: "cap-peer",
      cwd: server.home,
    });

    // 8192 ASCII bytes — boundary case, must succeed.
    const okBody = "a".repeat(8192);
    const ok = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "cap-peer",
      body: okBody,
    });
    assert.equal(ok.ok, true, `8192-byte body must succeed: ${JSON.stringify(ok)}`);

    // Drain so the next test isn't affected.
    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try { drain(process.pid); } finally { process.env.HOME = prev; }

    // 8193 — must fail at the zod refine boundary.
    const tooBig = "a".repeat(8193);
    const result = await server.client.callTool({
      name: "send_message",
      arguments: { target: "cap-peer", body: tooBig },
    });
    assert.equal(result.isError, true, "8193-byte body must error at zod boundary");
    const content = result.content as Array<{ type: string; text: string }>;
    const text = content.find((c) => c.type === "text")?.text ?? "";
    assert.match(text, /8192|exceeds/, `error should mention the cap: ${text}`);
  } finally {
    await server.cleanup();
  }
});

test("messaging: read_my_messages on empty mailbox returns count 0", async () => {
  const server = await spawnServer();
  try {
    const r = await callTool<ReadMyMessagesResponse>(server.client, "read_my_messages");
    assert.equal(r.ok, true);
    assert.equal(r.drained, true);
    assert.equal(r.count, 0);
    assert.deepEqual(r.messages, []);
  } finally {
    await server.cleanup();
  }
});

test("messaging: from_session_id present when sender has resolved id, absent when null", async () => {
  // Sender claims a session_id first; recipient's mailbox carries it.
  const server = await spawnServer();
  try {
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: "cafecafe-cafe-cafe-cafe-cafecafecafe",
      tmux_session: "fromsid-peer",
      cwd: server.home,
    });

    // Without claim, the sender's client.session_id is null → from_session_id
    // should be omitted from the enqueued line.
    await callTool(server.client, "send_message", {
      target: "fromsid-peer",
      body: "unclaimed",
    });

    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      const drainedBefore = drain(process.pid);
      assert.equal(drainedBefore.length, 1);
      assert.equal(
        drainedBefore[0].from_session_id,
        undefined,
        "from_session_id must be omitted when sender's session_id is null",
      );
    } finally {
      process.env.HOME = prev;
    }

    // Now claim and send again — from_session_id should be present.
    const senderUuid = "abcd1234-abcd-1234-abcd-1234abcd1234";
    await callTool(server.client, "claim_session", { session_id: senderUuid });
    await callTool(server.client, "send_message", {
      target: "fromsid-peer",
      body: "claimed",
    });

    process.env.HOME = server.home;
    try {
      const drainedAfter = drain(process.pid);
      assert.equal(drainedAfter.length, 1);
      assert.equal(drainedAfter[0].from_session_id, senderUuid);
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Slice 1 — wake-on-reply (reply_to default auto-wake)
// ────────────────────────────────────────────────────────────────────────────

// Write a fresh activity marker into the spawned server's HOME so its
// readActivity() sees the seeded peer as idle/busy with mtime≈now.
function seedActivity(home: string, sessionId: string, status: "idle" | "busy"): void {
  const dir = join(home, ".oxtail", "activity");
  mkdirSync(dir, { recursive: true });
  const key = sessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  writeFileSync(join(dir, key), status);
}

// Simulate a prior ask_peer (by `requesterSessionId`) that timed out and left a
// durable pending-ask. HOME-swapped so it lands in the spawned server's store.
function seedPendingAsk(home: string, requesterSessionId: string, requestId: string): void {
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    recordPendingAsk(join(home, ".oxtail", "pending-ask"), requesterSessionId, requestId, Date.now());
  } finally {
    process.env.HOME = prev;
  }
}

function pendingAskFiles(home: string): string[] {
  try {
    return readdirSync(join(home, ".oxtail", "pending-ask")).filter((n) => n[0] === "p");
  } catch {
    return [];
  }
}

// The seeded peer has no tmux pane/session, so when the reply-default GATE
// passes the subsequent send-keys has nowhere to fire and surfaces
// "skipped_no_target". That is the integration-visible proof the gate let the
// wake through (vs. the gate's own skip statuses). Real send-keys is covered by
// the OXTAIL_TMUX_TESTS path in wake-tmux.test.ts.
test("reply-default: reply_to to a freshly-idle peer triggers the gate (wake_reason set)", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa1111-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-idle",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "idle");
    await callTool(server.client, "claim_session", {
      session_id: "bbbb1111-2222-3333-4444-555555555555",
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "reply-default-idle",
      body: "here is your answer",
      reply_to: "req-xyz",
    });
    assert.equal(sent.ok, true);
    const ok = sent as SendOk;
    assert.equal(ok.wake_reason, "reply_to_default", "reply path is flagged");
    // Gate passed → tried to fire → no tmux target. NOT a gate-skip status.
    assert.equal(ok.wake_status, "skipped_no_target");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: a NON-fresh-idle (busy) peer is not woken — skipped_no_fresh_idle", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa2222-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-busy",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "busy");

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "reply-default-busy",
      body: "answer for a busy peer",
      reply_to: "req-busy",
    });
    const ok = sent as SendOk;
    assert.equal(ok.wake_reason, "reply_to_default");
    assert.equal(ok.wake_status, "skipped_no_fresh_idle");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: a peer with no activity marker is not woken — skipped_no_fresh_idle", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa3333-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-unknown",
      cwd: server.home,
      replyToCapable: true,
    });
    // No seedActivity → hooks-not-installed / unknown.

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "reply-default-unknown",
      body: "answer for an unknown-state peer",
      reply_to: "req-unknown",
    });
    const ok = sent as SendOk;
    assert.equal(ok.wake_status, "skipped_no_fresh_idle", "missing activity ⇒ no best-effort wake");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: explicit wake:'off' suppresses the reply auto-wake entirely", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa4444-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-off",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "idle"); // fresh idle — would otherwise fire

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "reply-default-off",
      body: "answer but stay quiet",
      reply_to: "req-quiet",
      wake: "off",
    });
    const ok = sent as SendOk;
    assert.equal(ok.wake_status, undefined, "explicit off → no wake attempted");
    assert.equal(ok.wake_reason, undefined, "explicit off → not the reply-default path");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: OXTAIL_AUTOWAKE=off kill-switch disables the reply auto-wake", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_AUTOWAKE: "off" } });
  try {
    const peerSessionId = "aaaa5555-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-killswitch",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "idle");

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "reply-default-killswitch",
      body: "answer with kill switch on",
      reply_to: "req-killed",
    });
    const ok = sent as SendOk;
    assert.equal(ok.wake_status, "disabled");
    assert.equal(ok.wake_reason, "reply_to_default");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: one-wake dedupe — same reply_to twice does not re-fire the gate", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa6666-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-dedupe",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "idle");

    // INTENTIONAL: the dedupe slot is claimed when the gate PASSES, before the
    // send-keys fires. So even though the first wake could not fire here (no
    // tmux target → skipped_no_target), the (session_id, reply_to) slot is now
    // taken and a retry of the same reply_to is deduped rather than re-attempted.
    const first = (await callTool<SendOk>(server.client, "send_message", {
      target: "reply-default-dedupe",
      body: "first reply",
      reply_to: "req-dupe",
    }));
    assert.equal(first.wake_status, "skipped_no_target", "gate passed on first (no tmux to fire)");

    const second = (await callTool<SendOk>(server.client, "send_message", {
      target: "reply-default-dedupe",
      body: "duplicate of the same reply",
      reply_to: "req-dupe",
    }));
    assert.equal(second.wake_status, "skipped_deduped", "same (session_id, reply_to) is deduped");
    assert.equal(second.wake_reason, "reply_to_default");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: a plain message (no reply_to) still does not wake", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa7777-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-plain",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "idle");

    const sent = await callTool<SendOk>(server.client, "send_message", {
      target: "reply-default-plain",
      body: "just an FYI, no reply expected",
    });
    assert.equal(sent.wake_status, undefined, "no reply_to, no wake:auto → no wake");
    assert.equal(sent.wake_reason, undefined);
  } finally {
    await server.cleanup();
  }
});

// Escape hatch: explicit wake:"auto" on a REPLY bypasses the strict fresh-idle
// gate and takes the lenient wakeForSend path — so a requester with no idle
// marker (Codex / hookless Claude) can still be reached, which the round-2 docs
// promise. Without this, reply_to + wake:"auto" would hit skipped_no_fresh_idle.
test("reply-default: explicit wake:'auto' on a reply uses the LENIENT path (unknown-state peer)", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa8888-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-auto-unknown",
      cwd: server.home,
      replyToCapable: true,
    });
    // No activity marker → strict gate would say skipped_no_fresh_idle. The
    // lenient path instead attempts the wake (no tmux target → skipped_no_target).

    const sent = await callTool<SendOk>(server.client, "send_message", {
      target: "reply-default-auto-unknown",
      body: "explicit nudge for a Codex-like requester",
      reply_to: "req-codexlike",
      wake: "auto",
    });
    assert.equal(sent.wake_status, "skipped_no_target", "lenient path tried to wake (not gated out)");
    assert.equal(sent.wake_reason, undefined, "explicit auto is not the reply_to_default path");
  } finally {
    await server.cleanup();
  }
});

test("reply-default: explicit wake:'auto' on a reply still respects the busy gate (skipped_busy)", async () => {
  const server = await spawnServer();
  try {
    const peerSessionId = "aaaa9999-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "reply-default-auto-busy",
      cwd: server.home,
      replyToCapable: true,
    });
    seedActivity(server.home, peerSessionId, "busy"); // fresh busy → lenient path skips

    const sent = await callTool<SendOk>(server.client, "send_message", {
      target: "reply-default-auto-busy",
      body: "explicit nudge while busy",
      reply_to: "req-busy-auto",
      wake: "auto",
    });
    assert.equal(sent.wake_status, "skipped_busy", "lenient wakeForSend still skips a fresh-busy peer");
    assert.equal(sent.wake_reason, undefined);
  } finally {
    await server.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// v0.6 ask_peer — blocking send + wait-for-reply
// ────────────────────────────────────────────────────────────────────────────

type AskPeerOk = {
  schema_version: 1;
  ok: true;
  message_id: string;
  request_id: string;
  wake_status: "fired" | "skipped_unsupported" | "skipped_no_target" | "disabled";
  reply: {
    id: string;
    body: string;
    enqueued_at: number;
    from_session_id: string | null;
    reply_to: string | null;
    correlation: "correlated" | "uncorrelated";
  } | null;
  correlation: "correlated" | "uncorrelated" | "none";
  timeout_ms: number;
  timed_out: boolean;
};

type AskPeerErr = {
  schema_version: 1;
  ok: false;
  error: string;
  message?: string;
};

function scheduleReplyFromAskMailbox(input: {
  home: string;
  peerPid: number;
  callerPid: number;
  peerSessionId: string;
  body: string;
  delayMs?: number;
  includeReplyTo?: boolean;
}): void {
  setTimeout(() => {
    const prev = process.env.HOME;
    process.env.HOME = input.home;
    try {
      let outbound = drain(input.peerPid).find((m) => m.request_id);
      for (let i = 0; !outbound && i < 20; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        outbound = drain(input.peerPid).find((m) => m.request_id);
      }
      enqueue(
        input.callerPid,
        input.body,
        input.peerSessionId,
        input.includeReplyTo === false
          ? {}
          : { reply_to: outbound?.request_id },
      );
    } finally {
      process.env.HOME = prev;
    }
  }, input.delayMs ?? 100);
}

test("ask_peer: peer replies via mailbox before timeout — returns the reply", async () => {
  // Use a moderate timeout so we don't hit it if the test runner is slow.
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "10000" } });
  try {
    const peerSessionId = "ffffffff-1111-2222-3333-444444444444";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "ask-peer-replier",
      cwd: server.home,
      type: "codex",
    });

    // Sender (A) must have a session_id for from_session_id to be set on the
    // outbound. Without it, the reply enqueue would have no from_session_id
    // to filter on — but that filter goes the OTHER way (we filter replies BY
    // the target's session_id). So A's session id isn't strictly required for
    // this test, but claim it anyway to mirror real usage.
    await callTool(server.client, "claim_session", {
      session_id: "00000000-1111-2222-3333-555555555555",
    });

    // Find A's server pid so the test runner can enqueue a "reply" with
    // from_session_id == peerSessionId into A's mailbox.
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const aPid = me.entry.server_pid;

    // Schedule a reply to land ~700ms after ask_peer starts — past the 500ms
    // grace, into the poll loop, but well before the 10s test timeout.
    setTimeout(() => {
      const prev = process.env.HOME;
      process.env.HOME = server.home;
      try {
        enqueue(aPid, "B reporting in", peerSessionId);
      } finally {
        process.env.HOME = prev;
      }
    }, 700);

    const t0 = Date.now();
    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-replier",
      body: "ping from sender",
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.ok, true, `expected ok: ${JSON.stringify(result)}`);
    const ok = result as AskPeerOk;
    assert.equal(ok.timed_out, false, "should not have timed out");
    assert.ok(ok.reply, "must have a reply");
    assert.equal(ok.reply!.body, "B reporting in");
    assert.equal(ok.reply!.from_session_id, peerSessionId);
    // Allow generous upper bound for slow CI; reply should not have waited
    // for the configured 10s timeout.
    assert.ok(elapsed < 5000, `expected fast return, took ${elapsed}ms`);
  } finally {
    await server.cleanup();
  }
});

test("ask_peer: no reply within timeout — returns timed_out: true, no error", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "1500" } });
  try {
    const peerSessionId = "deadbeef-1111-2222-3333-444444444444";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSessionId,
      tmux_session: "ask-peer-silent",
      cwd: server.home,
      type: "codex",
    });

    const t0 = Date.now();
    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-silent",
      body: "knock knock",
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    assert.equal(ok.timed_out, true);
    assert.equal(ok.reply, null);
    assert.ok(elapsed >= 1400, `should wait ~1.5s, took ${elapsed}ms`);
    assert.ok(elapsed < 4000, `should not over-wait, took ${elapsed}ms`);
  } finally {
    await server.cleanup();
  }
});

test("ask_peer: timeout records a durable pending-ask for a correlated peer + claimed requester", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "1200" } });
  try {
    const peerSid = "aaaaffff-1111-2222-3333-444444444444";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSid,
      tmux_session: "ask-timeout-pending",
      cwd: server.home,
      replyToCapable: true,
    });
    await callTool(server.client, "claim_session", {
      session_id: "cccc1111-2222-3333-4444-555555555555",
    });

    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-timeout-pending",
      body: "a task that will take a while",
    });
    const ok = result as AskPeerOk;
    assert.equal(ok.timed_out, true, "no reply within the window");
    // The durable pending obligation is recorded so a late reply can wake us.
    assert.equal(pendingAskFiles(server.home).length, 1, "one pending-ask record written");
  } finally {
    await server.cleanup();
  }
});

// NOTE: the ask_peer reply UNION-drain across sibling pids (drainMatchingReplyMany)
// is proven deterministically in mailbox.test.ts. Simulating it at the ask_peer
// integration level needs a SECOND LIVE MCP child sharing the requester's
// session_id — a fake dead-pid sibling is reaped/migrated by readAll's reap path
// before a late reply lands — which the single-process test harness can't spawn.

test("late reply: consumes the pending-ask and wakes even a MARKERLESS (Codex-like) idle requester", async () => {
  const server = await spawnServer();
  try {
    const reqSid = "dddd1111-2222-3333-4444-555555555555";
    // The requester whose ask timed out — markerless (no activity file), the
    // exact case the strict fresh-idle reply-default skips as skipped_no_fresh_idle.
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: reqSid,
      tmux_session: "late-reply-requester",
      cwd: server.home,
      type: "codex",
    });
    seedPendingAsk(server.home, reqSid, "req-late");
    await callTool(server.client, "claim_session", {
      session_id: "eeee1111-2222-3333-4444-555555555555",
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "late-reply-requester",
      body: "done — here is the result",
      reply_to: "req-late",
    });
    const ok = sent as SendOk;
    assert.equal(ok.wake_reason, "late_reply_to_pending", "took the durable pending path");
    // Lenient gate fired for the markerless requester (no tmux in tests).
    assert.equal(ok.wake_status, "skipped_no_target");
    assert.equal(pendingAskFiles(server.home).length, 0, "pending-ask consumed");
  } finally {
    await server.cleanup();
  }
});

test("late reply: wake:\"off\" consumes the pending-ask but does NOT wake (suppressed)", async () => {
  const server = await spawnServer();
  try {
    const reqSid = "dddd2222-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: reqSid,
      tmux_session: "late-reply-off",
      cwd: server.home,
      type: "codex",
    });
    seedPendingAsk(server.home, reqSid, "req-off");
    await callTool(server.client, "claim_session", {
      session_id: "eeee2222-2222-3333-4444-555555555555",
    });

    const sent = await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "late-reply-off",
      body: "fyi, done",
      reply_to: "req-off",
      wake: "off",
    });
    const ok = sent as SendOk;
    assert.equal(ok.wake_reason, "late_reply_to_pending_suppressed");
    assert.equal(ok.wake_status, undefined, "no wake under explicit off");
    assert.equal(pendingAskFiles(server.home).length, 0, "still consumed — obligation satisfied");
  } finally {
    await server.cleanup();
  }
});

test("late reply: OXTAIL_AUTOWAKE=off disables the automatic late wake but explicit wake:\"auto\" still fires", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_AUTOWAKE: "off" } });
  try {
    const reqSid = "dddd3333-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: reqSid,
      tmux_session: "late-reply-killswitch",
      cwd: server.home,
      type: "codex",
    });
    await callTool(server.client, "claim_session", {
      session_id: "eeee3333-2222-3333-4444-555555555555",
    });

    // Default (wake unset): kill-switch disables the automatic late wake.
    seedPendingAsk(server.home, reqSid, "req-ks");
    const auto = (await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "late-reply-killswitch",
      body: "done (default)",
      reply_to: "req-ks",
    })) as SendOk;
    assert.equal(auto.wake_reason, "late_reply_to_pending");
    assert.equal(auto.wake_status, "disabled", "kill-switch disables the automatic late wake");
    assert.equal(pendingAskFiles(server.home).length, 0, "still consumed");

    // Explicit wake:"auto" intentionally bypasses the kill-switch.
    seedPendingAsk(server.home, reqSid, "req-ks-explicit");
    const explicit = (await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "late-reply-killswitch",
      body: "done (explicit auto)",
      reply_to: "req-ks-explicit",
      wake: "auto",
    })) as SendOk;
    assert.equal(explicit.wake_reason, "late_reply_to_pending");
    assert.equal(explicit.wake_status, "skipped_no_target", "explicit auto still fires");
  } finally {
    await server.cleanup();
  }
});

test("late reply: stamps the autowake dedupe so a re-delivered duplicate can't strict-wake again", async () => {
  const server = await spawnServer();
  try {
    const reqSid = "dddd4444-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: reqSid,
      tmux_session: "late-reply-dedupe",
      cwd: server.home,
      replyToCapable: true,
    });
    // Fresh-idle so the strict reply-default WOULD fire on the duplicate if not deduped.
    seedActivity(server.home, reqSid, "idle");
    seedPendingAsk(server.home, reqSid, "req-dup");
    await callTool(server.client, "claim_session", {
      session_id: "eeee4444-2222-3333-4444-555555555555",
    });

    const first = (await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "late-reply-dedupe",
      body: "the answer",
      reply_to: "req-dup",
    })) as SendOk;
    assert.equal(first.wake_reason, "late_reply_to_pending", "pending path consumed + stamped dedupe");

    // A re-delivered copy of the SAME reply: pending gone → strict reply-default
    // path, but the dedupe stamp makes it skip rather than wake again.
    const second = (await callTool<SendOk | SendErr>(server.client, "send_message", {
      target: "late-reply-dedupe",
      body: "the answer (re-delivered)",
      reply_to: "req-dup",
    })) as SendOk;
    assert.equal(second.wake_reason, "reply_to_default", "no pending record left → strict path");
    assert.equal(second.wake_status, "skipped_deduped", "dedupe stamp prevents a second wake");
  } finally {
    await server.cleanup();
  }
});

test("ask_peer: rejects target peer that has no client.session_id", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "5000" } });
  try {
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: null,
      tmux_session: "ask-peer-anon",
      cwd: server.home,
    });

    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-anon",
      body: "are you there",
    });
    assert.equal(result.ok, false);
    const err = result as AskPeerErr;
    assert.equal(err.error, "peer-has-no-session-id");
  } finally {
    await server.cleanup();
  }
});

test("ask_peer: unrelated peer messages stay in mailbox; only matching reply is consumed", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "8000" } });
  try {
    const targetSid = "aaaaaaaa-2222-3333-4444-555555555555";
    const intruderSid = "bbbbbbbb-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: targetSid,
      tmux_session: "ask-peer-target",
      cwd: server.home,
      type: "codex",
    });
    // The intruder doesn't need a registry entry — we just enqueue a stray
    // message into A's mailbox with an arbitrary from_session_id below. ask_peer
    // filters by the resolved target's session_id, so the intruder's session_id
    // simply won't match.

    await callTool(server.client, "claim_session", {
      session_id: "11111111-2222-3333-4444-555555555555",
    });
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const aPid = me.entry.server_pid;

    // Enqueue an interloper message FIRST (before ask_peer starts polling),
    // then the actual reply. ask_peer should drain the matching reply and
    // leave the interloper.
    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      enqueue(aPid, "noise from C", intruderSid);
    } finally {
      process.env.HOME = prev;
    }

    setTimeout(() => {
      const prev2 = process.env.HOME;
      process.env.HOME = server.home;
      try {
        enqueue(aPid, "the real reply", targetSid);
      } finally {
        process.env.HOME = prev2;
      }
    }, 600);

    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-target",
      body: "ping",
    });
    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    assert.equal(ok.reply?.body, "the real reply");

    // Interloper message must still be present.
    process.env.HOME = server.home;
    try {
      const remaining = drain(aPid);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].body, "noise from C");
      assert.equal(remaining[0].from_session_id, intruderSid);
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

// v0.10.1 strict-correlation guard. A pre-existing message in A's mailbox from
// the target (e.g. a chat message that arrived before A called ask_peer) must
// not satisfy a reply_to-capable wait. The message is preserved for normal
// mailbox delivery while the fresh correlated reply wins.
test("ask_peer: correlated reply wins over stale chatter", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "8000" } });
  try {
    const targetSid = "cccccccc-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: targetSid,
      tmux_session: "ask-peer-stale-target",
      cwd: server.home,
      type: "codex",
      replyToCapable: true,
    });

    await callTool(server.client, "claim_session", {
      session_id: "dddddddd-2222-3333-4444-555555555555",
    });
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const aPid = me.entry.server_pid;

    // Pre-seed a stale message from the SAME target. Under strict reply_to
    // correlation the grace-window matcher must NOT claim this as the reply to a
    // question we haven't even sent yet: it carries no request_id, so it stays
    // in the mailbox for normal delivery (asserted below).
    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      enqueue(aPid, "old chatter from earlier", targetSid);
    } finally {
      process.env.HOME = prev;
    }

    scheduleReplyFromAskMailbox({
      home: server.home,
      peerPid: process.pid,
      callerPid: aPid,
      peerSessionId: targetSid,
      body: "real answer to the question",
    });

    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-stale-target",
      body: "the actual question",
    });
    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    assert.equal(
      ok.reply?.body,
      "real answer to the question",
      "fresh reply wins; the stale 'old chatter' must not be returned",
    );
    assert.equal(ok.reply?.reply_to, ok.request_id);
    assert.equal(ok.correlation, "correlated");

    // Stale same-peer chatter remains for normal mailbox delivery.
    process.env.HOME = server.home;
    try {
      const remaining = drain(aPid);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].body, "old chatter from earlier");
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

test("ask_peer: legacy peer may stale-match same-peer chatter as uncorrelated", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "5000" } });
  try {
    const targetSid = "99999999-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: targetSid,
      tmux_session: "ask-peer-legacy-stale-target",
      cwd: server.home,
      type: "codex",
    });

    await callTool(server.client, "claim_session", {
      session_id: "99999999-aaaa-bbbb-cccc-555555555555",
    });
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const aPid = me.entry.server_pid;

    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      enqueue(aPid, "legacy stale chatter", targetSid);
    } finally {
      process.env.HOME = prev;
    }

    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-legacy-stale-target",
      body: "legacy best-effort question",
    });
    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    assert.equal(ok.timed_out, false);
    assert.equal(ok.reply?.body, "legacy stale chatter");
    assert.equal(ok.reply?.reply_to, null);
    assert.equal(ok.reply?.correlation, "uncorrelated");
    assert.equal(ok.correlation, "uncorrelated");
  } finally {
    await server.cleanup();
  }
});

test("ask_peer: reply_to-capable peer does not consume uncorrelated replies", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "8000" } });
  try {
    const targetSid = "eeeeeeee-2222-3333-4444-555555555555";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: targetSid,
      tmux_session: "ask-peer-uncorrelated-target",
      cwd: server.home,
      type: "codex",
      replyToCapable: true,
    });
    await callTool(server.client, "claim_session", {
      session_id: "eeeeeeee-aaaa-bbbb-cccc-555555555555",
    });
    const me = await callTool<GetMySessionResponse>(server.client, "get_my_session");
    const aPid = me.entry.server_pid;

    scheduleReplyFromAskMailbox({
      home: server.home,
      peerPid: process.pid,
      callerPid: aPid,
      peerSessionId: targetSid,
      body: "forgot reply_to",
      includeReplyTo: false,
    });

    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-uncorrelated-target",
      body: "question needing strict reply_to",
      timeout_ms: 1200,
    });
    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    assert.equal(ok.timed_out, true);
    assert.equal(ok.correlation, "none");
    assert.equal(ok.timeout_ms, 1200);

    const prev = process.env.HOME;
    process.env.HOME = server.home;
    try {
      const remaining = drain(aPid);
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].body, "forgot reply_to");
      assert.equal(remaining[0].reply_to, undefined);
    } finally {
      process.env.HOME = prev;
    }
  } finally {
    await server.cleanup();
  }
});

// Claude Code peers wake via the same send-keys mechanism as Codex (no
// paste-burst gap needed). Verified end-to-end 2026-05-13 against the live
// `oxtail-claudejr` peer in this repo: ask_peer enqueue → tmux send-keys →
// peer entered a turn → PreToolUse hook drained the mailbox → peer replied
// via send_message → round-trip confirmed.
//
// In this test the seeded peer has no real tmux pane (the session name is
// fabricated), so send-keys fails and wakePeer returns skipped_no_target.
// The point is that ask_peer for a claude-code target now enters the poll
// loop just like any other client — it does NOT fail-fast with
// skipped_unsupported (the v0.7 regression that contradicted oxtail's
// symmetric-matrix vision).
test("ask_peer: claude-code target enters the poll loop like any other client", async () => {
  const server = await spawnServer({ extraEnv: { OXTAIL_ASK_PEER_TIMEOUT_MS: "1500" } });
  try {
    const peerSid = "12345678-aaaa-bbbb-cccc-111111111111";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSid,
      tmux_session: "ask-peer-claude",
      cwd: server.home,
      type: "claude-code",
    });

    const t0 = Date.now();
    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-claude",
      body: "claude-code peers are now wakeable via send-keys",
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    // Fake tmux session can't actually receive send-keys, so wake reports
    // skipped_no_target. The critical assertion is that this is NOT
    // skipped_unsupported — claude-code is no longer special-cased.
    assert.equal(ok.wake_status, "skipped_no_target");
    assert.notEqual(ok.wake_status, "skipped_unsupported");
    assert.equal(ok.reply, null);
    // We DID poll (no fail-fast) — timed_out: true is the correct signal.
    assert.equal(ok.timed_out, true, "claude-code now polls like any other client");
    assert.ok(elapsed >= 1400, `should have waited the full timeout, took ${elapsed}ms`);
  } finally {
    await server.cleanup();
  }
});

// v0.7: OXTAIL_ASK_PEER_WAKE_STRATEGY=off disables wake entirely; ask_peer
// becomes a pure blocking poll. wake_status surfaces as "disabled" so the
// caller knows no wake fired.
test("ask_peer: strategy=off surfaces wake_status: disabled and still polls", async () => {
  const server = await spawnServer({
    extraEnv: {
      OXTAIL_ASK_PEER_TIMEOUT_MS: "1500",
      OXTAIL_ASK_PEER_WAKE_STRATEGY: "off",
    },
  });
  try {
    const peerSid = "deadcafe-aaaa-bbbb-cccc-111111111111";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSid,
      tmux_session: "ask-peer-off",
      cwd: server.home,
      type: "claude-code",
    });

    const t0 = Date.now();
    const result = await callTool<AskPeerOk | AskPeerErr>(server.client, "ask_peer", {
      target: "ask-peer-off",
      body: "no wake should fire",
    });
    const elapsed = Date.now() - t0;

    assert.equal(result.ok, true);
    const ok = result as AskPeerOk;
    assert.equal(ok.wake_status, "disabled");
    assert.equal(ok.reply, null);
    assert.equal(ok.timed_out, true, "we did poll, and timed out");
    assert.ok(elapsed >= 1400, `should have waited the full timeout, took ${elapsed}ms`);
  } finally {
    await server.cleanup();
  }
});

test("integration: a restarted Codex MCP child recovers its session via sticky claim", async () => {
  // s1 and s2 are both spawned by THIS test process, so they share a parent
  // identity (ppid + signature) — the durable handle a sticky claim keys on.
  // A shared HOME lets the claim record + transcript persist across the
  // "restart". This is the real Codex case: the MCP child cycles under the same
  // host while its session-id env var stays stripped.
  const sharedHome = mkdtempSync(join(tmpdir(), "oxtail-sticky-int-"));
  const codexEnv = { HOME: sharedHome, CODEX_HOME: join(sharedHome, ".codex") };
  const sessionId = "019e7d25-bdb4-7f90-a422-795f18cbd07e";

  // Place Codex rollouts so the claim resolves a non-null transcript_path
  // (findCodexTranscriptPath scans ~/.codex/sessions/<recent>). We seed TWO
  // distinct session ids for this cwd on purpose: birth-time only resolves on
  // exactly one post-start candidate (pickByDelta requires ranked.length === 1),
  // so >=2 candidates force it to abstain and the restarted child must recover
  // via the sticky claim. Without the decoy, a UTC CI runner collapses both day
  // dirs into a single file and birth-time can win the startup race against
  // sticky-claim under load, flaking the source attribution. Write into both UTC
  // and local "today" dirs to also stay clear of a date-boundary flake.
  const decoyId = "019e7d25-0000-7000-a000-0000000000de";
  const d = new Date();
  const dayDirs = [
    [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
    [d.getFullYear(), d.getMonth() + 1, d.getDate()],
  ];
  for (const [y, m, day] of dayDirs) {
    const dir = join(
      sharedHome, ".codex", "sessions",
      String(y), String(m).padStart(2, "0"), String(day).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    for (const id of [sessionId, decoyId]) {
      writeFileSync(join(dir, `rollout-${id}.jsonl`), JSON.stringify({ payload: { cwd: sharedHome } }) + "\n");
    }
  }

  let s1: Awaited<ReturnType<typeof spawnServer>> | undefined;
  let s2: Awaited<ReturnType<typeof spawnServer>> | undefined;
  try {
    // First run: claim. The server persists a sticky claim keyed by its parent
    // (this test process) + cwd + client_type.
    s1 = await spawnServer({ cwd: sharedHome, clientName: "codex", extraEnv: codexEnv });
    const claim = await callTool<{ ok: boolean; session_id: string; transcript_path: string | null }>(
      s1.client, "claim_session", { session_id: sessionId },
    );
    assert.equal(claim.session_id, sessionId);
    assert.ok(claim.transcript_path, "claim must resolve a transcript so recovery's guard can pass");
    await s1.cleanup();
    s1 = undefined;

    // Let s1 fully exit before the "restart" so s2 starts against a clean
    // registry — a faithful single-child restart. (Recovery no longer depends on
    // the prior owner being gone; this just keeps the scenario unambiguous.)
    const prevHome = process.env.HOME;
    process.env.HOME = sharedHome;
    try {
      for (let i = 0; i < 100; i++) {
        if (!readAll().some((e) => e.client.session_id === sessionId)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      process.env.HOME = prevHome;
    }

    // Restart: a fresh Codex child, same parent + cwd + home. env detection has
    // no session id and birth-time abstains (the transcript predates this
    // child's started_at), so startup recovery must adopt the sticky claim.
    s2 = await spawnServer({ cwd: sharedHome, clientName: "codex", extraEnv: codexEnv });
    const me = await callTool<GetMySessionResponse>(s2.client, "get_my_session");
    assert.equal(me.entry.client.session_id, sessionId, "restarted child should recover the claimed session id");
    assert.equal(me.entry.client.session_id_source, "sticky-claim");
  } finally {
    if (s1) await s1.cleanup();
    if (s2) await s2.cleanup();
    rmSync(sharedHome, { recursive: true, force: true });
  }
});

test("integration: sticky claim recovered after handshake is written back to registry", async () => {
  // Claude Code's session id is normally absent from the MCP child env, so the
  // first moment we know the client type can be the initialize handshake. This
  // covers the path where sticky recovery happens after an initial null-session
  // registry write.
  const sharedHome = mkdtempSync(join(tmpdir(), "oxtail-sticky-claude-int-"));
  const sharedCwd = realpathSync(sharedHome);
  const sessionId = "b61d166f-cbe0-4881-bbe2-6af461e5c787";
  const projectDir = join(
    sharedHome,
    ".claude",
    "projects",
    sharedCwd.replace(/\//g, "-"),
  );
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), "\n");

  let s1: Awaited<ReturnType<typeof spawnServer>> | undefined;
  let s2: Awaited<ReturnType<typeof spawnServer>> | undefined;
  try {
    s1 = await spawnServer({
      cwd: sharedCwd,
      clientName: "claude-code",
      extraEnv: { HOME: sharedHome, CLAUDECODE: "1" },
    });
    const claim = await callTool<{ ok: boolean; session_id: string; transcript_path: string | null }>(
      s1.client,
      "claim_session",
      { session_id: sessionId },
    );
    assert.equal(claim.session_id, sessionId);
    assert.ok(claim.transcript_path, "claim must persist a transcript-backed sticky record");
    await s1.cleanup();
    s1 = undefined;
    assert.equal(
      readdirSync(join(sharedHome, ".oxtail", "claims")).filter((f) => f.endsWith(".json")).length,
      1,
      "first child must leave one sticky claim record for the restart",
    );

    const prevHome = process.env.HOME;
    process.env.HOME = sharedHome;
    try {
      for (let i = 0; i < 100; i++) {
        if (!readAll().some((e) => e.client.session_id === sessionId)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      process.env.HOME = prevHome;
    }
    // Keep the transcript birth time clearly before the restarted child's
    // started_at — far enough that birth-time detection abstains and sticky
    // recovery is exercised. Birth-time allows a 1s grace below started_at to
    // absorb second-resolution rounding (worst-case delta is 1000 - wait ms), so
    // wait > 2000ms to guarantee the transcript reads as genuinely pre-start —
    // which is what a real restart looks like (its transcript predates the new
    // child by seconds-to-hours).
    await new Promise((r) => setTimeout(r, 2100));

    s2 = await spawnServer({
      cwd: sharedCwd,
      clientName: "claude-code",
      extraEnv: { HOME: sharedHome },
    });
    const me = await callTool<GetMySessionResponse>(s2.client, "get_my_session");
    assert.equal(me.entry.client.session_id, sessionId);
    assert.equal(me.entry.client.session_id_source, "sticky-claim");

    const prevHomeForRegistry = process.env.HOME;
    process.env.HOME = sharedHome;
    try {
      assert.ok(
        readAll().some((e) => e.client.session_id === sessionId),
        "recovered sticky claim must be visible to peers through the registry",
      );
    } finally {
      process.env.HOME = prevHomeForRegistry;
    }
  } finally {
    if (s1) await s1.cleanup();
    if (s2) await s2.cleanup();
    rmSync(sharedHome, { recursive: true, force: true });
  }
});

function writeActivity(home: string, sessionId: string, status: string): void {
  const dir = join(home, ".oxtail", "activity");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sessionId), status);
}

test("messaging: send_message wake:auto skips a busy peer (skipped_busy)", async () => {
  const server = await spawnServer();
  try {
    const peerSid = "0a0a0a0a-0b0b-0c0c-0d0d-0e0e0e0e0e0e";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSid,
      tmux_session: "busy-peer",
      cwd: server.home,
    });
    writeActivity(server.home, peerSid, "busy");

    const res = await callTool<SendOk & { wake_status?: string }>(server.client, "send_message", {
      target: peerSid,
      body: "yo",
      wake: "auto",
    });
    assert.equal(res.ok, true);
    assert.equal(res.wake_status, "skipped_busy", "fresh busy peer must not be woken");
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message wake:auto with no tmux target returns skipped_no_target", async () => {
  const server = await spawnServer();
  try {
    const peerSid = "1b1b1b1b-2c2c-3d3d-4e4e-5f5f5f5f5f5f";
    // Codex-style peer: idle, but no tmux pane/session to send-keys into.
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSid,
      tmux_session: null,
      cwd: server.home,
      type: "codex",
    });
    writeActivity(server.home, peerSid, "idle");

    const res = await callTool<SendOk & { wake_status?: string }>(server.client, "send_message", {
      target: peerSid,
      body: "yo",
      wake: "auto",
    });
    assert.equal(res.ok, true);
    assert.equal(res.wake_status, "skipped_no_target", "idle peer with no pane cannot be send-keys-woken");
  } finally {
    await server.cleanup();
  }
});

test("messaging: send_message without wake carries no wake_status (contract preserved)", async () => {
  const server = await spawnServer();
  try {
    const peerSid = "2c2c2c2c-3d3d-4e4e-5f5f-606060606060";
    seedPeerEntry(server.home, {
      server_pid: process.pid,
      session_id: peerSid,
      tmux_session: "quiet-peer",
      cwd: server.home,
    });
    const res = await callTool<SendOk & { wake_status?: string }>(server.client, "send_message", {
      target: peerSid,
      body: "no wake",
    });
    assert.equal(res.ok, true);
    assert.equal(res.wake_status, undefined, "default send_message must not wake");
  } finally {
    await server.cleanup();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase A — response serialization is minified (no pretty-print whitespace)
// ────────────────────────────────────────────────────────────────────────────

// Read the raw response text for a tool (callTool parses; here we need the
// on-the-wire string to assert it carries no indentation/newlines).
async function callToolRaw(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return content.find((c) => c.type === "text")?.text ?? "";
}

test("phase-a: tool responses are minified JSON, schema fields intact, smaller than pretty", async () => {
  const server = await spawnServer();
  try {
    // get_my_session returns a deeply NESTED object — the strongest proof that
    // minification reaches nested structures, not just the top level.
    const text = await callToolRaw(server.client, "get_my_session");
    assert.ok(text.length > 0, "response must carry text");

    // Whitespace-gone, two independent ways:
    //  (1) JSON.stringify escapes any newline INSIDE a string value as the two
    //      chars backslash-n, never a literal 0x0A byte. So the only possible
    //      source of a literal newline in the payload is pretty-print indentation.
    assert.ok(
      !text.includes("\n"),
      `minified response must contain no literal newline (pretty-print leak): ${text.slice(0, 80)}`,
    );
    //  (2) An already-minified payload round-trips to byte-identical output.
    //      A pretty-printed one would not.
    const parsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(text, JSON.stringify(parsed), "response text must already be minified");

    //  (3) Explicit size assertion: the minified form is strictly smaller than
    //      the pretty form would have been — the token win, quantified in-test.
    const prettyLen = JSON.stringify(parsed, null, 2).length;
    assert.ok(
      text.length < prettyLen,
      `minified length (${text.length}) must be < pretty length (${prettyLen})`,
    );

    // Serialization-only change: every field is preserved (no renames/removals).
    assert.equal(parsed.schema_version, 1, "schema_version preserved");
    assert.ok("entry" in parsed, "entry field preserved");
    assert.ok("detect_diagnosis" in parsed, "detect_diagnosis field preserved");
    const entry = parsed.entry as Record<string, unknown>;
    assert.ok("client" in entry, "nested entry.client preserved");

    // A second tool with a top-level ARRAY (list_project_sessions) — confirms the
    // shared jsonResult() helper minifies array-bearing payloads too.
    const listText = await callToolRaw(server.client, "list_project_sessions");
    assert.ok(!listText.includes("\n"), "list response must contain no literal newline");
    const listParsed = JSON.parse(listText) as Record<string, unknown>;
    assert.equal(listText, JSON.stringify(listParsed), "list response must be minified");
    assert.equal(listParsed.schema_version, 1, "list schema_version preserved");
    assert.ok(Array.isArray(listParsed.sessions), "sessions[] shape preserved");
  } finally {
    await server.cleanup();
  }
});

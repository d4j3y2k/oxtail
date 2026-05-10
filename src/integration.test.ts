import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

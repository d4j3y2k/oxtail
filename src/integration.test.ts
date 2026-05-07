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
      cwd: string;
    };
  };
  detect_diagnosis: { winning: { strategy: string } | null };
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
    assert.ok(
      after.entry.client.transcript_path?.endsWith("manually-pinned-uuid.jsonl"),
      `transcript_path should end with the session id: ${after.entry.client.transcript_path}`,
    );
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

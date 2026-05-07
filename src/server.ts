#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

type Session = {
  name: string;
  path: string;
  attached: boolean;
  created_at: number;
  windows: number;
};

type Result = {
  schema_version: 1;
  project_root: string;
  inferred: boolean;
  sessions: Session[];
  error: string | null;
};

const TMUX_FORMAT =
  "#{session_name}|#{session_path}|#{session_created}|#{session_attached}|#{session_windows}";

function inferProjectRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isDescendantOrEqual(child: string, root: string): boolean {
  if (child === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(rootWithSep);
}

function listTmuxSessions(): { sessions: Session[]; error: string | null } {
  let raw: string;
  try {
    raw = execFileSync("tmux", ["list-sessions", "-F", TMUX_FORMAT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      return { sessions: [], error: "tmux not found" };
    }
    const stderr = e.stderr ? e.stderr.toString() : "";
    if (stderr.includes("no server running")) {
      return { sessions: [], error: null };
    }
    return { sessions: [], error: stderr.trim() || e.message || "tmux failed" };
  }

  const sessions: Session[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const [name, path, created, attached, windows] = line.split("|");
    if (!name || !path) continue;
    sessions.push({
      name,
      path,
      attached: attached === "1",
      created_at: Number(created) || 0,
      windows: Number(windows) || 0,
    });
  }
  return { sessions, error: null };
}

function buildResult(input: { project_root?: string }): Result {
  const explicit = typeof input.project_root === "string" && input.project_root.length > 0;
  const root = explicit ? input.project_root! : inferProjectRoot(process.cwd());
  const resolvedRoot = safeRealpath(root);

  const { sessions, error } = listTmuxSessions();
  const matched = sessions.filter((s) => isDescendantOrEqual(s.path, resolvedRoot));

  return {
    schema_version: 1,
    project_root: resolvedRoot,
    inferred: !explicit,
    sessions: matched,
    error,
  };
}

const server = new McpServer({
  name: "oxtail",
  version: "0.1.0",
});

server.registerTool(
  "list_project_sessions",
  {
    description:
      "List agent sessions running in or under a given project root. Pass project_root explicitly when known; if omitted, the server will attempt to infer it from its own cwd, but inference is best-effort and not always reliable.",
    inputSchema: {
      project_root: z
        .string()
        .optional()
        .describe(
          "Absolute path to the project root. Recommended. If omitted, the server walks up from its own cwd to the nearest .git ancestor.",
        ),
    },
  },
  async ({ project_root }) => {
    const result = buildResult({ project_root });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

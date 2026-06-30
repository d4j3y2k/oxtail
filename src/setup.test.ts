import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { claudeMcpEdit, codexMcpEdit, runSetup, type EnvReport } from "./setup.js";

// ── claudeMcpEdit (~/.claude.json) ──────────────────────────────────────────────
test("claudeMcpEdit: empty/blank file → adds oxtail under mcpServers", () => {
  for (const input of ["", "   ", "{}"]) {
    const r = claudeMcpEdit(input);
    assert.equal(r.changed, true, `changed for input ${JSON.stringify(input)}`);
    const j = parse(r.next) as { mcpServers: { oxtail: { command: string; args: string[] } } };
    assert.equal(j.mcpServers.oxtail.command, "npx");
    assert.deepEqual(j.mcpServers.oxtail.args, ["-y", "oxtail@latest"]);
  }
});

test("claudeMcpEdit: preserves unrelated keys + other mcpServers", () => {
  const input = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }, null, 2);
  const r = claudeMcpEdit(input);
  assert.equal(r.changed, true);
  const j = parse(r.next) as { theme: string; mcpServers: Record<string, unknown> };
  assert.equal(j.theme, "dark", "unrelated key preserved");
  assert.ok(j.mcpServers.other, "other MCP server preserved");
  assert.ok(j.mcpServers.oxtail, "oxtail added alongside");
});

test("claudeMcpEdit: NEVER clobbers an existing oxtail entry (idempotent)", () => {
  const dev = JSON.stringify({ mcpServers: { oxtail: { command: "node", args: ["/dev/dist/server.js"] } } }, null, 2);
  const r = claudeMcpEdit(dev);
  assert.equal(r.changed, false, "existing oxtail entry left untouched");
  assert.equal(r.next, dev);
  assert.match(r.reason, /already registered/);
  // And applying twice converges: edit(edit(x)) is a no-op the second time.
  const once = claudeMcpEdit("{}").next;
  assert.equal(claudeMcpEdit(once).changed, false, "second run is a no-op");
});

test("claudeMcpEdit: unparseable file is left untouched (no clobber)", () => {
  const r = claudeMcpEdit("{ this is not json ");
  assert.equal(r.changed, false);
  assert.equal(r.next, "{ this is not json ");
});

// ── codexMcpEdit (~/.codex/config.toml) ─────────────────────────────────────────
test("codexMcpEdit: empty file → appends the oxtail table", () => {
  const r = codexMcpEdit("");
  assert.equal(r.changed, true);
  assert.match(r.next, /\[mcp_servers\.oxtail\]/);
  assert.match(r.next, /command = "npx"/);
  assert.match(r.next, /args = \["-y", "oxtail@latest"\]/);
});

test("codexMcpEdit: appends after existing content without rewriting it", () => {
  const input = `[mcp_servers.other]\ncommand = "x"\n`;
  const r = codexMcpEdit(input);
  assert.equal(r.changed, true);
  assert.ok(r.next.startsWith(input), "existing content preserved verbatim at the top");
  assert.match(r.next, /\[mcp_servers\.oxtail\]/);
});

test("codexMcpEdit: NEVER duplicates an existing oxtail table (idempotent)", () => {
  const input = `[mcp_servers.oxtail]\ncommand = "node"\nargs = ["/dev/server.js"]\n`;
  const r = codexMcpEdit(input);
  assert.equal(r.changed, false, "existing table left untouched");
  assert.equal(r.next, input);
  // edit(edit(x)) converges.
  const once = codexMcpEdit("").next;
  assert.equal(codexMcpEdit(once).changed, false, "second run is a no-op");
});

// ── runSetup orchestration (dry-run, injected env, no real writes) ──────────────
test("runSetup --dry-run writes nothing + reports prerequisites", async () => {
  const lines: string[] = [];
  const env: EnvReport = { node: "v22", tmux: false, claude: true, codex: false };
  let hookCalled = false;
  const code = await runSetup(["--dry-run"], {
    out: (m) => lines.push(m),
    env,
    color: false,
    installHook: async () => { hookCalled = true; },
    // dry-run must not touch the hook either
  });
  const text = lines.join("\n");
  assert.equal(code, 0);
  assert.equal(hookCalled, false, "dry-run does not install the hook");
  assert.match(text, /dry-run/);
  assert.match(text, /tmux.*missing/s, "flags missing tmux");
  assert.match(text, /install tmux/, "tmux is a blocker → guidance");
});

test("runSetup (apply) installs the hook + reports ready when prereqs present", async () => {
  const lines: string[] = [];
  const env: EnvReport = { node: "v22", tmux: true, claude: true, codex: true };
  let hookCalled = false;
  // Point at throwaway temp paths so the real configs are never touched.
  const tmp = `/tmp/oxtail-setup-test-${process.pid}`;
  const code = await runSetup([], {
    out: (m) => lines.push(m),
    env,
    color: false,
    paths: { claudeJson: `${tmp}/.claude.json`, codexToml: `${tmp}/.codex/config.toml` },
    installHook: async () => { hookCalled = true; },
  });
  assert.equal(code, 0);
  assert.equal(hookCalled, true, "apply installs the hook");
  assert.match(lines.join("\n"), /ready/);
});

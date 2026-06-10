import { strict as assert } from "node:assert";
import { test } from "node:test";

test("smoke: test runner is wired", () => {
  assert.equal(1 + 1, 2);
});

// Regression: the dist entry must answer MCP initialize even when invoked
// through a SYMLINKED path. Node's ESM loader realpaths import.meta.url, so
// the old `invokedDirectly` raw-string comparison missed under any symlink
// (`/tmp` → `/private/tmp`, pnpm layouts) and the server exited 0 silently —
// found live while verifying the published v0.18.0.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("smoke: dist/server.js answers initialize when invoked via a symlinked path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-symlink-"));
  const home = mkdtempSync(join(tmpdir(), "oxtail-symlink-home-"));
  try {
    const real = resolve(import.meta.dirname, "..", "dist", "server.js");
    const link = join(dir, "server-link.js");
    symlinkSync(real, link);

    const out = await new Promise<string>((res, rej) => {
      const child = spawn(process.execPath, [link], {
        env: { PATH: process.env.PATH ?? "", HOME: home },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        rej(new Error("no initialize response within 10s (entry guard missed?)"));
      }, 10_000);
      child.stdout.on("data", (c) => {
        stdout += c;
        if (stdout.includes('"serverInfo"')) {
          clearTimeout(timer);
          child.kill();
          res(stdout);
        }
      });
      child.on("close", () => {
        // resolves via the data handler in the pass case; a silent exit
        // before any response is the regression shape
        clearTimeout(timer);
        rej(new Error(`server exited without responding; stdout=${JSON.stringify(stdout)}`));
      });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "claude-code", version: "smoke" },
          },
        }) + "\n",
      );
    });
    assert.match(out, /"name":"oxtail"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

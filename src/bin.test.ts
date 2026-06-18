// Guards the CLI bin wiring so the standalone `oxpit` command can't silently break:
// after `npm i [-g] oxtail`, a bare `oxpit` must exist and route to the cockpit. The
// package declares two bins (oxtail + oxpit); each must point at a real compiled
// entry, and the oxpit entry must be an executable (shebang) that delegates to the
// shared runOxpitCli (where the terminal-restore backstop lives).

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { bin: Record<string, string> };

test("package.json declares both the oxtail and oxpit bins", () => {
  assert.equal(pkg.bin.oxtail, "dist/server.js");
  assert.equal(pkg.bin.oxpit, "dist/oxpit-bin.js", "the standalone cockpit command");
});

test("the oxpit bin source exists, is executable (shebang), and delegates to runOxpitCli", () => {
  const src = new URL("./oxpit-bin.ts", import.meta.url);
  assert.ok(existsSync(src), "src/oxpit-bin.ts must exist (compiles to dist/oxpit-bin.js)");
  const body = readFileSync(src, "utf8");
  assert.ok(body.startsWith("#!/usr/bin/env node"), "must start with the node shebang");
  assert.match(body, /runOxpitCli/, "must run via the shared runOxpitCli wrapper");
});

test("runOxpitCli is exported from the tui module (shared by bin + subcommand)", async () => {
  const tui = (await import("./oxpit/tui.js")) as { runOxpitCli?: unknown };
  assert.equal(typeof tui.runOxpitCli, "function");
});

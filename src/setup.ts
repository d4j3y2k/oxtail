// `oxtail setup` — make a machine ready for the full oxtail experience in one command.
//
// Run it once on a new machine (or after `npm i -g oxtail@latest` to upgrade). It
// auto-configures everything it safely can and clearly guides the rest:
//
//   AUTO (idempotent · backs up · never clobbers an existing entry):
//     • register the oxtail MCP server in ~/.claude.json  (Claude Code, global)
//     • register it in ~/.codex/config.toml               (Codex CLI)
//     • install / refresh the message-delivery hook       (~/.claude/settings.json)
//   DETECT + GUIDE (external, can't auto):
//     • tmux on PATH? · claude CLI? · codex CLI?
//
// Safety: the config edits ADD the oxtail entry only when it's MISSING (an existing
// entry — e.g. a dev `node dist/server.js` one — is left untouched), each file is
// backed up to `<file>.oxtail-bak` before the first write, and `--dry-run` previews
// every change without touching anything. Re-running is a no-op once set up.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

// The MCP launch command we register. `npx -y oxtail@latest` is the README canonical —
// it works whether or not oxtail is installed globally (npx uses the global if present),
// and auto-tracks releases, so an upgrade is just `npm i -g` + re-running the hook.
const MCP_COMMAND = "npx";
const MCP_ARGS = ["-y", "oxtail@latest"];

export interface SetupPaths {
  claudeJson: string; // ~/.claude.json
  codexToml: string; // ~/.codex/config.toml
}

export function defaultPaths(home = homedir()): SetupPaths {
  return {
    claudeJson: join(home, ".claude.json"),
    codexToml: join(home, ".codex", "config.toml"),
  };
}

// ── Claude Code (~/.claude.json, JSON) ──────────────────────────────────────────
// Add mcpServers.oxtail ONLY if absent (jsonc-parser preserves unrelated keys, order,
// comments, whitespace). Returns {changed, next}; changed=false ⇒ already present or a
// non-oxtail entry we won't touch. A blank/missing file starts from `{}`.
export function claudeMcpEdit(current: string): { changed: boolean; next: string; reason: string } {
  const text = current.trim() ? current : "{}";
  // jsonc-parser is LENIENT (collects errors, doesn't throw) — so check the error array
  // and leave a malformed file untouched rather than risk corrupting it.
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: true });
  if (errors.length) return { changed: false, next: current, reason: "unparseable — left untouched" };
  const existing = (parsed as { mcpServers?: Record<string, unknown> } | null)?.mcpServers?.oxtail;
  if (existing) return { changed: false, next: current, reason: "already registered" };
  const edits = modify(text, ["mcpServers", "oxtail"], { command: MCP_COMMAND, args: MCP_ARGS }, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  return { changed: true, next: applyEdits(text, edits), reason: "registered" };
}

// ── Codex CLI (~/.codex/config.toml, TOML) ──────────────────────────────────────
// No TOML lib in deps + a parse→rewrite would reflow the user's file, so APPEND the
// table only when it's absent (a duplicate `[mcp_servers.oxtail]` would be a TOML
// error, so the presence check is also the idempotency guard). Append-only = the rest
// of the file is never rewritten.
const CODEX_BLOCK = `[mcp_servers.oxtail]\ncommand = "${MCP_COMMAND}"\nargs = [${MCP_ARGS.map((a) => `"${a}"`).join(", ")}]\n`;

export function codexMcpEdit(current: string): { changed: boolean; next: string; reason: string } {
  if (/^\s*\[mcp_servers\.oxtail\]/m.test(current)) {
    return { changed: false, next: current, reason: "already registered" };
  }
  const sep = current.length === 0 || current.endsWith("\n") ? (current.length && !current.endsWith("\n\n") ? "\n" : "") : "\n\n";
  return { changed: true, next: current + sep + CODEX_BLOCK, reason: "registered" };
}

// ── env detection ───────────────────────────────────────────────────────────────
export function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

export interface EnvReport {
  node: string;
  tmux: boolean;
  claude: boolean;
  codex: boolean;
}

export function detectEnv(): EnvReport {
  return { node: process.version, tmux: onPath("tmux"), claude: onPath("claude"), codex: onPath("codex") };
}

// Read a file, treating ENOENT as "" (a file to be created).
function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Write with a one-time backup of the pre-existing file (so a user can always revert).
function writeWithBackup(path: string, next: string, out: (m: string) => void): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) {
    const bak = `${path}.oxtail-bak`;
    if (!existsSync(bak)) {
      copyFileSync(path, bak);
      out(`    backup: ${bak}`);
    }
  }
  writeFileSync(path, next);
}

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

export interface SetupOptions {
  dryRun?: boolean;
  paths?: SetupPaths;
  out?: (m: string) => void;
  installHook?: () => Promise<void>; // injectable; defaults to the real install-hook
  env?: EnvReport; // injectable for tests
  color?: boolean;
}

export async function runSetup(argv: string[], opts: SetupOptions = {}): Promise<number> {
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(SETUP_USAGE + "\n");
    return 0;
  }
  const dryRun = opts.dryRun ?? (argv.includes("--dry-run") || argv.includes("-n"));
  const color = opts.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const c = {
    g: color ? GREEN : (s: string) => s,
    y: color ? YELLOW : (s: string) => s,
    d: color ? DIM : (s: string) => s,
  };
  const out = opts.out ?? ((m: string) => process.stdout.write(m + "\n"));
  const paths = opts.paths ?? defaultPaths();
  const env = opts.env ?? detectEnv();

  out(`oxtail setup${dryRun ? c.d(" (dry-run — nothing will be written)") : ""}`);
  out("");

  // 1. Register the MCP server in both client configs.
  const claude = claudeMcpEdit(readOrEmpty(paths.claudeJson));
  const codex = codexMcpEdit(readOrEmpty(paths.codexToml));
  for (const [label, path, r] of [
    ["Claude Code  ~/.claude.json", paths.claudeJson, claude],
    ["Codex CLI    ~/.codex/config.toml", paths.codexToml, codex],
  ] as const) {
    if (r.changed) {
      out(`  ${dryRun ? c.y("~") : c.g("✓")} ${label} — ${dryRun ? "would register oxtail MCP" : "registered oxtail MCP"}`);
      if (!dryRun) writeWithBackup(path, r.next, out);
    } else {
      out(`  ${c.g("✓")} ${label} — ${c.d(r.reason)}`);
    }
  }

  // 2. Install / refresh the message-delivery hook (idempotent itself).
  out("");
  if (dryRun) {
    out(`  ${c.y("~")} hook — would install/refresh (~/.claude/settings.json)`);
  } else {
    try {
      const install = opts.installHook ?? (async () => {
        const url = new URL("../scripts/install-hook.mjs", import.meta.url).href;
        const mod = (await import(url)) as { install: () => Promise<void> };
        await mod.install();
      });
      await install();
    } catch (e) {
      out(`  ${c.y("⚠")} hook install failed: ${e instanceof Error ? e.message : String(e)} — run \`npx oxtail install-hook\``);
    }
  }

  // 3. External prerequisites we can't install — detect + guide.
  out("");
  out("  prerequisites:");
  out(`    ${env.tmux ? c.g("✓") : c.y("⚠")} tmux        ${env.tmux ? c.d("found") : c.y("missing — `brew install tmux` (needed for `oxpit dock` + waking peers)")}`);
  out(`    ${env.claude ? c.g("✓") : c.y("⚠")} claude CLI  ${env.claude ? c.d("found") : c.y("missing — install + log in to run Claude agents")}`);
  out(`    ${env.codex ? c.g("✓") : c.y("⚠")} codex CLI   ${env.codex ? c.d("found") : c.y("missing — install + log in to run Codex agents")}`);

  out("");
  const blockers = [!env.tmux && "tmux"].filter(Boolean);
  if (dryRun) {
    out(c.d("  dry-run complete — re-run without --dry-run to apply."));
  } else if (blockers.length) {
    out(c.y(`  almost there — install ${blockers.join(", ")}, then run \`oxpit dock\` to assemble your cockpit.`));
  } else {
    out(c.g("  ✓ ready — run `oxpit dock` in a project to spawn your fleet + cockpit."));
  }
  return 0;
}

export const SETUP_USAGE = `oxtail setup — make this machine ready for the full oxtail experience

Registers the oxtail MCP server with Claude Code (~/.claude.json) and Codex CLI
(~/.codex/config.toml), installs the message-delivery hook, and checks the external
prerequisites (tmux, the claude/codex CLIs). Idempotent — safe to re-run after an
upgrade. Existing config entries are never overwritten; each file is backed up before
its first edit.

  oxtail setup            configure everything (writes config, with backups)
  oxtail setup --dry-run  show exactly what it would change, write nothing
  -h, --help              this help`;

#!/usr/bin/env node
// Install the oxtail PreToolUse hook into ~/.claude/settings.json.
//
// Idempotent: re-running on an installed system reports "already installed"
// and exits 0 without writing. Format-preserving: edits use jsonc-parser so
// unrelated keys, whitespace, and comments survive.
//
// Reverse with: npx oxtail uninstall-hook

import { readFile, writeFile, mkdir, rename, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import {
  SETTINGS_PATH,
  HOOK_MARKER_KEY,
  HOOK_MARKER_VERSION,
  HOOK_SCRIPT_PATH,
  HOOK_COMMAND,
  scriptHash,
} from "./hook-constants.mjs";

const SHIPPED_HOOK_PATH = new URL("../assets/pretooluse.sh", import.meta.url).pathname;
const FORMATTING = { tabSize: 2, insertSpaces: true };

function findOxtailHookIndex(parsed) {
  const arr = parsed?.hooks?.PreToolUse;
  if (!Array.isArray(arr)) return -1;
  return arr.findIndex((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (h) =>
        h &&
        typeof h === "object" &&
        typeof h.command === "string" &&
        // Loose match: any command referencing our installed script path.
        h.command.includes("oxtail/hooks/pretooluse.sh"),
    );
  });
}

export async function install() {
  const shipped = await readFile(SHIPPED_HOOK_PATH, "utf8");
  const wantHash = scriptHash(shipped);

  let source = "{}\n";
  if (existsSync(SETTINGS_PATH)) source = await readFile(SETTINGS_PATH, "utf8");
  const parsed = parse(source) ?? {};

  const marker = parsed[HOOK_MARKER_KEY];
  const existingIdx = findOxtailHookIndex(parsed);
  const upToDate =
    marker &&
    typeof marker === "object" &&
    marker.version === HOOK_MARKER_VERSION &&
    marker.scriptHash === wantHash &&
    existingIdx >= 0 &&
    existsSync(HOOK_SCRIPT_PATH);
  if (upToDate) {
    console.log(
      `oxtail hook already installed (v${HOOK_MARKER_VERSION}, hash ${wantHash.slice(0, 8)}). No changes.`,
    );
    return;
  }

  // Detect competing PreToolUse hooks (e.g. Terminator's _terminatorHook).
  // Behavior under multi-hook coexistence is determined live in Step 5
  // case 11 — for now, warn so users know install order may matter.
  const otherHooks = (parsed?.hooks?.PreToolUse ?? []).filter((entry, idx) => {
    if (idx === existingIdx) return false;
    if (!entry || !Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (h) => h && typeof h.command === "string" && !h.command.includes("oxtail/hooks/pretooluse.sh"),
    );
  });
  if (otherHooks.length > 0) {
    console.warn(
      `[oxtail] note: ${otherHooks.length} other PreToolUse hook(s) already installed. ` +
      `Multi-hook coexistence is supported but install order may matter; ` +
      `see README "Hook coexistence" for details.`,
    );
  }

  // Back up settings.json before mutating it (Skeptic M4).
  if (existsSync(SETTINGS_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${SETTINGS_PATH}.oxtail-backup.${stamp}`;
    await writeFile(backup, source, "utf8");
    console.log(`Backed up existing settings to ${backup}`);
  }

  // Install the shipped script atomically.
  const hooksDir = path.dirname(HOOK_SCRIPT_PATH);
  await mkdir(hooksDir, { recursive: true, mode: 0o755 });
  const scriptTmp = `${HOOK_SCRIPT_PATH}.tmp-${randomBytes(6).toString("hex")}`;
  await writeFile(scriptTmp, shipped, { mode: 0o755 });
  // writeFile's `mode` option only applies on file creation; an existing
  // tmp file would keep its previous perms. Explicit chmod for belt+braces.
  await chmod(scriptTmp, 0o755);
  await rename(scriptTmp, HOOK_SCRIPT_PATH);

  // Edit settings.json. Replace any prior oxtail entry; else append.
  let text = source;
  const newEntry = { hooks: [{ type: "command", command: HOOK_COMMAND }] };
  const arr = parsed?.hooks?.PreToolUse;
  if (existingIdx >= 0) {
    text = applyEdits(
      text,
      modify(text, ["hooks", "PreToolUse", existingIdx], newEntry, { formattingOptions: FORMATTING }),
    );
  } else {
    const insertIdx = Array.isArray(arr) ? arr.length : 0;
    text = applyEdits(
      text,
      modify(text, ["hooks", "PreToolUse", insertIdx], newEntry, { formattingOptions: FORMATTING }),
    );
  }
  text = applyEdits(
    text,
    modify(
      text,
      [HOOK_MARKER_KEY],
      {
        version: HOOK_MARKER_VERSION,
        installedAt: new Date().toISOString(),
        scriptHash: wantHash,
      },
      { formattingOptions: FORMATTING },
    ),
  );

  // Atomic write of settings.json.
  const settingsTmp = `${SETTINGS_PATH}.oxtail-tmp-${randomBytes(6).toString("hex")}`;
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(settingsTmp, text, "utf8");
  await rename(settingsTmp, SETTINGS_PATH);

  console.log(`Installed oxtail PreToolUse hook in ${SETTINGS_PATH}.`);
  console.log("Reverse with: npx oxtail uninstall-hook");
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(process.argv[1], "file:").href;
if (invokedDirectly) {
  install().catch((err) => {
    console.error("install-hook failed:", err?.message ?? err);
    process.exit(1);
  });
}

#!/usr/bin/env node
// Remove the oxtail PreToolUse hook entry and marker from
// ~/.claude/settings.json, and delete the installed ~/.oxtail/hooks/pretooluse.sh.
//
// Idempotent: a clean run on an uninstalled system exits 0 with "nothing to do."

import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyEdits, modify, parse } from "jsonc-parser";
import {
  SETTINGS_PATH,
  HOOK_MARKER_KEY,
  HOOK_SCRIPT_PATH,
} from "./hook-constants.mjs";

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
        h.command.includes("oxtail/hooks/pretooluse.sh"),
    );
  });
}

export async function uninstall() {
  if (!existsSync(SETTINGS_PATH)) {
    console.log(`No ${SETTINGS_PATH} — nothing to do.`);
    // Still try to remove the installed script in case it's a leftover.
    if (existsSync(HOOK_SCRIPT_PATH)) {
      try {
        await unlink(HOOK_SCRIPT_PATH);
        console.log(`Removed ${HOOK_SCRIPT_PATH}.`);
      } catch (err) {
        console.warn(`Could not remove ${HOOK_SCRIPT_PATH}: ${err?.message ?? err}`);
      }
    }
    return;
  }

  const source = await readFile(SETTINGS_PATH, "utf8");
  const parsed = parse(source) ?? {};

  const idx = findOxtailHookIndex(parsed);
  const hasMarker =
    parsed[HOOK_MARKER_KEY] && typeof parsed[HOOK_MARKER_KEY] === "object";

  if (idx < 0 && !hasMarker && !existsSync(HOOK_SCRIPT_PATH)) {
    console.log("oxtail hook not installed — nothing to do.");
    return;
  }

  let text = source;
  if (idx >= 0) {
    text = applyEdits(
      text,
      modify(text, ["hooks", "PreToolUse", idx], undefined, { formattingOptions: FORMATTING }),
    );
  }
  if (hasMarker) {
    text = applyEdits(
      text,
      modify(text, [HOOK_MARKER_KEY], undefined, { formattingOptions: FORMATTING }),
    );
  }

  const settingsTmp = `${SETTINGS_PATH}.oxtail-tmp-${randomBytes(6).toString("hex")}`;
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(settingsTmp, text, "utf8");
  await rename(settingsTmp, SETTINGS_PATH);
  console.log(`Removed oxtail PreToolUse hook from ${SETTINGS_PATH}.`);

  if (existsSync(HOOK_SCRIPT_PATH)) {
    try {
      await unlink(HOOK_SCRIPT_PATH);
      console.log(`Removed ${HOOK_SCRIPT_PATH}.`);
    } catch (err) {
      console.warn(`Could not remove ${HOOK_SCRIPT_PATH}: ${err?.message ?? err}`);
    }
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(process.argv[1], "file:").href;
if (invokedDirectly) {
  uninstall().catch((err) => {
    console.error("uninstall-hook failed:", err?.message ?? err);
    process.exit(1);
  });
}

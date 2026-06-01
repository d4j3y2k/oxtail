#!/usr/bin/env node
// Remove the oxtail hook entries (PreToolUse + Stop) and marker from
// ~/.claude/settings.json, and delete the installed scripts under
// ~/.oxtail/hooks/.
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
  MANAGED_HOOKS,
} from "./hook-constants.mjs";

const FORMATTING = { tabSize: 2, insertSpaces: true };

function findOxtailHookIndex(parsed, event, asset) {
  const arr = parsed?.hooks?.[event];
  if (!Array.isArray(arr)) return -1;
  return arr.findIndex((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some(
      (h) =>
        h &&
        typeof h === "object" &&
        typeof h.command === "string" &&
        h.command.includes(`oxtail/hooks/${asset}`),
    );
  });
}

async function removeScripts() {
  for (const h of MANAGED_HOOKS) {
    if (!existsSync(h.scriptPath)) continue;
    try {
      await unlink(h.scriptPath);
      console.log(`Removed ${h.scriptPath}.`);
    } catch (err) {
      console.warn(`Could not remove ${h.scriptPath}: ${err?.message ?? err}`);
    }
  }
}

export async function uninstall() {
  if (!existsSync(SETTINGS_PATH)) {
    console.log(`No ${SETTINGS_PATH} — nothing to do.`);
    // Still try to remove installed scripts in case they're leftovers.
    await removeScripts();
    return;
  }

  const source = await readFile(SETTINGS_PATH, "utf8");
  const parsed = parse(source) ?? {};

  const hasMarker =
    parsed[HOOK_MARKER_KEY] && typeof parsed[HOOK_MARKER_KEY] === "object";
  const anyEntry = MANAGED_HOOKS.some(
    (h) => findOxtailHookIndex(parsed, h.event, h.asset) >= 0,
  );
  const anyScript = MANAGED_HOOKS.some((h) => existsSync(h.scriptPath));

  if (!anyEntry && !hasMarker && !anyScript) {
    console.log("oxtail hooks not installed — nothing to do.");
    return;
  }

  // Remove each event's oxtail entry. Re-parse per iteration so indices stay
  // valid after the prior edit.
  let text = source;
  for (const h of MANAGED_HOOKS) {
    const cur = parse(text) ?? {};
    const idx = findOxtailHookIndex(cur, h.event, h.asset);
    if (idx >= 0) {
      text = applyEdits(
        text,
        modify(text, ["hooks", h.event, idx], undefined, { formattingOptions: FORMATTING }),
      );
    }
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
  console.log(`Removed oxtail hooks from ${SETTINGS_PATH}.`);

  await removeScripts();
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

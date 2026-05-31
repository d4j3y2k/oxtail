#!/usr/bin/env node
// Install the oxtail hooks (PreToolUse + Stop) into ~/.claude/settings.json.
//
// Idempotent: re-running on an up-to-date system reports "already installed"
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
  MANAGED_HOOKS,
  scriptHash,
} from "./hook-constants.mjs";

const FORMATTING = { tabSize: 2, insertSpaces: true };

// Find an oxtail-managed hook entry by its installed script filename
// (e.g. "oxtail/hooks/pretooluse.sh"). Loose substring match tolerates the
// "$HOME/..."-quoted command form. -F (fixed-string) is unsafe.
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

export async function install() {
  // Read shipped scripts + compute hashes up front.
  const shipped = [];
  for (const hook of MANAGED_HOOKS) {
    const shippedPath = new URL(`../assets/${hook.asset}`, import.meta.url).pathname;
    const text = await readFile(shippedPath, "utf8");
    shipped.push({ ...hook, text, hash: scriptHash(text) });
  }

  let source = "{}\n";
  if (existsSync(SETTINGS_PATH)) source = await readFile(SETTINGS_PATH, "utf8");
  const parsed = parse(source) ?? {};

  const marker = parsed[HOOK_MARKER_KEY];
  const markerHashes = (marker && typeof marker === "object" && marker.hashes) || {};
  const upToDate =
    marker &&
    typeof marker === "object" &&
    marker.version === HOOK_MARKER_VERSION &&
    shipped.every(
      (h) =>
        markerHashes[h.id] === h.hash &&
        findOxtailHookIndex(parsed, h.event, h.asset) >= 0 &&
        existsSync(h.scriptPath),
    );
  if (upToDate) {
    console.log(`oxtail hooks already installed (v${HOOK_MARKER_VERSION}). No changes.`);
    return;
  }

  // Detect competing hooks on the same events (e.g. Terminator's _terminatorHook).
  // Behavior under multi-hook coexistence is determined live; for now, warn.
  let otherCount = 0;
  for (const h of shipped) {
    const arr = parsed?.hooks?.[h.event] ?? [];
    const mine = findOxtailHookIndex(parsed, h.event, h.asset);
    otherCount += arr.filter((entry, idx) => {
      if (idx === mine) return false;
      if (!entry || !Array.isArray(entry.hooks)) return false;
      return entry.hooks.some(
        (x) => x && typeof x.command === "string" && !x.command.includes("oxtail/hooks/"),
      );
    }).length;
  }
  if (otherCount > 0) {
    console.warn(
      `[oxtail] note: ${otherCount} other hook(s) already present on managed events. ` +
      `Multi-hook coexistence is supported but install order may matter; ` +
      `see README "Hook coexistence" for details.`,
    );
  }

  // Back up settings.json before mutating it.
  if (existsSync(SETTINGS_PATH)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${SETTINGS_PATH}.oxtail-backup.${stamp}`;
    await writeFile(backup, source, "utf8");
    console.log(`Backed up existing settings to ${backup}`);
  }

  // Install each shipped script atomically.
  for (const h of shipped) {
    const hooksDir = path.dirname(h.scriptPath);
    await mkdir(hooksDir, { recursive: true, mode: 0o755 });
    const scriptTmp = `${h.scriptPath}.tmp-${randomBytes(6).toString("hex")}`;
    // writeFile's `mode` only applies on creation; explicit chmod for belt+braces.
    await writeFile(scriptTmp, h.text, { mode: 0o755 });
    await chmod(scriptTmp, 0o755);
    await rename(scriptTmp, h.scriptPath);
  }

  // Edit settings.json: replace any prior oxtail entry per event, else append.
  // Re-parse each iteration so indices reflect the prior edit. The two events
  // are independent, but re-parsing keeps append indices correct regardless.
  let text = source;
  for (const h of shipped) {
    const cur = parse(text) ?? {};
    const existingIdx = findOxtailHookIndex(cur, h.event, h.asset);
    const arr = cur?.hooks?.[h.event];
    const targetIdx = existingIdx >= 0 ? existingIdx : (Array.isArray(arr) ? arr.length : 0);
    const newEntry = { hooks: [{ type: "command", command: h.command }] };
    text = applyEdits(
      text,
      modify(text, ["hooks", h.event, targetIdx], newEntry, { formattingOptions: FORMATTING }),
    );
  }

  // Write the marker with per-hook hashes.
  const hashes = {};
  for (const h of shipped) hashes[h.id] = h.hash;
  text = applyEdits(
    text,
    modify(
      text,
      [HOOK_MARKER_KEY],
      { version: HOOK_MARKER_VERSION, installedAt: new Date().toISOString(), hashes },
      { formattingOptions: FORMATTING },
    ),
  );

  // Atomic write of settings.json.
  const settingsTmp = `${SETTINGS_PATH}.oxtail-tmp-${randomBytes(6).toString("hex")}`;
  await mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(settingsTmp, text, "utf8");
  await rename(settingsTmp, SETTINGS_PATH);

  console.log(
    `Installed oxtail hooks (${MANAGED_HOOKS.map((h) => h.event).join(", ")}) in ${SETTINGS_PATH}.`,
  );
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

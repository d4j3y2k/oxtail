// Shared constants for install-hook.mjs / uninstall-hook.mjs.
// Tiny on purpose — only the things both scripts genuinely need.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

export const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
export const HOOK_MARKER_KEY = "_oxtailHook";
// Bumping the version forces existing installs to upgrade (install any newly
// managed hooks) on the next `npx oxtail install-hook`.
//   v2: added the Stop hook alongside PreToolUse.
//   v3: added the UserPromptSubmit hook (busy/idle activity for wake-routing).
//   v4: pretooluse renders request_id/reply_to/origin + body-budget truncation
//       (v0.10.x correlated ask/reply). A stale pre-v4 pretooluse.sh silently
//       breaks Codex→Claude correlation by stripping request_id from the
//       delivered envelope, so the receiver can't reply_to=request_id.
// INVARIANT: any change to an assets/*.sh script MUST bump this version, so
// existing installs are forced to re-install. scripts/check-hook-version.mjs
// enforces this in CI.
export const HOOK_MARKER_VERSION = 4;

const HOOKS_DIR = path.join(os.homedir(), ".oxtail", "hooks");

// Every hook oxtail manages.
//   id         — keys the per-hook hash in the settings.json marker
//   event      — the Claude Code hook event name
//   asset      — shipped script filename under assets/
//   scriptPath — where the script is installed
//   command    — the literal settings.json command (stable across installs;
//                only the script file at scriptPath may drift, which is why
//                the marker hashes the script, not the command)
export const MANAGED_HOOKS = [
  {
    id: "pretooluse",
    event: "PreToolUse",
    asset: "pretooluse.sh",
    scriptPath: path.join(HOOKS_DIR, "pretooluse.sh"),
    command: `"$HOME/.oxtail/hooks/pretooluse.sh"`,
  },
  {
    id: "stop",
    event: "Stop",
    asset: "stop.sh",
    scriptPath: path.join(HOOKS_DIR, "stop.sh"),
    command: `"$HOME/.oxtail/hooks/stop.sh"`,
  },
  {
    id: "userpromptsubmit",
    event: "UserPromptSubmit",
    asset: "userpromptsubmit.sh",
    scriptPath: path.join(HOOKS_DIR, "userpromptsubmit.sh"),
    command: `"$HOME/.oxtail/hooks/userpromptsubmit.sh"`,
  },
];

// Back-compat: the original single-hook exports, kept so any external importer
// keeps resolving. Internally install/uninstall iterate MANAGED_HOOKS.
export const HOOK_SCRIPT_PATH = MANAGED_HOOKS[0].scriptPath;
export const HOOK_COMMAND = MANAGED_HOOKS[0].command;

export function scriptHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Directory holding the shipped hook scripts, resolved relative to this module
// so it works both from src (dev/tests) and dist (published) — scripts/ and
// assets/ ship side by side in the npm tarball.
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

// Hash of each shipped hook asset as it exists in THIS install of the package.
// Compared against the marker's recorded hashes to detect a stale install.
// A null entry means the asset couldn't be read (skip it rather than alarm).
export function shippedHookHashes() {
  const hashes = {};
  for (const h of MANAGED_HOOKS) {
    try {
      hashes[h.id] = scriptHash(readFileSync(path.join(ASSETS_DIR, h.asset), "utf8"));
    } catch {
      hashes[h.id] = null;
    }
  }
  return hashes;
}

// Assess whether the installed oxtail hooks match what this package version
// ships. The flagship failure mode this guards: a package upgrade changes a
// hook asset, but nothing re-runs install-hook, so the OLD script keeps running
// (e.g. v0.10.1's pretooluse.sh added request_id rendering; pre-v4 installs
// silently stripped it and broke correlated ask/reply). install-hook's
// presence check alone never noticed — a present-but-stale marker looked fine.
//
// Never throws; defaults to a silent "unknown"/"ok" on any read/parse failure
// so server startup never nags spuriously. Returns:
//   status: "ok"      — marker present and every shipped hash matches the marker
//           "absent"  — no _oxtailHook marker (hooks never installed)
//           "stale"   — marker present but one or more script hashes drifted
//           "unknown" — settings unreadable/unparseable; caller should stay quiet
//   driftedHooks      — ids whose installed hash != shipped hash
//   versionMismatch   — marker.version != HOOK_MARKER_VERSION (informational)
export function assessHookFreshness(settingsPath = SETTINGS_PATH) {
  let text;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch {
    // No settings file == hooks were never installed.
    return { status: "absent", driftedHooks: [], versionMismatch: false };
  }
  // Cheap pre-check mirrors the original presence test.
  if (!text.includes(HOOK_MARKER_KEY)) {
    return { status: "absent", driftedHooks: [], versionMismatch: false };
  }
  let parsed;
  try {
    parsed = parseJsonc(text);
  } catch {
    return { status: "unknown", driftedHooks: [], versionMismatch: false };
  }
  const marker = parsed && typeof parsed === "object" ? parsed[HOOK_MARKER_KEY] : null;
  if (!marker || typeof marker !== "object") {
    return { status: "absent", driftedHooks: [], versionMismatch: false };
  }
  const installedHashes =
    marker.hashes && typeof marker.hashes === "object" ? marker.hashes : {};
  const shipped = shippedHookHashes();
  const driftedHooks = [];
  for (const h of MANAGED_HOOKS) {
    const want = shipped[h.id];
    if (want == null) continue; // can't compare; don't false-alarm
    if (installedHashes[h.id] !== want) driftedHooks.push(h.id);
  }
  const versionMismatch = marker.version !== HOOK_MARKER_VERSION;
  // Trigger "stale" on actual script drift only — a version-only mismatch with
  // identical content is benign bookkeeping (install-hook will refresh the
  // marker) and not worth a startup warning.
  const status = driftedHooks.length > 0 ? "stale" : "ok";
  return { status, driftedHooks, versionMismatch };
}

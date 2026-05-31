// Shared constants for install-hook.mjs / uninstall-hook.mjs.
// Tiny on purpose — only the things both scripts genuinely need.

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
export const HOOK_MARKER_KEY = "_oxtailHook";
// v2: adds the Stop hook alongside PreToolUse. Bumping the version forces
// existing v1 installs to upgrade (install the new Stop hook) on the next
// `npx oxtail install-hook`.
export const HOOK_MARKER_VERSION = 2;

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
];

// Back-compat: the original single-hook exports, kept so any external importer
// keeps resolving. Internally install/uninstall iterate MANAGED_HOOKS.
export const HOOK_SCRIPT_PATH = MANAGED_HOOKS[0].scriptPath;
export const HOOK_COMMAND = MANAGED_HOOKS[0].command;

export function scriptHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

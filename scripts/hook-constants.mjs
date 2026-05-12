// Shared constants for install-hook.mjs / uninstall-hook.mjs.
// Tiny on purpose — only the things both scripts genuinely need.

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

export const SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");
export const HOOK_MARKER_KEY = "_oxtailHook";
export const HOOK_MARKER_VERSION = 1;
export const HOOK_SCRIPT_PATH = path.join(os.homedir(), ".oxtail", "hooks", "pretooluse.sh");
// The literal command string that ends up in settings.json. Stable across
// installs — only the script file at HOOK_SCRIPT_PATH may drift, which is
// why we only hash the script (not the command).
export const HOOK_COMMAND = `"$HOME/.oxtail/hooks/pretooluse.sh"`;

export function scriptHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

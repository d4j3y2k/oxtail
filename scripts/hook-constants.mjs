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
//   v5: token-efficiency pass on the delivered envelope — pretooluse + stop
//       collapse the 4-line preamble to one line, inline the per-message header,
//       and drop the redundant single-valued `origin` field. message_id +
//       from_session_id are still rendered (correlation/debug unaffected); a
//       stale pre-v5 hook is only larger, never wrong.
//   v6: owner-token advisory lock (mirror of src/locks.ts) in pretooluse + stop.
//       The lock dir gains a sidecar `<lock>.owner` token; stale removal is
//       gated behind a single-winner `<lock>.steal` marker + compare-and-clear,
//       and release only removes a lock we still own. The sidecar layout keeps
//       the lock dir EMPTY so a pre-v6 hook's plain `rmdir` still removes a v6
//       lock — i.e. mixed versions never WEDGE. They are not fully race-safe,
//       though: a pre-v6 hook does an unconditional stale-rmdir / release-rmdir
//       with no owner check, so during an upgrade window (before re-install) the
//       old hook can still lose the stall-resume / double-clear races against a
//       v6 peer. The version bump forces re-install to close that window.
//   v7: pretooluse re-stamps the "busy" activity marker on every tool call, so a
//       long ACTIVE turn stays fresh and doesn't invite a spurious wake:auto once
//       it outruns ACTIVITY_BUSY_TTL_MS. A stale pre-v7 hook just doesn't refresh
//       (the prior behavior) — never wrong, only less fresh on long turns.
//   v8: session-keyed mailboxes + the hook-drain helper. pretooluse/stop become
//       thin bash triggers: the fast path (sid, busy/idle marker, non-empty
//       mailbox discovery incl. the new session box via the registry's
//       `mailbox_key`) stays bash; lock+parse+render moves to a Node helper
//       installed beside the scripts (HELPER_FILES), one implementation shared
//       with the server. A stale pre-v8 hook keeps draining LEGACY pid boxes
//       correctly but never sees the session box — and a v0.17+ peer's sends
//       route there — so the upgrade warning matters: re-run install-hook.
//   v9: SessionStart auto-join drop. New sessionstart.sh writes the hook's
//       stdin payload (session_id, cwd, transcript_path) + the writing hook's
//       $PPID/start-sig to ~/.oxtail/session-starts/<safe_sid>; the server's
//       hook-drop detect strategy adopts it (ancestry-disambiguated), removing
//       the manual /oxtail-join ceremony for hooked Claude Code sessions. A
//       missing/stale sessionstart.sh just means detection falls back to the
//       explicit claim — never wrong, only manual.
//  v10: sessionstart.sh collapses internal space runs in ppid_sig. lstart pads
//       single-digit days with a double space ("Tue Jun  9"), but the reader's
//       sig (claims.ts snapshotProcs) is rebuilt single-spaced from a
//       whitespace split, so v9 drops failed ancestorConfirmed on days 1-9 of
//       every month. The server also normalizes on read, so v9 drops still
//       confirm against a v0.17.1+ server; the hook fix keeps the on-disk
//       drop canonical. hook-drain.ts: truncate a non-empty box whose lines
//       are ALL torn/invalid so it stops re-spawning the helper every call.
// INVARIANT: any change to an assets/*.sh script or the helper sources MUST
// bump this version, so existing installs are forced to re-install.
// scripts/check-hook-version.mjs enforces this in CI.
export const HOOK_MARKER_VERSION = 10;

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
  {
    id: "sessionstart",
    event: "SessionStart",
    asset: "sessionstart.sh",
    scriptPath: path.join(HOOKS_DIR, "sessionstart.sh"),
    command: `"$HOME/.oxtail/hooks/sessionstart.sh"`,
  },
];

// Back-compat: the original single-hook exports, kept so any external importer
// keeps resolving. Internally install/uninstall iterate MANAGED_HOOKS.
export const HOOK_SCRIPT_PATH = MANAGED_HOOKS[0].scriptPath;
export const HOOK_COMMAND = MANAGED_HOOKS[0].command;

// The hook-drain helper and its (compiled) dependency closure, installed beside
// the hook scripts so the hooks never depend on the ephemeral npx package dir.
// Sources are the package's dist/ output — the SAME compiled lock/mailbox code
// the server runs, which is the whole point: the advisory-lock and JSONL-parse
// protocols live once, in src/locks.ts and src/mailbox.ts. The files keep their
// relative-import names; HELPER_PACKAGE_JSON marks the install dir as ESM so
// node runs them as modules.
//   id         — keys the per-file hash in the settings.json marker
//   dist       — filename under the package's dist/
//   installPath— where the file lands
export const HELPER_FILES = [
  "hook-drain.js",
  "mailbox.js",
  "locks.js",
  "trace.js",
].map((f) => ({
  id: `helper:${f}`,
  dist: f,
  installPath: path.join(HOOKS_DIR, f === "hook-drain.js" ? "hook-drain.mjs" : f),
}));
export const HELPER_PACKAGE_JSON = path.join(HOOKS_DIR, "package.json");

export function scriptHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Directory holding the shipped hook scripts, resolved relative to this module
// so it works both from src (dev/tests) and dist (published) — scripts/ and
// assets/ ship side by side in the npm tarball.
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
// The compiled helper sources. In a published install this always exists; in a
// dev checkout it requires `npm run build` (the test script builds first).
export const DIST_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

// Hash of each shipped hook asset + helper file as it exists in THIS install of
// the package. Compared against the marker's recorded hashes to detect a stale
// install. A null entry means the file couldn't be read (skip it rather than
// alarm — e.g. an unbuilt dev checkout has no dist/).
export function shippedHookHashes() {
  const hashes = {};
  for (const h of MANAGED_HOOKS) {
    try {
      hashes[h.id] = scriptHash(readFileSync(path.join(ASSETS_DIR, h.asset), "utf8"));
    } catch {
      hashes[h.id] = null;
    }
  }
  for (const f of HELPER_FILES) {
    try {
      hashes[f.id] = scriptHash(readFileSync(path.join(DIST_DIR, f.dist), "utf8"));
    } catch {
      hashes[f.id] = null;
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
  for (const id of [...MANAGED_HOOKS.map((h) => h.id), ...HELPER_FILES.map((f) => f.id)]) {
    const want = shipped[id];
    if (want == null) continue; // can't compare; don't false-alarm
    if (installedHashes[id] !== want) driftedHooks.push(id);
  }
  const versionMismatch = marker.version !== HOOK_MARKER_VERSION;
  // Trigger "stale" on actual script drift only — a version-only mismatch with
  // identical content is benign bookkeeping (install-hook will refresh the
  // marker) and not worth a startup warning.
  const status = driftedHooks.length > 0 ? "stale" : "ok";
  return { status, driftedHooks, versionMismatch };
}

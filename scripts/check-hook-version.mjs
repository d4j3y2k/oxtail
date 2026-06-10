#!/usr/bin/env node
// CI guard: any change to a shipped hook asset (assets/*.sh) MUST bump
// HOOK_MARKER_VERSION in scripts/hook-constants.mjs. Without the bump, an asset
// change ships silently and users who upgraded oxtail keep running the OLD hook
// (nothing re-runs install-hook on upgrade). That is exactly the bug that broke
// v0.10.1's correlated ask/reply on the receive side: pretooluse.sh gained
// request_id rendering but the marker version stayed put, so existing installs
// never refreshed and silently stripped request_id.
//
// Usage: node scripts/check-hook-version.mjs [baseRef]
//   baseRef defaults to $GITHUB_BASE_SHA, then origin/main.
//
// Deliberately dependency-free (only node:child_process + node:fs) so CI can
// run it without `npm ci`. Reads both versions by regex rather than importing
// hook-constants.mjs (which now pulls jsonc-parser).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function parseVersion(text) {
  const m = text.match(/HOOK_MARKER_VERSION\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

const base = process.argv[2] || process.env.GITHUB_BASE_SHA || "origin/main";
// Hook scripts AND the hook-drain helper entry: both run as the installed hook
// surface. (The helper's mailbox/locks deps drift via the marker hash check at
// server startup instead — bumping the version for every mailbox.ts change
// would be noise.)
const HOOK_ASSET_RE = /^(assets\/.*\.sh|src\/hook-drain\.ts)$/;

let changed;
try {
  changed = git(["diff", "--name-only", `${base}...HEAD`]).split("\n").filter(Boolean);
} catch (e) {
  const msg = (e && e.message ? String(e.message).split("\n")[0] : String(e));
  console.warn(
    `[check-hook-version] could not diff against base "${base}" (${msg}); skipping guard. ` +
      "Ensure the base ref is fetched (actions/checkout fetch-depth: 0).",
  );
  process.exit(0);
}

const changedAssets = changed.filter((f) => HOOK_ASSET_RE.test(f));
if (changedAssets.length === 0) {
  console.log("[check-hook-version] no hook asset changes — OK.");
  process.exit(0);
}

const headVersion = parseVersion(readFileSync("scripts/hook-constants.mjs", "utf8"));
let baseVersion = null;
try {
  baseVersion = parseVersion(git(["show", `${base}:scripts/hook-constants.mjs`]));
} catch {
  baseVersion = null;
}

if (headVersion == null || baseVersion == null) {
  console.error(
    "[check-hook-version] hook asset(s) changed but HOOK_MARKER_VERSION could not be read:\n  " +
      changedAssets.join("\n  ") +
      `\n(head=${headVersion}, base=${baseVersion}). Verify scripts/hook-constants.mjs and bump the version.`,
  );
  process.exit(1);
}

if (headVersion > baseVersion) {
  console.log(
    `[check-hook-version] OK — ${changedAssets.length} hook asset(s) changed and ` +
      `HOOK_MARKER_VERSION bumped ${baseVersion} → ${headVersion}.`,
  );
  process.exit(0);
}

console.error(
  "[check-hook-version] FAIL — these hook asset(s) changed:\n  " +
    changedAssets.join("\n  ") +
    `\nbut HOOK_MARKER_VERSION did not increase (base ${baseVersion}, head ${headVersion}).\n` +
    "Bump HOOK_MARKER_VERSION in scripts/hook-constants.mjs so existing installs are forced to " +
    "re-run `npx oxtail install-hook`; otherwise upgraded users silently keep the old hook.",
);
process.exit(1);

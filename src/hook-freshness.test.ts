// Unit tests for assessHookFreshness — the server-startup staleness check that
// catches "upgraded oxtail but never re-ran install-hook" (the v0.10.1 stale-
// hook bug). Lives in scripts/ because install/uninstall/server all share it.

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assessHookFreshness,
  shippedHookHashes,
  HOOK_MARKER_KEY,
  HOOK_MARKER_VERSION,
} from "../scripts/hook-constants.mjs";

function withSettings(obj: unknown, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-fresh-"));
  const path = join(dir, "settings.json");
  writeFileSync(path, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
  try {
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function markerWith(hashes: Record<string, string>, version = HOOK_MARKER_VERSION) {
  return { [HOOK_MARKER_KEY]: { version, installedAt: "x", hashes } };
}

test("freshness: matching shipped hashes → ok", () => {
  withSettings(markerWith(shippedHookHashes()), (path) => {
    const r = assessHookFreshness(path);
    assert.equal(r.status, "ok");
    assert.deepEqual(r.driftedHooks, []);
    assert.equal(r.versionMismatch, false);
  });
});

test("freshness: a drifted hook hash → stale, names the hook", () => {
  const hashes = { ...shippedHookHashes(), pretooluse: "deadbeefdeadbeef" };
  withSettings(markerWith(hashes), (path) => {
    const r = assessHookFreshness(path);
    assert.equal(r.status, "stale");
    assert.ok(r.driftedHooks.includes("pretooluse"));
  });
});

test("freshness: no marker → absent", () => {
  withSettings({ hooks: {} }, (path) => {
    assert.equal(assessHookFreshness(path).status, "absent");
  });
});

test("freshness: missing settings file → absent", () => {
  const r = assessHookFreshness(join(tmpdir(), "oxtail-does-not-exist-xyz", "settings.json"));
  assert.equal(r.status, "absent");
});

test("freshness: version mismatch alone (hashes current) stays ok, but flags versionMismatch", () => {
  withSettings(markerWith(shippedHookHashes(), HOOK_MARKER_VERSION - 1), (path) => {
    const r = assessHookFreshness(path);
    // Version-only drift is benign bookkeeping — must NOT nag as stale.
    assert.equal(r.status, "ok");
    assert.equal(r.versionMismatch, true);
  });
});

test("freshness: unparseable settings → unknown (caller stays silent)", () => {
  withSettings(`{ this is not valid json ${HOOK_MARKER_KEY}`, (path) => {
    const r = assessHookFreshness(path);
    assert.ok(r.status === "unknown" || r.status === "absent");
  });
});

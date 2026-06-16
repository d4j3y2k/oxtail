import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { captureClipboardImage, type GrabResult } from "./clipboard.js";

test("captureClipboardImage: non-macOS degrades with a drag-instead hint", () => {
  const r = captureClipboardImage(() => "png", "linux");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /macOS-only/);
});

test("captureClipboardImage: empty clipboard ⇒ 'no image' (not a crash)", () => {
  const r = captureClipboardImage(() => "noimage", "darwin");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no image on the clipboard/);
});

test("captureClipboardImage: a grabbed image lands at a real temp path", () => {
  const grab: (p: string) => GrabResult = (p) => {
    writeFileSync(p, "fake-png-bytes");
    return "png";
  };
  const r = captureClipboardImage(grab, "darwin");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(existsSync(r.path));
  assert.equal(readFileSync(r.path, "utf8"), "fake-png-bytes");
  rmSync(dirname(r.path), { recursive: true, force: true }); // caller-owned cleanup
});

test("captureClipboardImage: a throwing grab is caught, never propagates", () => {
  const r = captureClipboardImage(() => {
    throw new Error("osascript exploded");
  }, "darwin");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /clipboard read failed/);
});

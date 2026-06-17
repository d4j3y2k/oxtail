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

test("captureClipboardImage: noimage cleans up the temp dir it created", () => {
  let seen = "";
  const r = captureClipboardImage((p) => {
    seen = p;
    return "noimage";
  }, "darwin");
  assert.equal(r.ok, false);
  assert.ok(seen, "grab should have been handed a path inside the temp dir");
  assert.equal(existsSync(dirname(seen)), false, "temp dir removed on noimage");
});

test("captureClipboardImage: a throwing grab cleans up the temp dir", () => {
  let seen = "";
  const r = captureClipboardImage((p) => {
    seen = p;
    throw new Error("boom");
  }, "darwin");
  assert.equal(r.ok, false);
  assert.equal(existsSync(dirname(seen)), false, "temp dir removed on throw");
});

test("captureClipboardImage: oversize result is rejected and the temp dir reaped", () => {
  let seen = "";
  const grab: (p: string) => GrabResult = (p) => {
    seen = p;
    writeFileSync(p, Buffer.alloc(2048)); // 2 KB
    return "png";
  };
  const r = captureClipboardImage(grab, "darwin", 1024); // 1 KB cap
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /too large/);
  assert.equal(existsSync(dirname(seen)), false, "temp dir removed when oversize");
});

test("captureClipboardImage: under-cap image is kept (caller cleans on ok)", () => {
  const grab: (p: string) => GrabResult = (p) => {
    writeFileSync(p, Buffer.alloc(512));
    return "png";
  };
  const r = captureClipboardImage(grab, "darwin", 1024);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(existsSync(r.path));
  rmSync(dirname(r.path), { recursive: true, force: true });
});

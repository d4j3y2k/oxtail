import { strict as assert } from "node:assert";
import { test } from "node:test";
import { cell, clip, clipToWidth, displayWidth, fmtAge } from "./format.js";

test("fmtAge: buckets seconds → s/m/h/d", () => {
  assert.equal(fmtAge(null), "—");
  assert.equal(fmtAge(0), "0s");
  assert.equal(fmtAge(45), "45s");
  assert.equal(fmtAge(60), "1m");
  assert.equal(fmtAge(3599), "59m");
  assert.equal(fmtAge(3600), "1h");
  assert.equal(fmtAge(90_000), "1d");
  assert.equal(fmtAge(-5), "0s"); // defensive
});

test("clip: collapses whitespace and adds ellipsis", () => {
  assert.equal(clip("hello", 10), "hello");
  assert.equal(clip("hello world", 8), "hello w…");
  assert.equal(clip("a\nb\tc   d", 20), "a b c d"); // newlines/tabs flattened
  assert.equal(clip("xyz", 0), "");
  assert.equal(clip("xyz", 1), "…");
});

test("displayWidth: ASCII counts 1 per char", () => {
  assert.equal(displayWidth(""), 0);
  assert.equal(displayWidth("hello"), 5);
});

test("displayWidth: ANSI SGR sequences are zero-width", () => {
  assert.equal(displayWidth("\x1b[31mred\x1b[0m"), 3);
  assert.equal(displayWidth("\x1b[1m\x1b[36mhi\x1b[0m"), 2);
});

test("displayWidth: known glyphs count as 2", () => {
  assert.equal(displayWidth("🟢"), 2);
  assert.equal(displayWidth("🟢 x"), 4); // glyph(2) + space(1) + x(1)
  assert.equal(displayWidth("✉⚑⏳"), 6);
});

test("clipToWidth: plain truncation by visible width", () => {
  assert.equal(clipToWidth("hello world", 5), "hello");
  assert.equal(clipToWidth("hello", 10), "hello"); // fits → unchanged
  assert.equal(clipToWidth("abc", 0), "");
});

test("clipToWidth: never splits a wide glyph, clips before it", () => {
  // "x" (1) + "🟢" (2) = width 3. At width 2 the glyph can't fit → only "x".
  assert.equal(clipToWidth("x🟢", 2), "x");
  assert.equal(clipToWidth("x🟢", 3), "x🟢");
});

test("clipToWidth: preserves ANSI and appends reset when truncated mid-color", () => {
  const out = clipToWidth("\x1b[31mredtext\x1b[0m", 3);
  assert.ok(out.startsWith("\x1b[31m"), "keeps the opening color");
  assert.ok(out.endsWith("\x1b[0m"), "closes the color on truncation");
  assert.equal(displayWidth(out), 3);
});

test("clipToWidth: ANSI codes don't consume width budget", () => {
  // 5 visible chars wrapped in color; width 5 should keep all 5 visible chars.
  assert.equal(displayWidth(clipToWidth("\x1b[32mhello\x1b[0m", 5)), 5);
});

test("cell: pads or truncates to exact width", () => {
  assert.equal(cell("hi", 5), "hi   ");
  assert.equal(cell("hello", 5), "hello");
  assert.equal(cell("hello world", 5), "hell…");
});

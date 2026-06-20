import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFirstFullLine } from "./firstline.js";

function withTmpFile(contents: string, fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-firstline-"));
  const path = join(dir, "rollout.jsonl");
  try {
    writeFileSync(path, contents);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("returns the whole first line even when it far exceeds 4KB", () => {
  // The bug this guards: a 4KB-capped reader truncates current Codex's
  // session_meta line (base_instructions inlined ~13KB+) and loses payload.cwd.
  const huge = "z".repeat(50 * 1024);
  const line1 = JSON.stringify({ type: "session_meta", payload: { cwd: "/repo", blob: huge } });
  withTmpFile(`${line1}\n{"type":"event"}\n`, (path) => {
    const got = readFirstFullLine(path);
    assert.equal(got, line1);
    const cwd = (JSON.parse(got) as { payload: { cwd: string } }).payload.cwd;
    assert.equal(cwd, "/repo");
  });
});

test("a no-newline file returns its entire content", () => {
  withTmpFile(`{"a":1}`, (path) => assert.equal(readFirstFullLine(path), `{"a":1}`));
});

test("respects the cap (does not read unboundedly)", () => {
  const noNewline = "y".repeat(10 * 1024);
  withTmpFile(noNewline, (path) => {
    const got = readFirstFullLine(path, 4096);
    assert.ok(got.length <= 4096 + 64 * 1024, "bounded by cap + one chunk");
    assert.ok(got.length >= 4096);
  });
});

test("a missing file returns empty string (never throws)", () => {
  assert.equal(readFirstFullLine("/no/such/path/rollout.jsonl"), "");
});

test("a multi-byte char straddling the 64KB read boundary decodes intact", () => {
  // Pad so a 3-byte char lands across the 65536-byte chunk boundary, then a
  // newline. The byte-scan for 0x0A must not corrupt the UTF-8 on concat.
  const pad = "a".repeat(64 * 1024 - 1); // boundary falls mid-"€" (E2 82 AC)
  const line = `${pad}€xyz`;
  withTmpFile(`${line}\nnext\n`, (path) => {
    assert.equal(readFirstFullLine(path), line);
  });
});

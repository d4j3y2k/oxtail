import { strict as assert } from "node:assert";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  attachmentsDir,
  formatAttachmentNote,
  gcAttachments,
  stageAttachment,
} from "./attachments.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-att-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

test("stageAttachment: copies a regular file into a staged 0600 path under attachmentsDir", () => {
  withHome((home) => {
    const src = join(home, "hello.txt");
    writeFileSync(src, "hello attach");
    const r = stageAttachment(src);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.attachment.stagedPath.startsWith(attachmentsDir()));
    assert.equal(readFileSync(r.attachment.stagedPath, "utf8"), "hello attach");
    assert.equal(r.attachment.name, "hello.txt");
    assert.equal(r.attachment.bytes, "hello attach".length);
    assert.match(r.attachment.sha256, /^[0-9a-f]{64}$/);
    // staged file is a real regular file (not a symlink), perms 0600
    const st = lstatSync(r.attachment.stagedPath);
    assert.ok(st.isFile());
    assert.equal(st.mode & 0o777, 0o600);
  });
});

test("stageAttachment: dereferences a symlink into a fresh regular staged file", () => {
  withHome((home) => {
    const target = join(home, "target.bin");
    writeFileSync(target, "secret-ish bytes");
    const link = join(home, "link.bin");
    symlinkSync(target, link);
    const r = stageAttachment(link);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(readFileSync(r.attachment.stagedPath, "utf8"), "secret-ish bytes");
    assert.ok(lstatSync(r.attachment.stagedPath).isFile(), "staged copy is regular, not a symlink");
  });
});

test("stageAttachment: rejects a directory / device / missing", () => {
  withHome((home) => {
    const dir = join(home, "adir");
    mkdirSync(dir);
    const rDir = stageAttachment(dir);
    assert.equal(rDir.ok, false);
    if (!rDir.ok) assert.match(rDir.reason, /not a regular file/);
    const rDev = stageAttachment("/dev/null");
    assert.equal(rDev.ok, false); // not a regular file
    const rMissing = stageAttachment(join(home, "nope.txt"));
    assert.equal(rMissing.ok, false);
    if (!rMissing.ok) assert.match(rMissing.reason, /not found/);
  });
});

test("stageAttachment: rejects oversize", () => {
  withHome((home) => {
    const src = join(home, "big.bin");
    writeFileSync(src, "0123456789"); // 10 bytes
    const r = stageAttachment(src, Date.now(), 5); // cap 5
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /too large/);
  });
});

test("stageAttachment: sanitizes an unsafe filename", () => {
  withHome((home) => {
    const src = join(home, "we ird;name$.txt");
    writeFileSync(src, "x");
    const r = stageAttachment(src);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.attachment.name, /^[A-Za-z0-9._-]+$/);
    assert.ok(!r.attachment.stagedPath.includes(" "));
  });
});

test("stageAttachment: strips surrounding quotes (drag paste)", () => {
  withHome((home) => {
    const src = join(home, "q.txt");
    writeFileSync(src, "q");
    const r = stageAttachment(`"${src}"`);
    assert.equal(r.ok, true);
  });
});

test("gcAttachments: removes only old staged files", () => {
  withHome(() => {
    const now = 1_000_000_000_000;
    const oldFile = stageAttachment(writeTmp("old"), now);
    const newFile = stageAttachment(writeTmp("new"), now);
    assert.ok(oldFile.ok && newFile.ok);
    if (!oldFile.ok || !newFile.ok) return;
    // age the old one well past the TTL
    const past = (now - 30 * 24 * 3_600_000) / 1000;
    utimesSync(oldFile.attachment.stagedPath, past, past);
    const removed = gcAttachments(now);
    assert.ok(removed >= 1);
    assert.throws(() => readFileSync(oldFile.attachment.stagedPath), "old file gone");
    assert.equal(readFileSync(newFile.attachment.stagedPath, "utf8"), "new"); // recent kept
  });
});

function writeTmp(content: string): string {
  const p = join(process.env.HOME!, `f-${content}-${content.length}.txt`);
  writeFileSync(p, content);
  return p;
}

test("formatAttachmentNote: lists staged paths, empty when none", () => {
  assert.equal(formatAttachmentNote([]), "");
  const note = formatAttachmentNote([
    { stagedPath: "/x/ab-img.png", name: "img.png", bytes: 12, sha256: "a".repeat(64) },
  ]);
  assert.match(note, /operator attached 1 file/);
  assert.match(note, /\/x\/ab-img\.png/);
});

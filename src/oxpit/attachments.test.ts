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
  safeDisplay,
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

test("stageAttachment: resolves a backslash-escaped drag path (macOS Terminal/iTerm)", () => {
  withHome((home) => {
    const src = join(home, "Screenshot 2026 at 10.55 PM.png"); // real spaces in the name
    writeFileSync(src, "img-bytes");
    // A terminal drag escapes the spaces with backslashes; realpath on the literal
    // escaped form fails, so staging must retry unescaped.
    const escaped = src.replace(/ /g, "\\ ");
    assert.notEqual(escaped, src);
    const r = stageAttachment(escaped);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(readFileSync(r.attachment.stagedPath, "utf8"), "img-bytes");
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

test("stageAttachment: staged filename embeds the FULL sha256 (no prefix aliasing)", () => {
  withHome((home) => {
    const src = join(home, "doc.txt");
    writeFileSync(src, "some content");
    const r = stageAttachment(src);
    assert.ok(r.ok);
    if (!r.ok) return;
    // The whole 64-hex digest is in the path — distinct content can never collide
    // on the same staged name (codex review #4).
    assert.ok(r.attachment.stagedPath.includes(r.attachment.sha256));
    assert.equal(r.attachment.sha256.length, 64);
  });
});

test("stageAttachment: same basename, different content ⇒ distinct staged paths", () => {
  withHome((home) => {
    const a = join(home, "a", "report.txt");
    const b = join(home, "b", "report.txt");
    mkdirSync(join(home, "a"));
    mkdirSync(join(home, "b"));
    writeFileSync(a, "alpha");
    writeFileSync(b, "bravo");
    const ra = stageAttachment(a);
    const rb = stageAttachment(b);
    assert.ok(ra.ok && rb.ok);
    if (!ra.ok || !rb.ok) return;
    assert.notEqual(ra.attachment.stagedPath, rb.attachment.stagedPath, "no aliasing");
    assert.equal(readFileSync(ra.attachment.stagedPath, "utf8"), "alpha");
    assert.equal(readFileSync(rb.attachment.stagedPath, "utf8"), "bravo");
  });
});

test("stageAttachment: bytes reflects the COPIED buffer length", () => {
  withHome((home) => {
    const src = join(home, "sz.bin");
    writeFileSync(src, "1234567");
    const r = stageAttachment(src);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.attachment.bytes, 7);
  });
});

test("safeDisplay: scrubs control chars and bounds length", () => {
  assert.equal(safeDisplay("ok-path.txt"), "ok-path.txt");
  assert.equal(safeDisplay("ev\x1b[2Jil\nname"), "ev?[2Jil?name"); // ESC + newline neutralized
  assert.ok(!safeDisplay("\x07\x00\x7f").includes("\x00"));
  const long = "x".repeat(500);
  assert.ok(safeDisplay(long).length <= 120);
});

test("safeDisplay: scrubs C1, bidi overrides, and zero-width spoofers (compile-sim F3)", () => {
  // RLO (U+202E) reverses display ("gpj.elif" → "file.jpg"); zero-width + BOM hide.
  assert.equal(safeDisplay("a\u202eb"), "a?b");
  assert.ok(!/[\u0080-\u009f\u200b-\u200f\u2066-\u2069\u202a-\u202e\ufeff]/.test(safeDisplay("x\u202ey\u200bz\ufeff\u009bq")));
});

test("formatAttachmentNote: lists staged paths, empty when none", () => {
  assert.equal(formatAttachmentNote([]), "");
  const note = formatAttachmentNote([
    { stagedPath: "/x/ab-img.png", name: "img.png", bytes: 12, sha256: "a".repeat(64) },
  ]);
  assert.match(note, /operator attached 1 file/);
  assert.match(note, /\/x\/ab-img\.png/);
});

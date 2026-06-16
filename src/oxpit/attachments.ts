// oxpit attachments — stage a file BY REFERENCE for an operator message.
//
// SECURITY (codex review): never hand a peer a raw user path. A raw path is mutable,
// can move, can be a symlink to an arbitrary file, and its name can carry control
// chars / prompt-injection text. So we:
//   - realpath the input (dereferences symlinks),
//   - reject anything that isn't a regular file (dir / device / FIFO / socket),
//   - reject oversize files,
//   - COPY the bytes into ~/.oxtail/attachments/<sha256>-<safe-name> (mode 0600) — a
//     fresh regular file with a sanitized, terminal-safe name,
//   - send only that canonical staged path.
// The recipient agent reads the staged copy with its own tools (Claude reads images
// natively; Codex reads files). Old staged files are mtime-GC'd.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const ATTACH_MAX_BYTES = (() => {
  const v = Number(process.env.OXTAIL_ATTACH_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 25 * 1024 * 1024; // 25 MB
})();

const GC_TTL_MS = 7 * 24 * 3_600_000;

export function attachmentsDir(): string {
  return join(homedir(), ".oxtail", "attachments");
}

export type StagedAttachment = {
  stagedPath: string;
  name: string;
  bytes: number;
  sha256: string;
};

export type StageResult =
  | { ok: true; attachment: StagedAttachment }
  | { ok: false; reason: string };

// Sanitize a filename to a terminal/path-safe token: keep [A-Za-z0-9._-], collapse
// the rest to "_", no leading dots, bounded length. (Never trust the source name.)
function safeName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 60);
  return cleaned || "file";
}

// Strip one layer of surrounding quotes (terminals/drag often quote a path).
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

// A user path can carry terminal control bytes (ESC, CR, etc.). The path itself is
// only ever used for file IO, never sent to a peer — but a REJECTED path is echoed
// in a local error reason that lands on the CLI stdout / TUI status line, where raw
// controls could corrupt the display or inject ANSI (codex review #5). So scrub
// controls for display only, and bound the length. (Accepted paths never reach a
// peer raw: they're staged under a sanitized, content-addressed name.)
export function safeDisplay(s: string, max = 120): string {
  // C0 + DEL + C1 (0x80-0x9f, incl. 8-bit CSI/OSC) → "?"; plus bidi overrides /
  // isolates, zero-width, and line/para separators, which don't print but can SPOOF
  // a path's apparent name (e.g. "gpj.elif" shown as "file.jpg") in any terminal.
  const scrubbed = s.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g,
    "?",
  );
  return scrubbed.length > max ? scrubbed.slice(0, max - 1) + "…" : scrubbed;
}

export function stageAttachment(
  inputPath: string,
  now: number = Date.now(),
  maxBytes: number = ATTACH_MAX_BYTES,
): StageResult {
  const raw = unquote(inputPath);
  if (!raw) return { ok: false, reason: "empty path" };
  const disp = safeDisplay(raw); // control-scrubbed; the rejected path lands on a UI
  let real: string;
  try {
    real = realpathSync(raw); // dereferences symlinks to a concrete target
  } catch {
    return { ok: false, reason: `not found: ${disp}` };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, reason: `unreadable: ${disp}` };
  }
  if (!st.isFile()) return { ok: false, reason: `not a regular file: ${disp}` };
  if (st.size > maxBytes) {
    return { ok: false, reason: `too large (${st.size}B > ${maxBytes}B cap)` };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(real);
  } catch (e) {
    // The fs error embeds the raw realpath verbatim (control bytes intact) — scrub it
    // too, or the safeDisplay defense is bypassed on the read-failure branch (the
    // realpath is attacker-influenceable: passes realpath+stat+size, fails the read
    // via a perms/EIO/TOCTOU race). compile-sim F1.
    return { ok: false, reason: `read failed: ${safeDisplay(e instanceof Error ? e.message : String(e))}` };
  }
  // The stat size is advisory: a file can grow/replace between statSync and read
  // (TOCTOU). The frozen copy is the bytes we actually read, so re-check THOSE and
  // report the true count, never the stale stat (codex review #1).
  if (buf.length > maxBytes) {
    return { ok: false, reason: `too large (${buf.length}B > ${maxBytes}B cap)` };
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const name = safeName(basename(real));
  // Full sha256 (not a 16-hex prefix) in the staged name: distinct content can never
  // alias the same staged path, so a previously-sent path can never come to point at
  // different bytes (codex review #4). Same content → same name → idempotent.
  const stagedPath = join(attachmentsDir(), `${sha256}-${name}`);
  try {
    mkdirSync(attachmentsDir(), { recursive: true, mode: 0o700 });
    // GC BEFORE the write (codex review #2): an opportunistic GC must never be able
    // to unlink the very file this call just staged. The post-write file has a fresh
    // mtime anyway, but ordering the sweep first removes the same-process window
    // entirely; gcAttachments itself re-checks age right before unlink to shrink the
    // cross-process window too.
    gcAttachments(now);
  } catch {
    // best effort — GC must never block a stage
  }
  try {
    // Copy bytes into a FRESH regular file (independent of the source; no symlink).
    // Idempotent: same content → same name → overwrite-identical.
    writeFileSync(stagedPath, buf, { mode: 0o600 });
  } catch (e) {
    return { ok: false, reason: `stage failed: ${safeDisplay(e instanceof Error ? e.message : String(e))}` };
  }
  return { ok: true, attachment: { stagedPath, name, bytes: buf.length, sha256 } };
}

// Remove staged files older than the TTL (mtime). Best-effort.
export function gcAttachments(now: number = Date.now()): number {
  let files: string[];
  try {
    files = readdirSync(attachmentsDir());
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    const p = join(attachmentsDir(), f);
    try {
      if (now - statSync(p).mtimeMs > GC_TTL_MS) {
        // Re-stat immediately before unlink (codex review #2): a concurrent stage in
        // another process may have just refreshed this exact path (same content
        // re-staged after the TTL). Only unlink if it is STILL old — shrinks the
        // TOCTOU window from the whole sweep to two adjacent syscalls.
        if (now - statSync(p).mtimeMs > GC_TTL_MS) {
          unlinkSync(p);
          removed++;
        }
      }
    } catch {
      // vanished / unreadable — skip
    }
  }
  return removed;
}

// The note appended to an operator message body so the recipient knows to read the
// staged files. Paths are already terminal-safe (sanitized names under our dir).
export function formatAttachmentNote(atts: ReadonlyArray<StagedAttachment>): string {
  if (atts.length === 0) return "";
  const list = atts.map((a) => `${a.stagedPath} (${a.name}, ${a.bytes}B)`).join("\n  ");
  return `\n\n[operator attached ${atts.length} file(s) — read them with your file tools:\n  ${list}\n]`;
}

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

export function stageAttachment(
  inputPath: string,
  now: number = Date.now(),
  maxBytes: number = ATTACH_MAX_BYTES,
): StageResult {
  const raw = unquote(inputPath);
  if (!raw) return { ok: false, reason: "empty path" };
  let real: string;
  try {
    real = realpathSync(raw); // dereferences symlinks to a concrete target
  } catch {
    return { ok: false, reason: `not found: ${raw}` };
  }
  let st;
  try {
    st = statSync(real);
  } catch {
    return { ok: false, reason: `unreadable: ${raw}` };
  }
  if (!st.isFile()) return { ok: false, reason: `not a regular file: ${raw}` };
  if (st.size > maxBytes) {
    return { ok: false, reason: `too large (${st.size}B > ${maxBytes}B cap)` };
  }
  let buf: Buffer;
  try {
    buf = readFileSync(real);
  } catch (e) {
    return { ok: false, reason: `read failed: ${e instanceof Error ? e.message : e}` };
  }
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const name = safeName(basename(real));
  const stagedPath = join(attachmentsDir(), `${sha256.slice(0, 16)}-${name}`);
  try {
    mkdirSync(attachmentsDir(), { recursive: true, mode: 0o700 });
    // Copy bytes into a FRESH regular file (independent of the source; no symlink).
    // Idempotent: same content → same name → overwrite-identical.
    writeFileSync(stagedPath, buf, { mode: 0o600 });
  } catch (e) {
    return { ok: false, reason: `stage failed: ${e instanceof Error ? e.message : e}` };
  }
  try {
    gcAttachments(now); // opportunistic; never blocks the stage
  } catch {
    // best effort
  }
  return { ok: true, attachment: { stagedPath, name, bytes: st.size, sha256 } };
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
        unlinkSync(p);
        removed++;
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

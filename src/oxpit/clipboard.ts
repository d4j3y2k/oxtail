// oxpit clipboard-image capture (macOS).
//
// WHY this exists: a terminal is a TEXT stream. An image copied to the clipboard
// (e.g. Cmd-C in Messages/Preview) is raw bytes with no file path, so it can NEVER
// arrive over stdin — Cmd-V / Ctrl-V paste in a terminal can only deliver text.
// Drag-and-drop works only because the OS converts the dragged FILE into a path it
// types for us. So to "paste an image" we read the clipboard OUT-OF-BAND via
// osascript and write it to a temp file; the caller then stages that file by
// reference exactly like a drag (copy → ~/.oxtail/attachments → send the path).

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACH_MAX_BYTES } from "./attachments.js";

export type ClipResult = { ok: true; path: string } | { ok: false; reason: string };

// Result of the OS grab: which image flavor was written, or "noimage".
export type GrabResult = "png" | "tiff" | "noimage";

// Pull a clipboard image to `outPath` as PNG. Tries PNG first; falls back to TIFF
// (what Messages/Finder often provide) and converts it with `sips`. Returns the
// flavor written, or "noimage" when the clipboard holds no image. macOS only.
function osascriptGrab(outPath: string): GrabResult {
  // outPath is OUR path (tmpdir + a random mkdtemp suffix + a fixed name), but we pass
  // it as a `run` handler ARGUMENT rather than interpolating it into the script
  // source — so even a hostile TMPDIR carrying a quote/backslash can't break out of
  // the AppleScript literal (defense-in-depth; the sips fallback already shells out
  // via `quoted form of`).
  const script = `on run argv
set outPath to item 1 of argv
try
  set d to (the clipboard as «class PNGf»)
  set f to open for access (POSIX file outPath) with write permission
  set eof f to 0
  write d to f
  close access f
  return "png"
on error
  try
    set tiffPath to outPath & ".tiff"
    set d to (the clipboard as «class TIFF»)
    set f to open for access (POSIX file tiffPath) with write permission
    set eof f to 0
    write d to f
    close access f
    do shell script "sips -s format png " & quoted form of tiffPath & " --out " & quoted form of outPath
    return "tiff"
  on error
    return "noimage"
  end try
end try
end run`;
  const out = execFileSync("osascript", ["-e", script, outPath], {
    timeout: 8000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return out === "png" || out === "tiff" ? out : "noimage";
}

// Capture the current clipboard image to a fresh temp PNG and return its path. On the
// ok path the CALLER stages it (copy-by-reference) and removes the temp dir; on EVERY
// failure path we remove the temp dir ourselves so a noimage / throw / oversize grab
// can't litter /tmp with the dir (and any partial PNG/TIFF the OS already wrote). The
// result is also bounded by `maxBytes` (the same cap stageAttachment enforces) BEFORE
// the path is handed on, so a multi-hundred-MB clipboard image is reaped here instead
// of after a needless copy. `grab`/`platform`/`maxBytes` are injectable for tests.
// Never throws.
export function captureClipboardImage(
  grab: (outPath: string) => GrabResult = osascriptGrab,
  platform: string = process.platform,
  maxBytes: number = ATTACH_MAX_BYTES,
): ClipResult {
  if (platform !== "darwin") {
    return { ok: false, reason: "clipboard-image paste is macOS-only — drag a file instead" };
  }
  let dir: string;
  try {
    dir = mkdtempSync(join(tmpdir(), "oxpit-clip-"));
  } catch (e) {
    return { ok: false, reason: `temp dir failed: ${e instanceof Error ? e.message : e}` };
  }
  // We OWN this temp dir until we hand a valid path back; reap it on any failure.
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  };
  const png = join(dir, "clipboard.png");
  let res: GrabResult;
  try {
    res = grab(png);
  } catch (e) {
    cleanup();
    return { ok: false, reason: `clipboard read failed: ${e instanceof Error ? e.message : e}` };
  }
  if (res === "noimage") {
    cleanup();
    return { ok: false, reason: "no image on the clipboard (copy an image first, or drag a file)" };
  }
  // Stat the produced file: reject oversize (and a vanished/lying grab) here rather
  // than leaking the temp file or surfacing a confusing stage error downstream.
  let size: number;
  try {
    size = statSync(png).size;
  } catch {
    cleanup();
    return { ok: false, reason: "clipboard image disappeared right after capture" };
  }
  if (size > maxBytes) {
    cleanup();
    return { ok: false, reason: `clipboard image too large (${size}B > ${maxBytes}B cap)` };
  }
  return { ok: true, path: png };
}

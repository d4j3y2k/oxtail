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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ClipResult = { ok: true; path: string } | { ok: false; reason: string };

// Result of the OS grab: which image flavor was written, or "noimage".
export type GrabResult = "png" | "tiff" | "noimage";

// Pull a clipboard image to `outPath` as PNG. Tries PNG first; falls back to TIFF
// (what Messages/Finder often provide) and converts it with `sips`. Returns the
// flavor written, or "noimage" when the clipboard holds no image. macOS only.
function osascriptGrab(outPath: string): GrabResult {
  // outPath is OUR path (tmpdir + a random mkdtemp suffix + a fixed name) — no user
  // input, no quotes/backslashes — so interpolating it into the script is safe.
  const script = `
set outPath to "${outPath}"
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
end try`;
  const out = execFileSync("osascript", ["-e", script], {
    timeout: 8000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return out === "png" || out === "tiff" ? out : "noimage";
}

// Capture the current clipboard image to a fresh temp PNG and return its path. The
// CALLER stages it (copy-by-reference) and is responsible for removing the temp dir
// afterward. `grab`/`platform` are injectable for tests. Never throws.
export function captureClipboardImage(
  grab: (outPath: string) => GrabResult = osascriptGrab,
  platform: string = process.platform,
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
  const png = join(dir, "clipboard.png");
  let res: GrabResult;
  try {
    res = grab(png);
  } catch (e) {
    return { ok: false, reason: `clipboard read failed: ${e instanceof Error ? e.message : e}` };
  }
  if (res === "noimage") {
    return { ok: false, reason: "no image on the clipboard (copy an image first, or drag a file)" };
  }
  return { ok: true, path: png };
}

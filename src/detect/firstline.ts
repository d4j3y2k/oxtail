// Read the WHOLE first line of a file (up to the first \n), capped for safety.
//
// Shared by the Codex readiness watch (oxpit/fleet/readiness.ts) and the
// birth-time detection strategy (birthTimeMatchStrategy.ts). Current Codex
// rollouts write a `session_meta` first line that inlines the full
// base_instructions text (~13KB), which blows past a small fixed cap — a
// 4KB-capped reader returns a truncated, unparseable line, so `payload.cwd` is
// unreachable and Codex birth-time matching silently sees ZERO candidates.
// Reading the full first line fixes that.
//
// Scans for the 0x0A byte directly (unambiguous in UTF-8 — never a continuation
// byte), copying each chunk slice before the buffer is reused, so a multi-byte
// character straddling a 64KB read boundary cannot corrupt the decoded line.

import { closeSync, openSync, readSync } from "node:fs";

export function readFirstFullLine(path: string, capBytes = 256 * 1024): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    let pos = 0;
    while (total < capBytes) {
      const n = readSync(fd, chunk, 0, chunk.length, pos);
      if (n <= 0) break;
      pos += n;
      const nl = chunk.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) {
        parts.push(Buffer.from(chunk.subarray(0, nl)));
        break;
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(parts).toString("utf8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

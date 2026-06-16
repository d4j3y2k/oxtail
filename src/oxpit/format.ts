// Small presentation helpers shared by the oxpit renderers (one-shot table +
// interactive TUI). Kept dependency-free and pure so both call sites — and their
// tests — format identically.

// Compact human age: seconds → "12s" / "3m" / "2h" / "5d". null → em dash.
export function fmtAge(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// Truncate a string to `width` columns, appending "…" when clipped. Used so a
// long purpose line can't blow out the table layout. Width <= 0 → "".
export function clip(s: string, width: number): string {
  if (width <= 0) return "";
  // Collapse newlines/tabs to spaces first: a purpose card or message body can
  // contain them and they'd corrupt the single-line table layout.
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  if (width === 1) return "…";
  return flat.slice(0, width - 1) + "…";
}

// Pad/truncate to exactly `width` visible columns (left-justified).
export function cell(s: string, width: number): string {
  const c = clip(s, width);
  return c.length >= width ? c : c + " ".repeat(width - c.length);
}

// The 2-column glyphs oxpit emits. We bias toward counting a glyph as wide: a
// wide-count over-estimate truncates a hair early (harmless), whereas an under-
// estimate lets a line exceed the terminal and WRAP — which desyncs the TUI's
// cursor-home repaint and corrupts the screen (max M3). This is not a full wcwidth;
// it just has to cover the glyphs we render.
const WIDE_GLYPHS = new Set(["🟢", "🟡", "⚫", "⏳", "⛔", "⚠", "✉", "⚑"]);

// Matches a CSI escape sequence (e.g. the SGR color codes "\x1b[..m"). Such
// sequences occupy ZERO display columns.
const CSI_RE = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

// Visible column width of a string, ignoring ANSI escapes and counting known wide
// glyphs as 2. Used to budget the trailing purpose column and to clip lines.
export function displayWidth(s: string): number {
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = CSI_RE.exec(s.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    i += ch.length;
    w += WIDE_GLYPHS.has(ch) ? 2 : 1;
  }
  return w;
}

// Strip terminal-dangerous characters from text that will be rendered RAW and/or
// sent VERBATIM to a peer (the TUI compose buffer, an ⌃X-restored attachment path,
// captured pane text). The one shared sanitizer — every untrusted-text path funnels
// through here so a hostile filename / pane line (ANSI/C0/C1/bidi/zero-width) can't
// corrupt the operator's terminal or reach a peer's context. Newlines survive only
// when keepNewline (a multi-line paste or an explicit newline key).
export function scrubBufferText(s: string, keepNewline: boolean): string {
  let out = "";
  for (const ch of s) {
    if (keepNewline && ch === "\n") {
      out += ch;
      continue;
    }
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) continue; // C0 / DEL / C1
    if (c >= 0x200b && c <= 0x200f) continue; // zero-width + bidi marks
    if (c === 0x2028 || c === 0x2029) continue; // line / paragraph separators
    if (c >= 0x202a && c <= 0x202e) continue; // bidi embeddings / overrides
    if (c >= 0x2066 && c <= 0x2069) continue; // bidi isolates
    if (c === 0xfeff) continue; // BOM / zero-width no-break space
    out += ch;
  }
  return out;
}

// Symbols allowed THROUGH sanitizeCaptured beyond printable ASCII — a curated set
// of glyphs that appear in agent pane chrome AND render in exactly 1 column in
// standard monospace terminals (spinner stars, bullets, arrows, dashes, prompt
// marks). Anything else in captured terminal output (CJK/fullwidth/emoji/combining
// — widths displayWidth can't know) is DROPPED, so the result is provably 1-column.
const CAPTURE_ALLOW = new Set([
  "·", "•", "…", "—", "–", "↑", "↓", "←", "→", "↔", "─", "│", "❯", "›", "‹", "✓", "✗",
  "✶", "✷", "✸", "✹", "✺", "✻", "✼", "✽", "✾", "✿", "❀", "✱", "✲", "✳", "✴", "✦", "✧",
  "∗", "★", "☆", "◐", "◓", "◑", "◒",
]);

// Sanitize UNTRUSTED captured terminal text (a tmux capture-pane line) for display.
// First the shared scrubber removes C0/C1/bidi/zero-width, then allowlist-drop to a
// provably 1-column character set so width accounting can never undercount and wrap
// the TUI (codex review #2 — clipToWidth alone is unsafe for arbitrary capture). The
// caller still clipToWidths the result; this just guarantees the width math is exact.
export function sanitizeCaptured(s: string): string {
  let out = "";
  for (const ch of scrubBufferText(s, false)) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x20 && c <= 0x7e) {
      out += ch; // printable ASCII
      continue;
    }
    if (CAPTURE_ALLOW.has(ch)) out += ch;
    // else: drop exotic/wide/combining — lose the glyph, never the layout
  }
  return out;
}

// Truncate a (possibly ANSI-colored) string to at most `width` display columns,
// preserving escape sequences and closing any open SGR with a reset. The TUI's
// safety net against wrap: every physical line is passed through this before the
// cursor-home repaint, so no line can ever exceed the terminal width.
export function clipToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  let w = 0;
  let i = 0;
  let out = "";
  let sawSgr = false;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = CSI_RE.exec(s.slice(i));
      if (m) {
        out += m[0];
        sawSgr = true;
        i += m[0].length;
        continue;
      }
      i += 1;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    const cw = WIDE_GLYPHS.has(ch) ? 2 : 1;
    if (w + cw > width) return sawSgr ? out + "\x1b[0m" : out;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return s; // fits as-is (keeps any trailing reset intact)
}

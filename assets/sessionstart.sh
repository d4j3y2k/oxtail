#!/usr/bin/env bash
# oxtail SessionStart hook — auto-join drop file.
#
# Claude Code strips CLAUDE_CODE_SESSION_ID from MCP children, so the oxtail
# server can't read its own session id; until v9 every session had to run the
# manual /oxtail-join ceremony. SessionStart hooks DO receive the session_id
# (plus cwd and transcript_path) on stdin, so this hook drops that payload into
# ~/.oxtail/session-starts/<safe_sid> where the server's hook-drop detection
# strategy (src/detect/hookDropStrategy.ts) picks it up — making join automatic
# for hooked Claude Code sessions.
#
# Disambiguation when several sessions share a project: we record OUR parent
# pid ($PPID — the Claude Code process) plus its start-time signature; the
# server matches that against its own process ancestry, so each MCP child
# adopts exactly the drop written by the Claude process above it.
#
# Fires on startup/resume/clear/compact (all sources — each refreshes the
# drop's mtime/ancestry; the session_id is stable across resume/clear/compact).
# CRITICAL: SessionStart stdout is injected into the model's context, so this
# script must NEVER print. Exits 0 on every path.

set -u

[ -t 0 ] && exit 0
payload=$(cat 2>/dev/null || true)
[ -z "$payload" ] && exit 0

# Whitespace-tolerant scanner (per Codex review): the live payload is minified
# today, but `"session_id" : "x"` is equally valid JSON and must not silently
# disable auto-join if upstream ever pretty-prints.
sid=$(printf '%s' "$payload" | awk '
  {
    p = index($0, "\"session_id\"")
    if (p == 0) next
    rest = substr($0, p + 12)
    i = 1; n = length(rest)
    while (i <= n && (substr(rest, i, 1) == " " || substr(rest, i, 1) == "\t")) i++
    if (i > n || substr(rest, i, 1) != ":") next
    i++
    while (i <= n && (substr(rest, i, 1) == " " || substr(rest, i, 1) == "\t")) i++
    if (i > n || substr(rest, i, 1) != "\"") next
    i++
    out = ""
    while (i <= n) {
      c = substr(rest, i, 1)
      if (c == "\\") {
        if (i+1 <= n) { out = out substr(rest, i, 2); i += 2 } else { i += 1 }
      } else if (c == "\"") {
        break
      } else {
        out = out c; i += 1
      }
    }
    print out; exit
  }
' 2>/dev/null)
[ -z "$sid" ] && exit 0

# Same sanitization as the server's activitySessionKey() / the other hooks.
safe_sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')
[ -n "$safe_sid" ] || exit 0

dir="$HOME/.oxtail/session-starts"
mkdir -p "$dir" 2>/dev/null || exit 0
chmod 700 "$dir" 2>/dev/null || true

# The Claude Code process hosting this session. lstart (start time) makes the
# pid meaningful across OS pid reuse; it contains only [A-Za-z0-9 :] so it is
# safe to embed in a JSON string without escaping. Internal space runs MUST be
# collapsed, not just trimmed: lstart pads single-digit days with a second
# space ("Tue Jun  9 ..."), while the reader (claims.ts snapshotProcs) rebuilds
# its sig from a whitespace split — i.e. single-spaced. Without the collapse,
# ancestorConfirmed's exact match fails on days 1-9 of every month.
ppid_sig=$(ps -o lstart= -p $PPID 2>/dev/null | sed 's/  */ /g;s/^ *//;s/ *$//' || true)
now=$(date +%s 2>/dev/null || echo 0)

# Wrapper JSON: our provenance fields + the RAW stdin payload embedded verbatim
# (it is already a JSON object, so no re-escaping is needed or attempted —
# the server parses real JSON instead of bash ever re-deriving fields).
tmp="$dir/.$safe_sid.tmp.$$"
{
  printf '{"schema_version":1,"ppid":%s,"ppid_sig":"%s","written_at":%s,"payload":' "$PPID" "$ppid_sig" "$now"
  printf '%s' "$payload"
  printf '}'
} > "$tmp" 2>/dev/null || { rm -f "$tmp" 2>/dev/null; exit 0; }
chmod 600 "$tmp" 2>/dev/null || true
mv -f "$tmp" "$dir/$safe_sid" 2>/dev/null || rm -f "$tmp" 2>/dev/null
exit 0

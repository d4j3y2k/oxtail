#!/usr/bin/env bash
# oxtail PreToolUse hook — delivers peer messages mid-turn to Claude Code.
#
# Reads ~/.oxtail/mailboxes/<my-server-pid>.jsonl, emits a hookSpecificOutput
# envelope, and truncates the mailbox under lock. Pure bash + awk; no jq,
# python, or node. Exits 0 on every error path so it never blocks a tool call.
#
# Step 0a verified that Claude Code strips CLAUDE_CODE_SESSION_ID from hook
# subprocesses but delivers it via stdin JSON. Stdin is the only path; env
# is dead code and not consulted here.

set -u

# 1. Read session_id from stdin JSON. Claude Code's PreToolUse contract
#    delivers a single JSON line on stdin: {"session_id":"...", ...}. If
#    stdin is a tty (interactive run), exit silently.
sid=""
if [ ! -t 0 ]; then
  payload=$(cat 2>/dev/null || true)
  sid=$(printf '%s' "$payload" | awk '
    {
      p = index($0, "\"session_id\":\"")
      if (p == 0) next
      rest = substr($0, p + 14)
      out = ""
      i = 1; n = length(rest)
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
  ')
fi
[ -z "$sid" ] && exit 0

sessions_dir="$HOME/.oxtail/sessions"
mailboxes_dir="$HOME/.oxtail/mailboxes"
[ -d "$sessions_dir" ] || exit 0
[ -d "$mailboxes_dir" ] || exit 0

# 2. Find this session's MCP-server pid. Registry files are pretty-printed
#    JSON (key/value separated by ": " with a space), so use grep -E with
#    [[:space:]]* to tolerate either form. -F (fixed-string) is unsafe.
entry_file=$(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null | head -n 1) || true
[ -z "$entry_file" ] && exit 0

pid=$(basename "$entry_file" .json)
case "$pid" in *[!0-9]*) exit 0 ;; esac

mbox="$mailboxes_dir/$pid.jsonl"
[ -f "$mbox" ] || exit 0
[ -s "$mbox" ] || exit 0

# 3. Acquire mkdir-based lock. Staleness window is 30s; matches
#    src/mailbox.ts:LOCK_STALE_MS. We can't use `find -mmin +0.5` portably —
#    BSD find and `bfs` reject fractional -mmin — so we read mtime via stat.
#    GNU and BSD stat formats differ, so try both.
LOCK_STALE_SECS=30
acquired=0
for i in $(seq 1 50); do
  if mkdir "$mbox.lock" 2>/dev/null; then acquired=1; break; fi
  now=$(date +%s 2>/dev/null || echo 0)
  mtime=$(stat -c %Y "$mbox.lock" 2>/dev/null || stat -f %m "$mbox.lock" 2>/dev/null || echo 0)
  if [ "$mtime" -gt 0 ] && [ $((now - mtime)) -gt "$LOCK_STALE_SECS" ]; then
    rmdir "$mbox.lock" 2>/dev/null
  fi
  sleep 0.01
done
[ "$acquired" -eq 1 ] || exit 0

# 4. Extract every line's body field (still JSON-encoded), join with literal
#    \n\n separators, emit hookSpecificOutput envelope. Truncating happens
#    after the awk completes; if awk's output never reaches Claude Code we'd
#    rather have the messages still in the box than lost.
output=$(awk '
  function json_string_field(line, key,   needle, p, rest, out, i, n, c) {
    needle = "\"" key "\":\""
    p = index(line, needle)
    if (p == 0) return ""
    rest = substr(line, p + length(needle))
    out = ""
    i = 1; n = length(rest)
    while (i <= n) {
      c = substr(rest, i, 1)
      if (c == "\\") {
        if (i + 1 <= n) { out = out substr(rest, i, 2); i += 2 } else { i += 1 }
      } else if (c == "\"") {
        break
      } else {
        out = out c
        i += 1
      }
    }
    return out
  }
  BEGIN { count = 0 }
  {
    body = json_string_field($0, "body")
    if (body == "") next
    bodies[count] = body
    ids[count] = json_string_field($0, "id")
    froms[count] = json_string_field($0, "from_session_id")
    count++
  }
  END {
    if (count == 0) exit 0
    ctx = "<system-reminder>\\n[oxtail] You have " count " new peer message(s)."
    ctx = ctx "\\nIf a message asks for a response and from_session_id is present, reply with mcp__oxtail__send_message using that UUID as target."
    for (j = 0; j < count; j++) {
      ctx = ctx "\\n\\n--- message " (j + 1) " ---"
      if (ids[j] != "") ctx = ctx "\\nmessage_id: " ids[j]
      if (froms[j] != "") {
        ctx = ctx "\\nfrom_session_id: " froms[j]
      } else {
        ctx = ctx "\\nfrom_session_id: unknown"
      }
      ctx = ctx "\\nbody:\\n" bodies[j]
    }
    ctx = ctx "\\n</system-reminder>"
    printf("{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"additionalContext\":\"%s\"}}\n", ctx)
  }
' < "$mbox")

if [ -n "$output" ]; then
  printf '%s' "$output"
  : > "$mbox"
fi

rmdir "$mbox.lock" 2>/dev/null || true
exit 0

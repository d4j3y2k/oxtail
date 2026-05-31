#!/usr/bin/env bash
# oxtail PreToolUse hook — delivers peer messages mid-turn to Claude Code.
#
# Reads this session's mailbox(es), emits a hookSpecificOutput envelope, and
# truncates under lock. Pure bash + awk (bash 3.2-compatible — no mapfile); no
# jq, python, or node. Exits 0 on every error path so it never blocks a tool call.
#
# Identity is keyed by session_id, never server_pid (see AGENTS.md). A dual-scope
# agent runs several MCP children sharing one session_id; the session's inbox is
# the UNION of those children's mailboxes, so this drains ALL of them rather than
# guessing one (the send side enqueues to readAll()'s freshest sibling).
#
# Step 0a verified that Claude Code strips CLAUDE_CODE_SESSION_ID from hook
# subprocesses but delivers it via stdin JSON. Stdin is the only path.

set -u

# 1. Read session_id from stdin JSON. If stdin is a tty (interactive run), exit.
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

# 2. Collect every non-empty sibling mailbox for this session_id. Registry files
#    are pretty-printed JSON, so grep -E with [[:space:]]* tolerates the form.
mboxes=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  pid=$(basename "$f" .json)
  case "$pid" in *[!0-9]*) continue ;; esac
  m="$mailboxes_dir/$pid.jsonl"
  if [ -f "$m" ] && [ -s "$m" ]; then mboxes+=("$m"); fi
done < <(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null)

[ "${#mboxes[@]}" -eq 0 ] && exit 0

# 3. Acquire each mailbox's mkdir-based lock (best-effort; 30s staleness window,
#    matching src/mailbox.ts:LOCK_STALE_MS). GNU and BSD stat formats differ.
locked=()
for m in "${mboxes[@]}"; do
  for i in $(seq 1 50); do
    if mkdir "$m.lock" 2>/dev/null; then locked+=("$m"); break; fi
    now=$(date +%s 2>/dev/null || echo 0)
    mtime=$(stat -c %Y "$m.lock" 2>/dev/null || stat -f %m "$m.lock" 2>/dev/null || echo 0)
    if [ "$mtime" -gt 0 ] && [ $((now - mtime)) -gt 30 ]; then
      rmdir "$m.lock" 2>/dev/null
    fi
    sleep 0.01
  done
done
[ "${#locked[@]}" -eq 0 ] && exit 0

# 4. Extract every line's body + reply metadata across all locked mailboxes,
#    join into one system-reminder envelope. Truncation happens only after awk
#    produces a valid payload — if the output never reaches Claude Code we'd
#    rather leave the messages in the box than lose them.
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
' "${locked[@]}")

if [ -n "$output" ]; then
  printf '%s' "$output"
  for m in "${locked[@]}"; do : > "$m"; done
fi

for m in "${locked[@]}"; do rmdir "$m.lock" 2>/dev/null || true; done
exit 0

#!/usr/bin/env bash
# oxtail Stop hook — delivers peer messages that landed as Claude Code finished
# a turn, forcing it to read + respond before going idle.
#
# Reads ~/.oxtail/mailboxes/<my-server-pid>.jsonl. If non-empty, emits a
# {"decision":"block","reason":...} envelope (so Claude continues instead of
# stopping) and truncates the mailbox under lock. Pure bash + awk; no jq,
# python, or node. Exits 0 on every error path so it never wedges the agent.
#
# Mirrors assets/pretooluse.sh's mailbox-read/lock/awk logic deliberately
# (duplicated, not shared) so changes here never touch the PreToolUse hook.
#
# Differences from pretooluse.sh:
#   - honors stop_hook_active: on a re-entry (Claude already continuing because
#     a prior Stop hook blocked) we exit 0 so decision:block can never loop.
#     Claude Code also force-overrides a Stop hook after 8 consecutive blocks,
#     but draining the mailbox below means the next Stop sees an empty box and
#     stops cleanly long before that cap.
#   - emits the Stop decision envelope ({"decision":"block","reason":...})
#     rather than PreToolUse's hookSpecificOutput/additionalContext.

set -u

# 1. Read the full stdin payload once (Claude Code delivers a single JSON line:
#    {"session_id":"...","stop_hook_active":false,...}). If stdin is a tty
#    (interactive run), there's nothing to deliver — exit silently.
payload=""
if [ ! -t 0 ]; then
  payload=$(cat 2>/dev/null || true)
fi
[ -z "$payload" ] && exit 0

# 2. Loop guard: if we already blocked once this stop sequence, allow the stop.
#    Tolerate either "key":true or "key": true spacing. Pure grep -E, no jq.
if printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

# 3. Extract session_id from the payload (same scanner as pretooluse.sh).
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
[ -z "$sid" ] && exit 0

sessions_dir="$HOME/.oxtail/sessions"
mailboxes_dir="$HOME/.oxtail/mailboxes"
[ -d "$sessions_dir" ] || exit 0
[ -d "$mailboxes_dir" ] || exit 0

# 4. Find this session's MCP-server pid via its registry entry.
entry_file=$(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null | head -n 1) || true
[ -z "$entry_file" ] && exit 0

pid=$(basename "$entry_file" .json)
case "$pid" in *[!0-9]*) exit 0 ;; esac

mbox="$mailboxes_dir/$pid.jsonl"
[ -f "$mbox" ] || exit 0
[ -s "$mbox" ] || exit 0

# 5. Acquire mkdir-based lock (30s staleness window; matches mailbox.ts).
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

# 6. Build the decision:block reason from every line's body + reply metadata.
#    Truncation happens only AFTER awk produces a valid payload — if the output
#    never reaches Claude Code we'd rather leave the messages in the box than
#    drop them (same philosophy as pretooluse.sh).
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
    r = "[oxtail] " count " new peer message(s) arrived as you finished your turn. Read them and respond before stopping."
    r = r "\\nIf a message asks for a response and from_session_id is present, reply with mcp__oxtail__send_message using that UUID as target."
    for (j = 0; j < count; j++) {
      r = r "\\n\\n--- message " (j + 1) " ---"
      if (ids[j] != "") r = r "\\nmessage_id: " ids[j]
      if (froms[j] != "") {
        r = r "\\nfrom_session_id: " froms[j]
      } else {
        r = r "\\nfrom_session_id: unknown"
      }
      r = r "\\nbody:\\n" bodies[j]
    }
    printf("{\"decision\":\"block\",\"reason\":\"%s\"}\n", r)
  }
' < "$mbox")

if [ -n "$output" ]; then
  printf '%s' "$output"
  : > "$mbox"
fi

rmdir "$mbox.lock" 2>/dev/null || true
exit 0

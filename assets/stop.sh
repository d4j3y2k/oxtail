#!/usr/bin/env bash
# oxtail Stop hook — two jobs at turn end:
#   1. Wake-routing: mark this session "idle" in ~/.oxtail/activity/<pid> on a
#      real stop (no pending messages). When it instead BLOCKS to deliver
#      messages the turn continues, so it leaves the "busy" mark (set by the
#      UserPromptSubmit hook) in place.
#   2. Delivery: if peer messages landed as the turn finished, emit a
#      {"decision":"block","reason":...} envelope so Claude reads + responds
#      before going idle, and truncate the mailbox under lock.
#
# Pure bash + awk; no jq, python, or node. Exits 0 on every error path so it
# never wedges the agent. Mirrors assets/pretooluse.sh's mailbox-read/lock/awk
# logic deliberately (duplicated, not shared) so changes here never touch the
# PreToolUse hook.
#
# stop_hook_active: on a re-entry (Claude already continuing because a prior
# Stop hook blocked) this is a real stop — mark idle and exit so decision:block
# can never loop.

set -u

# 1. Read the full stdin payload once. tty / empty → nothing to do.
payload=""
if [ ! -t 0 ]; then
  payload=$(cat 2>/dev/null || true)
fi
[ -z "$payload" ] && exit 0

# 2. Extract session_id (same scanner as pretooluse.sh).
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
activity_dir="$HOME/.oxtail/activity"
[ -d "$sessions_dir" ] || exit 0

# 3. Resolve this session's MCP-server pid from its registry entry.
entry_file=$(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null | head -n 1) || true
[ -z "$entry_file" ] && exit 0
pid=$(basename "$entry_file" .json)
case "$pid" in *[!0-9]*) exit 0 ;; esac

mark_idle() {
  mkdir -p "$activity_dir" 2>/dev/null || true
  printf 'idle' > "$activity_dir/$pid" 2>/dev/null || true
}

# 4. Loop guard: a re-entry is a real stop → mark idle, allow the stop.
if printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  mark_idle
  exit 0
fi

# 5. No deliverable mailbox → real stop. Mark idle and allow the stop.
mbox="$mailboxes_dir/$pid.jsonl"
if [ ! -d "$mailboxes_dir" ] || [ ! -f "$mbox" ] || [ ! -s "$mbox" ]; then
  mark_idle
  exit 0
fi

# 6. Acquire mkdir-based lock (30s staleness window; matches mailbox.ts).
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

# 7. Build the decision:block reason from every line's body + reply metadata.
#    Truncation happens only AFTER awk produces a valid payload.
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
  # Blocking: the turn continues, so leave the "busy" mark in place.
  printf '%s' "$output"
  : > "$mbox"
else
  # Nothing deliverable → real stop.
  mark_idle
fi

rmdir "$mbox.lock" 2>/dev/null || true
exit 0

#!/usr/bin/env bash
# oxtail Stop hook — two jobs at turn end:
#   1. Wake-routing: mark this session "idle" in ~/.oxtail/activity/<session_id>
#      on a real stop (no pending messages). When it instead BLOCKS to deliver
#      messages the turn continues, so it leaves the "busy" mark (set by the
#      UserPromptSubmit hook) in place.
#   2. Delivery: if peer messages landed as the turn finished, emit a
#      {"decision":"block","reason":...} envelope so Claude reads + responds
#      before going idle, and truncate the mailbox(es) under lock.
#
# Identity is keyed by session_id, never server_pid (see AGENTS.md). A dual-scope
# agent runs several MCP children sharing one session_id; the session's inbox is
# the UNION of those children's mailboxes, so delivery drains ALL of them rather
# than guessing one. Activity is written under the session_id directly.
#
# Pure bash + awk (bash 3.2-compatible — no mapfile); no jq/python/node. Exits 0
# on every error path so it never wedges the agent. stop_hook_active: on a
# re-entry (already continuing from a prior block) this is a real stop — mark
# idle and exit so decision:block can never loop.

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

activity_dir="$HOME/.oxtail/activity"
# Sanitize to a safe filename (UUIDs pass through). Must match the server's
# activitySessionKey() so reads and writes agree on the path.
safe_sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')
mark_idle() {
  [ -z "$safe_sid" ] && return 0
  mkdir -p "$activity_dir" 2>/dev/null || true
  printf 'idle' > "$activity_dir/$safe_sid" 2>/dev/null || true
}

# 3. Loop guard: a re-entry is a real stop → mark idle, allow the stop.
if printf '%s' "$payload" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  mark_idle
  exit 0
fi

sessions_dir="$HOME/.oxtail/sessions"
mailboxes_dir="$HOME/.oxtail/mailboxes"
# Can't locate siblings → it's still a real stop; mark idle and allow it.
if [ ! -d "$sessions_dir" ] || [ ! -d "$mailboxes_dir" ]; then
  mark_idle
  exit 0
fi

# 4. Collect every non-empty sibling mailbox for this session_id.
mboxes=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  pid=$(basename "$f" .json)
  case "$pid" in *[!0-9]*) continue ;; esac
  m="$mailboxes_dir/$pid.jsonl"
  if [ -f "$m" ] && [ -s "$m" ]; then mboxes+=("$m"); fi
done < <(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null)

# Nothing to deliver → real stop.
if [ "${#mboxes[@]}" -eq 0 ]; then
  mark_idle
  exit 0
fi

# 5. Lock each non-empty mailbox (best-effort; 30s staleness window).
locked=()
for m in "${mboxes[@]}"; do
  for i in $(seq 1 50); do
    if mkdir "$m.lock" 2>/dev/null; then locked+=("$m"); break; fi
    now=$(date +%s 2>/dev/null || echo 0)
    mt=$(stat -c %Y "$m.lock" 2>/dev/null || stat -f %m "$m.lock" 2>/dev/null || echo 0)
    if [ "$mt" -gt 0 ] && [ $((now - mt)) -gt 30 ]; then rmdir "$m.lock" 2>/dev/null; fi
    sleep 0.01
  done
done
# Couldn't lock anything → leave messages for next time. This still allows the
# turn to stop, so mark idle; otherwise wake:auto will suppress a wake for a
# peer that is no longer actually busy.
if [ "${#locked[@]}" -eq 0 ]; then
  mark_idle
  exit 0
fi

# 6. Build the decision:block reason from every locked mailbox's lines.
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
    r = r "\\nReply to any that need it via mcp__oxtail__send_message (target = the from_session_id below)."
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
' "${locked[@]}")

if [ -n "$output" ]; then
  # Blocking: the turn continues, so leave the "busy" mark in place.
  printf '%s' "$output"
  for m in "${locked[@]}"; do : > "$m"; done
else
  # Nothing deliverable → real stop.
  mark_idle
fi

for m in "${locked[@]}"; do rmdir "$m.lock" 2>/dev/null || true; done
exit 0

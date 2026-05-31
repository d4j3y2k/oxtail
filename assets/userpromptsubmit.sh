#!/usr/bin/env bash
# oxtail UserPromptSubmit hook — marks this session "busy" for wake-routing.
#
# Writes "busy" to ~/.oxtail/activity/<my-server-pid> whenever a turn starts
# (the user — or a peer's send-keys wake — submits a prompt). The Stop hook
# writes "idle" when a turn ends. A sender consults this file so send_message
# with wake:"auto" only fires a send-keys wake when the peer is NOT mid-turn —
# the PreToolUse/Stop hooks deliver during a turn, so waking then would type
# into a busy composer. Pure bash; no jq/python/node. Exits 0 on every path.

set -u

# 1. Read session_id from stdin JSON (Claude Code delivers it the same way it
#    does for PreToolUse). tty / no payload → nothing to do.
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
activity_dir="$HOME/.oxtail/activity"
[ -d "$sessions_dir" ] || exit 0

# 2. Resolve this session's MCP-server pid from its registry entry.
entry_file=$(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null | head -n 1) || true
[ -z "$entry_file" ] && exit 0
pid=$(basename "$entry_file" .json)
case "$pid" in *[!0-9]*) exit 0 ;; esac

# 3. Mark busy. The file's mtime doubles as the freshness timestamp the sender
#    uses to treat a stale "busy" as wakeable.
mkdir -p "$activity_dir" 2>/dev/null || true
printf 'busy' > "$activity_dir/$pid" 2>/dev/null || true
exit 0

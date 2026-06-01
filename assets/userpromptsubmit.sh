#!/usr/bin/env bash
# oxtail UserPromptSubmit hook — marks this session "busy" for wake-routing.
#
# Writes "busy" to ~/.oxtail/activity/<session_id> whenever a turn starts (the
# user — or a peer's send-keys wake — submits a prompt). The Stop hook writes
# "idle" when a turn ends. A sender consults this file so send_message with
# wake:"auto" only fires a send-keys wake when the peer is NOT mid-turn — the
# PreToolUse/Stop hooks deliver during a turn, so waking then would type into a
# busy composer.
#
# Keyed by session_id (the agent identity), NOT server_pid: a dual-scope agent
# runs several MCP children that share one session_id, and the sender reads this
# by the peer's session_id (see AGENTS.md — never key peer identity on
# server_pid). No registry/pid lookup needed; the session_id comes straight from
# the hook payload. Pure bash; no jq/python/node. Exits 0 on every path.

set -u

# Read session_id from stdin JSON (Claude Code delivers it the same way it does
# for PreToolUse). tty / no payload → nothing to do.
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

# Sanitize to a safe filename (UUIDs pass through unchanged). Must match the
# server's activitySessionKey() so reads and writes agree on the path.
safe_sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')
[ -z "$safe_sid" ] && exit 0

activity_dir="$HOME/.oxtail/activity"
mkdir -p "$activity_dir" 2>/dev/null || true
printf 'busy' > "$activity_dir/$safe_sid" 2>/dev/null || true
exit 0

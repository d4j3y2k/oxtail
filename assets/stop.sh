#!/usr/bin/env bash
# oxtail Stop hook — two jobs at turn end:
#   1. Wake-routing: mark this session "idle" in ~/.oxtail/activity/<session_id>
#      on a real stop (no pending messages). When it instead BLOCKS to deliver
#      messages the turn continues, so it leaves the "busy" mark (set by the
#      UserPromptSubmit hook) in place.
#   2. Delivery: if peer messages landed as the turn finished, the hook-drain
#      helper emits a {"decision":"block","reason":...} envelope so Claude reads
#      + responds before going idle, and truncates the mailbox(es) under lock.
#
# v8: thin trigger, same shape as pretooluse.sh — the fast path (sid, loop
# guard, idle marking, mailbox discovery) stays pure bash; lock+parse+render is
# the shared hook-drain helper installed beside this script. Helper exit 3
# means "delivered → blocking", so the busy marker stays; anything else is a
# real stop. Missing helper/node FAILS OPEN as a real stop (messages wait for
# read_my_messages or the next turn's PreToolUse).
#
# Identity is keyed by session_id, never server_pid (see AGENTS.md). The
# session's inbox is its SESSION box (the registry entry's precomputed
# `mailbox_key`) plus any legacy per-pid sibling boxes.
#
# Exits 0 on every path so it never wedges the agent. stop_hook_active: on a
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

# Shape-gate before $sid is interpolated into the registry grep below: a value
# outside the UUID charset would act as regex metacharacters there. It is still
# a real stop, so mark idle first — only the mailbox discovery is skipped
# (read_my_messages remains the fallback path), mirroring pretooluse.sh.
case "$sid" in *[!0-9a-fA-F-]*) mark_idle; exit 0 ;; esac

# 4. Discover this session's non-empty mailboxes (same logic as pretooluse.sh:
#    legacy per-pid boxes + the session box via the entry's `mailbox_key`).
boxes=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  pid=$(basename "$f" .json)
  case "$pid" in *[!0-9]*) : ;; *)
    m="$mailboxes_dir/$pid.jsonl"
    if [ -f "$m" ] && [ -s "$m" ]; then boxes+=("$m"); fi
  ;; esac
  key=$(sed -n 's/^[[:space:]]*"mailbox_key":[[:space:]]*"\(s-[A-Za-z0-9_-]\{1,\}\)".*/\1/p' "$f" 2>/dev/null | head -1)
  if [ -n "$key" ]; then
    m="$mailboxes_dir/$key.jsonl"
    if [ -f "$m" ] && [ -s "$m" ]; then boxes+=("$m"); fi
  fi
done < <(grep -lE "\"session_id\"[[:space:]]*:[[:space:]]*\"$sid\"" "$sessions_dir"/*.json 2>/dev/null)

# Nothing to deliver → real stop.
if [ "${#boxes[@]}" -eq 0 ]; then
  mark_idle
  exit 0
fi

# 5. Hand off to the hook-drain helper. Exit 3 = delivered (decision:block
#    emitted on our stdout — the turn continues, keep the busy marker); any
#    other outcome (nothing deliverable, contended locks, protocol mismatch,
#    helper/node missing) is a real stop → mark idle. Never blocks the agent.
script_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
helper="${OXTAIL_HOOK_HELPER:-$script_dir/hook-drain.mjs}"
node_bin="__OXTAIL_NODE__"
[ -x "$node_bin" ] || node_bin=$(command -v node 2>/dev/null || true)
if [ ! -f "$helper" ] || [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  mark_idle
  exit 0
fi
rc=0
# --sid: delivery-receipt attribution (UUID-gated above); old helpers discard it.
"$node_bin" "$helper" --event stop --protocol 1 --sid "$sid" "${boxes[@]}" || rc=$?
[ "$rc" -eq 3 ] || mark_idle
exit 0

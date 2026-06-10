#!/usr/bin/env bash
# oxtail PreToolUse hook — delivers peer messages mid-turn to Claude Code.
#
# v8: thin trigger. The FAST PATH stays pure bash — read session_id from stdin,
# re-stamp the busy marker, discover non-empty mailbox files via the registry —
# so a quiet inbox costs no Node process on the hot per-tool-call path. When
# mail exists, the subtle work (owner-token lock, JSON parse, body budget,
# envelope rendering) is delegated to the hook-drain helper installed BESIDE
# this script: one implementation, shared with the server (src/locks.ts /
# src/mailbox.ts), instead of the old bash/awk mirror that had to be kept in
# sync by hand. Exits 0 on every path so it never blocks a tool call; if the
# helper or node is missing the hook FAILS OPEN (messages wait for the next
# event or read_my_messages).
#
# Identity is keyed by session_id, never server_pid (see AGENTS.md). The
# session's inbox is its SESSION box (the registry entry's precomputed
# `mailbox_key` — never re-derived here) plus any legacy per-pid sibling boxes.
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
# Shape-gate before $sid is interpolated into the registry grep below: a value
# outside the UUID charset would act as regex metacharacters there (over- or
# under-matching other sessions' registry files). Claude Code session ids are
# UUIDs; anything else fails open to read_my_messages, mirroring the server's
# own UUID guard.
case "$sid" in *[!0-9a-fA-F-]*) exit 0 ;; esac

# 2. Re-stamp "busy" on EVERY tool call (before any early-exit below) so a long,
# ACTIVE turn keeps a fresh marker and never reads as stale-busy (>TTL) to a
# peer's wake:auto. UserPromptSubmit sets "busy" once at turn start; without this
# a turn outrunning the TTL would invite a spurious keystroke wake into a working
# agent. The Stop hook flips this back to "idle" on a real stop. Keyed by
# session_id; sanitization MUST match the server's activitySessionKey().
safe_sid=$(printf '%s' "$sid" | tr -c 'A-Za-z0-9_-' '_')
[ -n "$safe_sid" ] && {
  mkdir -p "$HOME/.oxtail/activity" 2>/dev/null || true
  printf 'busy' > "$HOME/.oxtail/activity/$safe_sid" 2>/dev/null || true
}

sessions_dir="$HOME/.oxtail/sessions"
mailboxes_dir="$HOME/.oxtail/mailboxes"
[ -d "$sessions_dir" ] || exit 0
[ -d "$mailboxes_dir" ] || exit 0

# 3. Discover this session's non-empty mailboxes from registry entries matching
#    session_id: the legacy per-pid box of each sibling, plus the SESSION box
#    named by the entry's precomputed `mailbox_key` (shape-checked; the key is
#    computed only by the server — see mailboxSessionKey). Duplicate paths are
#    fine — the helper dedups. Registry files are pretty-printed JSON, so the
#    extractions tolerate whitespace.
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

[ "${#boxes[@]}" -eq 0 ] && exit 0

# 4. Mail exists → hand off to the hook-drain helper (installed beside this
#    script; OXTAIL_HOOK_HELPER overrides for tests). Its stdout IS this hook's
#    stdout — no capture, so the envelope bytes can't be lost between the
#    helper's truncate and a bash print. node path is baked at install time
#    (__OXTAIL_NODE__), with PATH lookup as fallback; neither → fail open.
script_dir=$(cd "$(dirname "$0")" 2>/dev/null && pwd)
helper="${OXTAIL_HOOK_HELPER:-$script_dir/hook-drain.mjs}"
[ -f "$helper" ] || exit 0
node_bin="__OXTAIL_NODE__"
[ -x "$node_bin" ] || node_bin=$(command -v node 2>/dev/null || true)
{ [ -n "$node_bin" ] && [ -x "$node_bin" ]; } || exit 0
"$node_bin" "$helper" --event pretooluse --protocol 1 "${boxes[@]}" || true
exit 0

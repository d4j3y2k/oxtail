// Issue #5 — per-peer wake debouncer.
//
// Every wake fires `tmux send-keys` into the peer's composer. When the same peer
// is woken again within a fraction of a second — a caller retrying ask_peer, two
// callers targeting the same peer concurrently, or a polling loop — oxtail blasts
// a second WAKE_TEXT line on top of the first, which (with the Codex paste-burst
// gap) can land inside an already-active turn. This debouncer coalesces those:
// if a wake fired for a peer within a short window, subsequent wakes are skipped
// and rely on the still-pending response.
//
// Deliberately in-memory and per-process (state lives on the calling oxtail
// server): the common burst — one caller hammering one peer — is same-process,
// and cross-process coordination is out of scope for this slice. All wake paths
// (ask_peer, send_message wake:"auto", the reply-default wake) funnel through
// wakePeer, so one check there covers them all.

function envPosInt(name: string, def: number, env: NodeJS.ProcessEnv = process.env): number {
  const v = env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// Default 1s — long enough to swallow a rapid retry / concurrent double-wake,
// short enough that a genuinely separate follow-up wake a moment later still
// lands. Tunable via OXTAIL_WAKE_DEBOUNCE_MS.
export const WAKE_DEBOUNCE_MS = envPosInt("OXTAIL_WAKE_DEBOUNCE_MS", 1000);

// session_id → last-wake-fired timestamp (ms).
export type WakeDebounceStore = Map<string, number>;

export function newWakeDebounceStore(): WakeDebounceStore {
  return new Map();
}

// True if a wake fired for this key within the window — i.e. skip this one.
export function recentlyWoke(
  store: WakeDebounceStore,
  key: string,
  nowMs: number,
  windowMs: number = WAKE_DEBOUNCE_MS,
): boolean {
  const last = store.get(key);
  return last !== undefined && nowMs - last < windowMs;
}

// Record that a wake fired for this key. Opportunistically evicts stale entries
// so the map can't grow unbounded across many short-lived peers.
export function markWoke(
  store: WakeDebounceStore,
  key: string,
  nowMs: number,
  windowMs: number = WAKE_DEBOUNCE_MS,
): void {
  store.set(key, nowMs);
  if (store.size > 256) {
    for (const [k, t] of store) {
      if (nowMs - t > windowMs * 10) store.delete(k);
    }
  }
}

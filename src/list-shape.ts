// Pure result-shaping helpers for the list/read tools, extracted from
// server.ts so tests (and future callers) can import them WITHOUT importing
// the server module — server.ts registers this process in the live registry at
// import time (top-level register()), so importing it for a pure helper turns
// a unit test into a real oxtail agent with real-HOME side effects (v0.17.1
// review: registry.test.ts did exactly that, and the orphan-mailbox GC made
// the pollution destructive enough to notice).

import type { ClientType } from "./clients.js";
import type { RegistryEntry, StateCard } from "./registry.js";

export type Session = {
  name: string;
  path: string;
  attached: boolean;
  created_at: number;
  windows: number;
  client_type: ClientType | null;
  client_session_id: string | null;
  state: StateCard | null;
};

export type ListResult = {
  schema_version: 1;
  project_root: string;
  inferred: boolean;
  sessions: Session[];
  error: string | null;
};

// Pure join: matched tmux rows × registry entries → one Session row per agent.
// Extracted from buildListResult so it can be unit-tested without invoking
// tmux. When N agents share a tmux session, N rows are emitted with identical
// tmux fields and distinct client_session_id. Tmux sessions with no matching
// registry entry get a single null-client row so unclaimed peers (Codex
// pre-claim, stale sessions) remain discoverable.
export function joinSessionsWithRegistry(
  matched: Omit<Session, "client_type" | "client_session_id" | "state">[],
  registry: RegistryEntry[],
): Session[] {
  const regsByTmux = new Map<string, RegistryEntry[]>();
  for (const e of registry) {
    if (!e.tmux_session) continue;
    const arr = regsByTmux.get(e.tmux_session);
    if (arr) arr.push(e);
    else regsByTmux.set(e.tmux_session, [e]);
  }
  return matched.flatMap((s): Session[] => {
    const regs = regsByTmux.get(s.name) ?? [];
    if (regs.length === 0) {
      return [{ ...s, client_type: null, client_session_id: null, state: null }];
    }
    return regs.map((reg) => ({
      ...s,
      client_type: reg.client.type ?? null,
      client_session_id: reg.client.session_id ?? null,
      state: reg.state ?? null,
    }));
  });
}

type CompactAgent = {
  client_type: ClientType | null;
  client_session_id: string | null;
  state: StateCard | null;
};
type CompactTmuxSession = {
  name: string;
  path: string;
  attached: boolean;
  created_at: number;
  windows: number;
  agents: CompactAgent[];
};
export type ListCompactResult = {
  schema_version: 1;
  project_root: string;
  inferred: boolean;
  tmux_sessions: CompactTmuxSession[];
  error: string | null;
};

// Opt-in compact shape: hoist the tmux fields that are byte-identical across
// every agent sharing a session (name/path/attached/created_at/windows) into one
// group, with the per-agent fields nested under `agents`. Kills the per-row
// duplication that grows with the agent matrix (and the redundant per-row `path`
// that usually equals project_root). The DEFAULT response keeps the flat
// `sessions[]` shape — backward compatible; callers ask for this with
// compact:true. An unclaimed tmux session (no oxtail-aware agent) becomes a group
// with an empty `agents` array.
export function toCompactList(r: ListResult): ListCompactResult {
  const groups = new Map<string, CompactTmuxSession>();
  const order: string[] = [];
  for (const s of r.sessions) {
    let g = groups.get(s.name);
    if (!g) {
      g = {
        name: s.name,
        path: s.path,
        attached: s.attached,
        created_at: s.created_at,
        windows: s.windows,
        agents: [],
      };
      groups.set(s.name, g);
      order.push(s.name);
    }
    // joinSessionsWithRegistry emits a single all-null row for a tmux session
    // with no registry match; don't materialize that as a phantom agent.
    if (s.client_type !== null || s.client_session_id !== null || s.state !== null) {
      g.agents.push({
        client_type: s.client_type,
        client_session_id: s.client_session_id,
        state: s.state,
      });
    }
  }
  return {
    schema_version: 1,
    project_root: r.project_root,
    inferred: r.inferred,
    tmux_sessions: order.map((n) => groups.get(n)!),
    error: r.error,
  };
}

export function tailChars(text: string, maxChars: number): { text: string; truncated: boolean } {
  // Fast path: code-unit length is an upper bound on code-point count, so if it
  // already fits there's nothing to do (and we skip the Array.from allocation).
  if (text.length <= maxChars) return { text, truncated: false };
  // Slice by code points so we never split a surrogate pair at the boundary.
  const cps = Array.from(text);
  if (cps.length <= maxChars) return { text, truncated: false };
  const tail = cps.slice(cps.length - maxChars).join("");
  return { text: `…[pane truncated to last ${maxChars} chars]\n${tail}`, truncated: true };
}

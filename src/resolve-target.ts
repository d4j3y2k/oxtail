// Peer target resolution for the messaging tools (send_message /
// reply_to_message / ask_peer): turn a caller-supplied target — a tmux session
// name or a client_session_id UUID — into exactly one live, in-scope registry
// entry, or a precise refusal. Extracted from server.ts; the rules are the
// v0.5→v0.16 lineage: identity keys on client.session_id (AGENTS.md
// invariant), liveness + pid-reuse guards re-verify the on-disk entry, nested
// git repos are separate projects, ambiguity is surfaced (never guessed), and
// a dual-scope sibling of the caller is a self-send.

import { entryForPid, processStartSig, readAll, type RegistryEntry } from "./registry.js";
import {
  findProjectRoot,
  isDescendantOrEqual,
  safeRealpath,
  UUID_RE,
} from "./scope.js";
import type { WakeStatus } from "./wake.js";

export type ResolveOk = { ok: true; entry: RegistryEntry };
export type ResolveErr =
  | { ok: false; error: "target-not-found" }
  | { ok: false; error: "ambiguous-target"; candidates: string[]; note?: string }
  | { ok: false; error: "cross-project" }
  | { ok: false; error: "self-send" };

export function resolveErrorWakeStatus(error: ResolveErr["error"]): WakeStatus | undefined {
  return error === "target-not-found" ? "skipped_no_target" : undefined;
}

export function peerSupportsReplyTo(peer: RegistryEntry): boolean {
  return peer.capabilities?.mailbox?.reply_to === true;
}

function projectRootsMatch(caller: RegistryEntry, peer: RegistryEntry): boolean {
  const callerProject = findProjectRoot(caller.client.cwd);
  const peerProject = findProjectRoot(peer.client.cwd);
  const callerRoot = safeRealpath(callerProject.root);
  const peerRoot = safeRealpath(peerProject.root);

  if (callerProject.foundGit || peerProject.foundGit) {
    return callerProject.foundGit && peerProject.foundGit && callerRoot === peerRoot;
  }

  // No .git boundary exists for either side. Preserve the pre-v0.8 loose
  // behavior for ad-hoc directories so two agents in parent/child cwd under the
  // same scratch tree can still coordinate.
  const callerCwd = safeRealpath(caller.client.cwd);
  const peerCwd = safeRealpath(peer.client.cwd);
  return (
    callerRoot === peerRoot ||
    isDescendantOrEqual(peerCwd, callerRoot) ||
    isDescendantOrEqual(callerCwd, peerRoot)
  );
}

function isAliveLocal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM";
  }
}

export function resolveTarget(target: string, caller: RegistryEntry): ResolveOk | ResolveErr {
  const all = readAll();
  let candidates: RegistryEntry[];
  if (UUID_RE.test(target)) {
    candidates = all.filter((e) => e.client.session_id === target);
  } else {
    candidates = all.filter((e) => e.tmux_session === target);
  }

  // Liveness + PID-reuse guard: keep only entries whose pid is alive AND whose
  // on-disk started_at still matches what readAll() returned. A reused pid
  // would have been overwritten with a different started_at.
  candidates = candidates.filter((e) => {
    if (!isAliveLocal(e.server_pid)) return false;
    // PID-reuse guard: re-read the on-disk file and compare started_at to the
    // one we cached in memory at lookup time. A reused pid lands on a freshly
    // written entry with a different started_at.
    const fresh = entryForPid(e.server_pid);
    if (!fresh) return false;
    if (fresh.started_at !== e.started_at) return false;
    // PID-reuse: started_at is the original registration time and lives on the
    // stale on-disk entry, so a recycled pid (alive, file untouched) passes the
    // check above. If the entry recorded the process start-time signature,
    // confirm the live pid is still that same process; a recycled pid reads a
    // different signature and is rejected (M3). Empty reading → indeterminate,
    // leave it to downstream (the pane wake gate re-verifies before keystrokes).
    if (fresh.proc_sig) {
      const liveSig = processStartSig(e.server_pid);
      if (liveSig && liveSig !== fresh.proc_sig) return false;
    }
    return true;
  });

  // Self-exclusion BEFORE the ambiguity count: the caller's own entry (and any
  // dual-scope MCP sibling sharing its claimed session_id) is never a peer
  // candidate. Without this, name-targeting a shared tmux session counted US
  // toward ambiguity — the live v0.17.1-era failure shape: [caller(claimed),
  // codex(unclaimed)] returned ambiguous-target whose only listed candidate was
  // the caller itself, making the sole real peer unreachable in-band. Track
  // whether self matched so a target that resolves ONLY to us still reports
  // self-send rather than target-not-found.
  const isSelf = (e: RegistryEntry): boolean =>
    e.server_pid === caller.server_pid ||
    (caller.client.session_id != null && e.client.session_id === caller.client.session_id);
  const selfMatched = candidates.some(isSelf);
  candidates = candidates.filter((e) => !isSelf(e));

  if (candidates.length === 0) {
    return { ok: false, error: selfMatched ? "self-send" : "target-not-found" };
  }
  if (candidates.length > 1) {
    // Only claimed session_ids are addressable; an unclaimed peer has no UUID to
    // hand back. Don't emit a `pid:<n>` pseudo-handle — it isn't a routable
    // target (resolveTarget accepts only UUIDs / tmux names) and advertising it
    // fights the session_id identity invariant. Note the unclaimed count so the
    // caller knows to have those peers run claim_session.
    const uuids = candidates
      .map((c) => c.client.session_id)
      .filter((s): s is string => s != null);
    const unclaimed = candidates.length - uuids.length;
    return {
      ok: false,
      error: "ambiguous-target",
      candidates: uuids,
      ...(unclaimed > 0
        ? {
            note: `${unclaimed} peer(s) sharing tmux session '${target}' have not claimed a session_id and cannot be addressed by UUID; have them run claim_session.`,
          }
        : {}),
    };
  }
  // Exactly one non-self peer. It may be UNCLAIMED (client.session_id null) —
  // that is now a routable bootstrap target: delivery lands in its legacy pid
  // box (DeliveryRoute handles a null session_id) and a wake reaches its
  // verified pane, so the peer can be nudged to claim_session in-band instead
  // of requiring a human tmux relay. Tools that NEED a claimed identity for
  // correlation (ask_peer, reply waits) keep their own explicit guards.
  const peer = candidates[0];
  if (!projectRootsMatch(caller, peer)) return { ok: false, error: "cross-project" };
  return { ok: true, entry: peer };
}

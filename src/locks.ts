import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { trace } from "./trace.js";

// Shared advisory-lock primitive for the mkdir-based locks used by both the
// mailbox queues (mailbox.ts) and the received-ledger (received.ts), and mirrored
// in the bash hooks (assets/pretooluse.sh, assets/stop.sh). Centralised here
// because stale-recovery is subtle and must be reasoned about (and tested) once.
//
// HONEST LIMIT: a provably race-free, stale-recoverable advisory lock is not
// achievable on a plain shared filesystem (no atomic compare-and-swap; every
// "detect stale → remove → reacquire" has a check-then-act window). This design
// eliminates the REALISTIC failure modes; the residuals that remain ALL require
// a process to stall (SIGSTOP / huge swap / multi-second GC) past the 30s stale
// window while inside a microsecond-wide gap between two syscalls:
//   (a) a clearer that stalls >30s between its owner-compare and its rmdir, while
//       another clearer reclaims the (now >30s-stale) steal marker and reacquires;
//   (b) a holder that stalls >30s between mkdir(lock) and writeOwner(lock), gets
//       stale-cleared as owner-less, then resumes and overwrites a successor's
//       owner sidecar;
//   (c) a holder that stalls >30s mid-critical-section and resumes to do its data
//       write believing it still holds the lock (the data ops do not re-validate
//       ownership before writing).
// Eliminating these needs kernel-arbitrated locks (flock/fcntl), which are not
// viable here because the lock is shared with bash hooks on macOS (no flock CLI).
// The consequence of any of these firing is bounded — a rare double-delivery
// (benign once readers dedup by message_id) or a rare ledger lost-update (the
// reply handle degrades to send_message), never a wedge or torn file.
//
// Two mechanisms do the work:
//  1. OWNER TOKEN. Each acquisition writes a unique token into the SIDECAR file
//     `<lock>.owner` (kept beside the lock dir, NOT inside it, so the lock dir
//     stays empty and a bash hook's plain `rmdir <lock>` still works cross-
//     language). Release only removes the lock if the token still matches — so a
//     holder that stalled past the stale window, got its lock stolen, and then
//     resumes can no longer rmdir the SUCCESSOR's fresh lock (stall-resume bug).
//  2. SINGLE-WINNER + COMPARE-AND-CLEAR. Stale removal is gated behind an atomic
//     `mkdir(<lock>.steal)` marker, and the clearer removes the lock only if its
//     owner is STILL the dead token it observed. While the marker is held and the
//     lock still exists, nobody else can clear (marker) or acquire (mkdir EEXIST),
//     so the owner is stable across the check→rmdir. And the actual acquire is
//     ALWAYS the single-winner `mkdir(lock)`, so even redundant clears can never
//     produce two owners — the worst they do is race to recreate the lock, which
//     exactly one wins.

const LOCK_RETRY_DELAY_MS = 10;
// Total acquire budget is wall-clock, NOT a fixed retry count: a successful
// stale-clear retries mkdir immediately (no sleep) so it must not consume the
// budget without time passing — a count-based budget threw "could not acquire
// lock" spuriously under contention (H2). 2s is ample for the tiny mailbox/
// ledger critical sections and well under any caller-level timeout.
const LOCK_ACQUIRE_TIMEOUT_MS = 2_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Sidecar beside the lock dir (not inside) so the lock dir stays empty and a
// bash hook's plain `rmdir <lock>` still removes a Node-held lock. An orphaned
// sidecar (lock dir removed but sidecar left, e.g. by a bash clearer that doesn't
// know about it) is harmless — the next acquirer overwrites it.
function ownerPath(lock: string): string {
  return `${lock}.owner`;
}

function mintToken(): string {
  return `${process.pid}.${randomBytes(8).toString("hex")}`;
}

// Read the owner token, or null if the lock has none (foreign/legacy lock, or a
// lock observed in the tiny window after mkdir but before the owner write).
function readOwner(lock: string): string | null {
  try {
    return readFileSync(ownerPath(lock), "utf8");
  } catch {
    return null;
  }
}

function writeOwner(lock: string, token: string): void {
  try {
    writeFileSync(ownerPath(lock), token, { mode: 0o600 });
  } catch {
    // Best effort: an owner-less lock still excludes (the dir exists); it just
    // loses the stall-resume protection until the next acquisition.
  }
}

// Remove the lock dir and its owner file. Tolerates a foreign non-empty lock dir
// (e.g. one a bash hook or test created without our layout) via a recursive rm.
function removeLock(lock: string): void {
  try {
    unlinkSync(ownerPath(lock));
  } catch {
    // no owner file — fine
  }
  try {
    rmdirSync(lock);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return;
    // Non-empty (foreign contents) or other — fall back to recursive removal.
    try {
      rmSync(lock, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// Compare-and-clear a stale lock under the single-winner steal marker. Returns
// true iff this call did the clearing work (caller retries mkdir immediately);
// false if the lock is fresh, vanished, or another clearer holds the marker
// (caller should sleep and retry).
export function clearStaleLock(
  lock: string,
  staleMs: number,
  traceEvent: string,
  traceCtx: Record<string, unknown>,
): boolean {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(lock);
  } catch {
    return false; // lock vanished between the failed mkdir and now — just retry
  }
  if (Date.now() - st.mtimeMs <= staleMs) return false; // fresh holder — wait

  const observed = readOwner(lock); // the (presumed dead) holder's token, or null
  const steal = `${lock}.steal`;
  try {
    mkdirSync(steal, { mode: 0o700 });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EEXIST") {
      // Another clearer holds the marker. If the marker is itself stale by the
      // SAME stale window as the lock (its clearer crashed/SIGSTOP'd mid-steal),
      // force it so recovery cannot wedge forever. Using the lock's stale window
      // (not a shorter one) means a clearer can only be displaced after a full
      // 30s stall — the same SIGSTOP-class threshold as every other residual —
      // rather than after a brief pause. Compare-and-clear below still refuses to
      // remove a lock whose owner changed, backstopping a reclaim race.
      try {
        const sst = statSync(steal);
        if (Date.now() - sst.mtimeMs > staleMs) {
          try {
            rmdirSync(steal);
          } catch {
            // raced with another clearer — fine
          }
        }
      } catch {
        // marker vanished — fine
      }
    }
    return false; // lost the steal — sleep and retry
  }

  // Sole clearer (modulo a leaked-marker race, which compare-and-clear backstops).
  // Re-read the owner now: if it still equals what we observed, the dead holder's
  // lock is unchanged and safe to remove; if it changed, someone reacquired and
  // we must leave their lock alone.
  if (readOwner(lock) === observed) {
    removeLock(lock);
    trace(traceEvent, traceCtx);
  }
  try {
    rmdirSync(steal);
  } catch {
    // best effort — a leaked marker is force-cleared by the next clearer
  }
  return true;
}

// Acquire the advisory lock, returning the owner token to hand back to
// releaseDirLock. The caller is responsible for creating the parent directory.
// `budgetMs` overrides the default wall-clock acquire budget: the hook delivery
// helper passes a shorter one (it must never stall a tool call on a contended
// box — skipping and retrying next event is the correct behavior there).
export function acquireDirLock(
  lock: string,
  staleMs: number,
  traceEvent: string,
  traceCtx: Record<string, unknown>,
  budgetMs: number = LOCK_ACQUIRE_TIMEOUT_MS,
): string {
  const token = mintToken();
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeOwner(lock, token);
      return token;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") throw err;
      // A successful stale-clear means the lock is gone: loop straight back to
      // mkdir WITHOUT sleeping, to grab it before another contender (this retry
      // must not consume the budget without time passing). Otherwise — a fresh
      // holder or a lost steal — back off before retrying.
      if (!clearStaleLock(lock, staleMs, traceEvent, traceCtx)) {
        sleepSync(LOCK_RETRY_DELAY_MS);
      }
    }
    // Wall-clock budget so the no-sleep stale-clear path cannot spin forever.
    if (Date.now() >= deadline) {
      throw new Error(`could not acquire lock at ${lock}`);
    }
  }
}

// Release the lock — but only if we PROVABLY still own it (owner === our token).
// A holder that stalled past the stale window and was stolen from sees a
// different owner and leaves the successor's lock intact. We deliberately do NOT
// remove on an absent owner: a successor in its mkdir→writeOwner window has no
// owner yet, and removing then would stomp its fresh lock (Codex round-3). If our
// OWN owner write was lost, the cost is a leaked lock — which simply ages into a
// stale lock and is reclaimed by clearStaleLock, strictly safer than a stomp.
export function releaseDirLock(lock: string, token: string): void {
  if (!token) {
    // No token to prove ownership. An empty token reaches here only from a
    // lockTokens Map miss (an acquire that threw, or a future same-key nested
    // release), so removing would stomp whatever lock currently exists —
    // possibly a DIFFERENT owner's fresh one. Leave it: a genuinely leaked lock
    // ages into a stale lock and is reclaimed by clearStaleLock, strictly safer
    // than a stomp (H3).
    trace("lock_release_skipped_no_token", { lock });
    return;
  }
  const owner = readOwner(lock);
  if (owner === token) {
    removeLock(lock);
  } else {
    // Owner differs or is absent → not provably ours; leave it. A truly
    // abandoned lock becomes stale and is reclaimed by clearStaleLock.
    trace("lock_release_skipped_not_owner", { lock });
  }
}

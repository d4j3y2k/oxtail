import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnsureWindowResult } from "./ensure-window.js";
import { markPaneManaged, readPaneMarker } from "./ownership.js";
import { syncFleet } from "./sync.js";
import type { FleetSpec, FleetWindowSpec } from "./types.js";

// Opt-in real-tmux integration for SYNC (OXTAIL_TMUX_TESTS=1; skipped in normal CI).
// Applies the P5/P6 lesson — live-test the scary code — to the SYNC DESTRUCTIVE path:
// the agent launch is stubbed (a `markEnsure` stands in, no billable agent), but the
// DELETE half runs the REAL killManagedWindow + real new-window/kill-window against a
// throwaway session. Run: `OXTAIL_TMUX_TESTS=1 npm test`.
const skip = process.env.OXTAIL_TMUX_TESTS !== "1";

function tmuxOk(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}
function tmuxRaw(args: string[]): string {
  return execFileSync("tmux", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function windowNames(session: string): string[] {
  return tmuxRaw(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]).split("\n").filter(Boolean);
}
function paneOf(session: string, window: string): string {
  return tmuxRaw(["list-panes", "-t", `${session}:${window}`, "-F", "#{pane_id}"]).split("\n").filter(Boolean)[0];
}
function pidOf(pane: string): string {
  return tmuxRaw(["display-message", "-t", pane, "-p", "#{pane_pid}"]).trim();
}
function killSession(name: string): void {
  try {
    tmuxRaw(["kill-session", "-t", `=${name}`]);
  } catch {
    // already gone
  }
}
// Temp dir doubling as repoRoot + HOME (so the fleet lock lands in an isolated
// ~/.oxtail, never the live fleet's). The real tmux ops reach the same default server.
function withTempRepo(fn: (repoRoot: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-sync-tmux-"));
  const priorHome = process.env.HOME;
  process.env.HOME = dir;
  return (async () => {
    try {
      await fn(dir);
    } finally {
      process.env.HOME = priorHome;
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

const FID = "oxsync-deadbeef";

// Stand in for the agent launch: mark the pane the way ensure_window would (no billable
// agent started). DELETE uses the REAL killManagedWindow — that's the path under test.
const markEnsure = async (o: {
  target: string;
  window: FleetWindowSpec;
  fleetId: string;
  cwd: string;
}): Promise<EnsureWindowResult> => {
  markPaneManaged(o.target, o.fleetId);
  return { window: o.window.name, occupancy: "empty-shell", action: "launched", ok: true, sessionId: `sid-${o.window.name}` };
};

test(
  "sync-tmux: converges a REAL session — ADD new, KEEP healthy (not restarted), DELETE spec-removed, SURVIVOR untouched",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-sync-test-${process.pid}-${Date.now()}`;
    await withTempRepo(async (repoRoot) => {
      try {
        // Build a managed fleet by hand: main + max (ours), plus a human's unmarked "editor".
        tmuxRaw(["new-session", "-d", "-s", session, "-n", "main", "bash --noprofile --norc"]);
        tmuxRaw(["new-window", "-t", session, "-n", "max", "bash --noprofile --norc"]);
        tmuxRaw(["new-window", "-t", session, "-n", "editor", "bash --noprofile --norc"]);
        markPaneManaged(paneOf(session, "main"), FID);
        markPaneManaged(paneOf(session, "max"), FID);
        const editorPane = paneOf(session, "editor"); // stays UNMARKED — a human's window
        const mainPid = pidOf(paneOf(session, "main"));

        // spec: KEEP main, ADD test, DROP max. editor isn't ours → survivor.
        const spec: FleetSpec = {
          name: session,
          windows: [{ name: "main", agent: "claude" }, { name: "test", agent: "claude" }],
        };
        const res = await syncFleet(spec, repoRoot, session, { dryRun: false, fleetId: FID, ensure: markEnsure });

        assert.ok(res.ok, `sync ok: ${res.error ?? res.removed.map((r) => r.reason).join(";")}`);
        assert.deepEqual(windowNames(session).sort(), ["editor", "main", "test"], "max DELETEd, test ADDed, main+editor remain");
        assert.equal(pidOf(paneOf(session, "main")), mainPid, "KEEP left main running — same pid, NOT restarted");
        assert.equal(readPaneMarker(paneOf(session, "test")), FID, "the ADDed window is marked ours");
        assert.equal(readPaneMarker(editorPane), null, "the human's window is never marked or touched");
      } finally {
        killSession(session);
      }
    });
  },
);

test(
  "sync-tmux: REFUSES to DELETE a managed window holding a human split (won't destroy unmanaged work)",
  { skip: skip || !tmuxOk() },
  async () => {
    const session = `oxtail-sync-split-${process.pid}-${Date.now()}`;
    await withTempRepo(async (repoRoot) => {
      try {
        tmuxRaw(["new-session", "-d", "-s", session, "-n", "main", "bash --noprofile --norc"]);
        tmuxRaw(["new-window", "-t", session, "-n", "doomed", "bash --noprofile --norc"]);
        markPaneManaged(paneOf(session, "main"), FID);
        const doomedPane = paneOf(session, "doomed");
        markPaneManaged(doomedPane, FID);
        tmuxRaw(["split-window", "-t", doomedPane, "bash --noprofile --norc"]); // a HUMAN split into our window (unmarked)

        // spec drops "doomed" → DELETE target, but it now holds an unmanaged split.
        const spec: FleetSpec = { name: session, windows: [{ name: "main", agent: "claude" }] };
        const res = await syncFleet(spec, repoRoot, session, { dryRun: false, fleetId: FID, ensure: markEnsure });

        assert.equal(res.ok, false, "the guarded DELETE fails → overall not ok");
        assert.ok(
          res.removed.some((r) => !r.ok && /unmanaged|doesn't own/i.test(r.reason ?? "")),
          `DELETE refused with the unmanaged-split reason (got: ${JSON.stringify(res.removed)})`,
        );
        assert.ok(windowNames(session).includes("doomed"), "the window — and the human's split — SURVIVES");
      } finally {
        killSession(session);
      }
    });
  },
);

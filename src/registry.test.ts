import { test } from "node:test";
import assert from "node:assert/strict";

import { findTmuxPaneByAncestry } from "./registry.js";

test("findTmuxPaneByAncestry: hits when start pid IS a pane_pid", () => {
  const panePids = new Map<number, string>([[100, "%1"]]);
  const ppids = new Map<number, number>();
  assert.equal(findTmuxPaneByAncestry(100, panePids, ppids), "%1");
});

test("findTmuxPaneByAncestry: walks ppid chain to a pane_pid ancestor", () => {
  // codex MCP child (4000) -> codex (3000) -> shell (2000=pane_pid) -> tmux server (1500)
  const panePids = new Map<number, string>([[2000, "%7"]]);
  const ppids = new Map<number, number>([
    [4000, 3000],
    [3000, 2000],
    [2000, 1500],
  ]);
  assert.equal(findTmuxPaneByAncestry(4000, panePids, ppids), "%7");
});

test("findTmuxPaneByAncestry: returns null when no ancestor is a pane_pid", () => {
  const panePids = new Map<number, string>([[9999, "%99"]]);
  const ppids = new Map<number, number>([
    [4000, 3000],
    [3000, 2000],
    [2000, 1],
  ]);
  assert.equal(findTmuxPaneByAncestry(4000, panePids, ppids), null);
});

test("findTmuxPaneByAncestry: returns null when tmux is not running (empty pane map)", () => {
  // Bail cheap when there are no panes — don't even consult ppid map.
  const panePids = new Map<number, string>();
  const ppids = new Map<number, number>([[4000, 3000]]);
  assert.equal(findTmuxPaneByAncestry(4000, panePids, ppids), null);
});

test("findTmuxPaneByAncestry: stops at pid 1 instead of looping", () => {
  // pid 1's ppid is itself on some kernels; our guard is `pid > 1`, so we stop.
  const panePids = new Map<number, string>([[42, "%42"]]);
  const ppids = new Map<number, number>([
    [100, 1],
    [1, 1],
  ]);
  assert.equal(findTmuxPaneByAncestry(100, panePids, ppids), null);
});

test("findTmuxPaneByAncestry: bounded iteration cap prevents infinite loops on cycles", () => {
  // Pathological ppid cycle: A -> B -> A. We must terminate.
  const panePids = new Map<number, string>([[999, "%999"]]);
  const ppids = new Map<number, number>([
    [100, 200],
    [200, 100],
  ]);
  assert.equal(findTmuxPaneByAncestry(100, panePids, ppids), null);
});

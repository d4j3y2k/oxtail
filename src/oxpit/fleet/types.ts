// Backbone domain types for the oxpit fleet lifecycle manager. Kept node-free
// and dependency-free so every fleet module (spec, ownership, teardown, the
// ensure_window executor, recipes) can share them without an import cycle.

// What the operator selects in the thin spec. Maps to oxtail's ClientType at the
// executor boundary (claude → "claude-code", codex → "codex").
export type AgentKind = "claude" | "codex";

// One window's DESIRED state. Thin + serializable — the brittle "how to launch
// and configure" (model ids, effort chords, join ceremony) lives in versioned
// code recipes, not here.
export interface FleetWindowSpec {
  name: string; // tmux window name + role label, e.g. "main" | "max" | "codex"
  agent: AgentKind;
  model?: string; // e.g. "opus-4.8" — applied as a launch flag where supported
  effort?: string; // e.g. "xhigh" | "max"
  role?: string; // informational, e.g. "captain"
}

export interface FleetSpec {
  name: string; // base name for the tmux session + the ownership fleetId
  windows: FleetWindowSpec[];
}

// Idempotency LEVEL probe (max's core crack): what currently occupies a target
// window relative to its desired spec. Drives ensure_window's dispatch so a
// re-run on a healthy window is a true no-op instead of typing into a live agent.
//   empty-shell        → launch
//   healthy-right-type → NO-OP (idempotent skip)
//   half-up            → teardown+launch (P6); SPAWN aborts loudly instead
//   wrong-type         → teardown+launch (P6); SPAWN aborts loudly instead
//   unknown            → abstain loudly (never guess and launch-on-top)
export type WindowOccupancy =
  | "empty-shell"
  | "healthy-right-type"
  | "half-up"
  | "wrong-type"
  | "unknown";

// Per-step readiness classifier (codex's enum) used while driving a freshly
// launched agent — gates each keystroke; BLOCKED/UNKNOWN abort loudly rather
// than send the next key into a TUI that only LOOKS ready.
export type PaneReadiness =
  | "shell-ready" // a shell that echoes commands (pre-launch / Codex bootstrap)
  | "tui-ready" // the agent TUI is up and accepting input
  | "blocked-interstitial" // trust-folder / login / update / model-picker / permission
  | "busy" // mid-turn
  | "unknown";

// Recipes — a small typed step-DSL describing how to drive a freshly launched
// agent from an empty shell to a confirmed, addressable session. The brittle
// "how" (launch flags, effort/join ceremony, interstitial recovery) lives here
// as VERSIONED CODE rather than in the thin JSON fleet spec, so:
//   • a dry-run can print the EXACT steps before anything mutates a pane, and
//   • the executor is unit-testable against injected effects (no real tmux).
//
// The single load-bearing readiness step is `waitExternal`: it blocks on the
// launch-time filesystem artifact (readiness.ts), which is the source of truth
// that the agent came up and what its session id is — never a TUI string. The
// other steps (sendLiteral/key/classifyPane/claimCheck/abort) carry the
// configuration + external-confirmation ceremony layered on top.
//
// P2 ships the DSL + executor + a MINIMAL validated SPAWN recipe (launch →
// waitExternal → claimCheck). Effort/join chords and exact launch flags are
// finalized + live-verified in P3 alongside the spec; the DSL already supports
// them so that work is additive.

import type { ClientType } from "../../clients.js";
import type { PaneClassification } from "./classify.js";
import type { AgentKind, FleetWindowSpec, PaneReadiness } from "./types.js";

export type RecipeStep =
  // Type literal text + Enter (via fireKeystrokes — the literal `-l` neutralizes
  // any key-sequence, and Codex gets the paste-burst gap). `confirm`, when set,
  // is an echo needle the command prints bare on its own line (shell setup).
  | { op: "sendLiteral"; text: string; confirm?: string; note?: string }
  // A bare named key event (Enter / Escape / C-c) — for interstitial recovery.
  | { op: "key"; key: string; note?: string }
  // Block on the launch artifact for `artifact`, binding the session id. THE
  // readiness signal; everything after it may reference the bound session.
  | { op: "waitExternal"; artifact: AgentKind; note?: string }
  // Gate: the pane must currently classify into one of `expect`, else abort.
  | { op: "classifyPane"; expect: PaneReadiness[]; note?: string }
  // Cooperative self-claim: type a one-line instruction into the pane telling
  // the agent to register the just-bound session in oxtail's registry. Needed
  // ONLY for clients with no auto-join (Codex — CODEX_THREAD_ID is stripped from
  // its MCP child); Claude's SessionStart hook auto-joins, so its recipe omits
  // this step. Runs AFTER waitExternal (uses the bound session id).
  | { op: "joinClaim"; note?: string }
  // External confirmation that the bound session is now resolvable in oxtail's
  // registry (adoption landed) — not a pane-text check.
  | { op: "claimCheck"; note?: string }
  // Explicit loud abort.
  | { op: "abort"; reason: string };

export interface Recipe {
  client: AgentKind;
  label: string; // the window name/role, for dry-run + logs
  launchCommand: string; // the argv line the launch step types (also surfaced for SPAWN/new-window)
  steps: RecipeStep[];
}

export function clientTypeFor(kind: AgentKind): ClientType {
  return kind === "claude" ? "claude-code" : "codex";
}

// Single-quote a value so the interactive shell we type the launch into treats
// it as ONE literal token. `tmux send-keys -l` stops tmux KEY parsing, but the
// SHELL still interprets `;` backticks `$()` `|` `>` spaces etc — so every
// SPEC-DERIVED value (which in P3 comes from a repo's .oxtail/fleet.json) MUST
// be quoted before it joins the command line, or a model like
// `gpt-5.5; rm -rf ~` would run as a second command on SPAWN (codex P2 BLOCK #1).
// Constant code tokens (the base command, flag names) are trusted and unquoted.
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build the launch command line typed into the empty shell. Keeping the launch
// a CHILD of the pane shell is what lets readiness.ts bind the artifact's host
// pid to this pane. The spec's `model` field IS the value the client's --model
// flag accepts (the spec author owns it; no hardcoded id mapping here) — and it
// is shell-quoted because it is untrusted spec input.
//
// NOTE (P3): the exact flag name and effort application (launch flag vs in-TUI
// chord) are finalized + live-verified in P3. `--model` is the first cut;
// effort is intentionally deferred to a chord step rather than guessed here.
export function buildLaunchCommand(window: FleetWindowSpec): string {
  const base = window.agent === "claude" ? "claude" : "codex";
  const parts = [base];
  if (window.model) parts.push("--model", shellSingleQuote(window.model));
  return parts.join(" ");
}

// The one-line instruction oxpit types into a freshly-spawned Codex to make it
// register the just-bound session. EXPLICIT-id form: oxpit already read the
// thread-id from the rollout, so it tells Codex exactly what to claim rather than
// trusting Codex to self-resolve $CODEX_THREAD_ID (same value, but explicit
// removes the env dependency and gives an exact, confirmable target).
//
// Phrasing per the live Codex peer (it knows its own first-turn ergonomics): a
// single direct MCP tool-call instruction is the most reliable thing for a fresh
// Codex to execute — NO leading slash, code fences, shell syntax, or multi-step
// prose, and claim_session (not register_my_session) for the compact verify. The
// "reply Registered" tail is a human/diagnostic signal only — oxpit's truth is
// the registry (claimCheck/isClaimPaneBound), never this pane text.
export function buildJoinInstruction(sessionId: string): string {
  return (
    `Call the oxtail MCP tool claim_session with session_id "${sessionId}" now. ` +
    `If it succeeds, reply exactly: Registered: ${sessionId}`
  );
}

// The SPAWN recipe: launch into the empty shell, wait for the launch artifact to
// bind the session, (Codex only) fire the cooperative self-claim, then confirm
// registry adoption. Effort chords + classifyPane gates are layered in as P3
// finalizes (the DSL supports them).
//
// PHASING (max Q4): Claude auto-joins via its SessionStart hook, so its recipe is
// launch → waitExternal → claimCheck. Codex has no auto-join, so it gets an extra
// joinClaim step BEFORE claimCheck; without it a fresh Codex could never satisfy
// the pane-bound claimCheck.
export function buildRecipe(window: FleetWindowSpec): Recipe {
  const launchCommand = buildLaunchCommand(window);
  const steps: RecipeStep[] = [
    { op: "sendLiteral", text: launchCommand, note: "launch into the empty shell" },
    { op: "waitExternal", artifact: window.agent, note: "bind session via launch artifact" },
  ];
  if (window.agent === "codex") {
    steps.push({ op: "joinClaim", note: "cooperative self-claim (Codex has no auto-join)" });
  }
  steps.push({ op: "claimCheck", note: "confirm the bound session is registry-resolvable" });
  return {
    client: window.agent,
    label: window.role ? `${window.name} (${window.role})` : window.name,
    launchCommand,
    steps,
  };
}

// Map a whole fleet spec to per-window recipes (SPAWN runs ensure_window over
// these in order). Pure — for dry-run and SPAWN planning.
export function recipesForFleet(spec: { windows: FleetWindowSpec[] }): Recipe[] {
  return spec.windows.map(buildRecipe);
}

function renderStep(s: RecipeStep): string {
  switch (s.op) {
    case "sendLiteral":
      return `sendLiteral ${JSON.stringify(s.text)}${s.confirm ? ` (confirm: ${JSON.stringify(s.confirm)})` : ""}`;
    case "key":
      return `key ${s.key}`;
    case "waitExternal":
      return `waitExternal ${s.artifact} (${s.artifact === "claude" ? "SessionStart drop, ppid→pane" : "rollout file, new-file+cwd"})`;
    case "classifyPane":
      return `classifyPane expect [${s.expect.join(", ")}]`;
    case "joinClaim":
      return `joinClaim (cooperative self-claim, Codex)`;
    case "claimCheck":
      return `claimCheck`;
    case "abort":
      return `abort: ${s.reason}`;
  }
}

// Human-readable dry-run (no side effects). Printed before a SPAWN/RESET touches
// any pane so the operator sees EXACTLY what each window will do.
export function renderRecipe(recipe: Recipe): string {
  const lines: string[] = [];
  lines.push(`recipe: ${recipe.client} "${recipe.label}"`);
  lines.push(`  launch: ${recipe.launchCommand}`);
  recipe.steps.forEach((s, i) => {
    const note = "note" in s && s.note ? `  — ${s.note}` : "";
    lines.push(`  ${i + 1}. ${renderStep(s)}${note}`);
  });
  return lines.join("\n");
}

// Injected effects the executor drives. Each is a pure seam so executeRecipe's
// control flow is unit-testable; ensure-window.ts wires the real tmux/readiness/
// registry implementations.
export interface RecipeEffects {
  fireLiteral: (text: string) => Promise<void>;
  sendKey: (key: string) => Promise<void>;
  confirmLine: (needle: string) => Promise<boolean>;
  classify: () => PaneClassification;
  waitExternal: (
    artifact: AgentKind,
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }>;
  // Fire the cooperative self-claim instruction (joinClaim step) into the pane,
  // built from the bound session id. ensure-window wires this to fireKeystrokes
  // of buildJoinInstruction; Claude recipes never invoke it.
  cooperativeJoin: (sessionId: string) => Promise<void>;
  // External confirmation the bound session is now addressable. May poll (it
  // waits out registry-adoption lag), so it returns a promise; a sync boolean is
  // also accepted (tests). MUST be pane-bound, not bare sid presence — see
  // ensure-window.ts isClaimPaneBound (codex P2 BLOCK #2).
  claimCheck: (sessionId: string) => boolean | Promise<boolean>;
  log?: (msg: string) => void;
}

export type RecipeResult =
  | { ok: true; sessionId: string | null }
  | { ok: false; failed: RecipeStep; reason: string; sessionId: string | null };

// Interpret the recipe step-by-step against the effects. The bound session id
// (from waitExternal) flows to claimCheck. ANY gate/await/confirm failure stops
// the recipe and returns the offending step + reason for a loud abort — the
// executor never "best-efforts" past a failed step.
export async function executeRecipe(recipe: Recipe, fx: RecipeEffects): Promise<RecipeResult> {
  let sessionId: string | null = null;
  const log = (m: string) => fx.log?.(`[${recipe.client} ${recipe.label}] ${m}`);
  for (const step of recipe.steps) {
    switch (step.op) {
      case "sendLiteral": {
        log(`send: ${step.text}`);
        await fx.fireLiteral(step.text);
        if (step.confirm) {
          const ok = await fx.confirmLine(step.confirm);
          if (!ok) {
            return {
              ok: false,
              failed: step,
              reason: `confirm needle ${JSON.stringify(step.confirm)} never printed after send`,
              sessionId,
            };
          }
        }
        break;
      }
      case "key": {
        log(`key: ${step.key}`);
        await fx.sendKey(step.key);
        break;
      }
      case "waitExternal": {
        log(`waiting for ${step.artifact} launch artifact`);
        const r = await fx.waitExternal(step.artifact);
        if (!r.ok) {
          return { ok: false, failed: step, reason: r.reason, sessionId };
        }
        sessionId = r.sessionId;
        log(`bound session ${sessionId}`);
        break;
      }
      case "classifyPane": {
        const c = fx.classify();
        if (!step.expect.includes(c.readiness)) {
          return {
            ok: false,
            failed: step,
            reason:
              `pane is "${c.readiness}"${c.reason ? ` (${c.reason})` : ""}, expected one of ` +
              `[${step.expect.join(", ")}]`,
            sessionId,
          };
        }
        break;
      }
      case "joinClaim": {
        if (!sessionId) {
          return {
            ok: false,
            failed: step,
            reason: "joinClaim reached before waitExternal bound a session",
            sessionId,
          };
        }
        log(`firing cooperative self-claim for ${sessionId}`);
        await fx.cooperativeJoin(sessionId);
        break;
      }
      case "claimCheck": {
        if (!sessionId) {
          return {
            ok: false,
            failed: step,
            reason: "claimCheck reached before waitExternal bound a session",
            sessionId,
          };
        }
        if (!(await fx.claimCheck(sessionId))) {
          return {
            ok: false,
            failed: step,
            reason: `session ${sessionId} not resolvable in the oxtail registry yet (adoption did not land)`,
            sessionId,
          };
        }
        log(`claim confirmed for ${sessionId}`);
        break;
      }
      case "abort":
        return { ok: false, failed: step, reason: step.reason, sessionId };
    }
  }
  return { ok: true, sessionId };
}

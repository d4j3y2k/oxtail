// Recipes — a small typed step-DSL describing how to drive a freshly launched
// agent from an empty shell to a confirmed, addressable session. The brittle
// "how" (launch flags, effort/join ceremony, interstitial recovery) lives here
// as VERSIONED CODE rather than in the thin JSON fleet spec, so:
//   • a dry-run can print the EXACT steps before anything mutates a pane, and
//   • the executor is unit-testable against injected effects (no real tmux).
//
// Readiness is binding the session id from EXTERNAL state (a filesystem artifact),
// never a TUI string — but the two clients bind it through DIFFERENT steps because
// their artifact TIMING differs (live-verified):
//   • Claude → `waitExternal`: its SessionStart drop is a LAUNCH-TIME artifact, so a
//     passive launch→watch binds the id.
//   • Codex → `selfJoinClaim`: a fresh Codex writes NO rollout until its first turn,
//     so readiness inverts to stimulus→proof — the join turn creates the rollout we
//     bind from. (See selfJoinClaim below + ensure-window.codexSelfJoin.)
// The remaining steps (sendLiteral/key/classifyPane/claimCheck/abort) carry the
// configuration + external-confirmation ceremony layered on top.

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
  // Codex STIMULUS→PROOF self-join (binds the session id). Unlike Claude — whose
  // SessionStart drop is a LAUNCH-TIME artifact (so its recipe is launch →
  // waitExternal → claimCheck) — a fresh Codex writes NO rollout until its FIRST
  // TURN (live-verified v0.141.0). So readiness can't be a passive watch: the join
  // turn is BOTH the stimulus and the thing that creates the rollout. This step
  // encapsulates the whole bring-up — (optional classifier-accelerated) fire of the
  // self-resolve join (echo $CODEX_THREAD_ID + claim_session), then bind the session
  // id from the rollout that the turn creates (load-bearing: the rollout's
  // new-file+cwd+mtime binding is what ties the claimed thread-id to THIS pane), with
  // bounded re-send if the keystroke missed. Codex-only; Claude never reaches it.
  | { op: "selfJoinClaim"; note?: string }
  // External confirmation that the bound session is now resolvable in oxtail's
  // registry (adoption landed) — not a pane-text check.
  | { op: "claimCheck"; note?: string }
  // CLAUDE-ONLY remote control: after the agent is up + claimed, type the Claude
  // Code `/rc "<rcSession>"` slash command (phone/web access). rcSession is
  // `<tmux-session>-<window>`, baked at build time so the dry-run shows the exact
  // command. Best-effort (a post-success convenience), runs AFTER claimCheck so the
  // TUI is ready for the slash command.
  | { op: "remoteControl"; rcSession: string; note?: string }
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
// pid to this pane. The spec's `model`/`effort` fields ARE the values the
// client's flags accept (the spec author owns them; no hardcoded id mapping
// here) — and they are shell-quoted because they are untrusted spec input.
//
// Effort is a LAUNCH FLAG for BOTH clients (verified against each CLI: `claude
// --help` lists `--effort <level>`; `codex --help` lists `-c <key=value>` and
// ~/.codex/config.toml keys it as `model_reasoning_effort`). So there is NO
// in-TUI chord and no external-verification problem — effort is applied as
// deterministically as the model:
//   • Claude → `--effort <level>`  (first-class flag; low|medium|high|xhigh|max).
//   • Codex  → `-c model_reasoning_effort="<level>"`  (a config override that
//     supersedes ~/.codex/config.toml for THIS launch only; same key the
//     persistent config uses). Codex re-parses the value as TOML, so its
//     injection-safety rests on the spec's effort-token constraint (spec.ts
//     `effortStr` bans `"`/`=`/commas); shellSingleQuote then makes the whole
//     `key="value"` a single shell token. The default fleet sets no Codex effort,
//     so a default-fleet Codex inherits config.toml — this path is for custom
//     specs.
export function buildLaunchCommand(window: FleetWindowSpec): string {
  const base = window.agent === "claude" ? "claude" : "codex";
  const parts = [base];
  if (window.model) parts.push("--model", shellSingleQuote(window.model));
  if (window.effort) {
    if (window.agent === "claude") {
      parts.push("--effort", shellSingleQuote(window.effort));
    } else {
      parts.push("-c", shellSingleQuote(`model_reasoning_effort="${window.effort}"`));
    }
  }
  return parts.join(" ");
}

// The instruction oxpit types into a freshly-spawned Codex as its FIRST TURN to
// make it register itself. SELF-RESOLVE form (not the old explicit-id form): oxpit
// can't read the thread-id before the rollout exists, and the rollout doesn't exist
// until this very turn runs — so Codex supplies its own id. $CODEX_THREAD_ID is
// stripped from the MCP child but PRESENT in a Bash subshell (exactly how the
// /oxtail-join skill works), so the instruction routes through Bash. Phrasing per
// the live Codex peer: terse, do-only-this, no file/edit work, printf the id then
// claim_session with it. The "Registered:" reply is a human/diagnostic tail only —
// oxpit's truth is the registry (claimCheck), never this pane text. Prefer
// CODEX_THREAD_ID; fall back to CODEX_COMPANION_SESSION_ID only if empty.
export function buildSelfJoinInstruction(): string {
  return [
    "oxtail join: do only this. Use Bash to run:",
    `id="$CODEX_THREAD_ID"; [ -n "$id" ] || id="$CODEX_COMPANION_SESSION_ID"; printf '%s\\n' "$id"`,
    "Then call the oxtail MCP tool claim_session with that exact value as session_id.",
    "Do not inspect files or edit code. When claim_session succeeds, reply exactly:",
    "Registered: <session_id>",
  ].join(" ");
}

// The remote-control session name: <tmux-session>-<window>. Both halves are
// already constrained (tmuxSessionName sanitizes the session; windowNameStr bounds
// the window to [A-Za-z0-9_-]), so the result is a clean token — no quoting/
// injection concern when it's typed into the Claude `/rc "<name>"` slash command.
export function buildRcSession(sessionName: string, windowName: string): string {
  return `${sessionName}-${windowName}`;
}

// The Claude Code slash command that enables remote control for a session. Typed
// INTO the TUI (not a shell), so the double-quotes are literal /rc syntax (David's
// exact form: `/rc "session name"`), not shell quoting.
export function buildRcCommand(rcSession: string): string {
  return `/rc "${rcSession}"`;
}

// The SPAWN/RESET recipe per window. The two clients have FUNDAMENTALLY DIFFERENT
// readiness shapes (live-verified):
//   • Claude — SessionStart drop is a LAUNCH-TIME artifact + the hook auto-joins, so:
//       launch → waitExternal(drop binds id) → claimCheck.
//   • Codex — writes NO rollout until its first turn, and has no auto-join, so a
//     passive waitExternal would deadlock (the rollout it waits for is created by the
//     join it hasn't sent yet). Its recipe inverts to stimulus→proof:
//       launch → selfJoinClaim(fire the join turn → bind id from the rollout it
//       creates) → claimCheck.
// selfJoinClaim absorbs Codex's readiness (no separate waitExternal): the join IS the
// stimulus and the rollout it produces IS the bound-id proof. claimCheck stays the
// final registry truth for both.
//
// remoteControl (Claude-only) appends an `/rc "<session>-<window>"` step AFTER
// claimCheck (so the TUI is up). sessionName is needed to bake the exact rc name
// into the step (for the dry-run + the effect); absent it (a bare buildRecipe call),
// a "<session>" placeholder is used — real SPAWN/RESET always pass it.
export function buildRecipe(window: FleetWindowSpec, opts: { sessionName?: string } = {}): Recipe {
  const launchCommand = buildLaunchCommand(window);
  const steps: RecipeStep[] = [
    { op: "sendLiteral", text: launchCommand, note: "launch into the empty shell" },
  ];
  if (window.agent === "codex") {
    steps.push({ op: "selfJoinClaim", note: "fire the join turn; bind id from the rollout it creates" });
  } else {
    steps.push({ op: "waitExternal", artifact: window.agent, note: "bind session via launch artifact" });
  }
  steps.push({ op: "claimCheck", note: "confirm the bound session is registry-resolvable" });
  if (window.remoteControl && window.agent === "claude") {
    const rcSession = buildRcSession(opts.sessionName ?? "<session>", window.name);
    steps.push({ op: "remoteControl", rcSession, note: "enable remote control (phone/web access)" });
  }
  return {
    client: window.agent,
    label: window.role ? `${window.name} (${window.role})` : window.name,
    launchCommand,
    steps,
  };
}

// Map a whole fleet spec to per-window recipes (SPAWN runs ensure_window over
// these in order). Pure — for dry-run and SPAWN planning. (Wrap buildRecipe in an
// arrow — a bare `.map(buildRecipe)` would pass the array INDEX as opts.)
export function recipesForFleet(
  spec: { windows: FleetWindowSpec[] },
  opts: { sessionName?: string } = {},
): Recipe[] {
  return spec.windows.map((w) => buildRecipe(w, opts));
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
    case "selfJoinClaim":
      return `selfJoinClaim (Codex: fire join-turn → bind id from the rollout it creates, accelerator-gated + bounded re-send)`;
    case "claimCheck":
      return `claimCheck`;
    case "remoteControl":
      return `remoteControl ${buildRcCommand(s.rcSession)} (best-effort)`;
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
  // Run the whole Codex self-join bring-up and BIND the session id (selfJoinClaim
  // step). ensure-window wires this to: (optional classifier-accelerated) fire of
  // buildSelfJoinInstruction → poll the rollout the turn creates, bound to this pane
  // → bounded re-send if it didn't land → return the rollout-derived session id.
  // Claude recipes never invoke it. Returns a pane dump on failure for a loud abort.
  selfJoinClaim: () => Promise<
    { ok: true; sessionId: string } | { ok: false; reason: string; dump?: string }
  >;
  // External confirmation the bound session is now addressable. May poll (it
  // waits out registry-adoption lag), so it returns a promise; a sync boolean is
  // also accepted (tests). MUST be pane-bound, not bare sid presence — see
  // ensure-window.ts isClaimPaneBound (codex P2 BLOCK #2).
  claimCheck: (sessionId: string) => boolean | Promise<boolean>;
  // Fire the Claude `/rc "<rcSession>"` slash command (remoteControl step). Claude-
  // only; best-effort (see executeRecipe). ensure-window wires it to fireKeystrokes.
  remoteControl?: (rcSession: string) => Promise<void>;
  log?: (msg: string) => void;
}

export type RecipeResult =
  | { ok: true; sessionId: string | null }
  | { ok: false; failed: RecipeStep; reason: string; sessionId: string | null; dump?: string };

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
      case "selfJoinClaim": {
        // BINDS the session — the join turn both runs the claim AND creates the
        // rollout we read the id from (so, unlike Claude's waitExternal, there is no
        // pre-bound session to require here; this step is what produces it).
        log("firing Codex self-join turn; binding session from the rollout it creates");
        const r = await fx.selfJoinClaim();
        if (!r.ok) {
          return { ok: false, failed: step, reason: r.reason, sessionId, dump: r.dump };
        }
        sessionId = r.sessionId;
        log(`bound session ${sessionId}`);
        break;
      }
      case "claimCheck": {
        if (!sessionId) {
          return {
            ok: false,
            failed: step,
            reason: "claimCheck reached before a session was bound (waitExternal/selfJoinClaim)",
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
      case "remoteControl": {
        // BEST-EFFORT: the agent is already up + claimed (the launch SUCCEEDED), so a
        // remote-control hiccup must NOT fail the recipe — it's a phone-access
        // convenience that's not externally verifiable. Fire and continue; log a
        // warning on a send error so it's visible without aborting a good launch.
        try {
          await fx.remoteControl?.(step.rcSession);
          log(`remote control enabled: ${buildRcCommand(step.rcSession)}`);
        } catch (e) {
          log(`remote control send failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
        }
        break;
      }
      case "abort":
        return { ok: false, failed: step, reason: step.reason, sessionId };
    }
  }
  return { ok: true, sessionId };
}

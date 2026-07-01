// The thin per-project fleet spec: WHICH windows make up a fleet (name + agent +
// model/effort/role), nothing about HOW to launch them (that brittle layer lives
// in recipes.ts as versioned code). Resolved from `.oxtail/fleet.json` (JSONC —
// the repo has no YAML dep) with a clear precedence:
//   1. <repoRoot>/.oxtail/fleet.json   (per-project)
//   2. ~/.oxtail/fleet.json            (global default)
//   3. the built-in DEFAULT_WINDOWS    (main/max/codex)
//
// An ABSENT file at a level falls through to the next; a file that EXISTS but is
// malformed ERRORS (never silently runs a default the operator didn't intend).
// Validation is zod, and string fields reject control characters — both for
// operator sanity and because a window name carrying the U+001F field separator
// would corrupt ownership.ts's list-panes parsing (codex P2 follow-up).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { z } from "zod";
import type { FleetSpec } from "./types.js";

// Non-empty and free of control characters (incl. U+001F, the ownership FS
// separator, and DEL) — printable content only.
const safeStr = z
  .string()
  .regex(/^[^\u0000-\u001f\u007f]+$/, "must be non-empty and free of control characters");

// Effort is the ONE spec field interpolated into a value that gets re-parsed
// downstream: Codex applies it via `-c model_reasoning_effort="<level>"`, which
// Codex reads as TOML. The whole launch token is also shell-single-quoted
// (recipes.ts), so SHELL injection is closed there — but the value still reaches
// Codex's TOML parser, where an embedded `"` could break out of the string and
// inject OTHER config keys (TOML injection, distinct from shell injection). So
// constrain effort to the level-token SHAPE — lowercase letters + hyphen — which
// makes quotes / `=` / commas / whitespace structurally impossible, rather than
// an exact enum so a future level (e.g. "ultra") needs no code bump. Real
// levels: low, medium, high, xhigh, max (Claude); minimal..xhigh (Codex).
const effortStr = z
  .string()
  .regex(
    /^[a-z][a-z-]{0,23}$/,
    "effort must be a lowercase level token (e.g. low, medium, high, xhigh, max)",
  );

// A window name is the ONE spec field used RAW in tmux target syntax —
// `${session}:${windowName}` (spawn.ts paneForWindow, ensure-window probes) and
// `new-window -n <name>` — AND it flows through ownership.ts's `-F` listing. So,
// unlike the fleet `name` (which tmuxSessionName SANITIZES at use), it must be
// both TMUX-TARGET-safe (no `:`/`.` — the session:window / window.pane
// separators; no leading `@`/`%`/`=` target-id prefixes) and SENTINEL-safe (no
// `\` — a literal "\037" would be mis-read as the normalized 0x1F field
// separator). Constrain to a conservative label charset and REJECT (not
// sanitize), so two distinct specs can't silently collapse to one tmux window.
// This is what makes arbitrary custom .oxtail/fleet.json specs live-spawn-safe
// (codex P5 review). Note: the ownership PARSER stays space/`:`-tolerant for
// reading a HUMAN's arbitrarily-named panes — only the panes WE spawn are bounded.
const windowNameStr = z
  .string()
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_-]{0,39}$/,
    "window name must be a tmux-safe label: start with a letter/digit/_, then letters/digits/_/- only (no :/./backslash/spaces)",
  );

const WindowSchema = z
  .object({
    name: windowNameStr,
    agent: z.enum(["claude", "codex"]),
    model: safeStr.optional(),
    effort: effortStr.optional(),
    role: safeStr.optional(),
    // CLAUDE-ONLY remote-control toggle (the /rc slash command). Rejected on codex
    // below — /rc is a Claude Code command.
    remoteControl: z.boolean().optional(),
  })
  // Fail fast on a meaningless config rather than silently ignoring it.
  .refine((w) => !(w.remoteControl && w.agent !== "claude"), {
    message: "remoteControl is Claude-only (the /rc command doesn't exist for codex)",
  });

const FleetSchema = z
  .object({
    name: safeStr,
    windows: z.array(WindowSchema).min(1, "a fleet needs at least one window"),
  })
  .refine((s) => new Set(s.windows.map((w) => w.name)).size === s.windows.length, {
    message: "window names must be unique (they map to tmux window names)",
  });

// The standing fleet (David's roles): main captain + max big-brain + codex. The
// fleet NAME is derived per-load from the repo basename so two repos don't share
// a tmux session / ownership fleetId; only the WINDOWS are constant here.
//
// EFFORT is asymmetric BY DESIGN, respecting each client's idiom (max Q2): the
// Claude windows PIN effort explicitly because Claude has no persistent effort
// config — the spec is its only home, and it's exactly what distinguishes
// main=xhigh from max=max. The codex window deliberately OMITS effort, so it is
// NOT pinned to a level for everyone: a spawned codex runs at the operator's OWN
// ~/.codex/config.toml level (this fleet's box happens to be xhigh there).
// Injecting `-c model_reasoning_effort` by default would shadow the user's own
// config — surprising — so "your codex, your config.toml" is the default.
// model values MUST be what each client's `--model` flag accepts (LIVE-verified):
// Claude wants an ALIAS ('opus'/'sonnet'/…) or a full id, NOT a "opus-4.8"-style
// label (that errors "issue with the selected model"). `opus[1m]` = the standing
// fleet's actual config (latest Opus + 1M context, version-robust); the `[1m]` is
// why buildLaunchCommand shell-quotes the model (the brackets are shell globs).
// Codex's `--model gpt-5.5` is the full model name it accepts.
//
// remoteControl is ON for the claude windows because it's part of the standing
// ceremony oxpit automates away ("…effort + remote-control + oxtail-join"): each
// spawned claude fires `/rc "<session>-<window>"` so David can reach it from his
// phone. Codex has no /rc, so it's omitted there. It's shown in the SPAWN plan and
// overridable per-window (set false in a .oxtail/fleet.json).
const DEFAULT_WINDOWS: FleetSpec["windows"] = [
  { name: "main", agent: "claude", model: "opus[1m]", effort: "xhigh", role: "captain", remoteControl: true },
  { name: "max", agent: "claude", model: "opus[1m]", effort: "max", remoteControl: true },
  { name: "codex", agent: "codex", model: "gpt-5.5" },
];

export function defaultFleet(repoRoot?: string): FleetSpec {
  const name = (repoRoot ? basename(repoRoot) : "") || "fleet";
  return { name, windows: DEFAULT_WINDOWS.map((w) => ({ ...w })) };
}

// Curated model options for the in-TUI editor's picker — so a user doesn't have to
// KNOW an exact `--model` id (the opus-4.8 trap). Claude values are LIVE-verified
// aliases (`claude --model X`): opus[1m] (latest Opus + 1M context, the standing
// fleet), opus, sonnet, haiku, fable (Fable 5 — the creative-tier Claude 5 model,
// back online + `claude --model fable` verified 2026-07-01). (sonnet[1m]/haiku[1m]
// need 1M-context usage credits, so only opus carries the [1m] variant here.) Codex
// is conservative — gpt-5.5 is the verified default; add more as they're confirmed. A
// custom value in a hand-edited config still works (the editor preserves it); these
// are just the menu.
export const CLAUDE_MODELS = ["opus[1m]", "opus", "sonnet", "haiku", "fable"] as const;
export const CODEX_MODELS = ["gpt-5.5"] as const;

export function modelOptionsForAgent(agent: "claude" | "codex"): string[] {
  return [...(agent === "claude" ? CLAUDE_MODELS : CODEX_MODELS)];
}

export function projectFleetConfigPath(repoRoot: string): string {
  return join(repoRoot, ".oxtail", "fleet.json");
}

// Scaffold a project .oxtail/fleet.json from `spec` (the operator's starting point
// to edit) — the "easy config" entry: the SPAWN overlay's `w` key writes the
// effective spec so you don't author JSON from scratch. REFUSES to clobber an
// existing config (edit it directly). The leading comment is JSONC-legal (the
// loader uses jsonc-parser).
// Validate an IN-MEMORY spec (what the in-TUI editor builds) against the same zod
// schema the file loader uses — name uniqueness, tmux-safe window names, valid
// effort tokens, claude-only remoteControl, etc. So the editor can refuse to spawn
// or save an invalid fleet with the same messages a bad .oxtail/fleet.json gets.
export function validateFleetSpec(
  data: unknown,
): { ok: true; spec: FleetSpec } | { ok: false; error: string } {
  const parsed = FleetSchema.safeParse(data);
  if (!parsed.success) return { ok: false, error: formatZodError(parsed.error) };
  return { ok: true, spec: parsed.data };
}

export function writeFleetScaffold(
  repoRoot: string,
  spec: FleetSpec,
  opts: { overwrite?: boolean } = {},
): { ok: true; path: string } | { ok: false; reason: string } {
  const path = projectFleetConfigPath(repoRoot);
  if (!opts.overwrite && existsSync(path)) {
    return { ok: false, reason: `a config already exists at ${path} — edit it directly` };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const header =
      "// oxpit fleet spec — edit freely, then re-run SPAWN. windows[]: name, agent\n" +
      "// (claude|codex), model, effort, role, remoteControl (claude-only).\n";
    writeFileSync(path, header + JSON.stringify(spec, null, 2) + "\n");
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: `could not write ${path}: ${String(e)}` };
  }
}

// Lazy homedir() each call (mirrors registry/mailbox dir helpers) so tests can
// swap HOME.
export function globalFleetConfigPath(base: string = homedir()): string {
  return join(base, ".oxtail", "fleet.json");
}

export type FleetConfigSource = "project" | "global" | "default";

export type LoadFleetResult =
  | { ok: true; spec: FleetSpec; source: FleetConfigSource; path: string | null }
  | { ok: false; source: Exclude<FleetConfigSource, "default">; path: string; error: string };

function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

function loadFrom(path: string, source: Exclude<FleetConfigSource, "default">): LoadFleetResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, source, path, error: `cannot read: ${String(e)}` };
  }
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    const msgs = errors.map((e) => `${printParseErrorCode(e.error)} @${e.offset}`).join("; ");
    return { ok: false, source, path, error: `JSONC parse error(s): ${msgs}` };
  }
  const parsed = FleetSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, source, path, error: `invalid fleet spec — ${formatZodError(parsed.error)}` };
  }
  return { ok: true, spec: parsed.data, source, path };
}

// Resolve the fleet spec for a repo. project > global > built-in default. An
// existing-but-malformed file errors at its level (does NOT fall through), so a
// typo can't silently spawn the wrong fleet.
export function loadFleetConfig(repoRoot: string, opts: { home?: string } = {}): LoadFleetResult {
  const projectPath = projectFleetConfigPath(repoRoot);
  if (existsSync(projectPath)) return loadFrom(projectPath, "project");
  const globalPath = globalFleetConfigPath(opts.home);
  if (existsSync(globalPath)) return loadFrom(globalPath, "global");
  return { ok: true, spec: defaultFleet(repoRoot), source: "default", path: null };
}

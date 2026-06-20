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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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

const WindowSchema = z.object({
  name: windowNameStr,
  agent: z.enum(["claude", "codex"]),
  model: safeStr.optional(),
  effort: effortStr.optional(),
  role: safeStr.optional(),
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
const DEFAULT_WINDOWS: FleetSpec["windows"] = [
  { name: "main", agent: "claude", model: "opus-4.8", effort: "xhigh", role: "captain" },
  { name: "max", agent: "claude", model: "opus-4.8", effort: "max" },
  { name: "codex", agent: "codex", model: "gpt-5.5" },
];

export function defaultFleet(repoRoot?: string): FleetSpec {
  const name = (repoRoot ? basename(repoRoot) : "") || "fleet";
  return { name, windows: DEFAULT_WINDOWS.map((w) => ({ ...w })) };
}

export function projectFleetConfigPath(repoRoot: string): string {
  return join(repoRoot, ".oxtail", "fleet.json");
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

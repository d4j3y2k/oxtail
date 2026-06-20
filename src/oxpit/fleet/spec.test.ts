import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultFleet, loadFleetConfig, validateFleetSpec, writeFleetScaffold } from "./spec.js";

function withDirs<T>(fn: (repoRoot: string, home: string) => T): T {
  const repoRoot = mkdtempSync(join(tmpdir(), "oxtail-spec-repo-"));
  const home = mkdtempSync(join(tmpdir(), "oxtail-spec-home-"));
  try {
    return fn(repoRoot, home);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

function writeConfig(root: string, contents: string): void {
  mkdirSync(join(root, ".oxtail"), { recursive: true });
  writeFileSync(join(root, ".oxtail", "fleet.json"), contents);
}

const VALID = JSON.stringify({
  name: "demo",
  windows: [
    { name: "main", agent: "claude", model: "opus[1m]", effort: "xhigh", role: "captain" },
    { name: "codex", agent: "codex", model: "gpt-5.5" },
  ],
});

// ── defaults ───────────────────────────────────────────────────────────────────

test("defaultFleet is main/max/codex, named from the repo basename", () => {
  const f = defaultFleet("/Users/dev/myrepo");
  assert.equal(f.name, "myrepo");
  assert.deepEqual(f.windows.map((w) => w.name), ["main", "max", "codex"]);
  assert.equal(f.windows[0].role, "captain");
  assert.equal(f.windows[2].agent, "codex");
});

test("defaultFleet falls back to 'fleet' with no repoRoot", () => {
  assert.equal(defaultFleet().name, "fleet");
});

// ── resolution precedence ──────────────────────────────────────────────────────

test("no config anywhere → built-in default", () => {
  withDirs((repoRoot, home) => {
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.source, "default");
      assert.equal(r.path, null);
      assert.equal(r.spec.windows.length, 3);
    }
  });
});

test("project config wins over global", () => {
  withDirs((repoRoot, home) => {
    writeConfig(home, JSON.stringify({ name: "GLOBAL", windows: [{ name: "g", agent: "claude" }] }));
    writeConfig(repoRoot, VALID);
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.source, "project");
      assert.equal(r.spec.name, "demo");
    }
  });
});

test("global config used when there is no project config", () => {
  withDirs((repoRoot, home) => {
    writeConfig(home, VALID);
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.source, "global");
  });
});

// ── JSONC + validation ─────────────────────────────────────────────────────────

test("JSONC comments and trailing commas are accepted", () => {
  withDirs((repoRoot, home) => {
    writeConfig(
      repoRoot,
      `{
        // the captain
        "name": "demo",
        "windows": [
          { "name": "main", "agent": "claude" }, // trailing comma below
        ],
      }`,
    );
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.spec.windows[0].name, "main");
  });
});

test("an EXISTING but malformed config ERRORS — never silently falls to default", () => {
  withDirs((repoRoot, home) => {
    writeConfig(repoRoot, `{ "name": "x", "windows": [ { "name": "a" `); // unterminated
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.source, "project");
      assert.match(r.error, /parse error/i);
    }
  });
});

test("schema violations are reported (bad agent, empty windows, missing name)", () => {
  withDirs((repoRoot, home) => {
    const cases: string[] = [
      JSON.stringify({ name: "x", windows: [] }), // empty
      JSON.stringify({ name: "x", windows: [{ name: "a", agent: "gpt" }] }), // bad enum
      JSON.stringify({ windows: [{ name: "a", agent: "claude" }] }), // missing name
    ];
    for (const c of cases) {
      writeConfig(repoRoot, c);
      const r = loadFleetConfig(repoRoot, { home });
      assert.equal(r.ok, false, c);
      if (!r.ok) assert.match(r.error, /invalid fleet spec/);
    }
  });
});

test("duplicate window names are rejected (they map to tmux window names)", () => {
  withDirs((repoRoot, home) => {
    writeConfig(
      repoRoot,
      JSON.stringify({ name: "x", windows: [{ name: "main", agent: "claude" }, { name: "main", agent: "codex" }] }),
    );
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /unique/);
  });
});

test("a control character in a window name is rejected (FS-separator safety)", () => {
  withDirs((repoRoot, home) => {
    // U+001F is ownership.ts's field separator — a name carrying it would corrupt
    // list-panes parsing. Built via fromCharCode so no literal control char in source.
    const badName = "ma" + String.fromCharCode(0x1f) + "in";
    writeConfig(repoRoot, JSON.stringify({ name: "x", windows: [{ name: badName, agent: "claude" }] }));
    const r = loadFleetConfig(repoRoot, { home });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /tmux-safe label/);
  });
});

test("a tmux-UNSAFE window name is rejected (target + sentinel safety, codex P5)", () => {
  withDirs((repoRoot, home) => {
    // `:`/`.` break `${session}:${window}` and window.pane targets; `\` could form a
    // literal "\037" the ownership parser would mis-read as the field separator;
    // leading @/%/= are tmux target-id prefixes; spaces/punct aren't label-safe; a
    // window name is used RAW (unlike the sanitized fleet `name`).
    const bad = ["ma:in", "ma.in", "ma\\in", "@main", "%0", "=main", "my window", "-main", "main!", ""];
    for (const name of bad) {
      writeConfig(repoRoot, JSON.stringify({ name: "x", windows: [{ name, agent: "claude" }] }));
      const r = loadFleetConfig(repoRoot, { home });
      assert.equal(r.ok, false, `window name ${JSON.stringify(name)} should be rejected`);
      if (!r.ok) assert.match(r.error, /invalid fleet spec/);
    }
  });
});

test("valid tmux-safe window names are accepted", () => {
  withDirs((repoRoot, home) => {
    for (const name of ["main", "max", "codex", "code_review", "agent-1", "M2"]) {
      writeConfig(repoRoot, JSON.stringify({ name: "x", windows: [{ name, agent: "claude" }] }));
      const r = loadFleetConfig(repoRoot, { home });
      assert.equal(r.ok, true, `window name ${name} should be accepted`);
    }
  });
});

test("valid effort level tokens are accepted", () => {
  withDirs((repoRoot, home) => {
    for (const lvl of ["low", "medium", "high", "xhigh", "max", "minimal"]) {
      writeConfig(
        repoRoot,
        JSON.stringify({ name: "x", windows: [{ name: "main", agent: "claude", effort: lvl }] }),
      );
      const r = loadFleetConfig(repoRoot, { home });
      assert.equal(r.ok, true, `effort ${lvl} should be accepted`);
    }
  });
});

test("a hostile effort value is rejected — no Codex `-c` TOML/shell injection", () => {
  withDirs((repoRoot, home) => {
    // Effort flows into Codex's `-c model_reasoning_effort="<v>"` override, which
    // Codex re-parses as TOML; a value bearing a quote/comma could inject OTHER
    // config keys. The level-token shape bans every metacharacter, so the attack
    // surface is closed at the spec boundary (defense-in-depth with the shell
    // quoting in recipes.ts). Also rejects uppercase / underscores / empty.
    const hostile = [
      `xhigh"`,
      `high", model="evil`,
      `max ; rm -rf ~`,
      `x=y`,
      `UP`,
      `x_y`,
      ``,
    ];
    for (const bad of hostile) {
      writeConfig(
        repoRoot,
        JSON.stringify({ name: "x", windows: [{ name: "main", agent: "claude", effort: bad }] }),
      );
      const r = loadFleetConfig(repoRoot, { home });
      assert.equal(r.ok, false, `effort ${JSON.stringify(bad)} should be rejected`);
      if (!r.ok) assert.match(r.error, /invalid fleet spec/);
    }
  });
});

// ── remoteControl (Claude-only /rc toggle) ───────────────────────────────────────

test("remoteControl is accepted on a claude window, rejected on a codex window", () => {
  withDirs((repoRoot, home) => {
    writeConfig(
      repoRoot,
      JSON.stringify({ name: "x", windows: [{ name: "main", agent: "claude", remoteControl: true }] }),
    );
    const okR = loadFleetConfig(repoRoot, { home });
    assert.equal(okR.ok, true, "claude + remoteControl is valid");

    writeConfig(
      repoRoot,
      JSON.stringify({ name: "x", windows: [{ name: "codex", agent: "codex", remoteControl: true }] }),
    );
    const badR = loadFleetConfig(repoRoot, { home });
    assert.equal(badR.ok, false, "codex + remoteControl must be rejected (no /rc for codex)");
    if (!badR.ok) assert.match(badR.error, /Claude-only/);
  });
});

test("defaultFleet enables remoteControl on the claude windows, not codex", () => {
  const f = defaultFleet("/Users/dev/myrepo");
  const byName = Object.fromEntries(f.windows.map((w) => [w.name, w]));
  assert.equal(byName.main.remoteControl, true, "main (claude) has rc on — part of the ceremony");
  assert.equal(byName.max.remoteControl, true, "max (claude) has rc on");
  assert.notEqual(byName.codex.remoteControl, true, "codex has no /rc");
});

// ── writeFleetScaffold (the "easy config" entry — `w` in the SPAWN overlay) ──────

test("writeFleetScaffold writes a loadable .oxtail/fleet.json, then refuses to clobber", () => {
  withDirs((repoRoot, home) => {
    const spec = defaultFleet(repoRoot);
    const w = writeFleetScaffold(repoRoot, spec);
    assert.equal(w.ok, true, "scaffolds when absent");

    // It round-trips: the loader reads it back as a project config (JSONC header ok).
    const loaded = loadFleetConfig(repoRoot, { home });
    assert.equal(loaded.ok, true);
    if (loaded.ok) {
      assert.equal(loaded.source, "project");
      assert.deepEqual(loaded.spec.windows.map((win) => win.name), ["main", "max", "codex"]);
      assert.equal(loaded.spec.windows[0].remoteControl, true, "scaffold preserves rc");
    }

    // Second call refuses to overwrite an existing config.
    const again = writeFleetScaffold(repoRoot, spec);
    assert.equal(again.ok, false, "must not clobber an existing config");
    if (!again.ok) assert.match(again.reason, /already exists/);

    // …but the editor's explicit save (overwrite:true) DOES replace it.
    const forced = writeFleetScaffold(repoRoot, { ...spec, name: "renamed" }, { overwrite: true });
    assert.equal(forced.ok, true, "overwrite:true replaces an existing config");
    const reloaded = loadFleetConfig(repoRoot, { home });
    if (reloaded.ok) assert.equal(reloaded.spec.name, "renamed");
  });
});

test("validateFleetSpec accepts a good in-memory spec, rejects bad ones (editor's gate)", () => {
  const good = validateFleetSpec({
    name: "demo",
    windows: [
      { name: "main", agent: "claude", model: "opus[1m]", effort: "xhigh", remoteControl: true },
      { name: "codex", agent: "codex", model: "gpt-5.5" },
    ],
  });
  assert.equal(good.ok, true);

  for (const bad of [
    { name: "x", windows: [] }, // empty
    { name: "x", windows: [{ name: "a", agent: "claude" }, { name: "a", agent: "codex" }] }, // dup names
    { name: "x", windows: [{ name: "a", agent: "codex", remoteControl: true }] }, // rc on codex
    { name: "x", windows: [{ name: "a", agent: "claude", effort: "MAX" }] }, // bad effort token
  ]) {
    const r = validateFleetSpec(bad);
    assert.equal(r.ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

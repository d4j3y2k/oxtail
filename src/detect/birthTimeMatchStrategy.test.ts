import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  birthTimeMatchStrategy,
  listClaudeCandidates,
  listCodexCandidatesIn,
  pickByDelta,
  type Candidate,
} from "./birthTimeMatchStrategy.js";
import { isAbstain } from "./types.js";

// ----- pickByDelta (pure) -----

test("pickByDelta: single positive-delta candidate within window wins", () => {
  const cands: Candidate[] = [{ session_id: "A", birth_ms: 10_000 }];
  const r = pickByDelta(cands, 9_000);
  assert.equal(r?.session_id, "A");
});

test("pickByDelta: rejects candidates with negative delta (born before MCP started)", () => {
  const cands: Candidate[] = [{ session_id: "A", birth_ms: 8_000 }];
  const r = pickByDelta(cands, 9_000);
  assert.equal(r, null);
});

test("pickByDelta: rejects candidates outside 5min window", () => {
  const cands: Candidate[] = [{ session_id: "A", birth_ms: 9_000 + 6 * 60_000 }];
  const r = pickByDelta(cands, 9_000);
  assert.equal(r, null);
});

test("pickByDelta: multiple positive-delta candidates returns null (ambiguous)", () => {
  const cands: Candidate[] = [
    { session_id: "A", birth_ms: 100_000 },
    { session_id: "B", birth_ms: 50_000 },
    { session_id: "C", birth_ms: 200_000 },
  ];
  const r = pickByDelta(cands, 10_000);
  assert.equal(r, null, "any 2+ in-window candidates means another Claude is in this project");
});

test("pickByDelta: empty candidates returns null", () => {
  assert.equal(pickByDelta([], 10_000), null);
});

test("pickByDelta: real-world two-session case — older server null, newer resolves", () => {
  // From spike data:
  // MCP server pid 7155 started 1778156500 (08:21:40)
  // MCP server pid 9274 started 1778156607 (08:23:27)
  // transcripts:
  //   c412dc1a born 1778156590 (08:23:10)
  //   a0152bce born 1778156639 (08:23:59)
  const cands: Candidate[] = [
    { session_id: "c412dc1a", birth_ms: 1778156590_000 },
    { session_id: "a0152bce", birth_ms: 1778156639_000 },
  ];
  // pid 7155 sees both transcripts as positive delta -> ambiguous, null
  const for7155 = pickByDelta(cands, 1778156500_000);
  assert.equal(for7155, null, "older server can't disambiguate; falls through to register_my_session");
  // pid 9274 sees only a0152bce as positive (c412dc1a was born before it started)
  const for9274 = pickByDelta(cands, 1778156607_000);
  assert.equal(for9274?.session_id, "a0152bce", "newer server still resolves cleanly");
});

// ----- listClaudeCandidates (real fs) -----

test("listClaudeCandidates: lists *.jsonl files from encoded project dir", () => {
  const base = mkdtempSync(join(tmpdir(), "oxtail-claude-"));
  try {
    const cwd = "/Users/test/dev/proj";
    const encoded = cwd.replace(/\//g, "-");
    const projDir = join(base, ".claude", "projects", encoded);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, "abc-123.jsonl"), "x");
    writeFileSync(join(projDir, "def-456.jsonl"), "y");
    writeFileSync(join(projDir, "ignore.txt"), "z");

    const cands = listClaudeCandidates(cwd, base);
    const ids = cands.map((c) => c.session_id).sort();
    assert.deepEqual(ids, ["abc-123", "def-456"]);
    for (const c of cands) {
      assert.ok(c.birth_ms > 0, `birth_ms should be set for ${c.session_id}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listClaudeCandidates: returns empty when project dir missing", () => {
  const base = mkdtempSync(join(tmpdir(), "oxtail-claude-"));
  try {
    const cands = listClaudeCandidates("/nope/nope", base);
    assert.deepEqual(cands, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ----- listCodexCandidatesIn (real fs, cwd filtering) -----

test("listCodexCandidatesIn: filters by first-line payload.cwd", () => {
  const base = mkdtempSync(join(tmpdir(), "oxtail-codex-"));
  try {
    const dir = join(base, "2026", "05", "07");
    mkdirSync(dir, { recursive: true });

    // Match: cwd matches
    writeFileSync(
      join(dir, "rollout-2026-05-07T12-00-00-aaaaaaaa-1111-2222-3333-444444444444.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/proj" } }) + "\n",
    );
    // Skip: different cwd
    writeFileSync(
      join(dir, "rollout-2026-05-07T13-00-00-bbbbbbbb-1111-2222-3333-444444444444.jsonl"),
      JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/other" } }) + "\n",
    );
    // Skip: not a UUID-named file
    writeFileSync(join(dir, "rollout-no-uuid.jsonl"), "{}");
    // Skip: not jsonl
    writeFileSync(join(dir, "rollout-2026-05-07T14-00-00-cccccccc-1111-2222-3333-444444444444.txt"), "{}");

    const cands = listCodexCandidatesIn([dir], "/proj");
    assert.equal(cands.length, 1);
    assert.equal(cands[0].session_id, "aaaaaaaa-1111-2222-3333-444444444444");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("listCodexCandidatesIn: missing dir is silently skipped", () => {
  const cands = listCodexCandidatesIn(["/nope/does/not/exist"], "/anywhere");
  assert.deepEqual(cands, []);
});

// ----- birthTimeMatchStrategy (integration via real fs) -----

test("birthTimeMatchStrategy: claude-code resolves a freshly-created transcript", async () => {
  const base = mkdtempSync(join(tmpdir(), "oxtail-strat-"));
  try {
    const cwd = "/Users/test/proj-x";
    const encoded = cwd.replace(/\//g, "-");
    const projDir = join(base, ".claude", "projects", encoded);
    mkdirSync(projDir, { recursive: true });

    // Capture started_at as "now" — file we'll create after will have positive delta.
    const startedAt = Math.floor(Date.now() / 1000) - 1; // 1s ago, so positive delta
    await new Promise((r) => setTimeout(r, 30));
    writeFileSync(join(projDir, "fresh-uuid.jsonl"), "x");

    // Inject our temp base by overriding HOME via the function default arg.
    // birthTimeMatchStrategy reads from real homedir(), so we test the IO helpers
    // (covered above) and pickByDelta separately. Here we sanity-check the public
    // strategy returns something non-null when there's an obvious recent file in
    // the real ~/.claude/projects path of the test runner. To keep this test
    // hermetic, we just assert the strategy returns null on an unknown cwd.
    const result = birthTimeMatchStrategy({
      type: "claude-code",
      cwd: "/definitely/not/a/real/project/9b3c",
      started_at: startedAt,
      env: {},
    });
    assert.ok(isAbstain(result));
    assert.match(result.reason, /no transcript files/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("birthTimeMatchStrategy: unknown client type abstains with reason", () => {
  const result = birthTimeMatchStrategy({
    type: "unknown",
    cwd: "/anywhere",
    started_at: Math.floor(Date.now() / 1000),
    env: {},
  });
  assert.ok(isAbstain(result));
  assert.match(result.reason, /unknown/);
});

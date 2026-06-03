#!/usr/bin/env node
// Issue #7 — drift detector for Codex's paste-burst window.
//
// oxtail's Codex wake inserts a 500ms gap (ASK_PEER_CODEX_SUBMIT_DELAY_MS)
// between the typed wake text and Enter, to outlast Codex's paste-burst
// PASTE_ENTER_SUPPRESS_WINDOW — a private constant tested at 120ms. If Codex
// bumps that window past our gap in a future release, our wake silently
// regresses to "Enter gets swallowed" with no signal pointing at the cause.
//
// This script fetches the upstream constant and exits non-zero if it changed
// (or moved/renamed). Run on a schedule (see .github/workflows/codex-drift.yml)
// so drift surfaces as a failing job rather than a silent field regression.

const URL =
  "https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/bottom_pane/paste_burst.rs";
const EXPECTED_MS = 120; // value oxtail's 500ms gap was verified against
const OUR_GAP_MS = 500; // ASK_PEER_CODEX_SUBMIT_DELAY_MS in src/server.ts

async function fetchSource(attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw lastErr;
}

let src;
try {
  src = await fetchSource();
} catch (e) {
  console.error(`drift-check: could not fetch paste_burst.rs (${e?.message ?? e}). Transient — re-run.`);
  process.exit(2);
}

const m = src.match(/PASTE_ENTER_SUPPRESS_WINDOW[\s\S]{0,120}?from_millis\((\d+)\)/);
if (!m) {
  console.error(
    "drift-check: PASTE_ENTER_SUPPRESS_WINDOW / from_millis(...) not found upstream — Codex may have renamed or restructured the paste-burst logic. Re-verify oxtail's Codex wake gap (ASK_PEER_CODEX_SUBMIT_DELAY_MS) by hand.",
  );
  process.exit(1);
}

const ms = Number(m[1]);
if (ms !== EXPECTED_MS) {
  const stillSafe = ms < OUR_GAP_MS;
  console.error(
    `drift-check: PASTE_ENTER_SUPPRESS_WINDOW changed ${EXPECTED_MS}ms -> ${ms}ms. ` +
      `oxtail's gap is ${OUR_GAP_MS}ms — ` +
      (stillSafe
        ? "still larger, so wake should still submit, but update EXPECTED_MS here once re-verified."
        : "NO LONGER LARGER: Codex wake will regress (Enter swallowed). Bump ASK_PEER_CODEX_SUBMIT_DELAY_MS in src/server.ts."),
  );
  process.exit(1);
}

console.log(`drift-check: PASTE_ENTER_SUPPRESS_WINDOW still ${ms}ms; oxtail gap ${OUR_GAP_MS}ms — OK.`);

# oxpit activity layer — CODE review (max, round 2)

**Reviewer:** max · **Lens:** architecture/UX · **Commits:** 76a99ac (slice 1) + a512f27 (slice 2)
**Verdict:** **APPROVE.** Both structural deltas landed faithfully and the hard parts are correct
*and* well-tested (running/done pairing by call_id not adjacency; the `TodoWrite→plan` /
`read_session→oxtail` normalizer traps; the hostile-Unicode `displayWidth==codepoint-count`
1-column guarantee; C1 stale-pane refusal asserting `ran===false`). No HIGH. Two MEDIUMs worth
folding in with the next slice + a short LOW punch-list. Ship it.

Structural-delta fidelity check: B1 `scanTailLines` is now the single reverse byte reader, `readTailScan`
rides it ✓ · B2 read-class folded into `buildSnapshot` under `readActivity` (mirrors `checkProcSig`),
exec-class isolated in `activity.ts`, wired into BOTH the TUI (selected-row) and `oxtail status`
(all-eligible, try/catch degrade) ✓ · Q3 pane-activity stays OUT of the enum, surfaced as the orthogonal
`✽Ns` badge ✓ · C1 re-verify ✓ · C4 is_self skipped in TUI *and* `captureFleetPanes` ✓ · C6 hoist ✓ ·
C7 exec deferred to first slow tick ✓.

---

## Answers to your four targets

### T1 — cost-class boundary clean? → **Yes, with one wart.**
The boundary is clean: `readActivity` (read) folds into the snapshot, `capturePaneActivity` (exec) is
the only fork and lives in `activity.ts`; `status` and the TUI both consume it correctly.

**[MED] The fast-tick badge backfill MUTATES `snapshot.agents` in place** (`refresh()`:
`a.activity = activityCache.get(...)`). That forks `buildSnapshot`'s output — the one thing oxpit is
paranoid about ("DON'T FORK TRUTH") — and it's *asymmetric with the clean overlay right next to it*:
`paneActivity` is passed as a `RenderOptions` overlay and never mutates the snapshot. Do the same for
the tool badge: pass `activityCache` as a render overlay (or a `Map` arg) instead of writing onto the
agents. Then `buildSnapshot`'s result stays the single immutable truth and the two caches are handled
identically. Cleanliness, not a runtime bug today.

Coherence: liveness is re-stat'd each fast tick while the badge is ≤1.5s old — fine (bounded, labeled
"last did X" when not running). One honest caveat **[LOW]**: a cached `running…` badge keeps showing
in-flight for up to ~1.5s after the tool actually returned (self-heals next slow tick). Acceptable for
a hint; if you want it tighter, drop the running-flag on a fast tick when `transcript_age_s` advanced
past the cache.

### T2 — `✽` as first badge vs widening STATUS_W? → **First-badge is the right call.**
Widening a *fixed* 13-col status cell to keep a *sometimes-present* hint inline wastes 4 cols on every
row forever. The flex cluster sits immediately right of the status column, so `✽2s` lands visually
where the inline suffix would've been — you get the placement without the permanent tax. Endorsed; do
NOT widen STATUS_W. **[LOW]** verify every `TOOL_GLYPH` + `✽` is `displayWidth==1` *and* renders
1-col in iTerm/Terminal.app/tmux — `clipToWidth` backstops a wrap, but a width mis-budget would still
clip a trailing char. (Your test already pins this for the *captured* text; add the glyph set.)

### T3 — change-detector: stuck, or captures every tick? → **Neither, in the normal case — verified.**
`activityAt = generated_at − pane_activity_age_s` exactly reconstructs the absolute pty-epoch
(`nowSec − (nowSec − paneActAt) = paneActAt`), so it's STABLE across ticks when there's no new output
(→ not every-tick) and advances only on real repaint (→ not stuck). Good. Two edge caveats, both fixed
by the same change:

**[MED] Carry the ABSOLUTE epoch on `FleetAgent` (`pane_activity_at`), not just the relative age.**
The relative→absolute round-trip is lossy through the `max(0,…)` clamp: (a) a *future-dated* pane epoch
(any clock skew where `paneActAt > nowSec`) clamps age to 0 → `activityAt` tracks `nowSec` → advances
every tick → **captures every tick**; (b) if tmux populates *neither* `pane_activity` nor
`window_activity`, `activity_at` is null → the detector is **inert** (selected pane-tail only refreshes
on selection-change `force`, never on the slow tick). `panePresence` already *has* the absolute epoch —
expose it on the agent for the detector and derive the display age from it. Single source, no
reconstruction, both edges gone.

### T4 — pane-tail beats purpose / idle shows nothing / is_self skip → **Feels right.**
observed > declared is the correct priority; quiet/idle panes correctly yield `{tail:null,busy:false}`
→ fall back to purpose; is_self skipped both places. ✓ Minor UX note **[NIT]**: selecting *your own*
row shows no live line while peers do — a momentary "why is mine blank?" — but the purpose caption
fills it, so acceptable.

---

## Punch-list (new findings)

- **[LOW] transcripts exactness regression — `scanTailLines` is NOT byte-identical at one boundary.**
  A file with *exactly* `limit` messages whose oldest is the **first physical line** now mislabels a
  complete read as truncated. Empirically (real module, this branch):
  ```
  file = "<msgA>\n<msgB>\n", limit=2
  OLD (a06fcd9): exact=true  count_trunc=false trunc=false total=2     msgs=["A","B"]
  NEW (a512f27): exact=false count_trunc=true  trunc=true  total=null  msgs=["A","B"]
  ```
  No data loss — only the `total_messages_exact`/`count_truncated`/`truncated` metadata flips. Cause:
  the BOF leftover line now routes through the same `onLine` that trips `hitLimit`, whereas OLD's BOF
  block pushed without touching `hitLimit`. It's in the SHARED reader (read_session / read-transcript
  MCP tools), not oxpit's path, and it's **untested** — so green ≠ safe here, and it contradicts the
  "byte-identical, 24 tests green" claim. Clean fix = the fetch-(limit+1) pattern: collect until
  `limit+1` OR BOF; `>limit` ⇒ inexact + return first `limit`; `≤limit` at BOF ⇒ exact. Restores OLD
  semantics AND keeps every current test green (I checked the three controls). Add a test pinning
  `"A\nB\n", limit 2`.

- **[LOW] `scanLatestTool` lost its byte bound.** The generic `scanTailLines` dropped `maxBytes`, so the
  only backstop is `MAX_SCAN_LINES=2000` *lines*. A long tool-less stretch (a planning back-and-forth)
  could read many MB backward per agent on every 1.5s slow tick. Realistically it stops fast (tool calls
  are frequent), but the plan explicitly prized boundedness — add a `maxChunks`/`maxBytes` backstop to
  `scanLatestTool` so a pathological tail can't blow the read budget.

- **[LOW] `captureFleetPanes(snap.agents)` forks one exec per eligible agent, unbounded.** Fine for a
  human-invoked one-shot, but `oxtail status --all` across many projects could fork dozens of
  `capture-pane`s. Consider a soft cap (or document `--no-activity` as the escape).

- **[LOW] `capture-pane -p` without `-J`** (server.ts's `capturePane` uses `-p -J`). A spinner/working
  line wider than the pane could wrap and miss the extractor regex. The robust `esc to interrupt` busy
  flag still works; just a tail-extraction robustness gap. Cheap to add `-J` for parity.

- **[NIT] `agentKey` now lives in `activity.ts`** — a module that also forks tmux execs — though it's a
  pure identity helper unrelated to activity. Natural home is beside `FleetAgent` (snapshot.ts). No
  cycle either way; cohesion nit only.

- **[NIT] `--json` / piped-`oxpit` carry `activity` but not `pane_tail`** (the json branch runs after
  `readActivity` but the exec capture is render-only). Probably intended (cheap field in json, exec only
  for humans) — just confirm no json consumer wants the pane line.

---

## Net
APPROVE. The MEDIUMs (snapshot-mutation → overlay; carry absolute pane epoch) are the two I'd fold in
next — both make the code match patterns already present three lines away. The transcripts exactness
LOW is narrow but lives in a shared reader and is a quick fetch-(N+1) fix + one test; worth doing before
this rides into a `main` release. Everything else is hint-quality polish. Genuinely clean work — the
adversarial pieces (C1 verify, the epoch reconstruction, the 1-column sanitize) are right, not just
present. Architecture/UX lens only; codex owns the edge/security + Codex-chrome pass.

// token-audit — the Phase-2 research loop for oxtail's token-efficiency self-audit.
//
// Codifies the model validated by hand on send_message (2026-06-28): an
// independent PROPOSER tightens each tool description, INDEPENDENT adversarial
// skeptics try to refute it (the verify must NOT be the same agent as the
// proposer — that independence is the whole guardrail), and a SYNTHESIZER
// re-measures the real deltas and buckets each survivor for HUMAN review.
//
// Guardrail (load-bearing — do not "fix" this into an auto-applier):
//   - The token metric gates REJECTION, never ACCEPTANCE. A candidate reaches
//     the report only if it saves bytes (or fixes a coherence/accuracy defect)
//     AND no skeptic refutes it. A refuted candidate is dropped no matter how
//     many tokens it would have saved.
//   - Output is a ranked, human-gated REPORT. It applies NOTHING. Buckets:
//       safe                  → dead/stale/contradictory text, low risk
//       needs-review          → real savings, no refutation, touches live guidance
//       needs-behavioral-eval → cuts load-bearing text; static review can't clear it
//   - Telemetry-/byte-targeted: audits only the TOP_N heaviest descriptions, not
//     all 14, because per-description token payback is marginal (the spike cost
//     ~115k tokens to save ~140 tok/session). Batch + weight coherence over bytes.
//
// STATUS: first-run-pending. The script JS sandbox has no FS/Node API — all I/O
// (reading server.ts, measuring chars) is done by the AGENTS via their tools.
// On the first real run, resume-iterate if any stage misbehaves.
//
// Fire with:  Workflow({ name: "token-audit", args: { topN: 5 } })
// (running it is a deliberate, multi-agent, token-spending action — opt in.)

export const meta = {
  name: "token-audit",
  description:
    "Audit oxtail's heaviest tool descriptions for token-efficiency + coherence; emit human-gated edit proposals with independent adversarial verification (applies nothing).",
  whenToUse:
    "When you want a batched token-efficiency / coherence pass over the MCP tool descriptions. Expensive (≈ TOP_N × 3 agents). Output is a review report, never an auto-merge.",
  phases: [
    { title: "Target", detail: "measure the budget, pick the heaviest descriptions" },
    { title: "Propose", detail: "one independent agent rewrites each target" },
    { title: "Verify", detail: "independent skeptics (misuse + accuracy-vs-code) try to refute" },
    { title: "Behavioral", detail: "decision-scenario eval — does the text still cause the right call?" },
    { title: "Synthesize", detail: "re-measure deltas, bucket survivors, emit the report" },
  ],
};

// OBJECTIVE (re-centered after the real-spend measurement + max/codex review):
// the goal is DECISION-ACCURACY per real-traffic token, NOT description size.
// Caching makes turn-count × persistent-context the dominant cost, so a misused
// call (a wasted turn) costs far more than any description's bytes. Bytes are a
// capped constraint (the ceiling brake); decision-accuracy is the objective —
// measured by the Behavioral stage against the frozen scenario bank, not by
// dueling skeptic opinion.

const REPO = (args && args.repo) || "/Users/davidkim/dev/oxtail";
const TOP_N = (args && args.topN) || 5;

// ── schemas (structured agent output; validated at the tool-call layer) ───────

const TARGETS_SCHEMA = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          totalChars: { type: "number" },
        },
        required: ["name", "totalChars"],
        additionalProperties: false,
      },
    },
  },
  required: ["targets"],
  additionalProperties: false,
};

const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    original: { type: "string", description: "the exact current description string" },
    proposed: { type: "string", description: "the rewritten description, ready to paste" },
    origChars: { type: "number" },
    proposedChars: { type: "number" },
    changeLedger: {
      type: "array",
      items: {
        type: "object",
        properties: {
          change: { type: "string" },
          kind: { type: "string", enum: ["cut-redundancy", "merge", "reword", "drop-detail", "fix-drift"] },
          protects: { type: "string" },
          stillProtects: { type: "string" },
        },
        required: ["change", "kind", "protects", "stillProtects"],
        additionalProperties: false,
      },
    },
    riskTier: { type: "string", enum: ["safe", "needs-review", "needs-behavioral-eval"] },
    leastSure: { type: "string", description: "the single change the reviewers should attack hardest" },
    foundDrift: { type: "boolean", description: "true if the current description contradicts the handler code" },
    betterLeverElsewhere: { type: "string", description: "if the real win is a protocol change (collapse accreted caller-facing surface) or an ADD (missing field/clarification) a description edit can't reach, name it; else empty" },
  },
  required: ["name", "original", "proposed", "origChars", "proposedChars", "riskTier", "leastSure", "foundDrift"],
  additionalProperties: false,
};

const BEHAVIORAL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    scenariosRun: { type: "number" },
    accuracyOriginal: { type: "number", description: "0..1 decision-accuracy of the ORIGINAL description" },
    accuracyProposed: { type: "number", description: "0..1 decision-accuracy of the PROPOSED description" },
    regressed: { type: "boolean", description: "true if PROPOSED misses any scenario ORIGINAL passed" },
    perScenario: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          originalCorrect: { type: "boolean" },
          proposedCorrect: { type: "boolean" },
          note: { type: "string" },
        },
        required: ["id", "originalCorrect", "proposedCorrect"],
        additionalProperties: false,
      },
    },
    verdict: { type: "string", enum: ["pass", "veto"] },
  },
  required: ["name", "accuracyOriginal", "accuracyProposed", "regressed", "verdict"],
  additionalProperties: false,
};

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    lens: { type: "string", enum: ["misuse-prevention", "accuracy-vs-code"] },
    refuted: { type: "boolean" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    argument: { type: "string" },
    minimalFix: { type: "string", description: "smallest wording restoration if refuted, else empty" },
  },
  required: ["lens", "refuted", "confidence", "argument"],
  additionalProperties: false,
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          deltaChars: { type: "number", description: "re-measured by you, negative = saves" },
          survived: { type: "boolean" },
          bucket: { type: "string", enum: ["safe", "needs-review", "needs-behavioral-eval", "rejected"] },
          note: { type: "string" },
        },
        required: ["name", "deltaChars", "survived", "bucket", "note"],
        additionalProperties: false,
      },
    },
    markdown: { type: "string", description: "the full human-readable report" },
  },
  required: ["summary", "rows", "markdown"],
  additionalProperties: false,
};

// ── prompts ──────────────────────────────────────────────────────────────────

const proposePrompt = (t) =>
  `You are the PROPOSER in oxtail's token-efficiency audit. Tighten ONE MCP tool description as much as is SAFE — every byte sits in every session's system prompt, but a cut that causes one misused call costs far more than it saves.

TOOL: ${t.name}   (current full entry ~${t.totalChars} chars)
REPO: ${REPO}

Do this:
1. Open ${REPO}/src/server.ts, find \`server.registerTool("${t.name}", ...)\`. The top-level \`description\` (often an array .join'd) is your target. Read the handler body right after it too.
2. Cross-check the description against what the handler ACTUALLY does (read the helpers it calls — e.g. src/wake.ts, src/autowake.ts, src/mailbox.ts as relevant). If the description claims behavior the code doesn't do (or omits/ misstates a returned status/field), that is DRIFT — fixing it is the highest-value change; set foundDrift=true.
3. Rewrite the description: cut redundancy, merge overlapping clauses, drop mechanism color that changes no caller decision. PRESERVE every distinction a caller needs to choose a parameter, interpret a returned status/field, or pick a different verb. Do NOT touch the inputSchema field descriptions (out of scope).
4. Count chars exactly (a quick \`node -e\` or wc on the exact strings). Report origChars and proposedChars.

A reader of this description is an LLM agent. A LOAD-BEARING distinction is anything that changes which parameter it sets, how it reads a result, or which tool it reaches for next. Keep all of those.

THE LOOP IS NOT SUBTRACT-ONLY (max review): oxtail's reliability story is mostly ADDED guidance/fields. If the honest conclusion is "this needs a clarifying clause / a missing field" (proposed LONGER), say so — a correct ADD beats a risky cut. And the only move that wins bytes AND behavior at once is collapsing ACCRETED protocol surface: if a description is huge because it exposes many states the CALLER does not act on differently (e.g. several skipped_* wake_status values that all mean "not nudged, in mailbox, seen next turn"), the real fix is a protocol pass (collapse the caller-facing surface, keep detail in a debug field), which a description edit CANNOT reach. You can't make that change here, but FLAG it in betterLeverElsewhere so it's not lost.

Set riskTier honestly: "safe" (only cut dead/redundant text or fixed drift), "needs-review" (tightened live guidance, believe it's preserved), "needs-behavioral-eval" (cut something load-bearing for real savings). In leastSure, name the single change a skeptic should attack hardest — be honest, it's how the hole gets caught.`;

const verifyMisusePrompt = (t, p) =>
  `You are an ADVERSARIAL VERIFIER (lens: MISUSE-PREVENTION) in oxtail's token audit. A proposer shortened the "${t.name}" tool description. REFUTE it: find a concrete way the shorter text makes an LLM caller decide WRONG where the original decided right. You are the safety gate — bias toward refutation; if a load-bearing distinction was weakened and you're unsure, refute.

ORIGINAL:
"""
${p.original}
"""
PROPOSED:
"""
${p.proposed}
"""
The proposer's self-flagged weakest change: ${p.leastSure}
Attack that, but DON'T stop there — sweep the whole diff. For each caller decision (which param to set, how to read a returned status/field, which verb to reach for next), check the proposed text still steers it. You MAY read ${REPO}/src to confirm a borderline claim.

Give ONE strongest concrete misuse if refuted (the scenario, what original made the caller do, what proposed now makes them do wrong), plus the smallest wording fix. If you genuinely can't break it, say so and name where you probed hardest — do not manufacture a refutation.`;

const verifyAccuracyPrompt = (t, p) =>
  `You are an ADVERSARIAL VERIFIER (lens: ACCURACY-VS-CODE) in oxtail's token audit. A proposer shortened the "${t.name}" tool description. REFUTE it on two failure modes: (1) OMISSION — a returned status/field/conditional the caller needs that the proposed text dropped or blurred vs the original AND the code; (2) FALSE CLAIM — the proposed text asserts something the handler doesn't do, or states a condition more strongly/loosely than the code behaves.

ORIGINAL:
"""
${p.original}
"""
PROPOSED:
"""
${p.proposed}
"""
Verify against real behavior: open ${REPO}/src/server.ts at \`registerTool("${t.name}", ...)\` and the helpers it calls. Confirm every enum value / returned field / gating conditional in the original survives in the proposed AND matches the code, and that the proposed introduces no claim the code can't back. If the proposer set foundDrift=${p.foundDrift}, confirm the fix is correct.

Give ONE strongest concrete inaccuracy/omission if refuted (quote the proposed text + the code/original it contradicts or drops), plus the smallest correction. If accurate and complete, say so and name what you cross-checked (esp. the full status/field set and the conditionals).`;

const behavioralPrompt = (t, p) =>
  `You are the BEHAVIORAL VETO in oxtail's token audit — the MEASUREMENT static skeptics can't provide. Static review checks "does the text still SAY the distinction"; you check "does the text still CAUSE the right decision."

For tool "${t.name}": read ${REPO}/src/eval/scenarios.ts and select the scenarios whose \`tools\` include "${t.name}". For EACH, run the decision test TWICE — once treating ONLY the ORIGINAL description as the agent's knowledge of this tool, once treating ONLY the PROPOSED — decide the action a fresh agent WOULD take given only that description + scenario.situation, and score it against scenario.rubric / scenario.correct. Grade STRICTLY: if the description doesn't make the correct action clearly inferable, that's a MISS even if you personally know the right answer — you are testing the DESCRIPTION, not your knowledge.

ORIGINAL:
"""
${p.original}
"""
PROPOSED:
"""
${p.proposed}
"""
Report per-scenario originalCorrect/proposedCorrect, each version's accuracy (fraction correct), regressed=true if PROPOSED misses ANY scenario ORIGINAL passed, and verdict="veto" if it regressed on a high- or medium-frequency scenario (else "pass"). A veto KILLS the candidate regardless of bytes saved — decision-accuracy is the objective, size is the constraint.

(v1 limitation: you role-play the fresh-agent decision for all scenarios in one context; the higher-fidelity upgrade is a truly isolated fresh agent per (description, scenario). Grade honestly against that ideal — and if a scenario's correct action is genuinely ambiguous from EITHER description, say so rather than inventing a pass/fail.)`;

const synthPrompt = (bundle) =>
  `You are the SYNTHESIZER in oxtail's token audit. Below is a JSON array of {target, proposal, verdicts[]}. Produce the human-review report. Rules:
- A candidate SURVIVES only if ALL THREE hold: (1) exactly two verdicts, one per DISTINCT lens (misuse-prevention AND accuracy-vs-code), both refuted=false; (2) behavioral is non-null with verdict="pass" and regressed=false (no decision-accuracy loss on the scenario bank); (3) tokenDelta < 0 OR it's a coherence/drift fix. Independence is the guardrail: one skeptic is not a pass. The behavioral veto is the OBJECTIVE check — a candidate that saves bytes but regresses a high/medium scenario is bucket="needs-behavioral-eval", NEVER safe. A behavioral=null means it was rejected by the static skeptics before behavioral ran → bucket="rejected". Any static refutation → "rejected" with the refuter's argument + minimalFix in the note.
- For each SURVIVOR, RE-MEASURE the real delta yourself: deltaChars = proposedChars - origChars (negative = saves). Trust the numbers in the proposal only after sanity-checking they're consistent; if a proposal's counts look off, note it.
- Bucket survivors by the proposal's riskTier (safe / needs-review / needs-behavioral-eval), but DOWNGRADE to needs-review if any verdict was refuted=false at only "low" confidence on a live-guidance change.
- Rank survivors by (bytes saved × confidence). Sum the total potential saving and translate to ~tokens at 3.7 chars/tok.
- The report APPLIES NOTHING. It ends with the exact next step: which "safe" rows can batch into a PR, which "needs-review" rows want a human eye on a named phrase, and which are parked for behavioral eval. Remind that after any batch lands, BUDGET_CEILING_CHARS in src/token-budget.ts should be ratcheted DOWN to lock the win.

DATA:
${JSON.stringify(bundle)}`;

// ── pipeline: target → propose → verify (independent), then synthesize ────────

phase("Target");
const picked = await agent(
  `You are the TARGET stage of oxtail's token audit. Run \`cd ${REPO} && node dist/server.js token-budget --json\` and parse the JSON. From schema.tools (each has name + totalChars, already sorted heaviest-first), return the ${TOP_N} heaviest as the audit targets. These are the descriptions whose bytes most justify a pass.`,
  { schema: TARGETS_SCHEMA, label: "pick-targets", phase: "Target" },
);

const targets = (picked && picked.targets ? picked.targets : []).slice(0, TOP_N);
if (targets.length === 0) {
  log("token-audit: no targets resolved (is `node dist/server.js token-budget --json` working?). Aborting.");
  return { summary: "no targets", rows: [], markdown: "token-audit produced no targets." };
}
log(`token-audit: auditing ${targets.length} heaviest descriptions — ${targets.map((t) => t.name).join(", ")}`);

const audited = await pipeline(
  targets,
  // stage 1: propose
  (t) => agent(proposePrompt(t), { schema: PROPOSAL_SCHEMA, label: `propose:${t.name}`, phase: "Propose" }),
  // stage 2: two INDEPENDENT skeptics in parallel, attached to the proposal.
  // FAIL-SAFE (codex review): a verifier that dies (null) becomes a REFUTATION,
  // never a dropped slot. Independence is the whole guardrail — without this,
  // a `filter(Boolean)` let a candidate reach synthesis seen by only ONE skeptic
  // and still satisfy "all returned verdicts passed". Both distinct lenses must
  // run AND pass before a candidate can survive; a missing lens kills it.
  (proposal, t) =>
    parallel([
      () => agent(verifyMisusePrompt(t, proposal), { schema: VERDICT_SCHEMA, label: `verify-misuse:${t.name}`, phase: "Verify" }),
      () => agent(verifyAccuracyPrompt(t, proposal), { schema: VERDICT_SCHEMA, label: `verify-accuracy:${t.name}`, phase: "Verify" }),
    ]).then((verdicts) => ({
      target: t,
      proposal,
      verdicts: verdicts.map((v, i) =>
        v || {
          lens: i === 0 ? "misuse-prevention" : "accuracy-vs-code",
          refuted: true,
          confidence: "low",
          argument: "verifier returned no verdict — fail-safe refutation; both independent lenses must run and pass before a candidate survives.",
        }),
    })),
  // stage 3: behavioral veto — only spend it on candidates that PASSED both
  // static skeptics (a candidate already refuted is rejected; don't pay to eval
  // it). Decision-accuracy regression vetoes regardless of bytes saved.
  (verified, t) => {
    if (!verified) return null;
    // Independence is CODE-enforced, not just prompt-enforced (codex review):
    // require exactly two verdicts, two DISTINCT lenses, both non-refuted. Two
    // same-lens verdicts must NOT reach behavioral on the synthesizer's good
    // faith — the distinct-lens set check closes that.
    const lenses = new Set(verified.verdicts.map((v) => v && v.lens));
    const passedStatic =
      verified.verdicts.length === 2 &&
      lenses.size === 2 &&
      verified.verdicts.every((v) => v && v.refuted === false);
    if (!passedStatic) return { ...verified, behavioral: null };
    return agent(behavioralPrompt(t, verified.proposal), {
      schema: BEHAVIORAL_SCHEMA,
      label: `behavioral:${t.name}`,
      phase: "Behavioral",
    }).then((behavioral) => ({ ...verified, behavioral }));
  },
);

phase("Synthesize");
const report = await agent(synthPrompt(audited.filter(Boolean)), { schema: REPORT_SCHEMA, label: "synthesize", phase: "Synthesize" });
log(`token-audit complete: ${report.summary}`);
return report;

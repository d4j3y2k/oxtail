// Behavioral decision-scenario bank — the CapEx asset that turns the token audit
// from "dueling skeptic opinion" into MEASUREMENT (max + codex review, 2026-06-29).
//
// The premise (from the real-spend measurement): over the fleet's 300-1500-turn
// sessions, caching makes the dominant cost driver TURN COUNT × persistent
// context — so a single misused call (a wasted turn, a repair loop) costs far
// more than any description's bytes. The lever is DECISION-ACCURACY, not size.
//
// Each scenario is a frozen (situation → correct-action) pair encoding ONE
// load-bearing distinction, mined from a REAL oxtail incident (the memory's scar
// tissue). The eval: give a FRESH agent ONLY a candidate tool description + the
// situation, capture the action it would take, and score it against the rubric.
// A description edit that lowers decision-accuracy on its scenarios is VETOED no
// matter how many bytes it saves — eval gates REJECTION; humans gate acceptance.
//
// Discipline (avoid the bank BECOMING the Goodhart target): grow it from live
// incidents, hold scenarios out from the proposer, and treat "can't author a
// breaking scenario" as real evidence a cut is safe — "reads fine" is not.

export type Frequency = "high" | "medium" | "low";

export type Scenario = {
  id: string;
  // Which tool descriptions this exercises — used to select the scenarios
  // relevant to a candidate under audit.
  tools: string[];
  // The single load-bearing distinction the description must preserve.
  distinction: string;
  // How often this misuse actually bites, from real incidents — the frequency
  // weight in expected-cost = frequency × (bytes + misuse/repair penalty).
  frequency: Frequency;
  // The real incident/memory this is mined from (provenance, not decoration).
  incident: string;
  // The prompt handed to a fresh agent (only this + the candidate description).
  situation: string;
  // The correct action: tool + key params + how to read the result.
  correct: string;
  // The misuse to catch — what a confused-by-the-description agent does instead.
  commonWrong: string;
  // Scoring checklist; an eval scores the agent's action against these.
  rubric: string[];
};

export const SCENARIOS: Scenario[] = [
  {
    id: "reply-includes-request-id",
    tools: ["send_message", "reply_to_message", "ask_peer"],
    distinction: "A reply to an ask_peer must correlate via reply_to=request_id (or reply_to_message(message_id)), or the waiter never resolves.",
    frequency: "high",
    incident: "v0.10.1 correlated ask/reply; the whole reply-correlation design.",
    situation: "A peer sent you a message that includes request_id=req_42 and from_session_id=S. You've finished the answer they asked for. How do you send it back?",
    correct: "reply_to_message(message_id) — or send_message(target=S, reply_to=req_42). The request_id correlation is what releases their ask_peer wait.",
    commonWrong: "A plain send_message(target=S) with no reply_to — the body arrives but the peer's ask_peer never correlates and times out.",
    rubric: ["uses reply_to_message OR sets reply_to=req_42", "targets the from_session_id, not a tmux name", "does NOT drop the correlation"],
  },
  {
    id: "action-required-closes-not-replies",
    tools: ["send_message", "complete_work", "block_work", "read_my_messages", "my_open_work"],
    distinction: "An action_required delegation is a durable OBLIGATION closed with complete_work/block_work — NOT discharged by reply_to_message.",
    frequency: "high",
    incident: "v0.20.0 hook-path obligation blindness — a hooked Claude left an obligation open by replying instead of closing.",
    situation: "You received a message tagged action_required (message_id=m9) asking you to audit a file. You've done the audit. How do you discharge it?",
    correct: "complete_work(m9, result) (or block_work(m9, reason) if you couldn't). Optionally also send the findings, but the OBLIGATION closes only via complete/block_work.",
    commonWrong: "reply_to_message(m9, ...) — the findings arrive but the obligation stays OPEN forever in my_open_work / open_work_count.",
    rubric: ["closes via complete_work or block_work", "does NOT treat reply_to_message as closing it", "references the message_id"],
  },
  {
    id: "stranded-send-needs-stronger-verb",
    tools: ["send_message", "ask_peer"],
    distinction: "A plain send to a claimed, idle, HOOKED peer that must ACT strands until its next turn (delivery_outlook stranded_until_read) — use ask_peer / action_required / wake.",
    frequency: "high",
    incident: "Participant-error stall gap + v0.24.0 delivery_outlook — a plain send to an idle peer silently stranded work.",
    situation: "You need peer S (a claimed, currently-idle Claude with hooks) to start a task now. You send_message and get delivery_outlook:\"stranded_until_read\". What does that mean and what do you do?",
    correct: "It means S won't read this until its next turn — it's NOT acting now. If it must act: ask_peer (you need an answer this turn), action_required:true (durable task), or wake:\"auto\" (nudge it to read now).",
    commonWrong: "Treat the ok:true as 'delivered and handled' and move on / wait for a result that never comes (the silent stall).",
    rubric: ["recognizes stranded_until_read = not acting now", "escalates to ask_peer / action_required / wake", "does NOT assume the bare send caused action"],
  },
  {
    id: "hookless-reply-needs-explicit-wake",
    tools: ["send_message", "reply_to_message"],
    distinction: "Replying to a HOOKLESS requester (Codex / no fresh-idle marker) returns skipped_no_fresh_idle and does NOT auto-wake — use explicit wake:\"auto\".",
    frequency: "medium",
    incident: "Reply-default wake gating (Slice 1) + the Codex idle-receive convention work.",
    situation: "You're replying to a Codex peer that asked you something. You reply and the response says wake_status:\"skipped_no_fresh_idle\". Will Codex see your reply promptly?",
    correct: "Not necessarily — the reply-default wake skipped (Codex has no fresh-idle marker). To nudge it now, re-send/reply with wake:\"auto\"; otherwise it sees the reply at its next read_my_messages.",
    commonWrong: "Assume the reply woke Codex (as it would a hooked Claude) and wait for it to act immediately.",
    rubric: ["recognizes skipped_no_fresh_idle = not woken", "knows hookless peers need explicit wake:auto", "does not assume prompt pickup"],
  },
  {
    id: "fired-unconfirmed-not-delivery",
    tools: ["send_message", "ask_peer"],
    distinction: "fired_unconfirmed = keystrokes sent to a hookless peer, OPEN-LOOP, NOT proof of pickup — the durable mailbox / next read is the guarantee.",
    frequency: "high",
    incident: "v0.25.0 H2 honest wake — fired_unconfirmed introduced precisely so a wake isn't mistaken for delivery.",
    situation: "You send_message(wake:\"auto\") to a Codex peer and get wake_status:\"fired_unconfirmed\". Has Codex received and read it?",
    correct: "No — keystrokes were sent but submission/pickup is NOT confirmed (the paste-burst Enter can be suppressed). It IS durably in Codex's mailbox; the guarantee is its next read_my_messages, not the wake.",
    commonWrong: "Treat fired_unconfirmed as delivered+read and depend on an immediate response.",
    rubric: ["fired_unconfirmed ≠ delivered/read", "knows the mailbox is the durable guarantee", "doesn't block on an assumed immediate pickup"],
  },
  {
    id: "ask-peer-timeout-trust-durable-pullback",
    tools: ["ask_peer", "read_my_messages"],
    distinction: "On ask_peer timeout (correlated, claimed), the request is recorded pending and the late reply WAKES you back — end your turn, don't idle-poll.",
    frequency: "high",
    incident: "v0.15.0 durable ask_peer + the Codex over-wait / idle-poll friction.",
    situation: "You ask_peer a peer for a slow analysis with a 60s timeout. It returns reply:null, timed_out:true. The work will take ~10 minutes. What do you do?",
    correct: "End your turn. The pending obligation was recorded; when the peer's reply lands (minutes later) it wakes you back (late_reply_to_pending). Don't sit in a sleep/poll loop.",
    commonWrong: "Loop calling read_my_messages (or re-fire ask_peer) every few seconds to 'wait' for the reply — burning turns/tokens for nothing.",
    rubric: ["ends the turn / does not idle-poll", "trusts the durable late-reply pull-back", "does not busy-wait or re-ask"],
  },
  {
    id: "count0-after-hook-not-unresponsive",
    tools: ["read_my_messages", "read_session"],
    distinction: "read_my_messages count:0 after a hook delivery is normal (the hook already drained) — it is NOT evidence a peer is unresponsive.",
    frequency: "medium",
    incident: "v0.16.2 read_session freshness — a Claude trusted a stale read over the mailbox and wrongly called a peer unresponsive.",
    situation: "A peer message was just injected into your turn by the hook. You then call read_my_messages and it returns count:0. Did you lose a message / is the peer broken?",
    correct: "No — the PreToolUse hook already drained and injected those messages, so the mailbox is legitimately empty. count:0 here means 'already delivered', not 'nothing/unresponsive'.",
    commonWrong: "Conclude the message was lost or the peer is unresponsive and escalate / re-request.",
    rubric: ["count:0 after hook = already delivered", "does not conclude loss/unresponsiveness", "does not redundantly re-request"],
  },
  {
    id: "target-by-uuid-when-names-collide",
    tools: ["send_message", "ask_peer", "list_project_sessions"],
    distinction: "When peers share a tmux session name, target by client_session_id (UUID); a name is ambiguous and can misroute.",
    frequency: "medium",
    incident: "Split-identity work + observed live: three agents sharing tmux session 'oxtail'.",
    situation: "list_project_sessions shows three agents all named 'oxtail' with distinct client_session_ids. You want to message exactly one of them. What target do you use?",
    correct: "The specific peer's client_session_id (UUID). Targeting by the shared name 'oxtail' is ambiguous and may reach the wrong agent.",
    commonWrong: "send_message(target=\"oxtail\", ...) — ambiguous; routes to whichever the resolver picks, not necessarily the intended peer.",
    rubric: ["targets by client_session_id UUID", "recognizes the name is ambiguous", "uses list_project_sessions to disambiguate"],
  },
  {
    id: "mailbox-push-beats-read-session-pull",
    tools: ["read_session", "read_my_messages", "ask_peer"],
    distinction: "read_session (pull) can serve a stale/rotated thread; it is NOT proof a peer replied — the mailbox (push) is the source of truth.",
    frequency: "medium",
    incident: "v0.16.2 read_session freshness — read_session served a 2503s-stale thread vs a 5s-live mailbox.",
    situation: "You want to know if peer S answered your question. You call read_session(S) and see no answer in the returned transcript. Has S definitely not replied?",
    correct: "Not definitely — read_session can serve a stale/rotated thread (check transcript_age). A reply arrives via your mailbox (read_my_messages / the hook / ask_peer); trust that push, not the pull's absence.",
    commonWrong: "Conclude from read_session's silence that S never replied, and re-ask or call S unresponsive.",
    rubric: ["does not treat read_session silence as proof-of-no-reply", "trusts the mailbox/push for replies", "checks freshness if using read_session"],
  },
  {
    id: "long-task-use-durable-delegation",
    tools: ["send_message", "ask_peer", "complete_work"],
    distinction: "For a long task you want tracked, action_required:true makes a durable obligation that survives wake mistiming (vs a plain send that can strand).",
    frequency: "medium",
    incident: "v0.19.0 durable delegation (action_required / my_open_work).",
    situation: "You're handing a multi-step task to a peer and you want to be sure it's not lost if a wake is missed, and to track that it gets done. Which verb/param?",
    correct: "send_message(..., action_required:true) — a durable obligation the peer sees in my_open_work/open_work_count and must close with complete_work/block_work, surviving any missed wake.",
    commonWrong: "A plain send_message and hope it's seen — no durability, no tracking; a missed wake strands it.",
    rubric: ["uses action_required:true for the durable task", "knows it's tracked via my_open_work", "prefers it over a bare send for delegated work"],
  },
  {
    id: "skipped-busy-hook-delivers-dont-resend",
    tools: ["send_message", "ask_peer"],
    distinction: "wake_status skipped_busy = peer is mid-turn; its hook/poll delivers the already-enqueued message. Don't re-send or escalate.",
    frequency: "medium",
    incident: "Wake state-gating — typing into a busy composer is noise; the hook delivers.",
    situation: "You send_message(wake:\"auto\") and get wake_status:\"skipped_busy\". Was the message lost? Should you re-send?",
    correct: "Not lost — the peer is mid-turn, so the keystroke was skipped on purpose; the message is enqueued and its hook/poll will deliver it. Do nothing extra.",
    commonWrong: "Re-send the message (or escalate to ask_peer) thinking skipped_busy means failure — creating duplicates/noise.",
    rubric: ["skipped_busy = enqueued, hook delivers", "does NOT re-send or duplicate", "does not treat it as failure"],
  },
  {
    id: "unclaimed-target-bootstrap-first",
    tools: ["send_message", "ask_peer", "claim_session"],
    distinction: "An UNCLAIMED target has no session_id: deliverable to its pid box + wakeable, but not UUID-addressable / correlatable until it runs claim_session.",
    frequency: "low",
    incident: "v0.18.0 in-band bootstrap for unclaimed peers + the split-identity bootstrap path.",
    situation: "You try to ask_peer a peer but get an error that it has no registered client.session_id. What's the right move?",
    correct: "Bootstrap it in-band first: send_message(wake:\"auto\") with a body telling it to run claim_session; once claimed, retry ask_peer (which needs a correlatable session_id).",
    commonWrong: "Keep retrying ask_peer against the unclaimed peer, or give up calling it unreachable.",
    rubric: ["recognizes unclaimed = not correlatable yet", "bootstraps via send_message + claim_session instruction", "retries ask_peer only after claim"],
  },
];

// Select the scenarios that exercise a given tool's description — the targeting
// for a candidate under audit (only run what's relevant).
export function scenariosForTool(tool: string): Scenario[] {
  return SCENARIOS.filter((s) => s.tools.includes(tool));
}

// Coarse frequency weight for expected-cost ranking. Deliberately simple; refine
// from real misuse-mining (trace repair-loops, idle polls) as that data lands.
export function frequencyWeight(f: Frequency): number {
  return f === "high" ? 3 : f === "medium" ? 2 : 1;
}

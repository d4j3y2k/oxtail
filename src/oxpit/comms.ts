// oxpit comms-log — a passive, cross-fleet message feed.
//
// Each agent's received-ledger is its durable inbox history (every inbound message,
// body included). Merging the ledgers of all agents in scope yields the full
// inter-agent conversation: a message is received by exactly ONE session, so it
// appears in exactly one ledger — its receiver is that ledger's owner, its sender
// is from_session_id. This is a pure VIEW (canonical received reader, no draining,
// torn-line tolerant), so it can never disturb the traffic it shows.

import { listRecentLedgerRecords } from "../received.js";

export type CommsMessage = {
  message_id: string;
  from_session_id: string | null; // sender (null = unattributed / system)
  to_session_id: string; // receiver = the ledger owner
  body: string;
  at: number; // enqueued_at, unix seconds
  request_id?: string; // present ⇒ this was an ask_peer
  reply_to?: string; // present ⇒ this is a reply correlating to a request_id
  action_required?: boolean; // a durable delegation
  closed?: "done" | "blocked"; // delegation outcome, if closed
};

export type BuildCommsOptions = {
  // Per-agent ledger scan depth (newest records). Default 50.
  perAgent?: number;
  // Total messages returned after the merge (newest-first). Default 100.
  limit?: number;
  // Injectable for tests; defaults to the canonical received reader.
  readLedger?: (sessionId: string, limit: number) => ReturnType<typeof listRecentLedgerRecords>;
};

// Merge the in-scope agents' ledgers into one newest-first feed, deduped by
// message_id (defensive — a message normally lands in a single ledger).
export function buildCommsLog(
  agents: ReadonlyArray<{ session_id: string | null }>,
  opts: BuildCommsOptions = {},
): CommsMessage[] {
  const perAgent = opts.perAgent ?? 50;
  const limit = opts.limit ?? 100;
  const read = opts.readLedger ?? listRecentLedgerRecords;

  const seen = new Set<string>();
  const out: CommsMessage[] = [];
  for (const a of agents) {
    if (!a.session_id) continue;
    for (const r of read(a.session_id, perAgent)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({
        message_id: r.id,
        from_session_id: r.from_session_id,
        to_session_id: a.session_id,
        body: r.body,
        at: r.enqueued_at,
        request_id: r.request_id,
        reply_to: r.reply_to,
        action_required: r.action_required,
        closed: r.closed,
      });
    }
  }
  // Chronological ascending (oldest→newest) so the feed tail-follows like a log;
  // tie-break on message_id (enqueued_at is seconds-granular, so a burst ties and
  // the id tiebreak keeps the order stable across refreshes). Then keep the most
  // recent `limit`.
  out.sort((x, y) => x.at - y.at || (x.message_id < y.message_id ? -1 : 1));
  return out.length > limit ? out.slice(-limit) : out;
}

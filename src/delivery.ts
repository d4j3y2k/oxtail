import * as mailbox from "./mailbox.js";
import { recordReceived } from "./received.js";
import { trace } from "./trace.js";

// Deliver a message to a peer's mailbox, recording the durable reply-handle in
// the receiver's ledger BEFORE the mailbox line becomes visible. The ordering is
// the correctness guarantee: a hook/poll drainer can only observe the mailbox
// line after the append, which happens strictly after the ledger write — so any
// message_id a receiver can drain/render already has a ledger entry behind it.
// The reverse order (append, then record) left a window where the hook rendered
// a handle reply_to_message could not yet resolve (the race Codex caught).
//
// receiverSessionId may be null/empty (an unclaimed peer): then there is no
// ledger to own the handle and we skip the record — reply_to_message simply
// won't find it, which is the documented fall-back-to-send_message path.
//
// The ledger write is best-effort: a ledger failure must NEVER drop the actual
// delivery. Worst case the reply handle is missing and the peer falls back to
// send_message — never the reverse (a visible line with no handle on success),
// because record precedes append.
export function deliverToPeer(
  receiverSessionId: string | null | undefined,
  targetPid: number,
  body: string,
  fromSessionId: string | undefined,
  options: mailbox.EnqueueOptions = {},
): mailbox.Mailbox {
  const msg = mailbox.buildMessage(body, fromSessionId, options);
  if (receiverSessionId) {
    try {
      recordReceived(receiverSessionId, msg);
    } catch (e) {
      trace("received_ledger_write_failed", { message_id: msg.id, error: String(e) });
    }
  }
  mailbox.requeue(targetPid, msg);
  return msg;
}

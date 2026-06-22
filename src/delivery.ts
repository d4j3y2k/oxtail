import * as mailbox from "./mailbox.js";
import { entryForPid } from "./registry.js";
import { recordReceived } from "./received.js";
import { trace } from "./trace.js";

// Where a delivery should land, derived by the caller from the RESOLVED target
// registry entry (resolveTarget) — never from assumptions about the peer:
//   session_id    — the receiver's agent identity (null/undefined = unclaimed).
//   server_pid    — the receiver's legacy pid box (always present).
//   session_keyed — the receiver ADVERTISED capabilities.mailbox.session_keyed,
//                   i.e. its reader drains the session box. Routing on the
//                   advertisement (not on our own knowledge of session_id) is
//                   what keeps mixed versions interoperable: a pre-v0.17 reader
//                   only drains pid boxes, so mail routed to its session box
//                   would never be seen.
export type DeliveryRoute = {
  session_id: string | null | undefined;
  server_pid: number;
  session_keyed: boolean;
};

// The box a route resolves to: the session box for a session_keyed-capable
// claimed receiver (canonical v0.17+ path — survives MCP-child pid rotation by
// construction), else the legacy pid box.
export function routeBox(route: DeliveryRoute): mailbox.BoxId {
  return route.session_keyed && route.session_id
    ? mailbox.mailboxSessionKey(route.session_id)
    : route.server_pid;
}

// After a LEGACY pid-box append, re-check that the receiver's registry
// breadcrumb still exists and still belongs to the same identity. This closes
// (most of) the documented resolve→enqueue orphan window: the sender resolved a
// live entry, but the receiver died and a sibling's gc unlinked the breadcrumb
// in the gap — leaving the just-appended pid mail unreachable by ANY reader's
// session union (sessionPidsForId walks registry files). When that happens and
// we know the receiver's session_id, also deliver the session-box copy: a
// v0.17+ reader finds it there; the orphaned pid copy has no breadcrumb so it
// is never double-drained. (A pre-v0.17 receiver in this state lost the message
// under the old code too — the residual is unchanged for old readers, narrowed
// to zero for new ones.) Best-effort: never fails the already-done delivery.
function recheckLegacyBreadcrumb(route: DeliveryRoute, msg: mailbox.Mailbox): void {
  if (!route.session_id) return;
  let fresh: ReturnType<typeof entryForPid> = null;
  try {
    fresh = entryForPid(route.server_pid);
  } catch {
    fresh = null;
  }
  if (fresh && fresh.client.session_id === route.session_id) return;
  try {
    mailbox.requeue(mailbox.mailboxSessionKey(route.session_id), msg);
    trace("mailbox_legacy_breadcrumb_lost", {
      message_id: msg.id,
      target_pid: route.server_pid,
      target_session_id: route.session_id,
      rescued: true,
    });
  } catch (e) {
    trace("mailbox_legacy_breadcrumb_lost", {
      message_id: msg.id,
      target_pid: route.server_pid,
      target_session_id: route.session_id,
      rescued: false,
      error: String(e),
    });
  }
}

function deliver(route: DeliveryRoute, msg: mailbox.Mailbox): void {
  const box = routeBox(route);
  mailbox.requeue(box, msg);
  if (typeof box === "number") recheckLegacyBreadcrumb(route, msg);
}

// Deliver a message to a peer's mailbox, recording the durable reply-handle in
// the receiver's ledger BEFORE the mailbox line becomes visible. The ordering is
// the correctness guarantee: a hook/poll drainer can only observe the mailbox
// line after the append, which happens strictly after the ledger write — so any
// message_id a receiver can drain/render already has a ledger entry behind it.
// The reverse order (append, then record) left a window where the hook rendered
// a handle reply_to_message could not yet resolve (the race Codex caught).
//
// route.session_id may be null/empty (an unclaimed peer): then there is no
// ledger to own the handle and we skip the record — reply_to_message simply
// won't find it, which is the documented fall-back-to-send_message path.
//
// The ledger write is best-effort FOR ORDINARY messages: a failure must not drop
// the delivery — worst case the reply handle is missing and the peer falls back to
// send_message (never the reverse: a visible line with no handle, because record
// precedes append). EXCEPTION — an action_required delegation: its obligation lives
// ONLY in the ledger, so a ledger failure there ABORTS the delivery (fail loud →
// sender retries) rather than enqueue a delegation the obligation surface can't see.
// `record` is injectable so tests can drive the ledger-failure branch.
export function deliverToPeer(
  route: DeliveryRoute,
  body: string,
  fromSessionId: string | undefined,
  options: mailbox.EnqueueOptions = {},
  record: (sessionId: string, msg: mailbox.Mailbox) => void = recordReceived,
): mailbox.Mailbox {
  const msg = mailbox.buildMessage(body, fromSessionId, options);
  if (route.session_id) {
    try {
      record(route.session_id, msg);
    } catch (e) {
      trace("received_ledger_write_failed", { message_id: msg.id, error: String(e) });
      // H1: my_open_work / countOpenObligations read the LEDGER, not the mailbox,
      // and recordReceived rewrites the whole ledger via atomicWrite (temp+rename)
      // — far likelier to fail under disk pressure than the tiny mailbox append
      // that follows. Delivering anyway would enqueue a delegation INVISIBLE to the
      // obligation surface, silently voiding its durable guarantee (the disk-full
      // incident). Fail loud so the sender retries; abort before deliver().
      if (msg.action_required) {
        throw new Error(
          `durable obligation not recorded — ledger write failed, delivery aborted: ${String(e)}`,
        );
      }
    }
  }
  deliver(route, msg);
  // Sender-side outbox record, AFTER the enqueue succeeded: message_status uses
  // it to locate the recipient's inbox (pending vs gone) when no delivery
  // receipt exists yet. Best-effort — the delivery above is already done.
  mailbox.recordOutbox({
    schema_version: 1,
    message_id: msg.id,
    enqueued_at: msg.enqueued_at,
    target_session_id: route.session_id ?? null,
    target_server_pid: route.server_pid,
    from_session_id: fromSessionId ?? null,
  });
  return msg;
}

// Re-deliver an ALREADY-BUILT message to a peer, preserving its message_id and
// (re)recording the receiver's ledger handle BEFORE the mailbox line becomes
// visible — same record-before-append ordering as deliverToPeer. Used by the
// ask_peer abort-recovery path: the reply was drained into memory but the client
// aborted before it was returned, so it must be re-enqueued WITHOUT minting a new
// id. (mailbox.enqueue would mint a fresh id and skip the ledger, so the
// redelivered reply's displayed id resolves to message-not-found on
// reply_to_message.) The ledger write is best-effort — a failure must never drop
// the redelivery; worst case the handle is missing and the peer falls back to
// send_message.
export function deliverExistingToPeer(
  route: DeliveryRoute,
  msg: mailbox.Mailbox,
): void {
  if (route.session_id) {
    try {
      recordReceived(route.session_id, msg);
    } catch (e) {
      trace("received_ledger_write_failed", { message_id: msg.id, error: String(e) });
    }
  }
  deliver(route, msg);
}

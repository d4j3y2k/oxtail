// oxpit CLI surface: `oxtail status` (one-shot snapshot) and `oxtail oxpit`
// (interactive TUI). Both are thin wrappers over the pure snapshot/render layer.

import { buildSnapshot } from "./snapshot.js";
import { computeAgentLabels, renderCommsLog, renderSnapshot } from "./render.js";
import { buildCommsLog } from "./comms.js";
import {
  NUDGE_TEXT,
  sendOperatorMessage,
  type OperatorSendResult,
  type OperatorTarget,
} from "./operator.js";
import { formatAttachmentNote, stageAttachment } from "./attachments.js";
import type { FleetAgent } from "./snapshot.js";

export type StatusArgs = {
  json: boolean;
  pretty: boolean;
  color: boolean | undefined; // undefined ⇒ auto (TTY && !NO_COLOR)
  all: boolean;
  width: number | undefined;
  project: string | undefined;
  log: boolean; // append the comms-log (cross-fleet message feed)
  limit: number | undefined; // comms-log message cap (-n / --limit)
  help: boolean;
};

const DEFAULT_LOG_LIMIT = 20;

export const USAGE = `oxtail status — print the agent fleet once and exit
oxtail oxpit  — live interactive fleet cockpit (separate terminal)

status flags:
  --json [--pretty]   machine-readable snapshot (CI / scripting)
  --log [-n N]        append the cross-fleet comms-log (recent message tail)
  --color | --no-color
  --all               include agents from every project, not just this one
  --width N           override output width
  --project PATH      scope to a specific project root
  -h, --help          this help

oxpit keys:  ↑/k ↓/j move · ⏎ jump to pane · l comms-log · r refresh · ? help · q quit
oxpit flags: --no-color, --all, --project PATH, --client NAME (which tmux
             client the jump drives when several are attached)`;

export function parseStatusArgs(argv: string[]): StatusArgs {
  const a: StatusArgs = {
    json: false,
    pretty: false,
    color: undefined,
    all: false,
    width: undefined,
    project: undefined,
    log: false,
    limit: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--pretty":
        a.pretty = true;
        break;
      case "--color":
        a.color = true;
        break;
      case "--no-color":
        a.color = false;
        break;
      case "--all":
        a.all = true;
        break;
      case "--log":
        a.log = true;
        break;
      case "-n":
      case "--limit":
        a.limit = Number(argv[++i]);
        break;
      case "--width":
        a.width = Number(argv[++i]);
        break;
      case "--project":
        a.project = argv[++i];
        break;
      default:
        if (arg.startsWith("--width=")) a.width = Number(arg.slice("--width=".length));
        else if (arg.startsWith("--project=")) a.project = arg.slice("--project=".length);
        else if (arg.startsWith("--limit=")) a.limit = Number(arg.slice("--limit=".length));
        // unknown flags are ignored (forward-compat with the TUI's own flags)
        break;
    }
  }
  return a;
}

function autoColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

// `oxtail status` — print the fleet snapshot once and exit. Scriptable
// (`watch -n1 oxtail status`), CI-friendly (`--json`), no TTY required.
export function runStatus(
  argv: string[],
  out: (line: string) => void = (s) => process.stdout.write(s + "\n"),
): number {
  const a = parseStatusArgs(argv);
  if (a.help) {
    out(USAGE);
    return 0;
  }
  const snap = buildSnapshot({ allProjects: a.all, projectRoot: a.project });
  const limit = a.limit && Number.isFinite(a.limit) && a.limit > 0 ? a.limit : DEFAULT_LOG_LIMIT;
  if (a.json) {
    // --log adds a `comms` array (full bodies) alongside the snapshot, so the
    // machine-readable form is a superset, not a separate shape.
    const payload = a.log ? { ...snap, comms: buildCommsLog(snap.agents, { limit }) } : snap;
    out(JSON.stringify(payload, null, a.pretty ? 2 : 0));
    return 0;
  }
  const color = a.color ?? autoColor();
  const width = a.width && Number.isFinite(a.width) ? a.width : process.stdout.columns || 100;
  out(renderSnapshot(snap, { color, width }));
  if (a.log) {
    const { bySession } = computeAgentLabels(snap.agents);
    out("");
    out(renderCommsLog(buildCommsLog(snap.agents, { limit }), bySession, { color, width }));
  }
  return 0;
}

// ── oxtail message — operator send (act-from-cockpit, one-shot) ────────────────

export const MESSAGE_USAGE = `oxtail message <target> <message…>            — message one agent
oxtail message <target> --nudge               — canned "check your work" nudge
oxtail message <target> --attach <path> [msg] — attach a file (staged; agent reads it)
oxtail message --broadcast --yes <message…>   — send to every live agent in scope

target: a session id, short id, or tmux window name (see oxtail status)
flags:  --nudge  --attach <path> (repeatable)  --no-wake  --broadcast --yes [--cap N]
        [--include-main]  --all  --project PATH

Operator messages are human-authorized but untrusted transport: they carry no agent
identity (origin=operator), are one-way (the recipient cannot reply to them), and
reuse the same delivery + wake path as peer messages.`;

const BROADCAST_CAP_DEFAULT = 10;

type MessageArgs = {
  positionals: string[];
  nudge: boolean;
  noWake: boolean;
  broadcast: boolean;
  yes: boolean;
  cap: number;
  all: boolean;
  project: string | undefined;
  includeMain: boolean; // include your own/main session in a broadcast
  attach: string[]; // file paths to stage + attach (repeatable --attach)
  help: boolean;
};

export function parseMessageArgs(argv: string[]): MessageArgs {
  const a: MessageArgs = {
    positionals: [],
    nudge: false,
    noWake: false,
    broadcast: false,
    yes: false,
    cap: BROADCAST_CAP_DEFAULT,
    all: false,
    project: undefined,
    includeMain: false,
    attach: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") a.help = true;
    else if (arg === "--nudge") a.nudge = true;
    else if (arg === "--no-wake") a.noWake = true;
    else if (arg === "--broadcast") a.broadcast = true;
    else if (arg === "--yes" || arg === "-y") a.yes = true;
    else if (arg === "--include-main") a.includeMain = true;
    else if (arg === "--attach") a.attach.push(argv[++i] ?? "");
    else if (arg.startsWith("--attach=")) a.attach.push(arg.slice("--attach=".length));
    else if (arg === "--all") a.all = true;
    else if (arg === "--cap") a.cap = Number(argv[++i]);
    else if (arg.startsWith("--cap=")) a.cap = Number(arg.slice("--cap=".length));
    else if (arg === "--project") a.project = argv[++i];
    else if (arg.startsWith("--project=")) a.project = arg.slice("--project=".length);
    else a.positionals.push(arg);
  }
  return a;
}

function targetOf(ag: FleetAgent): OperatorTarget {
  return {
    session_id: ag.session_id,
    server_pid: ag.server_pid,
    short_id: ag.window_name ?? ag.short_id,
  };
}

// Resolve a target string to exactly one in-scope agent: session_id, then short_id,
// then window name. Ambiguity is surfaced, never guessed.
function resolveAgent(
  agents: FleetAgent[],
  target: string,
): { agent?: FleetAgent; error?: string } {
  for (const key of [
    (a: FleetAgent) => a.session_id === target,
    (a: FleetAgent) => a.short_id === target,
    (a: FleetAgent) => a.window_name === target,
  ]) {
    const m = agents.filter(key);
    if (m.length === 1) return { agent: m[0] };
    if (m.length > 1) {
      return {
        error: `ambiguous target '${target}' — matches ${m.length} agents; address it by session id`,
      };
    }
  }
  return { error: `no agent matches '${target}' in scope — see 'oxtail status' for ids/names` };
}

function formatResult(r: OperatorSendResult): string {
  if (!r.ok) return `✗ ${r.target_short_id}: ${r.reason}`;
  const wake = r.wake_status ? ` · wake:${r.wake_status}` : "";
  const unc = r.unclaimed ? " · unclaimed (pid-box, no reply handle)" : "";
  return `✓ operator → ${r.target_short_id}  (${r.message_id})${wake}${unc}`;
}

// Stage every --attach path; fail-closed (don't send a partial attachment set).
// Returns the body note to append (empty if no attachments).
function stageAll(paths: string[]): { ok: true; note: string } | { ok: false; reason: string } {
  const staged = [];
  for (const p of paths) {
    if (!p.trim()) continue;
    const r = stageAttachment(p);
    if (!r.ok) return { ok: false, reason: `attach '${p}': ${r.reason}` };
    staged.push(r.attachment);
  }
  return { ok: true, note: formatAttachmentNote(staged) };
}

export async function runMessage(
  argv: string[],
  out: (line: string) => void = (s) => process.stdout.write(s + "\n"),
): Promise<number> {
  const a = parseMessageArgs(argv);
  if (a.help) {
    out(MESSAGE_USAGE);
    return 0;
  }
  const snap = buildSnapshot({ allProjects: a.all, projectRoot: a.project });

  if (a.broadcast) {
    const baseBody = a.nudge ? NUDGE_TEXT : a.positionals.join(" ");
    if (!baseBody.trim() && a.attach.length === 0) {
      out("error: empty message (give text, --nudge, or --attach)");
      return 1;
    }
    // Live + claimed only; dead/unclaimed excluded; and your OWN/main session is
    // excluded unless --include-main (codex guardrail: don't blast your own thread).
    const targets = snap.agents.filter(
      (ag) => ag.liveness !== "dead" && ag.session_id && (a.includeMain || !ag.is_self),
    );
    if (targets.length === 0) {
      out("no live, claimed agents to broadcast to in scope (main excluded; --include-main to add)");
      return 1;
    }
    // A malformed --cap (NaN / ≤0) must FAIL CLOSED to the default, not disable the
    // storm guard: `N > NaN` is always false, which would uncap the broadcast.
    const cap = Number.isFinite(a.cap) && a.cap > 0 ? a.cap : BROADCAST_CAP_DEFAULT;
    if (targets.length > cap) {
      out(`refusing broadcast: ${targets.length} recipients exceeds cap ${cap} (raise with --cap N)`);
      return 1;
    }
    const names = targets.map((t) => t.window_name ?? t.short_id).join(", ");
    if (!a.yes) {
      const att = a.attach.length ? ` + ${a.attach.length} attachment(s)` : "";
      out(`broadcast to ${targets.length} agent(s)${att}: ${names}`);
      out("re-run with --yes to send.");
      return 1;
    }
    const staged = stageAll(a.attach); // stage only on the actual send
    if (!staged.ok) {
      out("error: " + staged.reason);
      return 1;
    }
    const body = baseBody + staged.note;
    let failures = 0;
    for (const ag of targets) {
      const r = await sendOperatorMessage(targetOf(ag), body, { wake: !a.noWake });
      if (!r.ok) failures++;
      out(formatResult(r));
    }
    return failures === 0 ? 0 : 1;
  }

  const target = a.positionals[0];
  if (!target) {
    out(MESSAGE_USAGE);
    return 1;
  }
  const staged = stageAll(a.attach);
  if (!staged.ok) {
    out("error: " + staged.reason);
    return 1;
  }
  const body = (a.nudge ? NUDGE_TEXT : a.positionals.slice(1).join(" ")) + staged.note;
  if (!body.trim()) {
    out("error: empty message (give text, --nudge, or --attach)");
    return 1;
  }
  const res = resolveAgent(snap.agents, target);
  if (!res.agent) {
    out("error: " + res.error);
    return 1;
  }
  const r = await sendOperatorMessage(targetOf(res.agent), body, { wake: !a.noWake });
  out(formatResult(r));
  return r.ok ? 0 : 1;
}

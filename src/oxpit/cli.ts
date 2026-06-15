// oxpit CLI surface: `oxtail status` (one-shot snapshot) and `oxtail oxpit`
// (interactive TUI). Both are thin wrappers over the pure snapshot/render layer.

import { buildSnapshot } from "./snapshot.js";
import { computeAgentLabels, renderCommsLog, renderSnapshot } from "./render.js";
import { buildCommsLog } from "./comms.js";

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

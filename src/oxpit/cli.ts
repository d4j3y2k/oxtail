// oxpit CLI surface: `oxtail status` (one-shot snapshot) and `oxtail oxpit`
// (interactive TUI). Both are thin wrappers over the pure snapshot/render layer.

import { buildSnapshot } from "./snapshot.js";
import { renderSnapshot } from "./render.js";

export type StatusArgs = {
  json: boolean;
  pretty: boolean;
  color: boolean | undefined; // undefined ⇒ auto (TTY && !NO_COLOR)
  all: boolean;
  width: number | undefined;
  project: string | undefined;
};

export function parseStatusArgs(argv: string[]): StatusArgs {
  const a: StatusArgs = {
    json: false,
    pretty: false,
    color: undefined,
    all: false,
    width: undefined,
    project: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
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
      case "--width":
        a.width = Number(argv[++i]);
        break;
      case "--project":
        a.project = argv[++i];
        break;
      default:
        if (arg.startsWith("--width=")) a.width = Number(arg.slice("--width=".length));
        else if (arg.startsWith("--project=")) a.project = arg.slice("--project=".length);
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
  const snap = buildSnapshot({ allProjects: a.all, projectRoot: a.project });
  if (a.json) {
    out(JSON.stringify(snap, null, a.pretty ? 2 : 0));
    return 0;
  }
  const color = a.color ?? autoColor();
  const width = a.width && Number.isFinite(a.width) ? a.width : process.stdout.columns || 100;
  out(renderSnapshot(snap, { color, width }));
  return 0;
}

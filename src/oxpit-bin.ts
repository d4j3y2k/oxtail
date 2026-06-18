#!/usr/bin/env node
// Standalone `oxpit` command — the fleet cockpit, runnable directly once oxtail is
// installed (`npm i -g oxtail` → `oxpit`, or `node_modules/.bin/oxpit` when oxtail
// is a repo dependency). Equivalent to `oxtail oxpit`: it auto-scopes to the project
// of whatever directory you run it in, so no per-repo configuration is needed.
//
// Kept as a thin, dedicated entry (rather than basename-sniffing the shared oxtail
// bin) so routing is unambiguous across npm bin shims and platforms. All behavior +
// the terminal-restore backstop live in runOxpitCli.
import { runOxpitCli } from "./oxpit/tui.js";

process.exit(await runOxpitCli(process.argv.slice(2)));

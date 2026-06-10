// Guards against doc version drift — the failure mode where README install
// snippets kept recommending `oxtail@0.10.1` (and curl/blob links pinned
// v0.13.0) six releases after those shipped. Every user-facing pin and
// versioned GitHub link must track package.json. Historical era markers like
// "## Peer messaging (v0.5)" are deliberately NOT matched: only `oxtail@X.Y.Z`
// pins, `/oxtail/vX.Y.Z/` URL segments, and the two status lines are pinned.
// Runs in `npm test`, so a version-bump PR fails CI until the docs move too.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pkgVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const agents = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");

test("README oxtail@<version> install pins match package.json", () => {
  const pins = [...readme.matchAll(/oxtail@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
  assert.ok(pins.length > 0, "expected at least one oxtail@<version> pin in README");
  for (const pin of pins) {
    assert.equal(
      pin,
      pkgVersion,
      `README pins oxtail@${pin} but package.json is ${pkgVersion} — update the install snippets`,
    );
  }
});

test("README versioned GitHub links match package.json", () => {
  const links = [...readme.matchAll(/d4j3y2k\/oxtail\/(?:blob\/)?v(\d+\.\d+\.\d+)\//g)].map(
    (m) => m[1],
  );
  assert.ok(links.length > 0, "expected at least one versioned GitHub link in README");
  for (const v of links) {
    assert.equal(
      v,
      pkgVersion,
      `README links to tag v${v} but package.json is ${pkgVersion} — update the curl/blob URLs`,
    );
  }
});

test("README Status section leads with the current version", () => {
  const m = /^## Status\n\n(v\d+\.\d+\.\d+)\./m.exec(readme);
  assert.ok(m, "README ## Status section must open with `vX.Y.Z.`");
  assert.equal(
    m![1],
    `v${pkgVersion}`,
    `README Status says ${m![1]} but package.json is ${pkgVersion}`,
  );
});

test("AGENTS.md status heading matches the current version", () => {
  const m = /^## Status: (v\d+\.\d+\.\d+)/m.exec(agents);
  assert.ok(m, "AGENTS.md must have a `## Status: vX.Y.Z` heading");
  assert.equal(
    m![1],
    `v${pkgVersion}`,
    `AGENTS.md status says ${m![1]} but package.json is ${pkgVersion}`,
  );
});

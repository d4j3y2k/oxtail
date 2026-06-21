// Guards against doc version drift — the failure mode where README install
// snippets kept recommending `oxtail@0.10.1` (and curl/blob links pinned
// v0.13.0) six releases after those shipped. Every user-facing pin and any
// versioned GitHub link must track package.json, and the canonical changelog
// must lead with the current release.
//
// Doc architecture note (v0.23.0+ restructure): the README links to its siblings
// (AGENTS.md, CHANGELOG.md, SECURITY.md, docs/*.md) with RELATIVE links, which
// ship in the npm tarball (see package.json `files`) and so are inherently
// version-correct — there is no longer a *required* versioned GitHub link in the
// README. The release-history "leads with the current version" check moved from
// the old inline `## Status` section to CHANGELOG.md, where the history now lives.
// Historical era markers ("## Peer messaging (v0.5)") are deliberately NOT matched.
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
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

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

test("README versioned GitHub links match package.json (if any)", () => {
  // The README now uses relative links (version-correct in the tarball), so a
  // versioned GitHub link is no longer required — but any that appear must still
  // track package.json, or they rot the way blob/v0.13.0 links did historically.
  const links = [
    ...readme.matchAll(/d4j3y2k\/oxtail\/(?:blob\/|raw\/)?v(\d+\.\d+\.\d+)\//g),
  ].map((m) => m[1]);
  for (const v of links) {
    assert.equal(
      v,
      pkgVersion,
      `README links to tag v${v} but package.json is ${pkgVersion} — update the curl/blob URLs`,
    );
  }
});

test("CHANGELOG.md leads with the current version", () => {
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  assert.ok(m, "CHANGELOG.md must have a `## [X.Y.Z]` entry");
  assert.equal(
    m![1],
    pkgVersion,
    `CHANGELOG.md top entry is ${m![1]} but package.json is ${pkgVersion} — add the release entry`,
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

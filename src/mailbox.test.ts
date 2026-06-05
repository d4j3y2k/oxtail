import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import * as mailbox from "./mailbox.js";

const TSX_BIN = resolve(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

// homedir() defers to $HOME on POSIX; mailbox.ts resolves its dir lazily on
// every call. Swapping HOME between tests is enough to isolate them.
function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "oxtail-mbox-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

test("mailbox: enqueue then drain returns one message; file empty after", () => {
  withHome(() => {
    const pid = 11111;
    const msg = mailbox.enqueue(pid, "hello");
    assert.equal(msg.body, "hello");
    assert.equal(msg.schema_version, 1);
    assert.match(msg.id, /^[0-9a-f]{16}$/);

    const drained = mailbox.drain(pid);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].body, "hello");
    assert.equal(drained[0].id, msg.id);

    const mboxFile = mailbox.mailboxFilePath(pid);
    assert.equal(readFileSync(mboxFile, "utf8"), "", "mailbox file empty after drain");
  });
});

test("mailbox: three enqueues drain in append order; ids unique", () => {
  withHome(() => {
    const pid = 22222;
    mailbox.enqueue(pid, "one");
    mailbox.enqueue(pid, "two");
    mailbox.enqueue(pid, "three");
    const drained = mailbox.drain(pid);
    assert.equal(drained.length, 3);
    assert.deepEqual(drained.map((m) => m.body), ["one", "two", "three"]);
    const ids = new Set(drained.map((m) => m.id));
    assert.equal(ids.size, 3, "ids must be unique");
  });
});

test("mailbox: drain on missing file returns []", () => {
  withHome(() => {
    assert.deepEqual(mailbox.drain(33333), []);
  });
});

test("mailbox: drain on empty file returns []", () => {
  withHome((home) => {
    const pid = 44444;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${pid}.jsonl`), "");
    assert.deepEqual(mailbox.drain(pid), []);
  });
});

test("mailbox: drain skips malformed line and returns surrounding valid ones", () => {
  withHome(() => {
    const pid = 55555;
    mailbox.enqueue(pid, "before");
    const mboxFile = mailbox.mailboxFilePath(pid);
    writeFileSync(mboxFile, readFileSync(mboxFile, "utf8") + "this is not json\n");
    mailbox.enqueue(pid, "after");
    const drained = mailbox.drain(pid);
    assert.equal(drained.length, 2);
    assert.deepEqual(drained.map((m) => m.body), ["before", "after"]);
  });
});

test('mailbox: body survives escapes ("\\"", "\\\\", "\\n", "🦊")', () => {
  withHome(() => {
    const pid = 66666;
    const cases = [`a"b`, `a\\b`, `a\nb`, "🦊"];
    for (const c of cases) mailbox.enqueue(pid, c);
    const drained = mailbox.drain(pid);
    assert.equal(drained.length, cases.length);
    assert.deepEqual(drained.map((m) => m.body), cases);
  });
});

test("mailbox: 50-process concurrent enqueue — all 50 survive (regression net)", async () => {
  // Each child process writes one message under a fresh acquireLock+enqueue+
  // releaseLock cycle. If the mkdir lock is broken or appends race, we'll see
  // fewer than 50 survivors.
  const home = mkdtempSync(join(tmpdir(), "oxtail-mbox-"));
  try {
    const pid = 77777;
    const N = 50;
    const fixture = resolve(import.meta.dirname, "mailbox.concurrency-fixture.ts");
    writeFileSync(
      fixture,
      [
        `import { enqueue } from "./mailbox.ts";`,
        `const targetPid = Number(process.argv[2]);`,
        `const body = process.argv[3];`,
        `const msg = enqueue(targetPid, body);`,
        `process.stdout.write(msg.id + "\\n");`,
        ``,
      ].join("\n"),
    );
    try {
      const children: Promise<{ id: string; code: number; stderr: string }>[] = [];
      for (let i = 0; i < N; i++) {
        const body = `msg-${i}`;
        children.push(
          new Promise((resolveChild) => {
            const child = spawn(TSX_BIN, [fixture, String(pid), body], {
              env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" },
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (c) => { stdout += c; });
            child.stderr.on("data", (c) => { stderr += c; });
            child.on("close", (code) => resolveChild({ id: stdout.trim(), code: code ?? 0, stderr }));
          }),
        );
      }
      const results = await Promise.all(children);
      for (const r of results) {
        assert.equal(r.code, 0, `child failed: ${r.stderr}`);
      }
      // Read directly with our own drain pointed at the temp HOME.
      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        const drained = mailbox.drain(pid);
        assert.equal(drained.length, N, `expected ${N} survivors, got ${drained.length}`);
        const bodies = new Set(drained.map((m) => m.body));
        for (let i = 0; i < N; i++) {
          assert.ok(bodies.has(`msg-${i}`), `missing msg-${i}`);
        }
      } finally {
        process.env.HOME = prev;
      }
    } finally {
      try { rmSync(fixture); } catch { /* best effort */ }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("mailbox: field-order invariant — schema_version, id, body in order on every line", () => {
  withHome(() => {
    const pid = 88888;
    mailbox.enqueue(pid, "abc", "session-uuid");
    const raw = readFileSync(mailbox.mailboxFilePath(pid), "utf8");
    const firstLine = raw.split("\n")[0];
    assert.match(firstLine, /^\{"schema_version":1,"id":"[0-9a-f]{16}","body":"/);
    const parsed = JSON.parse(firstLine);
    const keys = Object.keys(parsed);
    assert.deepEqual(keys, [
      "schema_version",
      "id",
      "body",
      "enqueued_at",
      "body_bytes",
      "origin",
      "from_session_id",
    ]);
    assert.equal(parsed.body_bytes, 3);
    assert.equal(parsed.origin, "peer");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// drainMatchingSession (v0.6 — ask_peer reply pickup)
// ────────────────────────────────────────────────────────────────────────────

test("drainMatchingSession: single matching message returned; file empty", () => {
  withHome(() => {
    const pid = 100001;
    const sid = "sender-session-aaaa";
    mailbox.enqueue(pid, "from-sender", sid);
    const matched = mailbox.drainMatchingSession(pid, sid);
    assert.ok(matched, "should match");
    assert.equal(matched!.body, "from-sender");
    assert.equal(matched!.from_session_id, sid);
    assert.equal(
      readFileSync(mailbox.mailboxFilePath(pid), "utf8"),
      "",
      "file truncated when only message removed",
    );
  });
});

test("drainMatchingSession: non-matching from_session_id leaves file untouched", () => {
  withHome(() => {
    const pid = 100002;
    mailbox.enqueue(pid, "from-other", "other-session");
    const before = readFileSync(mailbox.mailboxFilePath(pid), "utf8");
    const matched = mailbox.drainMatchingSession(pid, "wanted-session");
    assert.equal(matched, null);
    assert.equal(
      readFileSync(mailbox.mailboxFilePath(pid), "utf8"),
      before,
      "file unchanged",
    );
  });
});

test("drainMatchingSession: middle match removed, others preserved byte-exact", () => {
  withHome(() => {
    const pid = 100003;
    mailbox.enqueue(pid, "first", "peer-a");
    mailbox.enqueue(pid, "target", "peer-b");
    mailbox.enqueue(pid, "third", "peer-c");
    const beforeLines = readFileSync(mailbox.mailboxFilePath(pid), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    const targetLine = beforeLines[1];

    const matched = mailbox.drainMatchingSession(pid, "peer-b");
    assert.ok(matched, "must match");
    assert.equal(matched!.body, "target");

    const afterLines = readFileSync(mailbox.mailboxFilePath(pid), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    assert.equal(afterLines.length, 2);
    // Byte-exact: surviving lines must equal their pre-drain bytes (not just JSON-equivalent).
    assert.equal(afterLines[0], beforeLines[0], "first line byte-exact");
    assert.equal(afterLines[1], beforeLines[2], "third line byte-exact");
    assert.notEqual(afterLines.includes(targetLine), true, "matched line is gone");

    // FIELD_ORDER_PREFIX invariant must hold on every surviving line.
    for (const line of afterLines) {
      assert.match(
        line,
        /^\{"schema_version":1,"id":"[0-9a-f]{16}","body":"/,
        `survived line preserves FIELD_ORDER_PREFIX: ${line}`,
      );
    }
  });
});

test("drainMatchingSession: returns first match when multiple candidates", () => {
  withHome(() => {
    const pid = 100004;
    mailbox.enqueue(pid, "first-reply", "peer-x");
    mailbox.enqueue(pid, "interloper", "peer-y");
    mailbox.enqueue(pid, "second-reply", "peer-x");
    const matched = mailbox.drainMatchingSession(pid, "peer-x");
    assert.ok(matched);
    assert.equal(matched!.body, "first-reply", "earliest match returned");

    // Remaining mailbox: interloper + second-reply, in that order.
    const remaining = mailbox.drain(pid);
    assert.deepEqual(
      remaining.map((m) => m.body),
      ["interloper", "second-reply"],
    );
  });
});

test("drainMatchingSession: missing file returns null", () => {
  withHome(() => {
    const matched = mailbox.drainMatchingSession(100005, "any-session");
    assert.equal(matched, null);
  });
});

test("drainMatchingSession: empty file returns null", () => {
  withHome((home) => {
    const pid = 100006;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${pid}.jsonl`), "");
    const matched = mailbox.drainMatchingSession(pid, "any-session");
    assert.equal(matched, null);
  });
});

test("drainMatchingSession: messages without from_session_id are never matched", () => {
  withHome(() => {
    const pid = 100007;
    mailbox.enqueue(pid, "anonymous"); // no from_session_id
    const matched = mailbox.drainMatchingSession(pid, "anything");
    assert.equal(matched, null);
    // The anonymous message remains.
    const drained = mailbox.drain(pid);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].body, "anonymous");
  });
});

// v0.6 ask_peer stale-reply guard: ask_peer calls drainMatchingSession in a
// loop before enqueueing the outbound so any pre-existing messages from the
// target are evicted (they can't be replies to a question we haven't asked).
// This test exercises the loop-drain pattern.
test("drainMatchingSession: loop drains all matching, leaves non-matching untouched", () => {
  withHome(() => {
    const pid = 100008;
    mailbox.enqueue(pid, "stale-1", "peer-x");
    mailbox.enqueue(pid, "from-other", "peer-y");
    mailbox.enqueue(pid, "stale-2", "peer-x");
    mailbox.enqueue(pid, "stale-3", "peer-x");

    let drainedCount = 0;
    const drainedBodies: string[] = [];
    while (true) {
      const m = mailbox.drainMatchingSession(pid, "peer-x");
      if (!m) break;
      drainedCount++;
      drainedBodies.push(m.body);
    }
    assert.equal(drainedCount, 3, "three matching messages drained");
    assert.deepEqual(drainedBodies, ["stale-1", "stale-2", "stale-3"], "drained in append order");

    // peer-y's message survives byte-exact.
    const remaining = mailbox.drain(pid);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].body, "from-other");
    assert.equal(remaining[0].from_session_id, "peer-y");
  });
});

test("drainMatchingReply: matches from_session_id plus reply_to, leaves uncorrelated messages", () => {
  withHome(() => {
    const pid = 100009;
    mailbox.enqueue(pid, "placeholder", "peer-x");
    mailbox.enqueue(pid, "wrong request", "peer-x", { reply_to: "req-other" });
    mailbox.enqueue(pid, "right reply", "peer-x", { reply_to: "req-1" });
    mailbox.enqueue(pid, "after", "peer-y", { reply_to: "req-1" });

    const matched = mailbox.drainMatchingReply(pid, "peer-x", "req-1");
    assert.ok(matched);
    assert.equal(matched!.body, "right reply");
    assert.equal(matched!.reply_to, "req-1");

    const remaining = mailbox.drain(pid);
    assert.deepEqual(
      remaining.map((m) => m.body),
      ["placeholder", "wrong request", "after"],
      "non-matching messages are not consumed",
    );
  });
});

test("mailbox: stale lock (mtime 60s ago) is force-cleared and enqueue proceeds", () => {
  withHome((home) => {
    const pid = 99999;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = mailbox.mailboxLockPath(pid);
    mkdirSync(lock, { mode: 0o700 });
    const old = Math.floor((Date.now() - 60_000) / 1000);
    utimesSync(lock, old, old);

    const before = Date.now();
    const msg = mailbox.enqueue(pid, "after stale clear");
    const elapsed = Date.now() - before;
    assert.ok(elapsed < 1000, `enqueue took ${elapsed}ms — should be near-instant after stale clear`);
    assert.equal(msg.body, "after stale clear");
    assert.equal(existsSync(lock), false, "lock dir cleaned up after enqueue");
  });
});

// Real multi-process contention on a PRE-STALED lock: every child must steal-
// recover and enqueue without losing an append or deadlocking. The single-winner
// steal marker (locks.ts) guarantees only one clearer removes the stale lock, so
// no child rmdir's another's fresh lock. All N messages must survive, and no
// lock/steal residue may remain.
test("mailbox: N processes contend on a stale lock — all survive, no residue", async () => {
  const home = mkdtempSync(join(tmpdir(), "oxtail-mbox-"));
  try {
    const pid = 88001;
    const N = 20;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Pre-create a STALE lock so every child enters the steal-recovery path.
    const lock = join(dir, `${pid}.jsonl.lock`);
    mkdirSync(lock, { mode: 0o700 });
    const old = Math.floor((Date.now() - 60_000) / 1000);
    utimesSync(lock, old, old);

    const fixture = resolve(import.meta.dirname, "mailbox.stale-contention-fixture.ts");
    writeFileSync(
      fixture,
      [
        `import { enqueue } from "./mailbox.ts";`,
        `const msg = enqueue(Number(process.argv[2]), process.argv[3]);`,
        `process.stdout.write(msg.id + "\\n");`,
        ``,
      ].join("\n"),
    );
    try {
      const children = Array.from({ length: N }, (_, i) =>
        new Promise<{ code: number; stderr: string }>((resolveChild) => {
          const child = spawn(TSX_BIN, [fixture, String(pid), `msg-${i}`], {
            env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" },
          });
          let stderr = "";
          child.stderr.on("data", (c) => { stderr += c; });
          child.on("close", (code) => resolveChild({ code: code ?? 0, stderr }));
        }),
      );
      const results = await Promise.all(children);
      for (const r of results) assert.equal(r.code, 0, `child failed: ${r.stderr}`);

      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        const drained = mailbox.drain(pid);
        assert.equal(drained.length, N, `expected ${N} survivors, got ${drained.length}`);
        const bodies = new Set(drained.map((m) => m.body));
        for (let i = 0; i < N; i++) assert.ok(bodies.has(`msg-${i}`), `missing msg-${i}`);
      } finally {
        process.env.HOME = prev;
      }
      assert.equal(existsSync(lock), false, "stale lock fully cleared");
      assert.equal(existsSync(`${lock}.steal`), false, "no steal-marker residue");
    } finally {
      try { rmSync(fixture); } catch { /* best effort */ }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────────────
// drainMany / mailboxHasMessages / requeue / migrateMailbox
// (session_id union drain + dead-sibling consolidation)
// ────────────────────────────────────────────────────────────────────────────

test("drainMany: unions multiple pid mailboxes in pid order; both emptied", () => {
  withHome(() => {
    mailbox.enqueue(201, "a1");
    mailbox.enqueue(201, "a2");
    mailbox.enqueue(202, "b1");
    const { messages, skipped } = mailbox.drainMany([201, 202]);
    assert.equal(skipped, 0);
    assert.deepEqual(messages.map((m) => m.body), ["a1", "a2", "b1"]);
    assert.deepEqual(mailbox.drain(201), []);
    assert.deepEqual(mailbox.drain(202), []);
  });
});

test("drainMany: duplicate pids are drained once", () => {
  withHome(() => {
    mailbox.enqueue(203, "only");
    const { messages } = mailbox.drainMany([203, 203]);
    assert.deepEqual(messages.map((m) => m.body), ["only"]);
  });
});

test("drainMany: a contended mailbox lock is skipped, not fatal", () => {
  withHome(() => {
    mailbox.enqueue(204, "readable");
    mailbox.enqueue(205, "blocked");
    // Hold a FRESH (non-stale) lock on 205 so drain(205) cannot acquire it.
    const lock = mailbox.mailboxLockPath(205);
    mkdirSync(lock, { recursive: true, mode: 0o700 });
    try {
      const { messages, skipped } = mailbox.drainMany([204, 205]);
      assert.deepEqual(messages.map((m) => m.body), ["readable"]);
      assert.equal(skipped, 1, "the locked mailbox is reported as skipped");
    } finally {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
    // 205 still holds its message for the next poll — nothing lost.
    assert.deepEqual(mailbox.drain(205).map((m) => m.body), ["blocked"]);
  });
});

test("mailboxHasMessages: true with mail; false when missing/empty/after drain", () => {
  withHome(() => {
    assert.equal(mailbox.mailboxHasMessages(206), false, "missing file");
    mailbox.enqueue(206, "x");
    assert.equal(mailbox.mailboxHasMessages(206), true);
    mailbox.drain(206);
    assert.equal(mailbox.mailboxHasMessages(206), false, "empty after drain");
  });
});

test("requeue: re-appends an existing message without minting a new id", () => {
  withHome(() => {
    const orig = mailbox.enqueue(207, "hello", "peer-z", { reply_to: "req-9" });
    const drained = mailbox.drain(207);
    assert.equal(drained.length, 1);
    mailbox.requeue(207, drained[0]);
    const again = mailbox.drain(207);
    assert.equal(again.length, 1);
    assert.equal(again[0].id, orig.id, "same id preserved");
    assert.equal(again[0].body, "hello");
    assert.equal(again[0].reply_to, "req-9");
    assert.equal(again[0].from_session_id, "peer-z");
  });
});

test("migrateMailbox: appends source lines byte-exact into dest tail; empties source", () => {
  withHome(() => {
    const from = 301;
    const to = 302;
    mailbox.enqueue(to, "dest-existing");
    mailbox.enqueue(from, "m1", "peer-a", { request_id: "r1" });
    mailbox.enqueue(from, "m2", "peer-b");
    const srcRaw = readFileSync(mailbox.mailboxFilePath(from), "utf8");

    const moved = mailbox.migrateMailbox(from, to);
    assert.equal(moved, 2);
    assert.equal(mailbox.mailboxHasMessages(from), false, "source emptied");

    const destRaw = readFileSync(mailbox.mailboxFilePath(to), "utf8");
    assert.ok(destRaw.endsWith(srcRaw), "source lines appended byte-exact to dest tail");

    const destDrained = mailbox.drain(to);
    assert.deepEqual(destDrained.map((m) => m.body), ["dest-existing", "m1", "m2"]);
    assert.equal(destDrained[1].request_id, "r1");
    assert.equal(destDrained[2].from_session_id, "peer-b");
  });
});

test("migrateMailbox: empty/missing source and same-pid are no-ops (return 0)", () => {
  withHome(() => {
    assert.equal(mailbox.migrateMailbox(303, 304), 0, "missing source");
    mailbox.enqueue(305, "x");
    assert.equal(mailbox.migrateMailbox(305, 305), 0, "same pid no-op");
    assert.deepEqual(mailbox.drain(305).map((m) => m.body), ["x"], "305 untouched");
  });
});

test("migrateMailbox: a re-migrate of an already-drained source delivers exactly once", () => {
  withHome(() => {
    mailbox.enqueue(401, "x");
    assert.equal(mailbox.migrateMailbox(401, 402), 1);
    // Source was truncated under lock; a second migrate finds nothing.
    assert.equal(mailbox.migrateMailbox(401, 402), 0, "nothing re-migrated");
    assert.deepEqual(
      mailbox.drain(402).map((m) => m.body),
      ["x"],
      "delivered exactly once, no duplicate",
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Crash-consistency: torn appends must not glue records; rewrites are atomic
// (compile-sim Finding 2 + Codex round-1 NEW findings)
// ────────────────────────────────────────────────────────────────────────────

// appendFileSync of a buffer is not atomic; a crash mid-write can leave a file
// ending in a partial line with NO trailing "\n". The next append must not
// concatenate onto that partial line — doing so glues two JSONL records into one
// unparseable line and drain() then drops BOTH. Every append path heals this.
test("mailbox: enqueue after a torn line (no trailing newline) does not glue/eat it", () => {
  withHome((home) => {
    const pid = 70001;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A crash-torn append: a partial JSONL record, no trailing newline.
    writeFileSync(
      join(dir, `${pid}.jsonl`),
      '{"schema_version":1,"id":"deadbeefdeadbeef","body":"tor',
    );
    mailbox.enqueue(pid, "survivor");
    const drained = mailbox.drain(pid);
    // The torn record is unrecoverable, but the new message must survive intact.
    assert.equal(drained.length, 1, "new message survives; not glued into the torn line");
    assert.equal(drained[0].body, "survivor");
  });
});

test("requeue: re-append onto a torn tail does not glue", () => {
  withHome((home) => {
    const pid = 70004;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${pid}.jsonl`),
      '{"schema_version":1,"id":"aaaaaaaaaaaaaaaa","body":"tor',
    );
    const msg = mailbox.buildMessage("requeued", "peer-q");
    mailbox.requeue(pid, msg);
    const drained = mailbox.drain(pid);
    assert.equal(drained.length, 1);
    assert.equal(drained[0].id, msg.id, "id preserved");
    assert.equal(drained[0].body, "requeued");
  });
});

test("migrateMailbox: append onto a torn dest tail does not glue", () => {
  withHome((home) => {
    const to = 70002;
    const from = 70003;
    const dir = join(home, ".oxtail", "mailboxes");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, `${to}.jsonl`),
      '{"schema_version":1,"id":"bbbbbbbbbbbbbbbb","body":"tor',
    );
    mailbox.enqueue(from, "moved");
    mailbox.migrateMailbox(from, to);
    const drained = mailbox.drain(to);
    assert.equal(drained.length, 1, "migrated message survives the torn dest tail");
    assert.equal(drained[0].body, "moved");
  });
});

// drainFirstMatching rewrites the surviving lines; a torn writeFileSync there can
// lose unrelated messages. The atomic tmp+rename rewrite leaves no temp residue.
test("drainFirstMatching: atomic rewrite leaves no .tmp residue", () => {
  withHome((home) => {
    const pid = 70005;
    mailbox.enqueue(pid, "first", "peer-a");
    mailbox.enqueue(pid, "target", "peer-b");
    mailbox.enqueue(pid, "third", "peer-c");
    const matched = mailbox.drainMatchingSession(pid, "peer-b");
    assert.ok(matched);
    assert.equal(matched!.body, "target");
    const dir = join(home, ".oxtail", "mailboxes");
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp"));
    assert.deepEqual(leftover, [], "no temp files left behind after atomic rewrite");
    // Survivors intact and in order.
    assert.deepEqual(mailbox.drain(pid).map((m) => m.body), ["first", "third"]);
  });
});

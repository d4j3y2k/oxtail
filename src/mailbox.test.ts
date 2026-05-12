import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    assert.deepEqual(keys, ["schema_version", "id", "body", "enqueued_at", "from_session_id"]);
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

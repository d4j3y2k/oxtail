import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FleetBusyError, fleetLockPath, withFleetLock } from "./lock.js";

function withTempHome<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oxtail-fleetlock-"));
  const prior = process.env.HOME;
  process.env.HOME = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    process.env.HOME = prior;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });
}

test("fleetLockPath slugs the repo root under HOME/.oxtail/fleet-locks", async () => {
  await withTempHome((home) => {
    const p = fleetLockPath("/Users/davidkim/dev/oxtail");
    assert.equal(p, join(home, ".oxtail", "fleet-locks", "-Users-davidkim-dev-oxtail"));
  });
});

test("withFleetLock runs fn, returns its value, and releases (lock gone after)", async () => {
  await withTempHome(async () => {
    const repo = "/repo/a";
    const out = await withFleetLock(repo, async () => 42);
    assert.equal(out, 42);
    assert.equal(existsSync(fleetLockPath(repo)), false, "lock released after fn");
    // sequential re-acquire works
    const out2 = await withFleetLock(repo, async () => "again");
    assert.equal(out2, "again");
  });
});

test("a concurrent holder of the SAME repo is excluded (FleetBusyError)", async () => {
  await withTempHome(async () => {
    const repo = "/repo/contended";
    await withFleetLock(repo, async () => {
      // while we hold it, a second acquisition for the same repo must fail.
      await assert.rejects(() => withFleetLock(repo, async () => "nope"), FleetBusyError);
    });
    // once released, it's acquirable again.
    assert.equal(await withFleetLock(repo, async () => "ok"), "ok");
  });
});

test("the lock is released even if fn throws", async () => {
  await withTempHome(async () => {
    const repo = "/repo/throws";
    await assert.rejects(
      () =>
        withFleetLock(repo, async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.equal(existsSync(fleetLockPath(repo)), false, "lock released despite throw");
  });
});

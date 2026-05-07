import { strict as assert } from "node:assert";
import { test } from "node:test";

test("smoke: test runner is wired", () => {
  assert.equal(1 + 1, 2);
});

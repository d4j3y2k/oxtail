import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  WAKE_DEBOUNCE_MS,
  markWoke,
  newWakeDebounceStore,
  recentlyWoke,
} from "./wake-debounce.js";

const SID = "11111111-2222-3333-4444-555555555555";
const NOW = 1_900_000_000_000;

test("recentlyWoke: false on an empty store", () => {
  assert.equal(recentlyWoke(newWakeDebounceStore(), SID, NOW), false);
});

test("recentlyWoke: true inside the window, false once it elapses", () => {
  const store = newWakeDebounceStore();
  markWoke(store, SID, NOW);
  assert.equal(recentlyWoke(store, SID, NOW + 1), true, "immediately after a wake");
  assert.equal(recentlyWoke(store, SID, NOW + WAKE_DEBOUNCE_MS - 1), true, "just inside window");
  assert.equal(recentlyWoke(store, SID, NOW + WAKE_DEBOUNCE_MS), false, "at the window edge");
  assert.equal(recentlyWoke(store, SID, NOW + WAKE_DEBOUNCE_MS + 5_000), false, "well past");
});

test("recentlyWoke: independent per key — one peer's wake doesn't debounce another", () => {
  const store = newWakeDebounceStore();
  markWoke(store, SID, NOW);
  assert.equal(recentlyWoke(store, "99999999-0000-0000-0000-000000000000", NOW + 1), false);
});

test("a second wake refreshes the window", () => {
  const store = newWakeDebounceStore();
  markWoke(store, SID, NOW);
  // A later wake (after the first window) re-stamps, extending the debounce.
  markWoke(store, SID, NOW + WAKE_DEBOUNCE_MS + 100);
  assert.equal(recentlyWoke(store, SID, NOW + WAKE_DEBOUNCE_MS + 200), true);
});

test("markWoke: evicts stale entries so the store can't grow unbounded", () => {
  const store = newWakeDebounceStore();
  // Seed many old entries far outside the GC horizon (window * 10).
  for (let i = 0; i < 300; i++) store.set(`old-${i}`, NOW);
  assert.equal(store.size, 300);
  // A fresh wake well past the horizon triggers the sweep (size > 256).
  markWoke(store, SID, NOW + WAKE_DEBOUNCE_MS * 10 + 1);
  assert.ok(store.has(SID), "the fresh entry survives");
  assert.ok(store.size < 300, `stale entries swept (size now ${store.size})`);
});

// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Loading the venues' market lists at startup: how long it is waited for, and what becomes of
// a venue that answers late.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadMarketsWithin } from "../src/sources.ts";
import type { LateOutcome, MarketLoader } from "../src/sources.ts";

/** A wait the test ends by hand, and a venue whose answer the test gives by hand. */
function manual<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const listed = (...markets: string[]) => Object.fromEntries(markets.map((market) => [market, {}]));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("venues that answer in time are checked and nothing is reported", async () => {
  const late: LateOutcome[] = [];
  const loaders: MarketLoader[] = [
    { id: "a", markets: ["BTC/USD"], load: async () => listed("BTC/USD", "ETH/USD") },
    { id: "b", markets: ["BTC/USDT"], load: async () => listed("BTC/USDT") },
  ];
  const problems = await loadMarketsWithin(loaders, 5_000, (o) => late.push(o), () => manual<void>().promise);
  assert.deepEqual(problems, []);
  assert.deepEqual(late, []);
});

test("a venue that fails to load is a problem, not a reason to stop", async () => {
  const loaders: MarketLoader[] = [
    { id: "a", markets: ["BTC/USD"], load: async () => listed("BTC/USD") },
    { id: "down", markets: ["BTC/USD"], load: () => Promise.reject(new Error("no route")) },
  ];
  const problems = await loadMarketsWithin(loaders, 5_000, () => {}, () => manual<void>().promise);
  assert.deepEqual(problems, ["down: markets not loaded (no route)"]);
});

test("a configured market a venue does not list stops the start", async () => {
  const loaders: MarketLoader[] = [{ id: "a", markets: ["BTC/USD", "XYZ/USD"], load: async () => listed("BTC/USD") }];
  await assert.rejects(
    loadMarketsWithin(loaders, 5_000, () => {}, () => manual<void>().promise),
    /a has no market "XYZ\/USD"/,
  );
});

test("a slow venue does not hold the start back, and is checked when it answers", async () => {
  const deadline = manual<void>();
  const slow = manual<Record<string, unknown>>();
  const late: LateOutcome[] = [];
  const loaders: MarketLoader[] = [
    { id: "fast", markets: ["BTC/USD"], load: async () => listed("BTC/USD") },
    { id: "slow", markets: ["BTC/USDT"], load: () => slow.promise },
  ];
  let done: string[] | null = null;
  const started = loadMarketsWithin(loaders, 5_000, (o) => late.push(o), () => deadline.promise).then((p) => (done = p));
  await tick();
  assert.equal(done, null, "the start waits while the deadline has not passed");

  deadline.resolve();
  await started;
  assert.deepEqual(done, ["slow: markets still loading after 5000 ms, starting without them"]);
  assert.deepEqual(late, []);

  slow.resolve(listed("BTC/USDT"));
  await tick();
  assert.deepEqual(late, [{ id: "slow", ok: true }]);
});

test("a slow venue that ends badly is reported, never thrown", async () => {
  const deadline = manual<void>();
  const failing = manual<Record<string, unknown>>();
  const wrong = manual<Record<string, unknown>>();
  const late: LateOutcome[] = [];
  const loaders: MarketLoader[] = [
    { id: "failing", markets: ["BTC/USD"], load: () => failing.promise },
    { id: "wrong", markets: ["XYZ/USD"], load: () => wrong.promise },
  ];
  const started = loadMarketsWithin(loaders, 5_000, (o) => late.push(o), () => deadline.promise);
  deadline.resolve();
  assert.equal((await started).length, 2);

  failing.reject(new Error("no answer within 30000 ms"));
  wrong.resolve(listed("BTC/USD"));
  await tick();
  assert.deepEqual(late, [
    { id: "failing", ok: false, fatal: false, reason: "markets not loaded (no answer within 30000 ms)" },
    { id: "wrong", ok: false, fatal: true, reason: 'wrong has no market "XYZ/USD"' },
  ]);
});

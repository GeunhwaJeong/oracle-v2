// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { aggregate, clampStep, splitOutliers, weightedMedianMid } from "../src/aggregate.ts";
import type { Quote } from "../src/aggregate.ts";
import { ONE } from "../src/fixed.ts";

function quote(source: string, mid: number, halfSpread: number, weight = 1): Quote {
  return { source, mid: BigInt(mid) * ONE, halfSpread: BigInt(halfSpread) * ONE, weight };
}

test("one quote aggregates to itself", () => {
  const { price, confidence } = aggregate([quote("a", 100, 2)]);
  assert.equal(price, 100n * ONE);
  // Votes 98, 100, 102: the quartile votes are the outer ones.
  assert.equal(confidence, 2n * ONE);
});

test("the aggregate is the median vote and ignores a far outlier", () => {
  const quotes = [quote("a", 100, 1), quote("b", 101, 1), quote("c", 99, 1), quote("d", 100, 1), quote("x", 80, 1)];
  // Votes: 79 80 81 98 99 99 99 [100] 100 100 100 101 101 101 102.
  assert.equal(aggregate(quotes).price, 100n * ONE);
  // Moving the outlier further away changes nothing.
  assert.equal(aggregate([...quotes.slice(0, 4), quote("x", 1, 0)]).price, 100n * ONE);
});

test("a tight quote pulls the aggregate toward itself", () => {
  // A wide venue at 110 +/- 10 and two tight ones at 101: the aggregate stays at 101.
  const { price } = aggregate([quote("tight1", 101, 0), quote("tight2", 101, 0), quote("wide", 110, 10)]);
  assert.equal(price, 101n * ONE);
});

test("the confidence widens when venues disagree", () => {
  const agree = aggregate([quote("a", 100, 1), quote("b", 100, 1), quote("c", 100, 1), quote("d", 100, 1)]);
  const split = aggregate([quote("a", 90, 1), quote("b", 90, 1), quote("c", 110, 1), quote("d", 110, 1)]);
  assert.equal(agree.confidence, 1n * ONE);
  // Votes 89 89 90 90 91 91 | 109 109 110 110 111 111: median 100, quartiles 90 and 110.
  assert.equal(split.price, 100n * ONE);
  assert.equal(split.confidence, 10n * ONE);
});

test("the confidence is the further quartile", () => {
  // Votes 100 100 100 100 104 108: median 100, p25 = 100, p75 = 104.
  const { price, confidence } = aggregate([quote("a", 100, 0), quote("b", 104, 4)]);
  assert.equal(price, 100n * ONE);
  assert.equal(confidence, 4n * ONE);
});

test("weights repeat a venue's votes", () => {
  // Unweighted the median of 100, 104, 104 is 104; a weight of 3 on the first makes it 100.
  const mids = [quote("a", 100, 0), quote("b", 104, 0), quote("c", 104, 0)];
  assert.equal(aggregate(mids).price, 104n * ONE);
  assert.equal(aggregate([{ ...mids[0]!, weight: 3 }, mids[1]!, mids[2]!]).price, 100n * ONE);
  assert.equal(weightedMedianMid([{ ...mids[0]!, weight: 3 }, mids[1]!, mids[2]!]), 100n * ONE);
});

test("an even number of votes takes the mean of the middle two", () => {
  assert.equal(weightedMedianMid([quote("a", 100, 0), quote("b", 102, 0)]), 101n * ONE);
});

test("the aggregate lies within the span of the votes, for random quotes", () => {
  let seed = 12345;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let round = 0; round < 500; round++) {
    const count = 1 + Math.floor(random() * 9);
    const quotes: Quote[] = [];
    for (let i = 0; i < count; i++) {
      const mid = BigInt(1 + Math.floor(random() * 100_000)) * (ONE / 100n);
      const halfSpread = (mid * BigInt(Math.floor(random() * 50))) / 10_000n;
      quotes.push({ source: `v${i}`, mid, halfSpread, weight: 1 + Math.floor(random() * 3) });
    }
    const { price, confidence } = aggregate(quotes);
    const lows = quotes.map((q) => q.mid - q.halfSpread);
    const highs = quotes.map((q) => q.mid + q.halfSpread);
    const lowest = lows.reduce((m, v) => (v < m ? v : m));
    const highest = highs.reduce((m, v) => (v > m ? v : m));
    assert.ok(price >= lowest && price <= highest);
    assert.ok(confidence >= 0n && confidence <= highest - lowest);
  }
});

test("invalid quotes are refused", () => {
  assert.throws(() => aggregate([]), /no quotes/);
  assert.throws(() => aggregate([{ source: "a", mid: 0n, halfSpread: 0n, weight: 1 }]), /invalid quote/);
  assert.throws(() => aggregate([{ source: "a", mid: ONE, halfSpread: -1n, weight: 1 }]), /invalid quote/);
  assert.throws(() => aggregate([{ source: "a", mid: ONE, halfSpread: ONE, weight: 1 }]), /invalid quote/);
  assert.throws(() => aggregate([{ source: "a", mid: ONE, halfSpread: 0n, weight: 0 }]), /invalid weight/);
  assert.throws(() => aggregate([{ source: "a", mid: ONE, halfSpread: 0n, weight: 1.5 }]), /invalid weight/);
});

test("splitOutliers leaves out venues away from the median", () => {
  const quotes = [quote("a", 100, 0), quote("b", 100, 0), quote("c", 100, 0), quote("d", 101, 0), quote("x", 103, 0)];
  const { kept, outliers } = splitOutliers(quotes, 100);
  assert.deepEqual(kept.map((q) => q.source), ["a", "b", "c", "d"]);
  assert.deepEqual(outliers.map((q) => q.source), ["x"]);
  // The bound is inclusive: 101 is exactly 100 bps from the median of 100.
  assert.deepEqual(splitOutliers(quotes, 99).kept.map((q) => q.source), ["a", "b", "c"]);
  assert.deepEqual(splitOutliers([], 100), { kept: [], outliers: [] });
});

test("clampStep limits a move to the step, in both directions", () => {
  const previous = 100n * ONE;
  assert.equal(clampStep(100n * ONE + ONE / 2n, previous, 100), 100n * ONE + ONE / 2n);
  assert.equal(clampStep(101n * ONE, previous, 100), 101n * ONE);
  assert.equal(clampStep(150n * ONE, previous, 100), 101n * ONE);
  assert.equal(clampStep(50n * ONE, previous, 100), 99n * ONE);
});

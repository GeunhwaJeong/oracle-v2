// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Turns one round of exchange quotes into a price and a confidence interval.
//
// The aggregation is the one Pyth uses across its publishers: every quote casts three votes,
// at its price and at its price plus and minus its own confidence, and the aggregate is the
// median vote. A venue with a tight spread puts its three votes close together and so weighs
// more on where the median lands, while no venue can move the median further than the quotes
// around it allow. The aggregate confidence is the distance from the median to the further of
// the 25th and 75th percentile votes, so it widens when venues disagree.

import { BPS, deviationBps } from "./fixed.ts";

export interface Quote {
  /** Where the quote came from, for logs. */
  source: string;
  /** Mid price, 18 decimals. */
  mid: bigint;
  /** Half of the bid-ask spread: how well this venue pins the price down. */
  halfSpread: bigint;
  /** Votes are repeated this many times; a positive integer. */
  weight: number;
}

export interface Aggregate {
  price: bigint;
  confidence: bigint;
}

function sorted(values: bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Median of an ascending list: the middle element, or the mean of the two middle ones. */
function medianOfSorted(ascending: bigint[]): bigint {
  const n = ascending.length;
  if (n === 0) throw new Error("median of nothing");
  const upper = ascending[n >> 1]!;
  return n % 2 === 1 ? upper : (ascending[(n >> 1) - 1]! + upper) / 2n;
}

function repeat(value: bigint, times: number): bigint[] {
  if (!Number.isInteger(times) || times < 1) throw new Error(`invalid weight ${times}`);
  return Array<bigint>(times).fill(value);
}

/** Median of the quotes' mid prices, each counted `weight` times. */
export function weightedMedianMid(quotes: Quote[]): bigint {
  return medianOfSorted(sorted(quotes.flatMap((q) => repeat(q.mid, q.weight))));
}

/**
 * Splits the quotes into those within `maxDeviationBps` of the weighted median mid and those
 * further away. A venue that is down, lagging or manipulated shows up as the odd one out; it is
 * left out of the aggregate rather than allowed to widen it.
 */
export function splitOutliers(
  quotes: Quote[],
  maxDeviationBps: number,
): { kept: Quote[]; outliers: Quote[] } {
  if (quotes.length === 0) return { kept: [], outliers: [] };
  const center = weightedMedianMid(quotes);
  const kept: Quote[] = [];
  const outliers: Quote[] = [];
  for (const quote of quotes) {
    (deviationBps(quote.mid, center) <= BigInt(maxDeviationBps) ? kept : outliers).push(quote);
  }
  return { kept, outliers };
}

export function aggregate(quotes: Quote[]): Aggregate {
  if (quotes.length === 0) throw new Error("no quotes to aggregate");
  const votes = sorted(
    quotes.flatMap((q) => {
      if (q.mid <= 0n || q.halfSpread < 0n || q.halfSpread >= q.mid) {
        throw new Error(`invalid quote from ${q.source}`);
      }
      return [
        ...repeat(q.mid - q.halfSpread, q.weight),
        ...repeat(q.mid, q.weight),
        ...repeat(q.mid + q.halfSpread, q.weight),
      ];
    }),
  );
  const n = votes.length;
  const price = medianOfSorted(votes);
  const p25 = votes[n >> 2]!;
  const p75 = votes[n - 1 - (n >> 2)]!;
  const left = price - p25;
  const right = p75 - price;
  return { price, confidence: left > right ? left : right };
}

/** Moves `target` to within `maxStepBps` of `previous`. */
export function clampStep(target: bigint, previous: bigint, maxStepBps: number): bigint {
  const step = (previous * BigInt(maxStepBps)) / BPS;
  if (target > previous + step) return previous + step;
  if (target < previous - step) return previous - step;
  return target;
}

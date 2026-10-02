// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { ONE, parseFixed } from "../src/fixed.ts";
import { decide, formPrices } from "../src/round.ts";
import type { Fetched, Formed } from "../src/round.ts";

const NOW = 1_800_000_000_000;

function config(overrides: Record<string, unknown> = {}, feed: Record<string, unknown> = {}): Config {
  return parseConfig({
    rpcUrl: "http://127.0.0.1:9000",
    packageId: "0x1",
    sourceId: "0x2",
    aggregatorConfigId: "0x3",
    quoteRates: {
      USDT: { minSources: 2, sources: [{ exchange: "k", market: "USDT/USD" }, { exchange: "c", market: "USDT/USD" }] },
    },
    feeds: [
      {
        symbol: "BTC/USD",
        storageId: 0,
        priceFeedStorageId: "0x10",
        minSources: 3,
        sources: [
          { exchange: "a", market: "BTC/USD" },
          { exchange: "b", market: "BTC/USD" },
          { exchange: "c", market: "BTC/USD" },
          { exchange: "t", market: "BTC/USDT" },
        ],
        ...feed,
      },
      { symbol: "RYUSD/USD", storageId: 1, priceFeedStorageId: "0x11", fixedPrice: "1" },
    ],
    ...overrides,
  });
}

function ticker(bid: string, ask: string, exchangeTimestampMs: number | null = NOW): Fetched {
  return { ticker: { bid: parseFixed(bid), ask: parseFixed(ask), exchangeTimestampMs } };
}

function healthy(): Map<string, Fetched> {
  return new Map<string, Fetched>([
    ["a:BTC/USD", ticker("99999", "100001")],
    ["b:BTC/USD", ticker("99999", "100001")],
    ["c:BTC/USD", ticker("99999", "100001")],
    // 100,100 USDT at 0.999 USD per USDT is 99,999.9 USD.
    ["t:BTC/USDT", ticker("100099", "100101")],
    ["k:USDT/USD", ticker("0.999", "0.999")],
    ["c:USDT/USD", ticker("0.999", "0.999")],
  ]);
}

function formedOf(result: ReturnType<typeof formPrices>, symbol: string) {
  const formation = result.get(symbol)!;
  assert.ok(formation.ok, formation.ok ? "" : formation.reason);
  return formation;
}

test("a healthy round forms the price from every venue", () => {
  const btc = formedOf(formPrices(config(), healthy(), NOW), "BTC/USD");
  assert.equal(btc.price, 100_000n * ONE);
  assert.equal(btc.confidence, ONE);
  assert.deepEqual(btc.used, ["a:BTC/USD", "b:BTC/USD", "c:BTC/USD", "t:BTC/USDT"]);
  assert.deepEqual(btc.dropped, []);
});

test("a fixed-price feed needs no venue", () => {
  const ryusd = formedOf(formPrices(config(), new Map(), NOW), "RYUSD/USD");
  assert.equal(ryusd.price, ONE);
  assert.equal(ryusd.confidence, 0n);
});

test("a venue quoted in another currency is converted, not taken at par", () => {
  const fetched = healthy();
  // Only the USDT venue and one USD venue remain, so its converted price decides the median.
  fetched.set("a:BTC/USD", { error: "down" });
  fetched.set("b:BTC/USD", { error: "down" });
  const btc = formedOf(formPrices(config({}, { minSources: 2 }), fetched, NOW), "BTC/USD");
  // Votes: 99,999 100,000 100,001 and 99,998.901 99,999.9 100,000.899: median is the mean of
  // 99,999.9 and 100,000.
  assert.equal(btc.price, parseFixed("99999.95"));
});

test("the rate's own uncertainty widens the converted venue's spread", () => {
  const fetched = new Map<string, Fetched>([
    ["t:BTC/USDT", ticker("100000", "100000")],
    ["k:USDT/USD", ticker("0.998", "1.000")],
    ["c:USDT/USD", ticker("0.998", "1.000")],
  ]);
  const btc = formedOf(formPrices(config({}, { minSources: 1 }), fetched, NOW), "BTC/USD");
  // Rate 0.999 +/- 0.001, so 99,900 +/- 100 although the venue itself has no spread.
  assert.equal(btc.price, 99_900n * ONE);
  assert.equal(btc.confidence, 100n * ONE);
});

test("without a rate the venues that need it are left out", () => {
  const fetched = healthy();
  fetched.set("k:USDT/USD", { error: "down" });
  const btc = formedOf(formPrices(config(), fetched, NOW), "BTC/USD");
  assert.deepEqual(btc.used, ["a:BTC/USD", "b:BTC/USD", "c:BTC/USD"]);
  assert.match(btc.dropped[0]!.reason, /no USDT\/USD rate/);
});

test("a failing venue, an empty book, a crossed book and a stalled ticker are left out", () => {
  const cases: [Fetched, RegExp][] = [
    [{ error: "timeout" }, /timeout/],
    [ticker("0", "100001"), /empty or crossed/],
    [ticker("100002", "100001"), /empty or crossed/],
    [ticker("99999", "100001", NOW - 30_001), /ms old/],
  ];
  for (const [bad, reason] of cases) {
    const fetched = healthy();
    fetched.set("a:BTC/USD", bad);
    const btc = formedOf(formPrices(config(), fetched, NOW), "BTC/USD");
    assert.equal(btc.used.includes("a:BTC/USD"), false);
    assert.match(btc.dropped[0]!.reason, reason);
    assert.equal(btc.price, 100_000n * ONE);
  }
});

test("a ticker without a venue timestamp is accepted", () => {
  const fetched = healthy();
  fetched.set("a:BTC/USD", ticker("99999", "100001", null));
  assert.equal(formedOf(formPrices(config(), fetched, NOW), "BTC/USD").used.length, 4);
});

test("a venue away from the others is left out and does not move the price", () => {
  const fetched = healthy();
  fetched.set("a:BTC/USD", ticker("109999", "110001"));
  const btc = formedOf(formPrices(config(), fetched, NOW), "BTC/USD");
  assert.deepEqual(btc.dropped, [{ source: "a:BTC/USD", kind: "outlier", reason: "away from the other venues" }]);
  assert.equal(btc.price, 100_000n * ONE);
});

test("too few usable venues form no price", () => {
  const fetched = healthy();
  fetched.set("a:BTC/USD", { error: "down" });
  fetched.set("b:BTC/USD", { error: "down" });
  const btc = formPrices(config(), fetched, NOW).get("BTC/USD")!;
  assert.equal(btc.ok, false);
  assert.match(btc.ok ? "" : btc.reason, /2 usable venue\(s\), 3 needed/);
});

test("venues split into two camps form no price when neither is large enough", () => {
  const fetched = healthy();
  fetched.set("a:BTC/USD", ticker("89999", "90001"));
  fetched.set("b:BTC/USD", ticker("89999", "90001"));
  // Median mid is 95,000: every venue is more than 1% away from it.
  const btc = formPrices(config(), fetched, NOW).get("BTC/USD")!;
  assert.equal(btc.ok, false);
});

// === decide ===

const LIMITS = { maxConfidenceBps: 50, maxStepBps: 100 };

function formed(price: string, confidence = "1"): Formed {
  return { price: parseFixed(price), confidence: parseFixed(confidence), used: [], dropped: [], mids: [] };
}

test("the first price is signed as formed", () => {
  assert.deepEqual(decide(formed("100000"), null, LIMITS, NOW, 60_000), {
    sign: true,
    price: 100_000n * ONE,
    confidence: ONE,
    clampedFrom: null,
  });
});

test("a move within the step limit is signed as formed", () => {
  const previous = { price: 100_000n * ONE, timestampMs: NOW - 3_000 };
  const decision = decide(formed("101000"), previous, LIMITS, NOW, 60_000);
  assert.deepEqual(decision, { sign: true, price: 101_000n * ONE, confidence: ONE, clampedFrom: null });
});

test("a move beyond the step limit is signed at the limit, with the gap in the confidence", () => {
  const previous = { price: 100_000n * ONE, timestampMs: NOW - 3_000 };
  const up = decide(formed("101200"), previous, LIMITS, NOW, 60_000);
  assert.ok(up.sign);
  assert.equal(up.price, 101_000n * ONE);
  assert.equal(up.clampedFrom, 101_200n * ONE);
  // 1 + 200 of gap.
  assert.equal(up.confidence, 201n * ONE);

  const down = decide(formed("90000"), previous, LIMITS, NOW, 60_000);
  assert.ok(down.sign);
  assert.equal(down.price, 99_000n * ONE);
  // The gap of 9,000 is capped at the feed's confidence bound: 50 bps of 99,000.
  assert.equal(down.confidence, 495n * ONE);
});

test("a feed follows a real move over consecutive updates", () => {
  let previous = { price: 100_000n * ONE, timestampMs: NOW };
  const prices: bigint[] = [];
  for (let i = 1; i <= 4; i++) {
    const decision = decide(formed("103000"), previous, LIMITS, NOW + i * 3_000, 60_000);
    assert.ok(decision.sign);
    prices.push(decision.price / ONE);
    previous = { price: decision.price, timestampMs: NOW + i * 3_000 };
  }
  assert.deepEqual(prices, [101_000n, 102_010n, 103_000n, 103_000n]);
});

test("the step limit lapses once the previous price is old", () => {
  const previous = { price: 100_000n * ONE, timestampMs: NOW - 60_001 };
  const decision = decide(formed("120000"), previous, LIMITS, NOW, 60_000);
  assert.deepEqual(decision, { sign: true, price: 120_000n * ONE, confidence: ONE, clampedFrom: null });
  // At exactly the reset age it still applies.
  const atEdge = decide(formed("120000"), { ...previous, timestampMs: NOW - 60_000 }, LIMITS, NOW, 60_000);
  assert.ok(atEdge.sign && atEdge.price === 101_000n * ONE);
});

test("a confidence interval wider than the bound is not signed", () => {
  // 50 bps of 100,000 is 500.
  assert.equal(decide(formed("100000", "500"), null, LIMITS, NOW, 60_000).sign, true);
  const wide = decide(formed("100000", "500.000000000000000001"), null, LIMITS, NOW, 60_000);
  assert.deepEqual(wide, { sign: false, kind: "confidence", reason: "confidence interval wider than the feed allows" });
});

test("a non-positive price is not signed", () => {
  assert.equal(decide(formed("0", "0"), null, LIMITS, NOW, 60_000).sign, false);
});

// === config ===

test("the configuration is validated", () => {
  const base = () => ({
    rpcUrl: "http://x",
    packageId: "0x1",
    sourceId: "0x2",
    aggregatorConfigId: "0x3",
    feeds: [{ symbol: "BTC/USD", storageId: 0, priceFeedStorageId: "0x10", minSources: 1, sources: [{ exchange: "a", market: "BTC/USD" }] }],
  });
  assert.equal(parseConfig(base()).feeds[0]!.maxStepBps, 100);
  assert.equal(parseConfig(base()).intervalMs, 3_000);
  const broken: [(c: any) => void, RegExp][] = [
    [(c) => (c.feeds[0].sources[0].market = "BTC/USDT"), /no entry in quoteRates/],
    [(c) => (c.feeds[0].minSources = 2), /exceeds its number of sources/],
    [(c) => (c.feeds[0].fixedPrice = "1"), /either sources or a fixedPrice/],
    [(c) => delete c.feeds[0].sources, /either sources or a fixedPrice/],
    [(c) => c.feeds.push({ ...c.feeds[0] }), /used twice/],
    [(c) => c.feeds[0].sources.push({ exchange: "a", market: "BTC/USD" }), /twice/],
    [(c) => (c.feeds[0].symbol = "BTC"), /BASE\/QUOTE/],
    [(c) => (c.packageId = "nope"), /object id/],
    [(c) => (c.intervalMs = 10), /intervalMs/],
    [(c) => (c.feeds = []), /non-empty list/],
  ];
  for (const [mutate, message] of broken) {
    const c = base();
    mutate(c);
    assert.throws(() => parseConfig(c), message);
  }
});

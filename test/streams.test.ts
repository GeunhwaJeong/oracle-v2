// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The streams against scripted venues: what a round takes from a stream, and when it asks over
// REST instead.

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../src/config.ts";
import { parseFixed } from "../src/fixed.ts";
import { Metrics } from "../src/metrics.ts";
import type { Fetched } from "../src/round.ts";
import { StreamSources, streamMethod } from "../src/streams.ts";
import type { StreamClient } from "../src/streams.ts";

type Resolver<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

/** A venue whose stream says what the test tells it to, when the test tells it to. */
class Venue implements StreamClient {
  has: Record<string, unknown>;
  closed = 0;
  /** Subscriptions waiting for the venue to say something, by market (or "all"). */
  readonly waiting = new Map<string, Resolver<never>[]>();

  constructor(has: Record<string, unknown>) {
    this.has = has;
  }

  #wait<T>(key: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const list = this.waiting.get(key) ?? [];
      list.push({ resolve: resolve as (value: never) => void, reject });
      this.waiting.set(key, list);
    });
  }

  watchBidsAsks(): Promise<Record<string, { bid?: number; ask?: number; timestamp?: number }>> {
    return this.#wait("all");
  }

  watchTicker(market: string): Promise<{ bid?: number; ask?: number; timestamp?: number }> {
    return this.#wait(market);
  }

  watchOrderBook(market: string): Promise<{ bids: number[][]; asks: number[][]; nonce?: number }> {
    return this.#wait(market);
  }

  /** Makes the venue say `value` to whoever is waiting on `key`. */
  say(key: string, value: unknown): void {
    for (const waiter of this.waiting.get(key)?.splice(0) ?? []) waiter.resolve(value as never);
  }

  fail(key: string, message: string): void {
    for (const waiter of this.waiting.get(key)?.splice(0) ?? []) waiter.reject(new Error(message));
  }

  async close(): Promise<void> {
    this.closed += 1;
    for (const key of [...this.waiting.keys()]) this.fail(key, "closed");
  }
}

/** Lets the stream loops run up to their next wait. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup(has: Record<string, Record<string, unknown>> = {}) {
  const config = parseConfig({
    rpcUrl: "http://127.0.0.1:9000",
    packageId: "0x1",
    sourceId: "0x2",
    aggregatorConfigId: "0x3",
    streamExchanges: ["a", "b"],
    streamMaxAgeMs: 5_000,
    feeds: [
      {
        symbol: "BTC/USD",
        storageId: 0,
        priceFeedStorageId: "0x10",
        sources: [
          { exchange: "a", market: "BTC/USD" },
          { exchange: "b", market: "BTC/USD" },
          { exchange: "r", market: "BTC/USD" },
        ],
      },
      {
        symbol: "ETH/USD",
        storageId: 1,
        priceFeedStorageId: "0x11",
        sources: [
          { exchange: "a", market: "ETH/USD" },
          { exchange: "b", market: "ETH/USD" },
          { exchange: "r", market: "ETH/USD" },
        ],
      },
    ],
  });
  const state = { now: 1_800_000_000_000 };
  const venues = new Map<string, Venue>();
  const asked: string[][] = [];
  const logs: string[] = [];
  const sleeps: number[] = [];
  const metrics = new Metrics();
  const rest = {
    fetch: async (only?: ReadonlySet<string>) => {
      const keys = [...(only ?? [])].sort();
      asked.push(keys);
      return new Map<string, Fetched>(
        keys.map((key) => [key, { ticker: { bid: parseFixed("1"), ask: parseFixed("2"), exchangeTimestampMs: null } }]),
      );
    },
  };
  const streams = new StreamSources({
    config,
    rest,
    connect: (exchange) => {
      const venue = new Venue(has[exchange] ?? { watchBidsAsks: true, watchTicker: true });
      venues.set(exchange, venue);
      return venue;
    },
    metrics,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`) },
    now: () => state.now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { streams, state, venues, asked, logs, sleeps, metrics };
}

const bid = (fetched: Fetched | undefined) => (fetched && "ticker" in fetched ? fetched.ticker.bid : null);

test("the best-bid-and-ask channel is preferred, then the ticker, then the book", () => {
  assert.equal(streamMethod({ watchBidsAsks: true, watchTicker: true, watchOrderBook: true }), "watchBidsAsks");
  assert.equal(streamMethod({ watchBidsAsks: false, watchTicker: true, watchOrderBook: true }), "watchTicker");
  assert.equal(streamMethod({ watchOrderBook: true }), "watchOrderBook");
  assert.equal(streamMethod({ watchTrades: true }), null);
});

test("only the venues listed are streamed, and a venue without a stream cannot be", () => {
  const { streams, venues, logs } = setup();
  assert.deepEqual([...venues.keys()], ["a", "b"]);
  streams.start();
  assert.ok(logs.includes("info a: following BTC/USD, ETH/USD over watchBidsAsks"));
  assert.throws(() => setup({ a: { watchTrades: true } }).streams.start(), /a has no stream of its best bid and ask/);
  return streams.close();
});

test("until a stream has delivered, every market is asked for over REST", async () => {
  const { streams, asked, metrics } = setup();
  streams.start();
  const fetched = await streams.fetchAll();
  assert.equal(fetched.size, 6);
  assert.deepEqual(asked, [["a:BTC/USD", "a:ETH/USD", "b:BTC/USD", "b:ETH/USD", "r:BTC/USD", "r:ETH/USD"]]);
  assert.equal(metrics.streamUp.get({ exchange: "a" }), 0);
  await streams.close();
});

test("a round takes what the streams delivered and asks only for the rest", async () => {
  const { streams, venues, asked, state, metrics } = setup();
  streams.start();
  await settle();
  venues.get("a")!.say("all", {
    "BTC/USD": { bid: 100, ask: 101, timestamp: state.now - 20 },
    "ETH/USD": { bid: 10, ask: 11 },
  });
  await settle();
  state.now += 1_500;
  const fetched = await streams.fetchAll();
  assert.deepEqual(asked, [["b:BTC/USD", "b:ETH/USD", "r:BTC/USD", "r:ETH/USD"]]);
  const btc = fetched.get("a:BTC/USD");
  assert.equal(bid(btc), parseFixed("100"));
  assert.ok(btc && "ticker" in btc && btc.ticker.exchangeTimestampMs === state.now - 1_520);
  assert.equal(bid(fetched.get("a:ETH/USD")), parseFixed("10"));
  assert.equal(bid(fetched.get("b:BTC/USD")), parseFixed("1"));

  const labels = { exchange: "a", market: "BTC/USD" };
  assert.equal(metrics.quotes.get({ ...labels, transport: "stream", result: "ok" }), 1);
  assert.equal(metrics.quoteAgeSeconds.get(labels), 1.5);
  assert.equal(metrics.quoteAgeSeconds.get({ exchange: "b", market: "BTC/USD" }), 0);
  assert.equal(metrics.streamUp.get({ exchange: "a" }), 1);
  assert.equal(metrics.streamUp.get({ exchange: "b" }), 0);
  await streams.close();
});

test("a streamed quote older than the limit is not used", async () => {
  const { streams, venues, asked, state } = setup();
  streams.start();
  await settle();
  venues.get("a")!.say("all", { "BTC/USD": { bid: 100, ask: 101 }, "ETH/USD": { bid: 10, ask: 11 } });
  await settle();
  state.now += 5_000;
  assert.equal(bid((await streams.fetchAll()).get("a:BTC/USD")), parseFixed("100"), "at the limit");
  state.now += 1;
  assert.equal(bid((await streams.fetchAll()).get("a:BTC/USD")), parseFixed("1"), "past it");
  assert.ok(asked[1]!.includes("a:BTC/USD") && asked[1]!.includes("a:ETH/USD"));
  await streams.close();
});

test("a venue repeating what it already said is not heard as news", async () => {
  const { streams, venues, state, asked } = setup();
  streams.start();
  await settle();
  const a = venues.get("a")!;
  a.say("all", { "BTC/USD": { bid: 100, ask: 101, timestamp: 1 }, "ETH/USD": { bid: 10, ask: 11, timestamp: 1 } });
  await settle();
  // Only ETH moves; the venue hands back both, BTC as it was.
  state.now += 4_000;
  a.say("all", { "BTC/USD": { bid: 100, ask: 101, timestamp: 1 }, "ETH/USD": { bid: 10.5, ask: 11, timestamp: 2 } });
  await settle();
  state.now += 2_000;
  const fetched = await streams.fetchAll();
  assert.equal(bid(fetched.get("a:ETH/USD")), parseFixed("10.5"));
  // BTC was last heard six seconds ago.
  assert.ok(asked[0]!.includes("a:BTC/USD") && !asked[0]!.includes("a:ETH/USD"));
  await streams.close();
});

test("a message without both sides of the book is not a quote", async () => {
  const { streams, venues, asked } = setup();
  streams.start();
  await settle();
  venues.get("a")!.say("all", { "BTC/USD": { bid: 100 }, "ETH/USD": { bid: 10, ask: 11 } });
  await settle();
  await streams.fetchAll();
  assert.ok(asked[0]!.includes("a:BTC/USD") && !asked[0]!.includes("a:ETH/USD"));
  await streams.close();
});

test("a crossed quote takes back the one before it", async () => {
  const { streams, venues, asked, metrics } = setup();
  streams.start();
  await settle();
  const a = venues.get("a")!;
  a.say("all", { "BTC/USD": { bid: 100, ask: 101 }, "ETH/USD": { bid: 10, ask: 11 } });
  await settle();
  a.say("all", { "BTC/USD": { bid: 102, ask: 101 } });
  await settle();
  await streams.fetchAll();
  assert.ok(asked[0]!.includes("a:BTC/USD") && !asked[0]!.includes("a:ETH/USD"));
  // The other markets of the connection are not disturbed.
  assert.equal(metrics.streamErrors.get({ exchange: "a" }), 0);
  await streams.close();
});

test("a book that has gone wrong is opened again from a new snapshot", async () => {
  const { streams, venues, asked, sleeps, metrics, logs } = setup({ b: { watchOrderBook: true } });
  streams.start();
  await settle();
  const b = venues.get("b")!;
  b.say("BTC/USD", { bids: [[100, 1]], asks: [[101, 1]], nonce: 1 });
  await settle();
  b.say("BTC/USD", { bids: [[102, 1]], asks: [[101, 1]], nonce: 2 });
  await settle();
  // The venue's other market shares the connection: it waits and subscribes again too, but
  // the connection is closed once and one failure is counted.
  assert.equal(b.closed, 1);
  assert.deepEqual(sleeps, [1_000, 1_000]);
  assert.equal(metrics.streamErrors.get({ exchange: "b" }), 1);
  assert.ok(logs.some((line) => /warn b: stream of BTC\/USD failed, reconnecting: the book of BTC\/USD is empty or crossed/.test(line)));
  await streams.fetchAll();
  assert.ok(asked[0]!.includes("b:BTC/USD"));

  b.say("BTC/USD", { bids: [[100, 1]], asks: [[101, 1]], nonce: 1 });
  await settle();
  await streams.fetchAll();
  assert.ok(!asked[1]!.includes("b:BTC/USD"));
  await streams.close();
});

test("a venue with only a ticker or only a book is followed market by market", async () => {
  const { streams, venues, logs } = setup({ a: { watchTicker: true }, b: { watchOrderBook: true } });
  streams.start();
  await settle();
  assert.ok(logs.includes("info a: following BTC/USD, ETH/USD over watchTicker"));
  assert.ok(logs.includes("info b: following BTC/USD, ETH/USD over watchOrderBook"));
  venues.get("a")!.say("BTC/USD", { bid: 100, ask: 101, timestamp: 5 });
  venues.get("b")!.say("ETH/USD", { bids: [[10, 3], [9, 1]], asks: [[11, 2]], nonce: 7 });
  await settle();
  const fetched = await streams.fetchAll();
  assert.equal(bid(fetched.get("a:BTC/USD")), parseFixed("100"));
  const eth = fetched.get("b:ETH/USD");
  assert.ok(eth && "ticker" in eth && eth.ticker.bid === parseFixed("10") && eth.ticker.ask === parseFixed("11"));
  await streams.close();
});

test("a book that changes below its top still shows the stream is alive", async () => {
  const { streams, venues, state, asked } = setup({ b: { watchOrderBook: true } });
  streams.start();
  await settle();
  const b = venues.get("b")!;
  b.say("BTC/USD", { bids: [[100, 1]], asks: [[101, 1]], nonce: 1 });
  await settle();
  state.now += 4_000;
  b.say("BTC/USD", { bids: [[100, 1]], asks: [[101, 1]], nonce: 2 });
  await settle();
  state.now += 4_000;
  await streams.fetchAll();
  assert.ok(!asked[0]!.includes("b:BTC/USD"));
  await streams.close();
});

test("a stream that fails is closed and opened again, waiting longer each time", async () => {
  const { streams, venues, logs, sleeps, metrics } = setup();
  streams.start();
  await settle();
  const a = venues.get("a")!;
  a.fail("all", "connection reset");
  await settle();
  a.fail("all", "connection reset");
  await settle();
  assert.deepEqual(sleeps, [1_000, 2_000]);
  assert.equal(a.closed, 2);
  assert.equal(metrics.streamErrors.get({ exchange: "a" }), 2);
  assert.equal(metrics.streamUp.get({ exchange: "a" }), 0);
  // Said once, not once per attempt.
  assert.equal(logs.filter((line) => line.startsWith("warn a: stream of all failed")).length, 1);

  a.say("all", { "BTC/USD": { bid: 100, ask: 101 } });
  await settle();
  assert.equal(metrics.streamUp.get({ exchange: "a" }), 1);
  assert.equal(bid((await streams.fetchAll()).get("a:BTC/USD")), parseFixed("100"));
  // The wait starts over after a success.
  a.fail("all", "connection reset");
  await settle();
  assert.deepEqual(sleeps, [1_000, 2_000, 1_000]);
  await streams.close();
});

test("closing ends the streams without counting it as a failure", async () => {
  const { streams, venues, metrics } = setup();
  streams.start();
  await settle();
  await streams.close();
  assert.equal(venues.get("a")!.closed, 1);
  assert.equal(metrics.streamErrors.get({ exchange: "a" }), 0);
});

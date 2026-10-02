// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Follows the venues' best bid and ask over WebSockets, so that a round takes prices that are
// already there instead of waiting for nine request round trips.
//
// A stream is trusted only for as long as it keeps talking. A quote is used while it is younger
// than `streamMaxAgeMs`; past that the market is asked for over REST in the round itself. That
// covers a venue that has no stream, a stream that is reconnecting, a subscription that died on
// a connection that did not, and a market so quiet that its book has not changed: in every case
// the round gets a quote that was true a moment ago or none at all, never an old one.

import ccxt from "ccxt";

import { sourceKey } from "./config.ts";
import type { Config } from "./config.ts";
import { Metrics } from "./metrics.ts";
import type { Fetched } from "./round.ts";
import { allSources, describe, toFetched } from "./sources.ts";
import type { TickerFetcher, TickerSource } from "./sources.ts";

interface TickerLike {
  bid?: number | undefined;
  ask?: number | undefined;
  bidVolume?: number | undefined;
  askVolume?: number | undefined;
  timestamp?: number | undefined;
}

interface BookLike {
  /** `[price, size]` levels, best first. */
  bids: (number | undefined)[][];
  asks: (number | undefined)[][];
  timestamp?: number | undefined;
  nonce?: number | undefined;
}

/** The part of a ccxt.pro exchange the streams use. */
export interface StreamClient {
  has: Record<string, unknown>;
  watchBidsAsks(markets: string[]): Promise<Record<string, TickerLike>>;
  watchTicker(market: string): Promise<TickerLike>;
  watchOrderBook(market: string): Promise<BookLike>;
  close(): Promise<unknown>;
}

export interface StreamLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface StreamDeps {
  config: Config;
  /** Asked for the markets whose stream has nothing fresh. */
  rest: TickerFetcher;
  /** Opens a venue's stream client. */
  connect: (exchange: string) => StreamClient;
  metrics?: Metrics;
  log: StreamLogger;
  now: () => number;
  /** Resolves after `ms`; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

type Method = "watchBidsAsks" | "watchTicker" | "watchOrderBook";

/**
 * How a venue's top of book is followed: its best-bid-and-ask channel where it has one, else
 * its ticker, else its order book. The ticker of some venues carries no bid and ask; those all
 * have the first channel, which is why it is preferred.
 */
export function streamMethod(has: Record<string, unknown>): Method | null {
  for (const method of ["watchBidsAsks", "watchTicker", "watchOrderBook"] as const) {
    if (has[method] === true) return method;
  }
  return null;
}

const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
/**
 * A subscription that has delivered nothing for this long is opened again. A connection can
 * stay up while the subscription on it has silently stopped, and nothing else would notice.
 */
const IDLE_RECONNECT_MS = 120_000;

interface Entry {
  fetched: Fetched;
  receivedMs: number;
  /** What the venue last said, to tell news from a repeat. */
  identity: string;
}

const IDLE = Symbol("idle");

export class StreamSources implements TickerSource {
  readonly #deps: StreamDeps;
  readonly #metrics: Metrics;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #latest = new Map<string, Entry>();
  /**
   * Stream clients by exchange, the markets followed on each, and how many times the venue's
   * connection has been closed to open it again.
   */
  readonly #venues = new Map<string, { client: StreamClient; markets: string[]; resets: number }>();
  /** Loops currently failing, by exchange. */
  readonly #failing = new Map<string, Set<string>>();
  readonly #loops: Promise<void>[] = [];
  #closed = false;
  #stop: () => void = () => {};
  /** Resolves when the streams are closed, to cut a wait short. */
  readonly #stopped = new Promise<void>((resolve) => {
    this.#stop = resolve;
  });

  constructor(deps: StreamDeps) {
    this.#deps = deps;
    this.#metrics = deps.metrics ?? new Metrics();
    this.#sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (const spec of allSources(deps.config)) {
      if (!deps.config.streamExchanges.has(spec.exchange)) continue;
      let venue = this.#venues.get(spec.exchange);
      if (venue === undefined) {
        venue = { client: deps.connect(spec.exchange), markets: [], resets: 0 };
        this.#venues.set(spec.exchange, venue);
      }
      if (!venue.markets.includes(spec.market)) venue.markets.push(spec.market);
    }
  }

  /** Opens every stream. Rounds can start at once: until a stream delivers, REST answers. */
  start(): void {
    for (const [exchange, { client, markets }] of this.#venues) {
      const method = streamMethod(client.has);
      if (method === null) throw new Error(`${exchange} has no stream of its best bid and ask`);
      this.#failing.set(exchange, new Set());
      this.#metrics.streamUp.set({ exchange }, 0);
      this.#deps.log.info(`${exchange}: following ${markets.join(", ")} over ${method}`);
      if (method === "watchBidsAsks") {
        this.#loops.push(
          this.#follow(exchange, "all", async () => {
            const tickers = await client.watchBidsAsks(markets);
            for (const market of markets) {
              const ticker = tickers[market];
              if (ticker !== undefined) this.#deliver(exchange, market, ticker, "");
            }
          }),
        );
        continue;
      }
      for (const market of markets) {
        this.#loops.push(
          this.#follow(exchange, market, async () => {
            if (method === "watchTicker") {
              this.#deliver(exchange, market, await client.watchTicker(market), "");
              return;
            }
            const book = await client.watchOrderBook(market);
            const [bid, bidVolume] = book.bids[0] ?? [];
            const [ask, askVolume] = book.asks[0] ?? [];
            // Any change to the book shows the subscription is alive, also one below its top.
            const ticker = { bid, ask, bidVolume, askVolume, timestamp: book.timestamp };
            // A book kept from increments can lose its place and stay wrong. Opening the
            // stream again takes a new snapshot; until then the market is asked for over REST.
            if (!this.#deliver(exchange, market, ticker, String(book.nonce ?? ""))) {
              throw new Error(`the book of ${market} is empty or crossed`);
            }
          }),
        );
      }
    }
  }

  /** Repeats `step`, which resolves when the venue has said something, until closed. */
  async #follow(exchange: string, loop: string, step: () => Promise<void>): Promise<void> {
    const failing = this.#failing.get(exchange)!;
    const venue = this.#venues.get(exchange)!;
    let retryMs = FIRST_RETRY_MS;
    while (!this.#closed) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resets = venue.resets;
      try {
        const idle = new Promise<typeof IDLE>((resolve) => {
          idleTimer = setTimeout(() => resolve(IDLE), IDLE_RECONNECT_MS);
          // Waiting on a quiet venue is no reason to keep the process running.
          idleTimer.unref();
        });
        const heard = step();
        // If the wait is given up on, the abandoned step fails when the connection is closed.
        heard.catch(() => {});
        if ((await Promise.race([heard, idle])) === IDLE) {
          throw new Error(`nothing for ${IDLE_RECONNECT_MS / 1000} s`);
        }
        failing.delete(loop);
        retryMs = FIRST_RETRY_MS;
        this.#metrics.streamUp.set({ exchange }, failing.size === 0 ? 1 : 0);
      } catch (error) {
        if (this.#closed) return;
        this.#metrics.streamUp.set({ exchange }, 0);
        // A venue's markets share a connection. When another of them closed it to start over,
        // this one failed with it and has nothing of its own to report.
        if (venue.resets === resets) {
          // Said once per outage; the counter has every attempt.
          if (!failing.has(loop)) this.#deps.log.warn(`${exchange}: stream of ${loop} failed, reconnecting: ${describe(error)}`);
          this.#metrics.streamErrors.inc({ exchange });
          // Closing drops the connection, so that the next attempt subscribes from scratch.
          // Counted before and after: a neighbour that fails at any point of the closing sees
          // a count other than the one it started with.
          venue.resets += 1;
          await venue.client.close().catch(() => {});
          venue.resets += 1;
        }
        failing.add(loop);
        await Promise.race([this.#sleep(retryMs), this.#stopped]);
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      } finally {
        clearTimeout(idleTimer);
      }
    }
  }

  /** Takes in what a venue said. Returns whether it was a quote a round can use. */
  #deliver(exchange: string, market: string, ticker: TickerLike, extra: string): boolean {
    const fetched = toFetched(ticker);
    const key = sourceKey({ exchange, market });
    // A message without both sides of the book says nothing about the price, and a crossed
    // one says something false. Neither is kept, and what was kept before is no longer true.
    if ("error" in fetched || fetched.ticker.bid <= 0n || fetched.ticker.ask < fetched.ticker.bid) {
      this.#latest.delete(key);
      return false;
    }
    const identity = [ticker.bid, ticker.ask, ticker.bidVolume, ticker.askVolume, ticker.timestamp, extra].join("|");
    // Some venues hand back everything they hold whenever any market moves. Only what changed
    // counts as heard just now.
    if (this.#latest.get(key)?.identity !== identity) {
      this.#latest.set(key, { fetched, receivedMs: this.#deps.now(), identity });
    }
    return true;
  }

  async fetchAll(): Promise<Map<string, Fetched>> {
    const { config, rest, now } = this.#deps;
    const nowMs = now();
    const out = new Map<string, Fetched>();
    const ask = new Set<string>();
    for (const spec of allSources(config)) {
      const key = sourceKey(spec);
      if (out.has(key) || ask.has(key)) continue;
      const entry = this.#latest.get(key);
      const labels = { exchange: spec.exchange, market: spec.market };
      if (entry !== undefined && nowMs - entry.receivedMs <= config.streamMaxAgeMs) {
        out.set(key, entry.fetched);
        this.#metrics.quotes.inc({ ...labels, transport: "stream", result: "ok" });
        this.#metrics.quoteAgeSeconds.set(labels, (nowMs - entry.receivedMs) / 1000);
        continue;
      }
      ask.add(key);
    }
    if (ask.size > 0) {
      for (const [key, fetched] of await rest.fetch(ask)) {
        out.set(key, fetched);
        const [exchange, market] = key.split(":") as [string, string];
        if (!("error" in fetched)) this.#metrics.quoteAgeSeconds.set({ exchange, market }, 0);
      }
    }
    return out;
  }

  /** Closes every stream and waits for the loops to end. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#stop();
    await Promise.all([...this.#venues.values()].map(({ client }) => client.close().catch(() => {})));
    await Promise.all(this.#loops);
  }
}

/** A venue's ccxt.pro client. */
export function connectCcxt(exchange: string): StreamClient {
  const pro = (ccxt as unknown as { pro: Record<string, new (options: object) => StreamClient> }).pro;
  const constructor = pro[exchange];
  if (typeof constructor !== "function") throw new Error(`"${exchange}" has no stream client`);
  // The streams pace themselves; ccxt's limiter would only delay the subscriptions.
  return new constructor({ enableRateLimit: false });
}

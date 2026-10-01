// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Fetches best bid and ask from the venues, through ccxt's public REST clients.

import ccxt from "ccxt";
import type { Exchange, Ticker as CcxtTicker } from "ccxt";

import { sourceKey } from "./config.ts";
import type { Config, SourceSpec } from "./config.ts";
import { fromNumber } from "./fixed.ts";
import type { Fetched } from "./round.ts";

export interface TickerSource {
  /** One round: every configured market of every venue, keyed by `exchange:market`. */
  fetchAll(): Promise<Map<string, Fetched>>;
}

const MARKETS_TIMEOUT_MS = 30_000;

function allSources(config: Config): SourceSpec[] {
  return [
    ...config.feeds.flatMap((feed) => feed.sources),
    ...[...config.quoteRates.values()].flatMap((rate) => rate.sources),
  ];
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}...` : message;
}

function toFetched(ticker: CcxtTicker | undefined): Fetched {
  if (ticker === undefined) return { error: "no ticker in the response" };
  const { bid, ask, timestamp } = ticker;
  if (typeof bid !== "number" || typeof ask !== "number") return { error: "no bid or ask" };
  try {
    return {
      ticker: {
        bid: fromNumber(bid),
        ask: fromNumber(ask),
        exchangeTimestampMs: typeof timestamp === "number" ? timestamp : null,
      },
    };
  } catch (error) {
    return { error: describe(error) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class CcxtSources implements TickerSource {
  readonly #timeoutMs: number;
  readonly #batch: Set<string>;
  /** exchange id to its client and the markets fetched from it. */
  readonly #venues = new Map<string, { client: Exchange; markets: string[] }>();

  constructor(config: Config) {
    this.#timeoutMs = config.fetchTimeoutMs;
    this.#batch = config.batchExchanges;
    for (const spec of allSources(config)) {
      let venue = this.#venues.get(spec.exchange);
      if (venue === undefined) {
        const constructor = (ccxt as unknown as Record<string, new (options: object) => Exchange>)[spec.exchange];
        if (typeof constructor !== "function" || !ccxt.exchanges.includes(spec.exchange)) {
          throw new Error(`unknown exchange "${spec.exchange}"`);
        }
        // The service paces itself: one round of requests per interval.
        venue = { client: new constructor({ timeout: config.fetchTimeoutMs, enableRateLimit: false }), markets: [] };
        this.#venues.set(spec.exchange, venue);
      }
      if (!venue.markets.includes(spec.market)) venue.markets.push(spec.market);
    }
  }

  /**
   * Loads every venue's market list and checks that the configured markets exist. A venue that
   * cannot be reached is reported and retried on its first round, not treated as fatal: the
   * service has to start while one venue is down.
   */
  async init(): Promise<string[]> {
    const problems: string[] = [];
    await Promise.all(
      [...this.#venues].map(async ([id, venue]) => {
        // A market list is many times larger than a ticker and is loaded once.
        venue.client.timeout = MARKETS_TIMEOUT_MS;
        try {
          await withTimeout(venue.client.loadMarkets(), MARKETS_TIMEOUT_MS);
        } catch (error) {
          problems.push(`${id}: markets not loaded (${describe(error)})`);
          return;
        } finally {
          venue.client.timeout = this.#timeoutMs;
        }
        for (const market of venue.markets) {
          if (!(market in (venue.client.markets ?? {}))) {
            throw new Error(`${id} has no market "${market}"`);
          }
        }
      }),
    );
    return problems;
  }

  async fetchAll(): Promise<Map<string, Fetched>> {
    const out = new Map<string, Fetched>();
    await Promise.all(
      [...this.#venues].map(async ([id, venue]) => {
        if (this.#batch.has(id)) {
          try {
            const tickers = await withTimeout(venue.client.fetchTickers(venue.markets), this.#timeoutMs);
            for (const market of venue.markets) {
              out.set(sourceKey({ exchange: id, market }), toFetched(tickers[market]));
            }
          } catch (error) {
            for (const market of venue.markets) {
              out.set(sourceKey({ exchange: id, market }), { error: describe(error) });
            }
          }
          return;
        }
        await Promise.all(
          venue.markets.map(async (market) => {
            const key = sourceKey({ exchange: id, market });
            try {
              out.set(key, toFetched(await withTimeout(venue.client.fetchTicker(market), this.#timeoutMs)));
            } catch (error) {
              out.set(key, { error: describe(error) });
            }
          }),
        );
      }),
    );
    return out;
  }
}

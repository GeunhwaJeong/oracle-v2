// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Fetches best bid and ask from the venues, through ccxt's public REST clients.

import ccxt from "ccxt";
import type { Exchange, Ticker as CcxtTicker } from "ccxt";

import { sourceKey } from "./config.ts";
import type { Config, SourceSpec } from "./config.ts";
import { fromNumber } from "./fixed.ts";
import { Metrics } from "./metrics.ts";
import type { Fetched } from "./round.ts";

export interface TickerSource {
  /** One round: every configured market of every venue, keyed by `exchange:market`. */
  fetchAll(): Promise<Map<string, Fetched>>;
}

/** Something that can be asked for the tickers of some of the configured markets. */
export interface TickerFetcher {
  /** The markets named by `only` (as `exchange:market`), or every configured one. */
  fetch(only?: ReadonlySet<string>): Promise<Map<string, Fetched>>;
}

/**
 * Prices are formed from spot markets only. Left to itself a venue's client also loads the
 * venue's swaps, futures and options: thousands of markets that are never asked for, most of a
 * client's memory, and on some venues most of the time its market list takes to load. A venue
 * without the option ignores it.
 */
export const SPOT_MARKETS_ONLY = { fetchMarkets: { types: ["spot"] } };

const MARKETS_TIMEOUT_MS = 30_000;
/**
 * How long startup waits for the market lists. No price is signed while it waits, so a venue
 * that is slow to answer must not hold the others back.
 */
const STARTUP_WAIT_MS = 5_000;

export function allSources(config: Config): SourceSpec[] {
  return [
    ...config.feeds.flatMap((feed) => feed.sources),
    ...[...config.quoteRates.values()].flatMap((rate) => rate.sources),
  ];
}

export function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 160 ? `${message.slice(0, 160)}...` : message;
}

/** The best bid and ask of a ticker, or of anything shaped like one. */
export function toFetched(
  ticker: { bid?: number | undefined; ask?: number | undefined; timestamp?: number | undefined } | undefined,
): Fetched {
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

/** A venue whose market list is loaded at startup. */
export interface MarketLoader {
  id: string;
  /** The configured markets, which the venue has to list. */
  markets: string[];
  /** Resolves to the venue's markets by symbol. */
  load(): Promise<Record<string, unknown>>;
}

/** How the loading of a venue that was not waited for ended. */
export type LateOutcome = { id: string; ok: true } | { id: string; ok: false; fatal: boolean; reason: string };

function missingMarket(loader: MarketLoader, listed: Record<string, unknown>): string | null {
  for (const market of loader.markets) {
    if (!(market in listed)) return `${loader.id} has no market "${market}"`;
  }
  return null;
}

/**
 * Loads the venues' market lists side by side and waits for them at most `waitMs`.
 *
 * Returns the problems that are not fatal: the venues that failed to load and those still
 * loading. Throws when a venue that answered in time does not list a configured market, which
 * is a mistake in the configuration. A venue that answers later is checked the same way and
 * reported through `onLate`; by then prices are being signed, so nothing is thrown.
 */
export async function loadMarketsWithin(
  loaders: MarketLoader[],
  waitMs: number,
  onLate: (outcome: LateOutcome) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()),
): Promise<string[]> {
  type Outcome = { missing: string | null } | { error: string };
  const deadline = sleep(waitMs).then(() => null);
  const problems: string[] = [];
  let fatal: string | null = null;
  await Promise.all(
    loaders.map(async (loader) => {
      const loading: Promise<Outcome> = loader.load().then(
        (listed) => ({ missing: missingMarket(loader, listed) }),
        (error: unknown) => ({ error: describe(error) }),
      );
      const outcome = await Promise.race([loading, deadline]);
      if (outcome === null) {
        problems.push(`${loader.id}: markets still loading after ${waitMs} ms, starting without them`);
        void loading.then((late) => {
          if ("error" in late) onLate({ id: loader.id, ok: false, fatal: false, reason: `markets not loaded (${late.error})` });
          else if (late.missing !== null) onLate({ id: loader.id, ok: false, fatal: true, reason: late.missing });
          else onLate({ id: loader.id, ok: true });
        });
        return;
      }
      if ("error" in outcome) problems.push(`${loader.id}: markets not loaded (${outcome.error})`);
      else if (outcome.missing !== null) fatal ??= outcome.missing;
    }),
  );
  if (fatal !== null) throw new Error(fatal);
  return problems;
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

export class CcxtSources implements TickerSource, TickerFetcher {
  readonly #timeoutMs: number;
  readonly #batch: Set<string>;
  readonly #metrics: Metrics;
  /** exchange id to its client and the markets fetched from it. */
  readonly #venues = new Map<string, { client: Exchange; markets: string[] }>();

  constructor(config: Config, metrics: Metrics = new Metrics()) {
    this.#timeoutMs = config.fetchTimeoutMs;
    this.#batch = config.batchExchanges;
    this.#metrics = metrics;
    for (const spec of allSources(config)) {
      let venue = this.#venues.get(spec.exchange);
      if (venue === undefined) {
        const constructor = (ccxt as unknown as Record<string, new (options: object) => Exchange>)[spec.exchange];
        if (typeof constructor !== "function" || !ccxt.exchanges.includes(spec.exchange)) {
          throw new Error(`unknown exchange "${spec.exchange}"`);
        }
        // The service paces itself: one round of requests per interval.
        venue = {
          client: new constructor({ timeout: config.fetchTimeoutMs, enableRateLimit: false, options: SPOT_MARKETS_ONLY }),
          markets: [],
        };
        this.#venues.set(spec.exchange, venue);
      }
      if (!venue.markets.includes(spec.market)) venue.markets.push(spec.market);
    }
  }

  /**
   * Loads every venue's market list and checks that the configured markets exist, for at most
   * `waitMs`. A venue that cannot be reached, or has not answered by then, is reported and not
   * treated as fatal: the service has to start, and to start soon, while one venue is down or
   * slow. Such a venue is left out of the rounds until its markets are there, and `onLate` is
   * told how its loading ended.
   */
  init(onLate: (outcome: LateOutcome) => void = () => {}, waitMs: number = STARTUP_WAIT_MS): Promise<string[]> {
    return loadMarketsWithin(
      [...this.#venues].map(([id, venue]) => ({
        id,
        markets: venue.markets,
        load: async () => {
          // A market list is many times larger than a ticker and is loaded once.
          venue.client.timeout = MARKETS_TIMEOUT_MS;
          try {
            await withTimeout(venue.client.loadMarkets(), MARKETS_TIMEOUT_MS);
          } finally {
            venue.client.timeout = this.#timeoutMs;
          }
          return venue.client.markets ?? {};
        },
      })),
      waitMs,
      onLate,
    );
  }

  fetchAll(): Promise<Map<string, Fetched>> {
    return this.fetch();
  }

  async fetch(only?: ReadonlySet<string>): Promise<Map<string, Fetched>> {
    const out = new Map<string, Fetched>();
    const record = (exchange: string, market: string, fetched: Fetched) => {
      out.set(sourceKey({ exchange, market }), fetched);
      this.#metrics.quotes.inc({ exchange, market, transport: "rest", result: "error" in fetched ? "error" : "ok" });
    };
    await Promise.all(
      [...this.#venues].map(async ([id, venue]) => {
        const markets =
          only === undefined
            ? venue.markets
            : venue.markets.filter((market) => only.has(sourceKey({ exchange: id, market })));
        if (markets.length === 0) return;
        if (this.#batch.has(id)) {
          try {
            const tickers = await withTimeout(venue.client.fetchTickers(markets), this.#timeoutMs);
            for (const market of markets) record(id, market, toFetched(tickers[market]));
          } catch (error) {
            for (const market of markets) record(id, market, { error: describe(error) });
          }
          return;
        }
        await Promise.all(
          markets.map(async (market) => {
            try {
              record(id, market, toFetched(await withTimeout(venue.client.fetchTicker(market), this.#timeoutMs)));
            } catch (error) {
              record(id, market, { error: describe(error) });
            }
          }),
        );
      }),
    );
    return out;
  }
}

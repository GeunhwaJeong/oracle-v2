// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The service's configuration: a JSON file for everything public, the environment for keys.

import { readFileSync } from "node:fs";

import { parseFixed } from "./fixed.ts";

export interface SourceSpec {
  /** ccxt exchange id, e.g. `binance`. */
  exchange: string;
  /** ccxt unified market symbol on that exchange, e.g. `BTC/USDT`. */
  market: string;
  /** How many times the venue's votes count. */
  weight: number;
}

export interface FeedLimits {
  /** Fewest venues that have to agree before a price is signed. */
  minSources: number;
  /** A venue further than this from the median of all venues is left out. */
  maxDeviationBps: number;
  /** A price whose confidence interval is wider than this is not signed. */
  maxConfidenceBps: number;
  /** Furthest a signed price moves from the previous one, per update. */
  maxStepBps: number;
}

export interface FeedConfig extends FeedLimits {
  /** `BASE/QUOTE`, e.g. `BTC/USD`. */
  symbol: string;
  /** `storage_id` of the feed's `PriceFeedStorage`. */
  storageId: number;
  /** Object id of the feed's `PriceFeedStorage`. */
  priceFeedStorageId: string;
  /** A constant price, for an asset that is worth its quote by construction. */
  fixedPrice: bigint | null;
  sources: SourceSpec[];
}

export interface RateConfig {
  sources: SourceSpec[];
  minSources: number;
  maxDeviationBps: number;
}

export interface Config {
  /** gRPC endpoint of a Haneul node. */
  rpcUrl: string;
  network: string;
  /** Package id of `oracle_haneul`. */
  packageId: string;
  /** Object id of the shared `Source<HANEUL>`. */
  sourceId: string;
  /** Object id of the `oracle_aggregator` config. */
  aggregatorConfigId: string;
  /** How often a round runs: fetch, aggregate, sign and relay. */
  intervalMs: number;
  /** How long a venue has to answer before the round goes on without it. */
  fetchTimeoutMs: number;
  /** A ticker whose own timestamp is older than this is treated as a stalled venue. */
  maxExchangeLagMs: number;
  /**
   * After this long without a signed price the step limit no longer applies: the previous price
   * says nothing about the market any more, and creeping toward it would publish a wrong price
   * for longer than not publishing at all.
   */
  stepLimitResetMs: number;
  /** Port of the HTTP endpoint that serves the latest signed updates; 0 turns it off. */
  httpPort: number;
  httpHost: string;
  /** Balance of the relayer below which a warning is logged, in HANEUL. */
  lowBalanceHaneul: number;
  feeds: FeedConfig[];
  /** Conversion rates into the feeds' quote currency, keyed by the currency converted from. */
  quoteRates: Map<string, RateConfig>;
  /** Venues whose tickers are fetched in one request per round instead of one per market. */
  batchExchanges: Set<string>;
}

function fail(message: string): never {
  throw new Error(`config: ${message}`);
}

function object(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "") fail(`${where} must be a non-empty string`);
  return value;
}

function integer(value: unknown, where: string, fallback: number | undefined, min: number, max: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(`${where} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function objectId(value: unknown, where: string): string {
  const id = string(value, where);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(id)) fail(`${where} must be an object id`);
  return id;
}

function sources(value: unknown, where: string): SourceSpec[] {
  if (!Array.isArray(value) || value.length === 0) fail(`${where} must be a non-empty list`);
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const raw = object(entry, `${where}[${i}]`);
    const spec = {
      exchange: string(raw.exchange, `${where}[${i}].exchange`),
      market: string(raw.market, `${where}[${i}].market`),
      weight: integer(raw.weight, `${where}[${i}].weight`, 1, 1, 100),
    };
    if (!/^[^/]+\/[^/]+$/.test(spec.market)) fail(`${where}[${i}].market must be BASE/QUOTE`);
    const key = sourceKey(spec);
    if (seen.has(key)) fail(`${where} lists ${key} twice`);
    seen.add(key);
    return spec;
  });
}

export function sourceKey(spec: { exchange: string; market: string }): string {
  return `${spec.exchange}:${spec.market}`;
}

export function quoteOf(market: string): string {
  return market.split("/")[1]!;
}

export function parseConfig(json: unknown): Config {
  const root = object(json, "the file");

  const quoteRates = new Map<string, RateConfig>();
  for (const [currency, value] of Object.entries(object(root.quoteRates ?? {}, "quoteRates"))) {
    const raw = object(value, `quoteRates.${currency}`);
    const rate = {
      sources: sources(raw.sources, `quoteRates.${currency}.sources`),
      minSources: integer(raw.minSources, `quoteRates.${currency}.minSources`, 2, 1, 100),
      maxDeviationBps: integer(raw.maxDeviationBps, `quoteRates.${currency}.maxDeviationBps`, 50, 1, 10_000),
    };
    if (rate.minSources > rate.sources.length) {
      fail(`quoteRates.${currency}.minSources exceeds its number of sources`);
    }
    quoteRates.set(currency, rate);
  }

  if (!Array.isArray(root.feeds) || root.feeds.length === 0) fail("feeds must be a non-empty list");
  const storageIds = new Set<number>();
  const feeds = root.feeds.map((entry, i): FeedConfig => {
    const where = `feeds[${i}]`;
    const raw = object(entry, where);
    const symbol = string(raw.symbol, `${where}.symbol`);
    if (!/^[^/]+\/[^/]+$/.test(symbol)) fail(`${where}.symbol must be BASE/QUOTE`);
    const storageId = integer(raw.storageId, `${where}.storageId`, undefined, 0, 2 ** 32 - 1);
    if (storageIds.has(storageId)) fail(`${where}.storageId ${storageId} is used twice`);
    storageIds.add(storageId);

    const fixed = raw.fixedPrice === undefined ? null : parseFixed(string(raw.fixedPrice, `${where}.fixedPrice`));
    if (fixed !== null && fixed <= 0n) fail(`${where}.fixedPrice must be positive`);
    if ((fixed === null) === (raw.sources === undefined)) {
      fail(`${where} needs either sources or a fixedPrice`);
    }
    const feedSources = fixed === null ? sources(raw.sources, `${where}.sources`) : [];
    for (const spec of feedSources) {
      const quote = quoteOf(spec.market);
      if (quote !== quoteOf(symbol) && !quoteRates.has(quote)) {
        fail(`${where}: ${sourceKey(spec)} is quoted in ${quote}, which has no entry in quoteRates`);
      }
    }
    const minSources = integer(raw.minSources, `${where}.minSources`, 3, 1, 100);
    if (fixed === null && minSources > feedSources.length) {
      fail(`${where}.minSources exceeds its number of sources`);
    }
    return {
      symbol,
      storageId,
      priceFeedStorageId: objectId(raw.priceFeedStorageId, `${where}.priceFeedStorageId`),
      fixedPrice: fixed,
      sources: feedSources,
      minSources,
      maxDeviationBps: integer(raw.maxDeviationBps, `${where}.maxDeviationBps`, 100, 1, 10_000),
      maxConfidenceBps: integer(raw.maxConfidenceBps, `${where}.maxConfidenceBps`, 50, 0, 10_000),
      maxStepBps: integer(raw.maxStepBps, `${where}.maxStepBps`, 100, 1, 10_000),
    };
  });

  const batch = root.batchExchanges ?? [];
  if (!Array.isArray(batch)) fail("batchExchanges must be a list");

  return {
    rpcUrl: string(root.rpcUrl, "rpcUrl"),
    network: typeof root.network === "string" ? root.network : "mainnet",
    packageId: objectId(root.packageId, "packageId"),
    sourceId: objectId(root.sourceId, "sourceId"),
    aggregatorConfigId: objectId(root.aggregatorConfigId, "aggregatorConfigId"),
    intervalMs: integer(root.intervalMs, "intervalMs", 3_000, 500, 60_000),
    fetchTimeoutMs: integer(root.fetchTimeoutMs, "fetchTimeoutMs", 2_000, 100, 30_000),
    maxExchangeLagMs: integer(root.maxExchangeLagMs, "maxExchangeLagMs", 30_000, 1_000, 600_000),
    stepLimitResetMs: integer(root.stepLimitResetMs, "stepLimitResetMs", 60_000, 1_000, 86_400_000),
    httpPort: integer(root.httpPort, "httpPort", 0, 0, 65_535),
    httpHost: typeof root.httpHost === "string" ? root.httpHost : "127.0.0.1",
    lowBalanceHaneul: integer(root.lowBalanceHaneul, "lowBalanceHaneul", 20, 0, 1_000_000_000),
    feeds,
    quoteRates,
    batchExchanges: new Set(batch.map((id, i) => string(id, `batchExchanges[${i}]`))),
  };
}

export function loadConfig(path: string): Config {
  return parseConfig(JSON.parse(readFileSync(path, "utf8")));
}

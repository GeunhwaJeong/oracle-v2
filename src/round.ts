// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// One round of price formation, as a pure function of the tickers the venues returned. What
// to sign is decided here; nothing in this file touches the network, a clock or a key.

import { aggregate, clampStep, splitOutliers } from "./aggregate.ts";
import type { Quote } from "./aggregate.ts";
import { quoteOf, sourceKey } from "./config.ts";
import type { Config, FeedConfig, SourceSpec } from "./config.ts";
import { BPS, ONE, mulDiv } from "./fixed.ts";

export interface Ticker {
  /** Best bid and ask, 18 decimals. */
  bid: bigint;
  ask: bigint;
  /** The venue's own timestamp of the ticker, when it reports one. */
  exchangeTimestampMs: number | null;
}

/** What a venue returned for a market this round: a ticker, or why there is none. */
export type Fetched = { ticker: Ticker } | { error: string };

/** Why a venue was left out of a round, as a class a metric can count. */
export type DropKind = "error" | "crossed" | "stale" | "no_rate" | "outlier";

export interface Dropped {
  source: string;
  kind: DropKind;
  reason: string;
}

/** A venue's mid price in the feed's quote currency, whether it was used or found an outlier. */
export interface SourceMid {
  source: string;
  mid: bigint;
}

export interface Formed {
  price: bigint;
  confidence: bigint;
  used: string[];
  dropped: Dropped[];
  mids: SourceMid[];
}

export type Formation =
  | ({ ok: true } & Formed)
  | { ok: false; reason: string; dropped: Dropped[]; mids: SourceMid[] };

interface Rate {
  price: bigint;
  confidence: bigint;
}

function quotesFrom(
  specs: SourceSpec[],
  fetched: Map<string, Fetched>,
  nowMs: number,
  maxExchangeLagMs: number,
  convert: (spec: SourceSpec, quote: Quote) => Quote | string,
): { quotes: Quote[]; dropped: Dropped[] } {
  const quotes: Quote[] = [];
  const dropped: Dropped[] = [];
  for (const spec of specs) {
    const source = sourceKey(spec);
    const result = fetched.get(source);
    if (result === undefined) {
      dropped.push({ source, kind: "error", reason: "not fetched" });
      continue;
    }
    if ("error" in result) {
      dropped.push({ source, kind: "error", reason: result.error });
      continue;
    }
    const { bid, ask, exchangeTimestampMs } = result.ticker;
    if (bid <= 0n || ask < bid) {
      dropped.push({ source, kind: "crossed", reason: "empty or crossed book" });
      continue;
    }
    if (exchangeTimestampMs !== null && nowMs - exchangeTimestampMs > maxExchangeLagMs) {
      dropped.push({ source, kind: "stale", reason: `ticker is ${nowMs - exchangeTimestampMs} ms old` });
      continue;
    }
    const converted = convert(spec, {
      source,
      mid: (bid + ask) / 2n,
      halfSpread: (ask - bid) / 2n,
      weight: spec.weight,
    });
    if (typeof converted === "string") {
      dropped.push({ source, kind: "no_rate", reason: converted });
      continue;
    }
    quotes.push(converted);
  }
  return { quotes, dropped };
}

function form(
  quotes: Quote[],
  dropped: Dropped[],
  minSources: number,
  maxDeviationBps: number,
): Formation {
  const { kept, outliers } = splitOutliers(quotes, maxDeviationBps);
  const allDropped: Dropped[] = [
    ...dropped,
    ...outliers.map((q) => ({ source: q.source, kind: "outlier" as const, reason: "away from the other venues" })),
  ];
  const mids = quotes.map((q) => ({ source: q.source, mid: q.mid }));
  if (kept.length < minSources) {
    return {
      ok: false,
      reason: `${kept.length} usable venue(s), ${minSources} needed`,
      dropped: allDropped,
      mids,
    };
  }
  return { ok: true, ...aggregate(kept), used: kept.map((q) => q.source), dropped: allDropped, mids };
}

/**
 * Forms the price of every feed from this round's tickers.
 *
 * A venue quoted in another currency than the feed (BTC/USDT for BTC/USD) is converted with
 * that currency's rate, itself formed this round from venues that trade it against the feed's
 * quote. The rate's own uncertainty is added to the venue's spread. If the rate cannot be
 * formed, the venues that need it are left out rather than taken at par.
 */
export function formPrices(
  config: Config,
  fetched: Map<string, Fetched>,
  nowMs: number,
): Map<string, Formation> {
  const rates = new Map<string, Rate | string>();
  for (const [currency, rate] of config.quoteRates) {
    const { quotes, dropped } = quotesFrom(
      rate.sources,
      fetched,
      nowMs,
      config.maxExchangeLagMs,
      (_, quote) => quote,
    );
    const formed = form(quotes, dropped, rate.minSources, rate.maxDeviationBps);
    rates.set(
      currency,
      formed.ok ? { price: formed.price, confidence: formed.confidence } : formed.reason,
    );
  }

  const out = new Map<string, Formation>();
  for (const feed of config.feeds) {
    out.set(feed.symbol, formFeed(feed, fetched, rates, nowMs, config.maxExchangeLagMs));
  }
  return out;
}

function formFeed(
  feed: FeedConfig,
  fetched: Map<string, Fetched>,
  rates: Map<string, Rate | string>,
  nowMs: number,
  maxExchangeLagMs: number,
): Formation {
  if (feed.fixedPrice !== null) {
    return { ok: true, price: feed.fixedPrice, confidence: 0n, used: ["fixed"], dropped: [], mids: [] };
  }
  const feedQuote = quoteOf(feed.symbol);
  const { quotes, dropped } = quotesFrom(feed.sources, fetched, nowMs, maxExchangeLagMs, (spec, quote) => {
    const currency = quoteOf(spec.market);
    if (currency === feedQuote) return quote;
    const rate = rates.get(currency);
    if (rate === undefined || typeof rate === "string") {
      return `no ${currency}/${feedQuote} rate (${rate ?? "not configured"})`;
    }
    return {
      ...quote,
      mid: mulDiv(quote.mid, rate.price, ONE),
      halfSpread: mulDiv(quote.halfSpread, rate.price, ONE) + mulDiv(quote.mid, rate.confidence, ONE),
    };
  });
  return form(quotes, dropped, feed.minSources, feed.maxDeviationBps);
}

export interface Previous {
  price: bigint;
  timestampMs: number;
}

export type Decision =
  | { sign: true; price: bigint; confidence: bigint; clampedFrom: bigint | null }
  | { sign: false; kind: "price" | "confidence"; reason: string };

/**
 * Decides what to sign for a formed price, given the price signed before it.
 *
 * A confidence interval wider than the feed's bound is not signed at all: the venues disagree,
 * and a stale feed stops the markets, which is the safe outcome. A price further than the step
 * limit from the previous one is signed at the limit, so the feed follows a real move over a
 * few updates but cannot be thrown by a single bad round. The limit lapses once the previous
 * price is older than `stepLimitResetMs`.
 */
export function decide(
  formed: Pick<Formed, "price" | "confidence">,
  previous: Previous | null,
  limits: { maxConfidenceBps: number; maxStepBps: number },
  nowMs: number,
  stepLimitResetMs: number,
): Decision {
  if (formed.price <= 0n) return { sign: false, kind: "price", reason: "non-positive price" };
  if (formed.confidence * BPS > formed.price * BigInt(limits.maxConfidenceBps)) {
    return { sign: false, kind: "confidence", reason: "confidence interval wider than the feed allows" };
  }
  if (previous === null || nowMs - previous.timestampMs > stepLimitResetMs) {
    return { sign: true, price: formed.price, confidence: formed.confidence, clampedFrom: null };
  }
  const price = clampStep(formed.price, previous.price, limits.maxStepBps);
  if (price === formed.price) {
    return { sign: true, price, confidence: formed.confidence, clampedFrom: null };
  }
  // The signed price is not where the venues are: say so in the confidence interval, as far
  // as the feed's bound allows.
  const gap = price > formed.price ? price - formed.price : formed.price - price;
  const bound = (price * BigInt(limits.maxConfidenceBps)) / BPS;
  const confidence = formed.confidence + gap > bound ? bound : formed.confidence + gap;
  return { sign: true, price, confidence, clampedFrom: formed.price };
}

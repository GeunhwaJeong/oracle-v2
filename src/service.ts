// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The loop: every interval fetch the venues, form each feed's price, sign what passes the
// guards and relay it. The latest signed updates are kept for the HTTP endpoint, so a front
// end can put them in a trader's own transaction.

import type { Chain, SignedUpdate } from "./chain.ts";
import type { Config, FeedConfig } from "./config.ts";
import { BPS, ONE, formatFixed } from "./fixed.ts";
import type { PriceSigner } from "./message.ts";
import { Metrics } from "./metrics.ts";
import { decide, formPrices } from "./round.ts";
import type { Previous } from "./round.ts";
import type { TickerSource } from "./sources.ts";

export interface FeedStatus {
  symbol: string;
  /** Milliseconds since the last signed update, or null before the first one. */
  ageMs: number | null;
  lastPrice: string | null;
  /** Why the latest round signed nothing for this feed, or null if it did. */
  skipped: string | null;
  venuesUsed: number;
  /**
   * Milliseconds since an update of the feed last landed on chain, or null if none has. Absent
   * when the service does not relay.
   */
  relayedAgeMs?: number | null;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ServiceDeps {
  config: Config;
  sources: TickerSource;
  /** Null in dry-run mode: prices are formed and logged, nothing is signed. */
  signer: PriceSigner | null;
  /** Null when the service only signs and serves, and something else relays. */
  chain: Chain | null;
  log: Logger;
  now: () => number;
  metrics?: Metrics;
}

/** A fixed-point value as a float, for a metric. */
function toFloat(value: bigint): number {
  // The whole and the fraction separately: together they do not fit a double.
  return Number(value / ONE) + Number(value % ONE) / Number(ONE);
}

export class PriceService {
  readonly #deps: ServiceDeps;
  /** What each feed last signed (or, before that, what the chain holds). */
  readonly #previous = new Map<string, Previous>();
  readonly #latest = new Map<string, SignedUpdate>();
  readonly #skipped = new Map<string, string>();
  readonly #venuesUsed = new Map<string, number>();
  /** When an update of each feed last landed on chain. */
  readonly #relayedMs = new Map<string, number>();
  readonly #metrics: Metrics;
  #lastSignedMs = 0;
  #roundsSinceBalanceCheck = 0;

  constructor(deps: ServiceDeps) {
    this.#deps = deps;
    this.#metrics = deps.metrics ?? new Metrics();
  }

  /** Whether updates are relayed by this service, rather than only signed and served. */
  get relays(): boolean {
    return this.#deps.chain !== null;
  }

  /** Starts each feed's step limit from the price the chain holds. */
  async loadStoredPrices(): Promise<void> {
    const { chain, config, log } = this.#deps;
    if (chain === null) return;
    const sourceNumericId = await chain.sourceNumericId();
    for (const feed of config.feeds) {
      const stored = await chain.storedPrice(feed.priceFeedStorageId, sourceNumericId);
      if (stored === null) {
        log.warn(`${feed.symbol}: the source has no feed in ${feed.priceFeedStorageId} yet; updates will abort until it is created`);
        continue;
      }
      this.#previous.set(feed.symbol, stored);
      // What the chain holds landed there at some point: the feed starts from that age.
      this.#relayedMs.set(feed.symbol, stored.timestampMs);
      this.#metrics.lastRelayed.set({ feed: feed.symbol }, stored.timestampMs / 1000);
      this.#lastSignedMs = Math.max(this.#lastSignedMs, stored.timestampMs);
      log.info(`${feed.symbol}: on chain ${formatFixed(stored.price)} at ${new Date(stored.timestampMs).toISOString()}`);
    }
  }

  latestUpdates(): SignedUpdate[] {
    return [...this.#latest.values()];
  }

  status(): FeedStatus[] {
    const now = this.#deps.now();
    return this.#deps.config.feeds.map((feed) => {
      const latest = this.#latest.get(feed.symbol);
      return {
        symbol: feed.symbol,
        ageMs: latest === undefined ? null : now - Number(latest.timestampMs),
        lastPrice: latest === undefined ? null : formatFixed(latest.price),
        skipped: this.#skipped.get(feed.symbol) ?? null,
        venuesUsed: this.#venuesUsed.get(feed.symbol) ?? 0,
        ...(this.relays ? { relayedAgeMs: this.#relayedMs.has(feed.symbol) ? now - this.#relayedMs.get(feed.symbol)! : null } : {}),
      };
    });
  }

  /** One round. Returns the updates signed in it. */
  async round(): Promise<SignedUpdate[]> {
    const { config, sources, signer, chain, log, now } = this.#deps;
    const metrics = this.#metrics;
    const started = now();
    const fetched = await sources.fetchAll();
    const nowMs = now();
    metrics.fetchSeconds.observe((nowMs - started) / 1000);
    const formations = formPrices(config, fetched, nowMs);

    const signed: SignedUpdate[] = [];
    for (const feed of config.feeds) {
      const formation = formations.get(feed.symbol)!;
      const labels = { feed: feed.symbol };
      for (const dropped of formation.dropped) {
        log.warn(`${feed.symbol}: left out ${dropped.source}: ${dropped.reason}`);
        metrics.sourceOutcomes.inc({ ...labels, source: dropped.source, outcome: dropped.kind });
      }
      for (const { source, mid } of formation.mids) {
        metrics.sourceMid.set({ ...labels, source }, toFloat(mid));
      }
      if (!formation.ok) {
        this.#skip(feed, "sources", formation.reason);
        continue;
      }
      for (const source of formation.used) {
        metrics.sourceOutcomes.inc({ ...labels, source, outcome: "used" });
      }
      this.#venuesUsed.set(feed.symbol, formation.used.length);
      metrics.sourcesUsed.set(labels, formation.used.length);
      const decision = decide(formation, this.#previous.get(feed.symbol) ?? null, feed, nowMs, config.stepLimitResetMs);
      if (!decision.sign) {
        this.#skip(feed, decision.kind, decision.reason);
        continue;
      }
      if (decision.clampedFrom !== null) {
        metrics.clamped.inc(labels);
        log.warn(
          `${feed.symbol}: venues are at ${formatFixed(decision.clampedFrom)}, more than ${feed.maxStepBps} bps ` +
            `from the previous price; signing ${formatFixed(decision.price)}`,
        );
      }
      this.#skipped.delete(feed.symbol);
      if (signer === null) {
        log.info(
          `${feed.symbol}: ${formatFixed(decision.price)} +/- ${formatFixed(decision.confidence)} ` +
            `from ${formation.used.length} venue(s) (dry run, not signed)`,
        );
        continue;
      }
      signed.push(this.#sign(feed, signer, decision.price, decision.confidence, nowMs));
    }

    if (signed.length > 0 && chain !== null) {
      if (!(await this.#relay(chain, signed)) && signed.length > 1) {
        // One update the chain refuses (a feed beyond its step limit, say) fails the whole
        // transaction. The other feeds must not go stale with it, so each goes out on its own.
        for (const update of signed) await this.#relay(chain, [update]);
      }
      await this.#checkBalance();
    }
    metrics.rounds.inc();
    metrics.roundSeconds.observe((now() - started) / 1000);
    return signed;
  }

  /** Relays the updates in one transaction; a failure is logged, not thrown. */
  async #relay(chain: Chain, updates: SignedUpdate[]): Promise<boolean> {
    const { log } = this.#deps;
    const what = updates.map((u) => `${u.symbol}=${formatFixed(u.price)}`).join(" ");
    try {
      const { digest, gasUsed } = await chain.relay(updates);
      log.info(`relayed ${what} in ${digest} (gas ${gasUsed})`);
      const landedMs = this.#deps.now();
      for (const update of updates) {
        this.#relayedMs.set(update.symbol, landedMs);
        this.#metrics.lastRelayed.set({ feed: update.symbol }, landedMs / 1000);
      }
      this.#metrics.relays.inc({ result: "ok" });
      this.#metrics.relayGas.inc({}, Number(gasUsed));
      return true;
    } catch (error) {
      this.#metrics.relays.inc({ result: "failed" });
      // The signed updates stay available over HTTP; the next round signs fresh ones.
      log.error(`relay failed for ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  #skip(feed: FeedConfig, kind: "sources" | "price" | "confidence", reason: string): void {
    this.#skipped.set(feed.symbol, reason);
    this.#metrics.skipped.inc({ feed: feed.symbol, reason: kind });
    if (kind === "sources") {
      this.#venuesUsed.set(feed.symbol, 0);
      this.#metrics.sourcesUsed.set({ feed: feed.symbol }, 0);
    }
    this.#deps.log.error(`${feed.symbol}: nothing signed this round: ${reason}`);
  }

  #sign(feed: FeedConfig, signer: PriceSigner, price: bigint, confidence: bigint, nowMs: number): SignedUpdate {
    // The feed skips an update that is not newer than the stored one, so timestamps only go up.
    this.#lastSignedMs = Math.max(nowMs, this.#lastSignedMs + 1);
    const timestampMs = BigInt(this.#lastSignedMs);
    const update: SignedUpdate = {
      symbol: feed.symbol,
      storageId: feed.storageId,
      priceFeedStorageId: feed.priceFeedStorageId,
      price,
      confidence,
      timestampMs,
      publicKey: signer.publicKey,
      signature: signer.sign({
        sourceId: this.#deps.config.sourceId,
        storageId: feed.storageId,
        price,
        confidence,
        timestampMs,
      }),
    };
    this.#previous.set(feed.symbol, { price, timestampMs: this.#lastSignedMs });
    this.#latest.set(feed.symbol, update);
    const labels = { feed: feed.symbol };
    this.#metrics.signed.inc(labels);
    this.#metrics.price.set(labels, toFloat(price));
    this.#metrics.confidenceBps.set(labels, price === 0n ? 0 : Number((confidence * BPS * 1000n) / price) / 1000);
    this.#metrics.lastSigned.set(labels, this.#lastSignedMs / 1000);
    return update;
  }

  async #checkBalance(): Promise<void> {
    const { chain, config, log } = this.#deps;
    if (chain === null || ++this.#roundsSinceBalanceCheck < 100) return;
    this.#roundsSinceBalanceCheck = 0;
    try {
      const balance = await chain.relayerBalance();
      this.#metrics.relayerBalance.set({}, balance);
      if (balance < config.lowBalanceHaneul) {
        log.warn(`relayer balance is ${balance} HANEUL, below ${config.lowBalanceHaneul}`);
      }
    } catch (error) {
      log.warn(`balance check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

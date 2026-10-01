// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The loop: every interval fetch the venues, form each feed's price, sign what passes the
// guards and relay it. The latest signed updates are kept for the HTTP endpoint, so a front
// end can put them in a trader's own transaction.

import type { Chain, SignedUpdate } from "./chain.ts";
import type { Config, FeedConfig } from "./config.ts";
import { formatFixed } from "./fixed.ts";
import type { PriceSigner } from "./message.ts";
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
}

export class PriceService {
  readonly #deps: ServiceDeps;
  /** What each feed last signed (or, before that, what the chain holds). */
  readonly #previous = new Map<string, Previous>();
  readonly #latest = new Map<string, SignedUpdate>();
  readonly #skipped = new Map<string, string>();
  readonly #venuesUsed = new Map<string, number>();
  #lastSignedMs = 0;
  #roundsSinceBalanceCheck = 0;

  constructor(deps: ServiceDeps) {
    this.#deps = deps;
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
      };
    });
  }

  /** One round. Returns the updates signed in it. */
  async round(): Promise<SignedUpdate[]> {
    const { config, sources, signer, chain, log, now } = this.#deps;
    const fetched = await sources.fetchAll();
    const nowMs = now();
    const formations = formPrices(config, fetched, nowMs);

    const signed: SignedUpdate[] = [];
    for (const feed of config.feeds) {
      const formation = formations.get(feed.symbol)!;
      for (const dropped of formation.dropped) {
        log.warn(`${feed.symbol}: left out ${dropped.source}: ${dropped.reason}`);
      }
      if (!formation.ok) {
        this.#skip(feed, formation.reason);
        continue;
      }
      this.#venuesUsed.set(feed.symbol, formation.used.length);
      const decision = decide(formation, this.#previous.get(feed.symbol) ?? null, feed, nowMs, config.stepLimitResetMs);
      if (!decision.sign) {
        this.#skip(feed, decision.reason);
        continue;
      }
      if (decision.clampedFrom !== null) {
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
    return signed;
  }

  /** Relays the updates in one transaction; a failure is logged, not thrown. */
  async #relay(chain: Chain, updates: SignedUpdate[]): Promise<boolean> {
    const { log } = this.#deps;
    const what = updates.map((u) => `${u.symbol}=${formatFixed(u.price)}`).join(" ");
    try {
      const { digest, gasUsed } = await chain.relay(updates);
      log.info(`relayed ${what} in ${digest} (gas ${gasUsed})`);
      return true;
    } catch (error) {
      // The signed updates stay available over HTTP; the next round signs fresh ones.
      log.error(`relay failed for ${what}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  #skip(feed: FeedConfig, reason: string): void {
    this.#skipped.set(feed.symbol, reason);
    this.#venuesUsed.set(feed.symbol, 0);
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
    return update;
  }

  async #checkBalance(): Promise<void> {
    const { chain, config, log } = this.#deps;
    if (chain === null || ++this.#roundsSinceBalanceCheck < 100) return;
    this.#roundsSinceBalanceCheck = 0;
    try {
      const balance = await chain.relayerBalance();
      if (balance < config.lowBalanceHaneul) {
        log.warn(`relayer balance is ${balance} HANEUL, below ${config.lowBalanceHaneul}`);
      }
    } catch (error) {
      log.warn(`balance check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

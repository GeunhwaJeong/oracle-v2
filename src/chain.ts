// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Reads the feeds and relays signed updates to the `oracle_haneul` source, over gRPC.

import { HaneulGrpcClient } from "@haneullabs/haneul/grpc";
import { Ed25519Keypair } from "@haneullabs/haneul/keypairs/ed25519";
import { Transaction } from "@haneullabs/haneul/transactions";

import type { Config } from "./config.ts";

export interface SignedUpdate {
  symbol: string;
  storageId: number;
  priceFeedStorageId: string;
  price: bigint;
  confidence: bigint;
  timestampMs: bigint;
  publicKey: Uint8Array;
  signature: Uint8Array;
}

export interface StoredPrice {
  price: bigint;
  timestampMs: number;
}

const GEUNHWA_PER_HANEUL = 1_000_000_000n;

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !(name in value)) {
    throw new Error(`unexpected object layout: no field "${name}"`);
  }
  return (value as Record<string, unknown>)[name];
}

export class Chain {
  readonly #client: HaneulGrpcClient;
  readonly #config: Config;
  readonly #relayer: Ed25519Keypair | null;

  constructor(config: Config, relayerKey: string | null) {
    this.#config = config;
    this.#client = new HaneulGrpcClient({ network: config.network, baseUrl: config.rpcUrl });
    this.#relayer = relayerKey === null ? null : Ed25519Keypair.fromSecretKey(relayerKey);
  }

  get relayerAddress(): string | null {
    return this.#relayer?.toHaneulAddress() ?? null;
  }

  /** The `source_id` the aggregator assigned to the source: the key of its feed in each storage. */
  async sourceNumericId(): Promise<number> {
    const { object } = await this.#client.getObject({
      objectId: this.#config.sourceId,
      include: { json: true },
    });
    return Number(field(field(object.json, "source_cap"), "source_id"));
  }

  /** The source's price in a storage, or null while it has no feed there. */
  async storedPrice(priceFeedStorageId: string, sourceNumericId: number): Promise<StoredPrice | null> {
    const { object } = await this.#client.getObject({
      objectId: priceFeedStorageId,
      include: { json: true },
    });
    const feeds = field(object.json, "feeds");
    if (!Array.isArray(feeds)) throw new Error("unexpected object layout: feeds is not a list");
    for (const feed of feeds) {
      if (Number(field(feed, "source_id")) === sourceNumericId) {
        return {
          price: BigInt(String(field(feed, "price"))),
          timestampMs: Number(field(feed, "timestamp_ms")),
        };
      }
    }
    return null;
  }

  /** The relayer's balance in HANEUL. */
  async relayerBalance(): Promise<number> {
    if (this.#relayer === null) throw new Error("no relayer key");
    const { balance } = await this.#client.getBalance({ owner: this.#relayer.toHaneulAddress() });
    return Number(BigInt(balance.balance) / (GEUNHWA_PER_HANEUL / 1_000n)) / 1_000;
  }

  /**
   * Relays the updates in one transaction and waits for it. An update that is not newer than
   * the stored price is skipped on chain without failing the others.
   */
  async relay(updates: SignedUpdate[]): Promise<{ digest: string; gasUsed: bigint }> {
    if (this.#relayer === null) throw new Error("no relayer key");
    const tx = new Transaction();
    for (const update of updates) {
      tx.moveCall({
        target: `${this.#config.packageId}::price_feed_storage::update_price_feed`,
        arguments: [
          tx.object(this.#config.sourceId),
          tx.object(this.#config.aggregatorConfigId),
          tx.object(update.priceFeedStorageId),
          tx.pure.u128(update.price),
          tx.pure.u128(update.confidence),
          tx.pure.u64(update.timestampMs),
          tx.pure.vector("u8", update.publicKey),
          tx.pure.vector("u8", update.signature),
          tx.object.clock(),
        ],
      });
    }
    const result = await this.#client.signAndExecuteTransaction({
      transaction: tx,
      signer: this.#relayer,
      include: { effects: true },
    });
    const executed = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction;
    if (result.$kind !== "Transaction" || !executed.status.success) {
      // A Move abort does not reject the call; it comes back as a failed transaction.
      throw new Error(`relay failed on chain: ${JSON.stringify(executed.status.error)} (${executed.digest})`);
    }
    // The next round builds on the objects this one changed.
    await this.#client.waitForTransaction({ digest: executed.digest });
    const gas = executed.effects.gasUsed;
    return {
      digest: executed.digest,
      gasUsed: BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate),
    };
  }
}

// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The service loop against scripted venues and a recording chain.

import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { createPublicKey } from "node:crypto";
import { test } from "node:test";

import type { Chain, SignedUpdate, StoredPrice } from "../src/chain.ts";
import { parseConfig } from "../src/config.ts";
import { ONE, parseFixed } from "../src/fixed.ts";
import { PriceSigner, priceUpdateMessage } from "../src/message.ts";
import type { Fetched } from "../src/round.ts";
import { PriceService } from "../src/service.ts";

const SOURCE = "0x9ae707b98dfe186ddf62cbdaf35e030c4bcb1f74985af871b581098030e2cf82";

function setup(options: { stored?: StoredPrice | null; relayFails?: boolean } = {}) {
  const config = parseConfig({
    rpcUrl: "http://127.0.0.1:9000",
    packageId: "0x1",
    sourceId: SOURCE,
    aggregatorConfigId: "0x3",
    feeds: [
      {
        symbol: "BTC/USD",
        storageId: 0,
        priceFeedStorageId: "0x10",
        minSources: 2,
        sources: [
          { exchange: "a", market: "BTC/USD" },
          { exchange: "b", market: "BTC/USD" },
          { exchange: "c", market: "BTC/USD" },
        ],
      },
      { symbol: "RYUSD/USD", storageId: 1, priceFeedStorageId: "0x11", fixedPrice: "1" },
    ],
  });
  const state = { now: 1_800_000_000_000, mid: 100_000, down: new Set<string>() };
  const relayed: SignedUpdate[][] = [];
  const logs: string[] = [];
  const sources = {
    fetchAll: async () => {
      const out = new Map<string, Fetched>();
      for (const venue of ["a", "b", "c"]) {
        out.set(
          `${venue}:BTC/USD`,
          state.down.has(venue)
            ? { error: "down" }
            : { ticker: { bid: parseFixed(String(state.mid - 1)), ask: parseFixed(String(state.mid + 1)), exchangeTimestampMs: null } },
        );
      }
      return out;
    },
  };
  const chain = {
    relayerAddress: "0xabc",
    sourceNumericId: async () => 0,
    storedPrice: async (id: string) => (id === "0x10" ? (options.stored ?? null) : null),
    relayerBalance: async () => 100,
    relay: async (updates: SignedUpdate[]) => {
      if (options.relayFails) throw new Error("node unreachable");
      relayed.push(updates);
      return { digest: "digest", gasUsed: 1n };
    },
  } as unknown as Chain;
  const signer = PriceSigner.fromHex("11".repeat(32));
  const service = new PriceService({
    config,
    sources,
    signer,
    chain,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    now: () => state.now,
  });
  return { config, state, relayed, logs, service, signer };
}

function verifies(update: SignedUpdate): boolean {
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), update.publicKey]);
  return verify(
    null,
    priceUpdateMessage({
      sourceId: SOURCE,
      storageId: update.storageId,
      price: update.price,
      confidence: update.confidence,
      timestampMs: update.timestampMs,
    }),
    createPublicKey({ key: spki, format: "der", type: "spki" }),
    update.signature,
  );
}

test("a round signs and relays every feed in one transaction", async () => {
  const { service, relayed, state } = setup();
  const signed = await service.round();
  assert.equal(signed.length, 2);
  assert.equal(relayed.length, 1);
  const [btc, ryusd] = relayed[0]!;
  assert.equal(btc!.symbol, "BTC/USD");
  assert.equal(btc!.price, 100_000n * ONE);
  assert.equal(btc!.confidence, ONE);
  assert.equal(ryusd!.price, ONE);
  assert.ok(verifies(btc!) && verifies(ryusd!));
  // Timestamps are the round's time and strictly increasing across the updates.
  assert.equal(btc!.timestampMs, BigInt(state.now));
  assert.equal(ryusd!.timestampMs, BigInt(state.now) + 1n);
});

test("timestamps keep increasing when the clock does not", async () => {
  const { service, relayed } = setup();
  await service.round();
  await service.round();
  const stamps = relayed.flat().map((u) => u.timestampMs);
  for (let i = 1; i < stamps.length; i++) assert.ok(stamps[i]! > stamps[i - 1]!);
});

test("the step limit starts from the price the chain holds", async () => {
  const { service, relayed, state } = setup({ stored: { price: 90_000n * ONE, timestampMs: 1_800_000_000_000 - 3_000 } });
  await service.loadStoredPrices();
  await service.round();
  assert.equal(relayed[0]![0]!.price, 90_900n * ONE);
  state.now += 3_000;
  await service.round();
  assert.equal(relayed[1]![0]!.price, 91_809n * ONE);
});

test("an old price on chain does not hold the first update back", async () => {
  const { service, relayed } = setup({ stored: { price: 90_000n * ONE, timestampMs: 1_800_000_000_000 - 3_600_000 } });
  await service.loadStoredPrices();
  await service.round();
  assert.equal(relayed[0]![0]!.price, 100_000n * ONE);
});

test("a feed without enough venues is skipped while the others go out", async () => {
  const { service, relayed, state, logs } = setup();
  state.down.add("a");
  state.down.add("b");
  const signed = await service.round();
  assert.deepEqual(signed.map((u) => u.symbol), ["RYUSD/USD"]);
  assert.equal(relayed[0]!.length, 1);
  assert.ok(logs.some((line) => /error BTC\/USD: nothing signed this round: 1 usable venue/.test(line)));
  const btc = service.status().find((feed) => feed.symbol === "BTC/USD")!;
  assert.equal(btc.ageMs, null);
  assert.match(btc.skipped!, /1 usable venue/);

  // The venues come back: the feed resumes and the skip is cleared.
  state.down.clear();
  state.now += 3_000;
  assert.equal((await service.round()).length, 2);
  assert.equal(service.status().find((feed) => feed.symbol === "BTC/USD")!.skipped, null);
});

test("one venue down is reported and the price still forms", async () => {
  const { service, relayed, state, logs } = setup();
  state.down.add("c");
  await service.round();
  assert.equal(relayed[0]![0]!.price, 100_000n * ONE);
  assert.ok(logs.some((line) => line === "warn BTC/USD: left out c:BTC/USD: down"));
});

test("a failed relay is logged and the signed updates stay available", async () => {
  const { service, logs } = setup({ relayFails: true });
  const signed = await service.round();
  assert.equal(signed.length, 2);
  assert.ok(logs.some((line) => /error relay failed: node unreachable/.test(line)));
  assert.equal(service.latestUpdates().length, 2);
});

test("status reports the age of each feed's last signed update", async () => {
  const { service, state } = setup();
  await service.round();
  state.now += 4_000;
  const [btc, ryusd] = service.status();
  assert.equal(btc!.ageMs, 4_000);
  assert.equal(btc!.lastPrice, "100000");
  assert.equal(btc!.venuesUsed, 3);
  assert.equal(ryusd!.ageMs, 3_999);
});

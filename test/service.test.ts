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
import { Metrics } from "../src/metrics.ts";
import { isHealthy } from "../src/server.ts";
import type { Fetched } from "../src/round.ts";
import { PriceService } from "../src/service.ts";

const SOURCE = "0x9ae707b98dfe186ddf62cbdaf35e030c4bcb1f74985af871b581098030e2cf82";

function setup(options: { stored?: StoredPrice | null; relayFails?: boolean; refused?: string } = {}) {
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
      if (updates.some((update) => update.symbol === options.refused)) throw new Error("EStepTooLarge");
      relayed.push(updates);
      return { digest: "digest", gasUsed: 1n };
    },
  } as unknown as Chain;
  const signer = PriceSigner.fromHex("11".repeat(32));
  const metrics = new Metrics();
  const service = new PriceService({
    metrics,
    config,
    sources,
    signer,
    chain,
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    now: () => state.now,
  });
  return { config, state, relayed, logs, service, signer, metrics };
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
  assert.ok(logs.some((line) => /error relay failed for .*: node unreachable/.test(line)));
  assert.equal(service.latestUpdates().length, 2);
});

test("a feed the chain refuses does not hold the other feeds back", async () => {
  const { service, relayed, logs } = setup({ refused: "BTC/USD" });
  await service.round();
  // The joint transaction fails, then each feed goes out on its own: only the other one lands.
  assert.deepEqual(relayed.map((updates) => updates.map((u) => u.symbol)), [["RYUSD/USD"]]);
  assert.equal(logs.filter((line) => /error relay failed for .*BTC\/USD.*EStepTooLarge/.test(line)).length, 2);
  assert.ok(logs.some((line) => /info relayed RYUSD\/USD=1 /.test(line)));
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

test("a service that signs but cannot reach the chain is not healthy", async () => {
  const { service, state, config } = setup({ relayFails: true });
  await service.round();
  state.now += 1_000;
  const feeds = service.status();
  // Signed a second ago, never landed.
  assert.deepEqual(feeds.map((feed) => [feed.ageMs !== null, feed.relayedAgeMs]), [[true, null], [true, null]]);
  assert.equal(isHealthy(feeds, config.intervalMs), false);
});

test("a relaying service is healthy while its updates keep landing", async () => {
  const { service, state, config } = setup();
  assert.equal(isHealthy(service.status(), config.intervalMs), false, "nothing signed yet");
  await service.round();
  state.now += 3_000;
  assert.deepEqual(service.status().map((feed) => feed.relayedAgeMs), [3_000, 3_000]);
  assert.equal(isHealthy(service.status(), config.intervalMs), true);
  state.now += 7_000;
  assert.equal(isHealthy(service.status(), config.intervalMs), false, "three rounds without an update");
});

test("a feed the chain refuses is unhealthy while the others are not held to it", async () => {
  const { service, state } = setup({ refused: "BTC/USD" });
  await service.round();
  state.now += 1_000;
  const [btc, ryusd] = service.status();
  assert.equal(btc!.relayedAgeMs, null);
  assert.equal(ryusd!.relayedAgeMs, 1_000);
});

test("a service that only signs is judged on what it signs", async () => {
  const { config, state, signer } = setup();
  const sources = {
    fetchAll: async () =>
      new Map<string, Fetched>(
        ["a", "b", "c"].map((venue) => [
          `${venue}:BTC/USD`,
          { ticker: { bid: parseFixed("99999"), ask: parseFixed("100001"), exchangeTimestampMs: null } },
        ]),
      ),
  };
  const log = { info: () => {}, warn: () => {}, error: () => {} };
  const service = new PriceService({ config, sources, signer, chain: null, log, now: () => state.now });
  await service.round();
  assert.equal(service.status()[0]!.relayedAgeMs, undefined);
  assert.equal(isHealthy(service.status(), config.intervalMs), true);
});

test("a round is counted with what became of every venue", async () => {
  const { service, state, metrics } = setup();
  state.down.add("c");
  await service.round();
  const btc = { feed: "BTC/USD" };
  assert.equal(metrics.rounds.get(), 1);
  assert.equal(metrics.sourcesUsed.get(btc), 2);
  assert.equal(metrics.sourceOutcomes.get({ ...btc, source: "a:BTC/USD", outcome: "used" }), 1);
  assert.equal(metrics.sourceOutcomes.get({ ...btc, source: "c:BTC/USD", outcome: "error" }), 1);
  assert.equal(metrics.sourceMid.get({ ...btc, source: "a:BTC/USD" }), 100_000);
  assert.equal(metrics.signed.get(btc), 1);
  assert.equal(metrics.price.get(btc), 100_000);
  // A spread of 2 on 100,000 is a confidence of 1: a tenth of a basis point.
  assert.equal(metrics.confidenceBps.get(btc), 0.1);
  assert.equal(metrics.lastSigned.get(btc), state.now / 1000);
  assert.equal(metrics.lastRelayed.get(btc), state.now / 1000);
  assert.equal(metrics.relays.get({ result: "ok" }), 1);
  assert.equal(metrics.relayGas.get(), 1);
  assert.equal(metrics.roundSeconds.count, 1);

  state.down.add("b");
  await service.round();
  assert.equal(metrics.skipped.get({ ...btc, reason: "sources" }), 1);
  assert.equal(metrics.sourcesUsed.get(btc), 0);
  assert.equal(metrics.signed.get(btc), 1);
});

test("a failed relay and a clamped price are counted", async () => {
  const { service, metrics, state } = setup({ relayFails: true });
  await service.round();
  // The joint relay, then one attempt per feed.
  assert.equal(metrics.relays.get({ result: "failed" }), 3);
  assert.equal(metrics.lastRelayed.get({ feed: "BTC/USD" }), 0);
  state.mid = 105_000;
  state.now += 3_000;
  await service.round();
  assert.equal(metrics.clamped.get({ feed: "BTC/USD" }), 1);
  assert.equal(metrics.price.get({ feed: "BTC/USD" }), 101_000);
});

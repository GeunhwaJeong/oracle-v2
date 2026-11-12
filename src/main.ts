// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Price service for the `oracle_haneul` source.
//
//   node src/main.ts [--config <path>] [--once] [--dry-run]
//
// Environment:
//   ORACLE_CONFIG       path of the configuration file (default ./config.json)
//   ORACLE_SIGNER_SEED  32-byte Ed25519 seed of the price signer, as 64 hex characters
//   RELAYER_KEY         haneulprivkey1... of the wallet that pays for relaying; without it the
//                       service signs and serves updates but relays nothing
//
// --dry-run forms and logs prices without signing or relaying, and needs neither key.
// --once runs a single round; its exit code says whether every feed was signed.

import { monitorEventLoopDelay } from "node:perf_hooks";

import { Chain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { PriceSigner } from "./message.ts";
import { Metrics } from "./metrics.ts";
import { startServer } from "./server.ts";
import { PriceService } from "./service.ts";
import type { Logger } from "./service.ts";
import { CcxtSources } from "./sources.ts";
import { StreamSources, connectCcxt } from "./streams.ts";

const log: Logger = {
  info: (message) => console.log(`${new Date().toISOString()} info  ${message}`),
  warn: (message) => console.warn(`${new Date().toISOString()} warn  ${message}`),
  error: (message) => console.error(`${new Date().toISOString()} error ${message}`),
};

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<number> {
  const once = process.argv.includes("--once");
  const dryRun = process.argv.includes("--dry-run");
  const config = loadConfig(argument("--config") ?? process.env.ORACLE_CONFIG ?? "config.json");

  const seed = process.env.ORACLE_SIGNER_SEED;
  if (!dryRun && !seed) throw new Error("ORACLE_SIGNER_SEED is not set");
  const signer = dryRun ? null : PriceSigner.fromHex(seed!);
  const relayerKey = dryRun ? null : (process.env.RELAYER_KEY ?? null);
  const chain = dryRun ? null : new Chain(config, relayerKey);
  // The keys are held by the signer and the relayer objects from here on.
  delete process.env.ORACLE_SIGNER_SEED;
  delete process.env.RELAYER_KEY;

  const metrics = new Metrics();
  const rest = new CcxtSources(config, metrics);
  const problems = await rest.init((late) => {
    if (late.ok) log.info(`${late.id}: markets loaded`);
    // Prices are being signed by now: a market missing from a venue is said, not died of.
    else if (late.fatal) log.error(`${late.id}: ${late.reason}; the venue stays out of the rounds`);
    else log.warn(`${late.id}: ${late.reason}`);
  });
  for (const problem of problems) log.warn(problem);
  // A single round is over before a stream has connected; it is asked over REST.
  const streams =
    config.streamExchanges.size === 0 || once
      ? null
      : new StreamSources({ config, rest, connect: connectCcxt, metrics, log, now: Date.now });
  streams?.start();

  const service = new PriceService({
    config,
    sources: streams ?? rest,
    signer,
    chain: relayerKey === null ? null : chain,
    log,
    now: Date.now,
    metrics,
  });
  if (signer !== null) {
    log.info(`price signer ${Buffer.from(signer.publicKey).toString("hex")}`);
  }
  if (chain !== null && relayerKey !== null) {
    log.info(`relayer ${chain.relayerAddress}, balance ${await chain.relayerBalance()} HANEUL`);
    await service.loadStoredPrices();
  } else if (!dryRun) {
    log.warn("RELAYER_KEY is not set: updates are signed and served, not relayed");
  }

  if (once) {
    const signed = await service.round();
    return dryRun || signed.length === config.feeds.length ? 0 : 1;
  }

  const server = config.httpPort === 0 ? null : startServer(config, service, metrics);
  if (server !== null) log.info(`serving signed updates, health and metrics on ${config.httpHost}:${config.httpPort}`);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  log.info(`${config.feeds.length} feed(s), one round every ${config.intervalMs} ms`);
  // A process that is short of CPU or memory stays up and answers, but reads the venues'
  // streams late, and a late quote looks like a fresh one. How late it is to its own timers
  // is the one sign of that it can give. The gauge holds the worst of the last minute, so
  // that something that looks once a minute does not miss a stall.
  const lateness = monitorEventLoopDelay({ resolution: 20 });
  lateness.enable();
  const recent: number[] = [];
  const perMinute = Math.max(1, Math.round(60_000 / config.intervalMs));
  while (!stopping) {
    const started = Date.now();
    recent.push(lateness.max / 1e9);
    lateness.reset();
    if (recent.length > perMinute) recent.shift();
    metrics.eventLoopDelay.set({}, Math.max(...recent));
    try {
      await service.round();
    } catch (error) {
      log.error(`round failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    const rest = config.intervalMs - (Date.now() - started);
    if (rest > 0 && !stopping) await new Promise((resolve) => setTimeout(resolve, rest));
  }
  server?.close();
  await streams?.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);

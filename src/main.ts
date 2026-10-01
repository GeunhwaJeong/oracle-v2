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

import { Chain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { PriceSigner } from "./message.ts";
import { startServer } from "./server.ts";
import { PriceService } from "./service.ts";
import type { Logger } from "./service.ts";
import { CcxtSources } from "./sources.ts";

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

  const sources = new CcxtSources(config);
  for (const problem of await sources.init()) log.warn(problem);

  const service = new PriceService({
    config,
    sources,
    signer,
    chain: relayerKey === null ? null : chain,
    log,
    now: Date.now,
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

  const server = config.httpPort === 0 ? null : startServer(config, service);
  if (server !== null) log.info(`serving signed updates on ${config.httpHost}:${config.httpPort}`);

  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  log.info(`${config.feeds.length} feed(s), one round every ${config.intervalMs} ms`);
  while (!stopping) {
    const started = Date.now();
    try {
      await service.round();
    } catch (error) {
      log.error(`round failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
    const rest = config.intervalMs - (Date.now() - started);
    if (rest > 0 && !stopping) await new Promise((resolve) => setTimeout(resolve, rest));
  }
  server?.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    log.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);

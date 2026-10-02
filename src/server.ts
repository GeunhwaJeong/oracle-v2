// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Serves the latest signed updates. A front end fetches them and puts
// `oracle_haneul::price_feed_storage::update_price_feed` calls in front of the trade, so the
// trade never depends on the relayer having landed its own update first. What is served is
// public by design: an update is only worth its signature.
//
// Also serves the service's health and its metrics.

import { createServer } from "node:http";
import type { Server } from "node:http";

import type { Config } from "./config.ts";
import type { Metrics } from "./metrics.ts";
import type { FeedStatus, PriceService } from "./service.ts";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Whether the feeds are being kept: every feed signed within the last few rounds and, when the
 * service relays, landed on chain within them too. A service that signs but cannot reach the
 * chain keeps no market open, so it is not healthy.
 */
export function isHealthy(feeds: FeedStatus[], intervalMs: number): boolean {
  const recent = (ageMs: number | null | undefined) => ageMs !== null && ageMs !== undefined && ageMs <= 3 * intervalMs;
  return feeds.every((feed) => recent(feed.ageMs) && (feed.relayedAgeMs === undefined || recent(feed.relayedAgeMs)));
}

export function startServer(config: Config, service: PriceService, metrics: Metrics): Server {
  const server = createServer((request, response) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      response.end(JSON.stringify(body));
    };
    if (request.method !== "GET") return send(405, { error: "method not allowed" });
    const path = (request.url ?? "/").split("?")[0];
    if (path === "/v1/updates") {
      return send(200, {
        packageId: config.packageId,
        sourceId: config.sourceId,
        aggregatorConfigId: config.aggregatorConfigId,
        updates: service.latestUpdates().map((update) => ({
          symbol: update.symbol,
          storageId: update.storageId,
          priceFeedStorageId: update.priceFeedStorageId,
          // u128 and u64 do not fit a JSON number.
          price: update.price.toString(),
          confidence: update.confidence.toString(),
          timestampMs: update.timestampMs.toString(),
          publicKey: hex(update.publicKey),
          signature: hex(update.signature),
        })),
      });
    }
    if (path === "/healthz") {
      const feeds = service.status();
      const healthy = isHealthy(feeds, config.intervalMs);
      return send(healthy ? 200 : 503, { healthy, feeds });
    }
    if (path === "/metrics") {
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" });
      response.end(metrics.exposition());
      return;
    }
    return send(404, { error: "not found" });
  });
  server.listen(config.httpPort, config.httpHost);
  return server;
}

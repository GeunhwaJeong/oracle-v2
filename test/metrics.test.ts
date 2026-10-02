// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { Counter, Gauge, Histogram, Metrics } from "../src/metrics.ts";

test("counters add up per label set, whatever order the labels come in", () => {
  const counter = new Counter("things_total", "Things");
  counter.inc({ b: "2", a: "1" });
  counter.inc({ a: "1", b: "2" }, 4);
  counter.inc({ a: "x" });
  assert.equal(counter.get({ a: "1", b: "2" }), 5);
  assert.equal(counter.get({ a: "y" }), 0);
  assert.deepEqual(counter.lines(), ['things_total{a="1",b="2"} 5', 'things_total{a="x"} 1']);
});

test("a gauge holds the last value and label values are escaped", () => {
  const gauge = new Gauge("level", "Level");
  gauge.set({ source: 'a"b\\c\nd' }, 1.5);
  gauge.set({ source: 'a"b\\c\nd' }, 2.5);
  gauge.set({}, 7);
  assert.deepEqual(gauge.lines(), ["level 7", 'level{source="a\\"b\\\\c\\nd"} 2.5']);
});

test("a histogram counts every observation in each bucket it fits", () => {
  const histogram = new Histogram("wait_seconds", "Wait", [0.1, 1]);
  for (const value of [0.05, 0.1, 0.5, 3]) histogram.observe(value);
  assert.deepEqual(histogram.lines(), [
    'wait_seconds_bucket{le="0.1"} 2',
    'wait_seconds_bucket{le="1"} 3',
    'wait_seconds_bucket{le="+Inf"} 4',
    "wait_seconds_sum 3.65",
    "wait_seconds_count 4",
  ]);
});

test("the exposition is the Prometheus text format", () => {
  const metrics = new Metrics();
  metrics.rounds.inc();
  metrics.price.set({ feed: "BTC/USD" }, 84_900.5);
  const text = metrics.exposition();
  assert.ok(text.endsWith("\n"));
  assert.match(text, /^# HELP oracle_rounds_total Rounds run\n# TYPE oracle_rounds_total counter\noracle_rounds_total 1\n/);
  assert.match(text, /# TYPE oracle_feed_price gauge\noracle_feed_price\{feed="BTC\/USD"\} 84900\.5\n/);
  assert.match(text, /# TYPE oracle_round_duration_seconds histogram\n/);
  // A metric nothing was recorded for is left out rather than exposed empty.
  assert.ok(!text.includes("oracle_relays_total"));
  // Every sample line is `name{labels} value`.
  for (const line of text.trimEnd().split("\n")) {
    assert.match(line, /^(# (HELP|TYPE) \w+ .+|\w+(\{[^}]*\})? -?[\d.e+-]+|\w+(\{[^}]*\})? [+-]Inf)$/, line);
  }
});

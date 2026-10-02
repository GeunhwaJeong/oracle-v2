// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The service's metrics, in the Prometheus text format. What an operator has to be able to
// see is which venues are answering, how many of them each feed stands on, what was signed and
// when, and whether it reached the chain.

type Labels = Record<string, string>;

function escape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function render(labels: Labels): string {
  const names = Object.keys(labels).sort();
  if (names.length === 0) return "";
  return `{${names.map((name) => `${name}="${escape(labels[name]!)}"`).join(",")}}`;
}

function format(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "+Inf" : "-Inf";
  return String(value);
}

abstract class Metric {
  readonly name: string;
  readonly help: string;

  constructor(name: string, help: string) {
    this.name = name;
    this.help = help;
  }

  abstract readonly type: string;
  abstract lines(): string[];
}

class Series extends Metric {
  readonly type: string;
  protected readonly values = new Map<string, number>();

  constructor(name: string, help: string, type: "counter" | "gauge") {
    super(name, help);
    this.type = type;
  }

  get(labels: Labels = {}): number {
    return this.values.get(render(labels)) ?? 0;
  }

  lines(): string[] {
    return [...this.values].sort(([a], [b]) => (a < b ? -1 : 1)).map(([labels, value]) => `${this.name}${labels} ${format(value)}`);
  }
}

export class Counter extends Series {
  constructor(name: string, help: string) {
    super(name, help, "counter");
  }

  inc(labels: Labels = {}, by = 1): void {
    const key = render(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }
}

export class Gauge extends Series {
  constructor(name: string, help: string) {
    super(name, help, "gauge");
  }

  set(labels: Labels, value: number): void {
    this.values.set(render(labels), value);
  }
}

export class Histogram extends Metric {
  readonly type = "histogram";
  readonly #bounds: number[];
  readonly #buckets: number[];
  #sum = 0;
  #count = 0;

  constructor(name: string, help: string, bounds: number[]) {
    super(name, help);
    this.#bounds = bounds;
    this.#buckets = bounds.map(() => 0);
  }

  observe(value: number): void {
    this.#sum += value;
    this.#count += 1;
    this.#bounds.forEach((bound, i) => {
      if (value <= bound) this.#buckets[i]! += 1;
    });
  }

  get count(): number {
    return this.#count;
  }

  lines(): string[] {
    return [
      ...this.#bounds.map((bound, i) => `${this.name}_bucket{le="${format(bound)}"} ${this.#buckets[i]}`),
      `${this.name}_bucket{le="+Inf"} ${this.#count}`,
      `${this.name}_sum ${format(this.#sum)}`,
      `${this.name}_count ${this.#count}`,
    ];
  }
}

/** Seconds, from ten milliseconds to ten seconds. */
const DURATIONS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class Metrics {
  readonly rounds = new Counter("oracle_rounds_total", "Rounds run");
  readonly roundSeconds = new Histogram("oracle_round_duration_seconds", "Time a round took, relaying included", DURATIONS);
  readonly fetchSeconds = new Histogram(
    "oracle_fetch_duration_seconds",
    "Time a round waited for the venues: near zero while every venue streams, a request round trip when one is asked over REST",
    DURATIONS,
  );

  readonly quotes = new Counter(
    "oracle_source_quotes_total",
    "Quotes taken from a venue for a round, by how they arrived (stream or rest) and whether one was had (ok or error)",
  );
  readonly streamUp = new Gauge("oracle_stream_up", "1 while a venue's stream is delivering, 0 while it is down or has yet to deliver");
  readonly streamErrors = new Counter("oracle_stream_errors_total", "Times a venue's stream failed and was reconnected");
  readonly quoteAgeSeconds = new Gauge("oracle_source_quote_age_seconds", "Age of the quote a source gave the latest round");
  readonly sourceMid = new Gauge(
    "oracle_source_mid_price",
    "Mid price a venue gave a feed in the latest round, converted into the feed's quote currency",
  );
  readonly sourceOutcomes = new Counter(
    "oracle_feed_source_rounds_total",
    "Rounds of a feed by what became of each of its sources: used, or the reason it was left out",
  );

  readonly sourcesUsed = new Gauge("oracle_feed_sources_used", "Venues the latest round's price of a feed stands on");
  readonly price = new Gauge("oracle_feed_price", "Price last signed for a feed");
  readonly confidenceBps = new Gauge("oracle_feed_confidence_bps", "Confidence interval last signed for a feed, in basis points of its price");
  readonly signed = new Counter("oracle_feed_signed_total", "Updates signed for a feed");
  readonly skipped = new Counter("oracle_feed_skipped_total", "Rounds in which nothing was signed for a feed, by reason");
  readonly clamped = new Counter("oracle_feed_clamped_total", "Updates signed at the step limit instead of where the venues were");
  readonly lastSigned = new Gauge("oracle_feed_last_signed_timestamp_seconds", "When a feed was last signed");
  readonly lastRelayed = new Gauge("oracle_feed_last_relayed_timestamp_seconds", "When an update of a feed last landed on chain");

  readonly relays = new Counter("oracle_relays_total", "Relay transactions, by result (ok or failed)");
  readonly relayGas = new Counter("oracle_relay_gas_total", "Gas spent relaying, in the smallest unit of HANEUL");
  readonly relayerBalance = new Gauge("oracle_relayer_balance_haneul", "Balance of the relayer when last checked");

  #all(): Metric[] {
    return Object.values(this).filter((value): value is Metric => value instanceof Metric);
  }

  /** Everything, in the text format Prometheus scrapes. */
  exposition(): string {
    const out: string[] = [];
    for (const metric of this.#all()) {
      const lines = metric.lines();
      if (lines.length === 0) continue;
      out.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`, ...lines);
    }
    return `${out.join("\n")}\n`;
  }
}

# Haneul Oracle v2

The price oracle of the Haneul perp engine, operated by the network itself rather than taken
from a third-party oracle. This service forms prices from exchange order books, signs them and
relays them to the
[`oracle_haneul`](https://github.com/GeunhwaJeong/perp-dex/tree/main/packages/oracle_haneul)
source, which writes a price into the engine's feeds when it carries a signature by one of the
source's registered signers. The on-chain half (signature verification, signer set, bounds) lives
with the engine; this repository is the off-chain half.

```
exchanges (public REST, via ccxt)
        |  best bid and ask of every configured market, once per round
   price formation      leave out failed, stalled and outlying venues; convert USDT quotes;
        |               three-vote median; confidence from the vote quartiles
      guards            confidence bound, step limit against the previous signed price
        |
      signer            Ed25519 over (source object, storage id, price, confidence, timestamp)
        |
   +----+--------------------------+
relayer (one transaction per round)   GET /v1/updates (for front ends to put in a trade)
```

## What a round does

Every `intervalMs` (3 s by default):

1. **Fetch** the ticker of every configured market from every venue in parallel. A venue that
   does not answer within `fetchTimeoutMs` is left out of the round.
2. **Filter.** Left out: a failed request, an empty or crossed book, a ticker whose own timestamp
   is older than `maxExchangeLagMs`, and a venue further than `maxDeviationBps` from the weighted
   median of all venues.
3. **Convert.** A venue quoted in another currency than the feed (BTC/USDT for BTC/USD) is
   multiplied by that currency's rate, formed in the same round from venues that trade it against
   the feed's quote (`quoteRates`). The rate's uncertainty is added to the venue's spread. Without
   a rate those venues are left out; they are never taken at par.
4. **Aggregate.** Every remaining venue casts three votes, at its mid price and at the mid plus
   and minus half its spread, repeated `weight` times. The price is the median vote and the
   confidence the distance to the further of the 25th and 75th percentile votes. This is the
   aggregation Pyth uses across its publishers: a tight venue weighs more, no venue can move the
   median further than the others allow, and the confidence widens when venues disagree.
5. **Guard.** Fewer than `minSources` venues, or a confidence wider than `maxConfidenceBps`: the
   feed is not signed this round. The feed goes stale and the markets that read it stop, which is
   the intended outcome when the price is not known. A price further than `maxStepBps` from the
   previous signed price is signed at the limit, with the gap added to the confidence, so the feed
   follows a real move over a few rounds but cannot be thrown by one bad round. The limit lapses
   after `stepLimitResetMs` without a signed price.
6. **Sign** with a timestamp that only goes up, and **relay** all feeds in one transaction.
   If the chain refuses that transaction (one feed beyond its step limit fails all of it), each
   feed is relayed on its own, so the others do not go stale with it. A failed relay is logged;
   the next round signs fresh prices.

The source enforces a step limit of its own on chain (by default 0.5% at once plus 0.5% per
second since the stored price, 20% at most, and whatever is set per feed). The service's
`maxStepBps` of 1% per three-second round stays inside it, and because the chain's allowance
grows with time a few missed relays do not lock a feed out. A gap beyond the chain's maximum
needs the package admin (`force_update_price_feed`) with an update from `/v1/updates`.

A feed with a `fixedPrice` (a collateral that is worth its quote by construction) is signed at
that price every round, so that it stays within the markets' staleness tolerance.

## Running

Needs Node 22.18 or newer; TypeScript is run directly, there is no build step.

```bash
npm ci
cp config.example.json config.json     # fill in the package, source, config and storage ids
npm run quote                          # one dry-run round: forms and prints prices, no keys needed

export ORACLE_SIGNER_SEED=<64 hex characters>   # the price signer's Ed25519 seed
export RELAYER_KEY=haneulprivkey1...             # pays gas; holds no authority
npm start
```

`ORACLE_SIGNER_SEED` is the key the markets trust: whoever holds it decides the price, within the
bounds the source and the markets enforce. Its public key (logged at startup) is registered on
the source with `oracle_haneul::source::set_signer`, with an expiry. `RELAYER_KEY` only pays for
transactions and should be a separate wallet with a small balance. Without `RELAYER_KEY` the
service signs and serves updates and relays nothing. That is also how feeds are created: a feed
is created from a signed price (`new_price_feed`, with the vendor cap), so run the service
without a relayer, take the updates from `/v1/updates`, and create each feed at its market price.

`haneul-oracle-price-service.service.example` is a systemd unit for running it under a
dedicated user.

### Endpoints

Served on `httpHost:httpPort` when `httpPort` is not 0. Everything served is public by design:
an update is only worth its signature, and anyone may relay one.

- `GET /v1/updates`: the latest signed update of every feed, with the ids needed to build
  `oracle_haneul::price_feed_storage::update_price_feed(source, config, storage, price,
  confidence, timestamp_ms, public_key, signature, clock)`. Numbers are decimal strings, keys and
  signatures hex. A front end puts these calls in front of a trade.
- `GET /healthz`: 200 while every feed was signed within the last three rounds, 503 otherwise,
  with each feed's age, last price, venue count and the reason it was last skipped.

### Configuration

See `config.example.json`. Limits per feed and their defaults: `minSources` 3,
`maxDeviationBps` 100, `maxConfidenceBps` 50, `maxStepBps` 100. The confidence bound should stay
below the source's own (`oracle_haneul` refuses above 1% by default), and the interval well
below the markets' oracle tolerance (10 s for the base asset by default). Venues listed in
`batchExchanges` are asked for all their markets in one request per round.

## Tests

```bash
npm test             # 48 unit tests: fixed point, aggregation, message and signature, round, service loop
npm run typecheck
```

The message tests sign the same updates as the `oracle_haneul` Move unit tests and expect the
same signatures, which the chain's Ed25519 verification accepts.

`scripts/localnet_check.py` runs the service against a localnet with live exchange prices: it
publishes the perp engine's packages, sets up the source and a signer, creates four feeds from
the prices the service signs without a relayer, pins the collateral feed, runs the service with
a funded throwaway relayer, and checks the feeds on chain, the endpoints, a relay by a third
party, the step limit (a signed price 30% away refused, forced by the package admin, the pinned
feed refusing 1.01), and that a service whose signer is not registered changes nothing
(32 checks).

`scripts/localnet_market_check.py` goes on to the engine: it creates a BTC/USD market on feeds
the running service keeps fresh (one-minute feed TWAP) and checks that a maker and a taker trade
with no price update in their own transactions, that a trade can carry the updates served on
`/v1/updates`, that a position opened at exactly the initial margin is liquidated at the live
mark price once the real market has moved against it (the maintenance margin is set a hair
below the initial one, and one position is opened in each direction), that funding is cranked on
the live index, that every session aborts with `EBadIndexPrice` once the stopped service's feed
is older than the market's tolerance, that with the service signing but not relaying only the
sessions that carry the updates go through, and that the market reopens when the relayer is
back (23 checks; the wait for the liquidation depends on the market, about a minute in the runs
so far).

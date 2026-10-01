#!/usr/bin/env python3
# Copyright (c) 2026 Geunhwa Jeong
# SPDX-License-Identifier: Apache-2.0
"""Opens a perp market on a localnet that trades on the price service's live prices.

Where `localnet_check.py` stops at the feeds, this goes on to the engine: a BTC/USD market
collateralized in a test dollar is created on feeds the running service keeps fresh, and then

- a maker quotes around the live price and a taker trades, with no price update in their own
  transactions: the relayer alone keeps the market open;
- a trader puts the updates served on `/v1/updates` in front of a trade;
- two positions are opened at exactly the initial margin, one long and one short, with the
  maintenance margin a hair below it, and the script waits for the real market to move against
  one of them and liquidates it (partially, as the engine does) at the live mark price;
- funding is cranked once its period has passed;
- the service is stopped: once the feed is older than the market's tolerance every session
  aborts with `EBadIndexPrice`;
- the service is started again without a relayer: sessions that carry the served updates
  themselves go through, the others still abort;
- with the relayer back the market trades again without bundled updates.

Start the network first (see the perp engine's e2e/localnet_e2e.py), then:
    python3 scripts/localnet_market_check.py [path to the perp-dex checkout, default ~/perp-dex]
"""

import json
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import localnet_check as lc  # noqa: E402
from localnet_check import e2e, feed, http, new_relayer, start_service, stop_service  # noqa: E402
from localnet_e2e import B9, CLOCK, ONE, TUSD_UNIT, b, call, check, cli, events, obj, owned_created, ptb, section, shared_created, signed, u16, u64, u128, u256, vec_u8  # noqa: E402

SIGNER_SEED = lc.SIGNER_SEED
SIGNER = lc.SIGNER
SYMBOLS = ["BTC/USD", "TUSD/USD"]
IMR = ONE // 10
LOT = 1_000_000  # 0.001 BTC
TICK = B9  # $1
ASK, BID = True, False
LIQUIDATION_WAIT_S = 300


def main():
    e2e.safety_check()
    me = cli("client", "active-address").stdout.strip()

    section("Publish")
    ids = e2e.publish_all()
    P = {k: v["pkg"] for k, v in ids.items()}
    AUTH, VENDOR, ORACLE, SIGNED, PERP, E2E = (P[k] for k in ("authority_cap", "vendor", "oracle_aggregator", "oracle_haneul", "perpetuals", "perp_e2e"))
    ADMIN = f"{AUTH}::authority::ADMIN"
    TUSD = f"{E2E}::tusd::TUSD"
    VK = f"{E2E}::vendor_key::E2E"
    vendor_config = shared_created(ids["vendor"]["tx"], "::config::Config")
    vendor_pkg_admin = owned_created(ids["vendor"]["tx"], "::authority::AuthorityCap<")
    oracle_config = shared_created(ids["oracle_aggregator"]["tx"], "::config::Config")
    oracle_pkg_admin = owned_created(ids["oracle_aggregator"]["tx"], "::authority::AuthorityCap<")
    registry = shared_created(ids["perpetuals"]["tx"], "::registry::Registry")
    perp_pkg_admin = owned_created(ids["perpetuals"]["tx"], "::authority::AuthorityCap<")
    tusd_treasury = owned_created(ids["perp_e2e"]["tx"], "::coin::TreasuryCap<", "::tusd::TUSD>")
    tusd_metadata = next(
        c["objectId"]
        for c in ids["perp_e2e"]["tx"]["objectChanges"]
        if c["type"] == "created" and c["objectType"].endswith("::tusd::TUSD>") and "::coin::CoinMetadata<" in c["objectType"]
    )

    section("Vendor, source and storages")
    j = ptb("register vendor", call(f"{VENDOR}::config::register_vendor", [VK, ADMIN], obj(vendor_config), obj(vendor_pkg_admin), obj(me)))
    vendor_vk_cap = owned_created(j, "::authority::AuthorityCap<")
    cmds = call(f"{VENDOR}::metadata::new", [VK, ADMIN], obj(vendor_config), obj(vendor_vk_cap), "'Market check'", "'localnet'", assign="meta")
    cmds += call(f"{VENDOR}::metadata::approve_domain_registration", [VK, f"{ORACLE}::authority::PACKAGE"], "meta", obj(vendor_config), obj(oracle_pkg_admin))
    cmds += call(f"{ORACLE}::config::register_vendor", [VK, ADMIN], obj(oracle_config), obj(vendor_vk_cap), obj(vendor_config), "meta", assign="oracle_vk")
    cmds += call(f"{PERP}::registry::set_vendor_registration", [], obj(registry), obj(perp_pkg_admin), "true")
    cmds += call(f"{PERP}::registry::register_vendor", [VK, ADMIN], obj(registry), obj(vendor_vk_cap), obj(vendor_config), "meta", assign="perp_vk")
    cmds += call(f"{SIGNED}::source::create", [ADMIN], obj(oracle_config), obj(oracle_pkg_admin), assign="src")
    cmds += call(f"{SIGNED}::source::authorize", [ADMIN], "src", obj(oracle_config), obj(oracle_pkg_admin))
    cmds += call(f"{SIGNED}::source::set_signer", [ADMIN], "src", obj(oracle_config), obj(oracle_pkg_admin), vec_u8(SIGNER), u64(2**64 - 1), CLOCK)
    names = []
    for i, symbol in enumerate(SYMBOLS):
        cmds += call(f"{ORACLE}::price_feed_storage::new", [VK, ADMIN], obj(oracle_config), "oracle_vk", f"'{symbol}'", assign=f"pfs{i}")
        names.append(f"pfs{i}")
    cmds += ["--make-move-vec", f"<{ORACLE}::price_feed_storage::PriceFeedStorage>", "[" + ", ".join(names) + "]", "--assign", "pfs_vec"]
    cmds += call(f"{ORACLE}::price_feed_storage::share_vec", [], "pfs_vec")
    cmds += ["--move-call", "0x2::transfer::public_share_object", f"<{ORACLE}::source::Source<{SIGNED}::source::HANEUL>>", "src"]
    cmds += ["--transfer-objects", "[meta, oracle_vk, perp_vk]", obj(me)]
    j = ptb("vendor registration, source, signer and storages", cmds)
    source = shared_created(j, "::source::HANEUL>")
    source_id = int(events(j, "::events::CreatedSource")[0]["source_id"])
    oracle_vk = owned_created(j, f"AuthorityCap<{ORACLE}::authority::VENDOR<")
    perp_vk = owned_created(j, f"AuthorityCap<{PERP}::authority::VENDOR<{VK}>, {ADMIN}>")
    storages = {s["symbol"]: s for s in events(j, "::events::CreatedPriceFeedStorage")}
    pfs_btc = storages["BTC/USD"]["price_feed_storage_obj_id"]
    pfs_tusd = storages["TUSD/USD"]["price_feed_storage_obj_id"]

    venues = [("binance", "USDT", 3), ("okx", "USDT", 2), ("bybit", "USDT", 2), ("coinbaseexchange", "USD", 2), ("kraken", "USD", 1), ("kucoin", "USDT", 1), ("gate", "USDT", 1), ("mexc", "USDT", 1), ("bitstamp", "USD", 1)]
    config = {
        "rpcUrl": f"http://{e2e.GRPC_ADDR[0]}",
        "network": "localnet",
        "packageId": SIGNED,
        "sourceId": source,
        "aggregatorConfigId": oracle_config,
        "intervalMs": lc.INTERVAL_MS,
        "httpPort": lc.HTTP_PORT,
        "batchExchanges": ["kraken"],
        "quoteRates": {"USDT": {"minSources": 2, "sources": [{"exchange": ex, "market": "USDT/USD"} for ex in ("kraken", "coinbaseexchange", "bitstamp")]}},
        "feeds": [
            {"symbol": "BTC/USD", "storageId": int(storages["BTC/USD"]["storage_id"]), "priceFeedStorageId": pfs_btc, "minSources": 4, "sources": [{"exchange": ex, "market": f"BTC/{quote}", "weight": w} for ex, quote, w in venues]},
            {"symbol": "TUSD/USD", "storageId": int(storages["TUSD/USD"]["storage_id"]), "priceFeedStorageId": pfs_tusd, "fixedPrice": "1"},
        ],
    }
    workdir = Path(tempfile.mkdtemp(prefix="price-service-market-"))
    config_path = workdir / "config.json"
    config_path.write_text(json.dumps(config, indent=2))
    print(f"  config and logs in {workdir}")

    def served_updates():
        """`update_price_feed` calls for the updates the service serves right now."""
        cmds = []
        for u in http("/v1/updates")[1]["updates"]:
            cmds += call(
                f"{SIGNED}::price_feed_storage::update_price_feed",
                [],
                obj(source),
                obj(oracle_config),
                obj(u["priceFeedStorageId"]),
                u128(int(u["price"])),
                u128(int(u["confidence"])),
                u64(int(u["timestampMs"])),
                vec_u8(bytes.fromhex(u["publicKey"])),
                vec_u8(bytes.fromhex(u["signature"])),
                CLOCK,
            )
        return cmds

    def wait_for_updates(count):
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(1)
            try:
                updates = http("/v1/updates")[1]["updates"]
            except OSError:
                continue
            if len(updates) == count:
                return updates
        raise e2e.E2EError("the service did not serve its updates in time")

    section("Feeds from the service's signed prices")
    signing_only = start_service(config_path, SIGNER_SEED, None, workdir / "bootstrap.log")
    try:
        cmds = []
        for u in wait_for_updates(2):
            cmds += call(
                f"{SIGNED}::price_feed_storage::new_price_feed",
                [VK, ADMIN],
                obj(source),
                obj(oracle_vk),
                obj(oracle_config),
                obj(u["priceFeedStorageId"]),
                u128(int(u["price"])),
                u128(int(u["confidence"])),
                u64(int(u["timestampMs"])),
                vec_u8(bytes.fromhex(u["publicKey"])),
                vec_u8(bytes.fromhex(u["signature"])),
                # A one-minute TWAP, as a deployment would use, not the 1 ms of the engine's suite.
                u64(60_000),
                CLOCK,
            )
        j = ptb("feeds with a one-minute TWAP", cmds)
        check("both feeds created from signed prices", len(events(j, "::events::CreatedPriceFeed")) == 2)
    finally:
        stop_service(signing_only)
    ptb(
        "pin the collateral feed",
        call(f"{SIGNED}::source::set_step_limit", [ADMIN], obj(source), obj(oracle_config), obj(oracle_pkg_admin), f"{int(storages['TUSD/USD']['storage_id'])}u32", u64(0), u64(0), u64(0)),
    )

    section("Service with a relayer")
    relayer_key, relayer = new_relayer()
    cli("client", "faucet", "--address", relayer)
    deadline = time.time() + 90
    while lc.balance(relayer) == 0 and time.time() < deadline:
        time.sleep(1)
    check("the throwaway relayer is funded", lc.balance(relayer) > 0)
    logs = []

    def start_relaying(name):
        logs.append(workdir / f"{name}.log")
        process = start_service(config_path, SIGNER_SEED, relayer_key, logs[-1])
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(1)
            if int(time.time() * 1000) - feed(pfs_btc, source_id)[1] < 5_000:
                return process
        raise e2e.E2EError(f"the service did not bring the feed up to date: {logs[-1].read_text()[-600:]}")

    service = start_relaying("relaying-1")
    STATE["service"] = service
    try:
        return run_market(dict(locals()))
    finally:
        for process in STATE.values():
            if process.poll() is None:
                process.kill()


# Service processes still to be stopped if the check ends early.
STATE = {}


def run_market(env):
    # The setup above is plain bookkeeping; everything it produced is used by name below.
    PERP, E2E, TUSD, VK, ADMIN = env["PERP"], env["E2E"], env["TUSD"], env["VK"], env["ADMIN"]
    registry, perp_vk, tusd_metadata, tusd_treasury = env["registry"], env["perp_vk"], env["tusd_metadata"], env["tusd_treasury"]
    pfs_btc, pfs_tusd, source_id, me = env["pfs_btc"], env["pfs_tusd"], env["source_id"], env["me"]
    served_updates, wait_for_updates, start_relaying = env["served_updates"], env["wait_for_updates"], env["start_relaying"]
    config_path, workdir, logs = env["config_path"], env["workdir"], env["logs"]
    service = env["service"]

    section("Market on live prices")
    market_created_at = time.time()
    ch = None
    # The maintenance margin sits a hair below the initial one, so that a position opened at
    # exactly the initial margin is liquidatable after a move the real market makes in minutes.
    for mmr in (ONE * 999 // 10_000, ONE * 99 // 1_000, ONE * 95 // 1_000):
        cmds = call(f"{PERP}::clearing_house::create_orderbook", [VK, ADMIN], obj(perp_vk), obj(registry), u64(2), u64(4), u64(4), u64(2), u64(3), u64(4), assign="ob")
        cmds += call(f"{PERP}::market::new_creation_params", [], u256(IMR), u256(mmr), u64(LOT), u64(TICK), u256(0), u256(0), assign="params")
        cmds += call(f"{PERP}::market::set_fees", [], "params", u256(2 * 10**14), u256(5 * 10**14), u256(10**16), u256(5 * 10**15))
        cmds += call(f"{PERP}::market::set_funding", [], "params", u64(60_000), u64(21_600_000))
        cmds += call(f"{PERP}::clearing_house::create_clearing_house", [TUSD, VK, ADMIN], "ob", obj(perp_vk), obj(registry), obj(tusd_metadata), CLOCK, obj(pfs_btc), obj(pfs_tusd), u16(source_id), u16(source_id), "params", assign="ch")
        cmds += call(f"{PERP}::clearing_house::register_market", [VK, ADMIN, TUSD], obj(registry), obj(perp_vk), "ch")
        cmds += call(f"{PERP}::clearing_house::share", [TUSD], "ch")
        try:
            j = ptb("create the BTC/USD market", cmds)
        except e2e.E2EError as error:
            print(f"  maintenance margin {mmr / ONE:.4f} refused: {str(error)[-160:].strip()}")
            continue
        ch = shared_created(j, f"::clearing_house::ClearingHouse<{TUSD}>")
        print(f"  initial margin 0.1000, maintenance margin {mmr / ONE:.4f}")
        break
    check("the market is created on the live feeds", ch is not None)

    deposits = {"M": 1_000_000, "T": 100_000, "L": 200_000, "A": 10_000, "B": 10_000}
    allocs = {"M": 500_000, "T": 20_000, "L": 100_000, "A": 2_000, "B": 2_000}
    cmds = []
    for name, amount in deposits.items():
        cmds += call("0x2::coin::mint", [TUSD], obj(tusd_treasury), u64(amount * TUSD_UNIT), assign=f"coin{name}")
        cmds += call(f"{PERP}::account::create_account", [TUSD], obj(registry), assign=f"acc{name}")
        cmds += call(f"{PERP}::account::deposit_collateral", [TUSD, ADMIN], f"acc{name}.0", f"acc{name}.2", obj(registry), f"coin{name}")
        cmds += call(f"{PERP}::account::consume_policy_and_share_account", [TUSD], f"acc{name}.0", f"acc{name}.1")
    cmds += ["--transfer-objects", "[" + ", ".join(f"acc{n}.2" for n in deposits) + "]", obj(me)]
    j = ptb("create and fund five accounts", cmds)
    created = events(j, "::events::CreatedAccount")
    caps = [c["objectId"] for c in j["objectChanges"] if c["type"] == "created" and f"AuthorityCap<{PERP}::authority::ACCOUNT, {ADMIN}>" in c["objectType"]]
    cap_for = {json.loads(cli("client", "object", cid, "--json").stdout)["content"]["for"]: cid for cid in caps}
    acct = {name: dict(id=int(ev["account_id"]), obj=ev["account_obj_id"], cap=cap_for[ev["account_obj_id"]]) for name, ev in zip(deposits, created)}
    cmds = []
    for name, a in acct.items():
        cmds += call(f"{PERP}::clearing_house::create_market_position", [TUSD, ADMIN], obj(ch), obj(a["cap"]), obj(a["obj"]))
        cmds += call(f"{PERP}::clearing_house::allocate_collateral", [TUSD, ADMIN], obj(ch), obj(a["cap"]), obj(a["obj"]), u64(allocs[name] * TUSD_UNIT))
    for name in ("T", "A", "B"):
        a = acct[name]
        cmds += call(f"{PERP}::clearing_house::set_position_initial_margin_ratio", [TUSD, ADMIN], obj(ch), obj(a["cap"]), obj(a["obj"]), u256(IMR))
    ptb("positions, allocations and 10x leverage for T, A and B", cmds)

    def session(label, who, actions, bundle=False, expect_abort=None, dealloc_free=False, pre=None, inspect=False):
        a = acct[who]
        cmds = list(pre or [])
        if bundle:
            cmds += served_updates()
        cmds += call("0x1::option::none", [f"{PERP}::account::IntegratorInfo"], assign="no_integrator")
        cmds += call(f"{PERP}::clearing_house::start_session", [TUSD, ADMIN], obj(ch), obj(a["cap"]), obj(a["obj"]), obj(pfs_btc), obj(pfs_tusd), "no_integrator", CLOCK, assign="hp")
        for act in actions:
            cmds += act
        cmds += call(f"{PERP}::clearing_house::end_session", [TUSD, ADMIN], "hp", obj(a["cap"]), obj(a["obj"]), "false", b(dealloc_free), assign="res")
        cmds += call(f"{PERP}::clearing_house::share", [TUSD], "res.0")
        return ptb(label, cmds, expect_abort=expect_abort, inspect=inspect)

    def limit(side, size, price):
        return call(f"{PERP}::clearing_house::place_limit_order", [TUSD], "hp", b(side), u64(size), u64(price), u64(0), "none", "false", "none")

    def market_order(side, size):
        return call(f"{PERP}::clearing_house::place_market_order", [TUSD], "hp", b(side), u64(size), "false")

    def position(who):
        j = ptb("position", call(f"{E2E}::probe::position", [TUSD], obj(ch), u64(acct[who]["id"])), inspect=True)
        e = events(j, "::probe::PositionSnapshot")[0]
        return {"base": signed(e["base"]), "collateral": signed(e["collateral"]), "pending_orders": int(e["pending_orders"])}

    def mark():
        j = ptb("mark", call(f"{E2E}::probe::mark", [TUSD], obj(ch), obj(pfs_btc), CLOCK), inspect=True)
        return signed(events(j, "::probe::MarkSnapshot")[0]["mark_price"])

    def index():
        return feed(pfs_btc, source_id)[0]

    def quote(label, half_width, size):
        """M quotes `size` on each side, `half_width` dollars around the live index."""
        price = index() // ONE
        j = session(label, "M", [limit(ASK, size, (price + half_width) * B9), limit(BID, size, (price - half_width) * B9)])
        return [int(e["order_id"]) for e in events(j, "::events::PostedOrder")]

    def cancel(label, order_ids):
        cmds = ["--make-move-vec", "<u128>", "[" + ", ".join(f"{i}u128" for i in order_ids) + "]", "--assign", "ids"]
        cmds += call(f"{PERP}::clearing_house::cancel_orders", [TUSD, ADMIN], obj(ch), obj(acct["M"]["cap"]), obj(acct["M"]["obj"]), "ids")
        return ptb(label, cmds)

    # ---------------------------------------------------------------- trading on the relayer's prices
    section("Trading with the relayer keeping the feed fresh")
    live = index()
    print(f"  live index {live / ONE:,.2f} USD, mark {mark() / ONE:,.2f} USD")
    resting = quote("M quotes 0.5 BTC each side, $20 around the index", 20, 500_000_000)
    check("M's two orders rest on the book", len(resting) == 2 and position("M")["pending_orders"] == 2)
    j = session("T market-buys 0.05 BTC, no price update in the transaction", "T", [market_order(BID, 50_000_000)])
    fills = events(j, "::events::FilledTakerOrder")
    check("T's order filled against M", len(fills) == 1 and position("T")["base"] == ONE // 20, f"T base {position('T')['base'] / ONE} BTC")
    paid = signed(fills[0]["quote_asset_delta_bid"]) if fills else 0
    check("the fill is priced off the live market", abs(paid * 20 - live) * 100 <= live, f"{paid * 20 / ONE:,.2f} USD per BTC against an index of {live / ONE:,.2f}")

    section("A trade that carries the served updates itself")
    before_ms = feed(pfs_btc, source_id)[1]
    j = session("T sells 0.01 BTC with the updates from /v1/updates in front", "T", [market_order(ASK, 10_000_000)], bundle=True)
    check("the bundled trade filled", len(events(j, "::events::FilledTakerOrder")) == 1 and position("T")["base"] == ONE // 25)
    check("the feed is at least as new as before", feed(pfs_btc, source_id)[1] >= before_ms)

    # ---------------------------------------------------------------- liquidation at the live mark
    section("Liquidation driven by the real market")
    resting2 = quote("M quotes 0.05 BTC each side, $3 around the index", 3, 50_000_000)
    session("A opens a 0.01 BTC long and keeps only the initial margin", "A", [market_order(BID, 10_000_000)], dealloc_free=True)
    session("B opens a 0.01 BTC short and keeps only the initial margin", "B", [market_order(ASK, 10_000_000)], dealloc_free=True)
    a0, b0 = position("A"), position("B")
    check("A is long and B short 0.01 BTC", a0["base"] == ONE // 100 and b0["base"] == -ONE // 100)
    notional = mark() // 100
    print(f"  A keeps {a0['collateral'] / ONE:,.4f} and B {b0['collateral'] / ONE:,.4f} TUSD against {notional / ONE:,.2f} USD of notional")
    # With the book empty the mark price follows the index.
    cancel("M cancels its resting orders", [i for i in resting + resting2])
    check("the book is empty", position("M")["pending_orders"] == 0)

    def try_liquidate(who, inspect):
        return session(
            f"L liquidates {who}",
            "L",
            [call(f"{PERP}::clearing_house::liquidate", [TUSD], "hp", u64(acct[who]["id"]), "ids")],
            pre=["--make-move-vec", "<u128>", "[]", "--assign", "ids"],
            inspect=inspect,
        )

    opened_mark = mark()
    liquidated = None
    funding_event = None
    started = time.time()
    while time.time() - started < LIQUIDATION_WAIT_S and liquidated is None:
        if funding_event is None and time.time() - market_created_at > 65:
            j = ptb("crank funding", call(f"{PERP}::clearing_house::update_funding", [TUSD], obj(ch), obj(pfs_btc), CLOCK))
            funding_event = events(j, "::events::UpdatedFunding")
        for who in ("A", "B"):
            try:
                try_liquidate(who, inspect=True)
            except e2e.E2EError:
                continue
            j = try_liquidate(who, inspect=False)
            liquidated = (who, events(j, "::events::LiquidatedPosition")[0], mark())
            break
        else:
            time.sleep(4)
    waited = time.time() - started
    if liquidated is None:
        check(f"the market moved enough to liquidate A or B within {LIQUIDATION_WAIT_S} s", False, f"mark {opened_mark / ONE:,.2f} -> {mark() / ONE:,.2f}")
    else:
        who, ev, now_mark = liquidated
        move_bps = (now_mark - opened_mark) * 10_000 / opened_mark
        check(
            f"{who} was liquidated after the real market moved against it",
            ev["is_liqee_long"] == (who == "A") and (move_bps < 0) == (who == "A"),
            f"after {waited:.0f} s, mark {opened_mark / ONE:,.2f} -> {now_mark / ONE:,.2f} ({move_bps:+.2f} bps)",
        )
        # The engine liquidates only as much as brings the position back above its margin
        # requirement, in whole lots, and the liquidator takes that part over at the mark price.
        taken = signed(ev["base_liquidated"])
        side = 1 if who == "A" else -1
        check(
            "the liquidated part moved from the position to the liquidator",
            0 < taken <= ONE // 100 and position(who)["base"] == side * (ONE // 100 - taken) and position("L")["base"] == side * taken,
            f"{taken / ONE} BTC of 0.01; {who} now {position(who)['base'] / ONE}, L {position('L')['base'] / ONE} BTC",
        )
        liq_price = signed(ev["quote_liquidated"]) * ONE // signed(ev["base_liquidated"])
        check("it was liquidated at the live mark price", abs(liq_price - now_mark) * 1_000 <= now_mark, f"{liq_price / ONE:,.2f} USD against a mark of {now_mark / ONE:,.2f}")
        other = "B" if who == "A" else "A"
        try:
            try_liquidate(other, inspect=True)
            healthy = False
        except e2e.E2EError:
            healthy = True
        check(f"{other}, on the winning side, is not liquidatable", healthy)

    if funding_event is None:
        wait = 65 - (time.time() - market_created_at)
        if wait > 0:
            time.sleep(wait)
        j = ptb("crank funding", call(f"{PERP}::clearing_house::update_funding", [TUSD], obj(ch), obj(pfs_btc), CLOCK))
        funding_event = events(j, "::events::UpdatedFunding")
    check("funding was updated on the live index once its period had passed", len(funding_event) == 1)

    # ---------------------------------------------------------------- the service stops
    section("The service stops")
    code = stop_service(service)
    check("the service stops cleanly", code == 0, f"exit {code}")
    stopped_price, stopped_ms = feed(pfs_btc, source_id)
    print("  waiting 12 s so the feed is older than the market's 10 s tolerance")
    time.sleep(12)
    session("a session on the stale feed", "T", [limit(BID, 10_000_000, (stopped_price // ONE - 500) * B9)], expect_abort=("market", 1000))
    check("nothing moved the feed meanwhile", feed(pfs_btc, source_id) == (stopped_price, stopped_ms))

    section("The service signs again, without a relayer")
    signing = start_service(config_path, SIGNER_SEED, None, workdir / "signing-only.log")
    STATE["signing"] = signing
    try:
        wait_for_updates(2)
        session("a session without the updates still aborts", "T", [limit(BID, 10_000_000, (stopped_price // ONE - 500) * B9)], expect_abort=("market", 1000))
        j = session("a session that carries the served updates goes through", "T", [limit(BID, 10_000_000, (stopped_price // ONE - 500) * B9)], bundle=True)
        check("the trader's own transaction refreshed the feed and placed the order", len(events(j, "::events::PostedOrder")) == 1 and feed(pfs_btc, source_id)[1] > stopped_ms)
        check("the service relayed nothing itself", " relayed " not in (workdir / "signing-only.log").read_text())
    finally:
        stop_service(signing)

    section("The relayer comes back")
    service = start_relaying("relaying-2")
    STATE["service"] = service
    j = session("a session without updates trades again", "T", [limit(BID, 10_000_000, (index() // ONE - 500) * B9)])
    check("the market is open again on the relayer's prices", len(events(j, "::events::PostedOrder")) == 1)
    stop_service(service)

    relayed = sum(log.read_text().count(" relayed ") for log in logs)
    failures = [line for log in logs for line in log.read_text().splitlines() if " error " in line]
    check("the relayer never failed and no round was skipped", not failures, failures[0][:240] if failures else f"{relayed} relays")

    passed = sum(1 for _, ok in e2e.RESULTS if ok)
    print(f"\n{passed}/{len(e2e.RESULTS)} checks passed")
    return 0 if passed == len(e2e.RESULTS) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except e2e.E2EError as error:
        print(f"\nERROR: {error}")
        passed = sum(1 for _, ok in e2e.RESULTS if ok)
        print(f"{passed}/{len(e2e.RESULTS)} checks passed before the error")
        sys.exit(2)

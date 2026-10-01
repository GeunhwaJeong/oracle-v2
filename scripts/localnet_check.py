#!/usr/bin/env python3
# Copyright (c) 2026 Geunhwa Jeong
# SPDX-License-Identifier: Apache-2.0
"""Runs the price service against a localnet and checks what lands on chain.

Publishes the perp engine's packages with the helpers of its localnet suite, sets up the
`oracle_haneul` source with a throwaway signer and four feeds (BTC, ETH, SOL and a fixed-price
RYUSD), starts the service with live exchange prices and a freshly funded throwaway relayer, and
then checks the feeds, the HTTP endpoint, a third-party relay of a served update, and what a
service whose signer is not registered achieves.

Start the network first (see the perp engine's e2e/localnet_e2e.py), then:
    python3 scripts/localnet_check.py [path to the perp-dex checkout, default ~/perp-dex]

Needs python3, node, grpcurl and the Haneul CLI. It refuses to run against anything but a local
network (the check is the perp suite's own).
"""

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

SERVICE = Path(__file__).resolve().parent.parent
PERP = Path(sys.argv[1] if len(sys.argv) > 1 else "~/perp-dex").expanduser()
sys.path.insert(0, str(PERP / "e2e"))
import localnet_e2e as e2e  # noqa: E402
import oracle_signing  # noqa: E402
from localnet_e2e import CLOCK, ONE, call, check, cli, events, obj, owned_created, ptb, section, shared_created, u64, u128, vec_u8  # noqa: E402

SIGNER_SEED = bytes([0x44] * 32)
SIGNER = oracle_signing.public_key(SIGNER_SEED)
UNREGISTERED_SEED = bytes([0x55] * 32)
HTTP_PORT = 18787
INTERVAL_MS = 3000
SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD", "RYUSD/USD"]
# Placeholder prices the feeds are created with, stamped an hour ago so that the service's step
# limit has lapsed by the time it signs its first real price.
PLACEHOLDER = {"BTC/USD": 1, "ETH/USD": 1, "SOL/USD": 1, "RYUSD/USD": 1}


def grpc(method, request):
    out = subprocess.run(
        ["grpcurl", "-plaintext", "-d", "@", e2e.GRPC_ADDR[0], method],
        input=json.dumps(request),
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise e2e.E2EError(f"{method}: {(out.stdout + out.stderr)[-1000:]}")
    return json.loads(out.stdout)


def object_json(object_id):
    return grpc(
        "haneul.rpc.v2.LedgerService/GetObject",
        {"object_id": object_id, "read_mask": {"paths": ["json"]}},
    )["object"]["json"]


def balance(address):
    reply = grpc("haneul.rpc.v2.StateService/GetBalance", {"owner": address, "coin_type": "0x2::haneul::HANEUL"})
    return int(reply.get("balance", {}).get("balance", 0))


def feed(pfs, source_id):
    for f in object_json(pfs)["feeds"]:
        if int(f["source_id"]) == source_id:
            return int(f["price"]), int(f["timestamp_ms"])
    raise e2e.E2EError(f"no feed of source {source_id} in {pfs}")


def http(path):
    with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}{path}", timeout=5) as response:
        return response.status, json.loads(response.read())


def new_relayer():
    """A fresh keypair for the relayer: (bech32 private key, address)."""
    script = (
        "import { Ed25519Keypair } from '@haneullabs/haneul/keypairs/ed25519';"
        "const k = Ed25519Keypair.generate();"
        "console.log(JSON.stringify([k.getSecretKey(), k.toHaneulAddress()]));"
    )
    out = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, cwd=SERVICE)
    if out.returncode != 0:
        raise e2e.E2EError(f"keypair generation failed: {out.stderr[-500:]}")
    return json.loads(out.stdout.strip().splitlines()[-1])


def start_service(config_path, seed, relayer_key, log_path):
    env = dict(os.environ, ORACLE_SIGNER_SEED=seed.hex(), RELAYER_KEY=relayer_key, NODE_NO_WARNINGS="1")
    return subprocess.Popen(
        ["node", "src/main.ts", "--config", str(config_path)],
        cwd=SERVICE,
        env=env,
        stdout=open(log_path, "w"),
        stderr=subprocess.STDOUT,
    )


def stop_service(process):
    process.send_signal(signal.SIGTERM)
    try:
        return process.wait(timeout=20)
    except subprocess.TimeoutExpired:
        process.kill()
        return None


def main():
    e2e.safety_check()
    me = cli("client", "active-address").stdout.strip()

    section("Publish")
    ids = e2e.publish_all()
    P = {k: v["pkg"] for k, v in ids.items()}
    AUTH, VENDOR, ORACLE, SIGNED, E2E = P["authority_cap"], P["vendor"], P["oracle_aggregator"], P["oracle_haneul"], P["perp_e2e"]
    ADMIN = f"{AUTH}::authority::ADMIN"
    VK = f"{E2E}::vendor_key::E2E"
    vendor_config = shared_created(ids["vendor"]["tx"], "::config::Config")
    vendor_pkg_admin = owned_created(ids["vendor"]["tx"], "::authority::AuthorityCap<")
    oracle_config = shared_created(ids["oracle_aggregator"]["tx"], "::config::Config")
    oracle_pkg_admin = owned_created(ids["oracle_aggregator"]["tx"], "::authority::AuthorityCap<")

    section("Source, signer and feeds")
    j = ptb(
        "register vendor",
        call(f"{VENDOR}::config::register_vendor", [VK, ADMIN], obj(vendor_config), obj(vendor_pkg_admin), obj(me)),
    )
    vendor_vk_cap = owned_created(j, "::authority::AuthorityCap<")
    cmds = call(f"{VENDOR}::metadata::new", [VK, ADMIN], obj(vendor_config), obj(vendor_vk_cap), "'Price service check'", "'localnet'", assign="meta")
    cmds += call(f"{VENDOR}::metadata::approve_domain_registration", [VK, f"{ORACLE}::authority::PACKAGE"], "meta", obj(vendor_config), obj(oracle_pkg_admin))
    cmds += call(f"{ORACLE}::config::register_vendor", [VK, ADMIN], obj(oracle_config), obj(vendor_vk_cap), obj(vendor_config), "meta", assign="oracle_vk")
    cmds += call(f"{SIGNED}::source::create", [ADMIN], obj(oracle_config), obj(oracle_pkg_admin), assign="src")
    cmds += call(f"{SIGNED}::source::authorize", [ADMIN], "src", obj(oracle_config), obj(oracle_pkg_admin))
    cmds += call(f"{SIGNED}::source::set_signer", [ADMIN], "src", obj(oracle_config), obj(oracle_pkg_admin), vec_u8(SIGNER), u64(2**64 - 1), CLOCK)
    names = []
    for i, symbol in enumerate(SYMBOLS):
        cmds += call(f"{ORACLE}::price_feed_storage::new", [VK, ADMIN], obj(oracle_config), "oracle_vk", f"'{symbol}'", assign=f"pfs{i}")
        names.append(f"pfs{i}")
    cmds += ["--make-move-vec", f"<{ORACLE}::price_feed_storage::PriceFeedStorage>", "[" + ", ".join(names) + "]", "--assign", "pfs_vec"]
    cmds += call(f"{ORACLE}::price_feed_storage::share_vec", [], "pfs_vec")
    # The service reads the source by reference in every relay, so it is shared, as on mainnet.
    cmds += ["--move-call", "0x2::transfer::public_share_object", f"<{ORACLE}::source::Source<{SIGNED}::source::HANEUL>>", "src"]
    cmds += ["--transfer-objects", "[meta, oracle_vk]", obj(me)]
    j = ptb("source, signer and storages", cmds)
    source = shared_created(j, "::source::HANEUL>")
    source_id = int(events(j, "::events::CreatedSource")[0]["source_id"])
    oracle_vk = owned_created(j, f"AuthorityCap<{ORACLE}::authority::VENDOR<")
    storages = {s["symbol"]: s for s in events(j, "::events::CreatedPriceFeedStorage")}
    check("four storages created", set(storages) == set(SYMBOLS))

    created_ms = int(time.time() * 1000) - 3_600_000
    cmds = []
    for i, symbol in enumerate(SYMBOLS):
        s = storages[symbol]
        price = PLACEHOLDER[symbol] * ONE
        signature = oracle_signing.sign_price_update(SIGNER_SEED, source, int(s["storage_id"]), price, 0, created_ms + i)
        cmds += call(
            f"{SIGNED}::price_feed_storage::new_price_feed",
            [VK, ADMIN],
            obj(source),
            obj(oracle_vk),
            obj(oracle_config),
            obj(s["price_feed_storage_obj_id"]),
            u128(price),
            u128(0),
            u64(created_ms + i),
            vec_u8(SIGNER),
            vec_u8(signature),
            u64(60_000),
            CLOCK,
        )
    j = ptb("feeds from signed placeholder prices", cmds)
    check("four feeds created", len(events(j, "::events::CreatedPriceFeed")) == 4)

    section("Relayer")
    relayer_key, relayer = new_relayer()
    out = cli("client", "faucet", "--address", relayer)
    deadline = time.time() + 90
    while balance(relayer) == 0 and time.time() < deadline:
        time.sleep(1)
    funded = balance(relayer)
    check("the throwaway relayer is funded by the faucet", funded > 0, f"{funded / 1e9:.2f} HANEUL; {out.stderr[-200:].strip()}" if funded == 0 else f"{funded / 1e9:.2f} HANEUL")

    venues = [("binance", "USDT", 3), ("okx", "USDT", 2), ("bybit", "USDT", 2), ("coinbaseexchange", "USD", 2), ("kraken", "USD", 1), ("kucoin", "USDT", 1), ("gate", "USDT", 1), ("mexc", "USDT", 1), ("bitstamp", "USD", 1)]
    feeds = []
    for symbol in SYMBOLS:
        s = storages[symbol]
        base = symbol.split("/")[0]
        entry = {"symbol": symbol, "storageId": int(s["storage_id"]), "priceFeedStorageId": s["price_feed_storage_obj_id"]}
        if symbol == "RYUSD/USD":
            entry["fixedPrice"] = "1"
        else:
            entry["minSources"] = 4
            entry["sources"] = [{"exchange": ex, "market": f"{base}/{quote}", "weight": w} for ex, quote, w in venues]
        feeds.append(entry)
    config = {
        "rpcUrl": f"http://{e2e.GRPC_ADDR[0]}",
        "network": "localnet",
        "packageId": SIGNED,
        "sourceId": source,
        "aggregatorConfigId": oracle_config,
        "intervalMs": INTERVAL_MS,
        "httpPort": HTTP_PORT,
        "batchExchanges": ["kraken"],
        "quoteRates": {"USDT": {"minSources": 2, "sources": [{"exchange": ex, "market": "USDT/USD"} for ex in ("kraken", "coinbaseexchange", "bitstamp")]}},
        "feeds": feeds,
    }
    workdir = Path(tempfile.mkdtemp(prefix="price-service-check-"))
    config_path = workdir / "config.json"
    config_path.write_text(json.dumps(config, indent=2))
    log_path = workdir / "service.log"
    print(f"  config and log in {workdir}")

    section("Service with live prices")
    service = start_service(config_path, SIGNER_SEED, relayer_key, log_path)
    try:
        time.sleep(45)
        check("the service is still running", service.poll() is None, log_path.read_text()[-800:] if service.poll() is not None else "")

        now_ms = int(time.time() * 1000)
        status, updates = http("/v1/updates")
        served = {u["symbol"]: u for u in updates["updates"]}
        check("the endpoint serves an update for every feed", status == 200 and set(served) == set(SYMBOLS))
        for symbol in SYMBOLS:
            pfs = storages[symbol]["price_feed_storage_obj_id"]
            price, timestamp_ms = feed(pfs, source_id)
            age = now_ms - timestamp_ms
            check(f"{symbol}: the feed on chain is fresh", 0 <= age <= 10_000, f"{price / ONE:,.6f} USD, {age} ms old")
            if symbol == "RYUSD/USD":
                check("RYUSD/USD: the fixed price is exactly one", price == ONE)
            else:
                check(f"{symbol}: the placeholder was replaced by a market price", price > 2 * ONE, f"{price / ONE:,.2f}")
                drift = abs(price - int(served[symbol]["price"])) * 10_000 // price
                check(f"{symbol}: on chain within 1% of the latest served update", drift <= 100, f"{drift} bps")
        status, health = http("/healthz")
        check("the health endpoint reports every feed signed recently", status == 200 and health["healthy"], json.dumps(health)[:200] if status != 200 else "")

        btc_pfs = storages["BTC/USD"]["price_feed_storage_obj_id"]
        _, before_ms = feed(btc_pfs, source_id)
        stop_code = stop_service(service)
        check("the service stops cleanly on SIGTERM", stop_code == 0, f"exit {stop_code}")
    finally:
        if service.poll() is None:
            service.kill()

    log = log_path.read_text()
    relays = [line for line in log.splitlines() if " relayed " in line]
    gas = [int(line.rsplit("(gas ", 1)[1].rstrip(")")) for line in relays]
    check("rounds were relayed throughout", len(relays) >= 10, f"{len(relays)} relays in 45 s")
    if gas:
        steady = sorted(gas)[len(gas) // 2]
        print(f"  gas per relay of 4 feeds: median {steady / 1e9:.6f} HANEUL (min {min(gas) / 1e9:.6f}, max {max(gas) / 1e9:.6f})")
        print(f"  at one relay every {INTERVAL_MS / 1000:.0f} s that is {steady / 1e9 * 86_400_000 / INTERVAL_MS:.1f} HANEUL per day")
    check("no relay failed", " relay failed" not in log, next((line for line in log.splitlines() if "relay failed" in line), "")[:300])
    errors = [line for line in log.splitlines() if " error " in line]
    check("no feed was skipped", not errors, errors[0][:300] if errors else "")

    section("A third party relays a signed update")
    # The service is stopped; sign one more update the way it would and relay it from the
    # active address, which is neither the relayer nor a holder of any oracle cap.
    stale_price, stale_ms = feed(btc_pfs, source_id)
    fresh_ms = int(time.time() * 1000)
    fresh_price = stale_price + ONE
    signature = oracle_signing.sign_price_update(SIGNER_SEED, source, int(storages["BTC/USD"]["storage_id"]), fresh_price, 0, fresh_ms)
    update = [obj(source), obj(oracle_config), obj(btc_pfs), u128(fresh_price), u128(0), u64(fresh_ms), vec_u8(SIGNER), vec_u8(signature), CLOCK]
    ptb("relay by the active address", call(f"{SIGNED}::price_feed_storage::update_price_feed", [], *update))
    price, timestamp_ms = feed(btc_pfs, source_id)
    check("the update relayed by a third party is on chain", price == fresh_price and timestamp_ms == fresh_ms and timestamp_ms > before_ms)

    section("A service whose signer is not registered")
    held = {symbol: feed(storages[symbol]["price_feed_storage_obj_id"], source_id) for symbol in SYMBOLS}
    rogue_log = workdir / "rogue.log"
    rogue = start_service(config_path, UNREGISTERED_SEED, relayer_key, rogue_log)
    try:
        time.sleep(20)
    finally:
        stop_service(rogue)
    log = rogue_log.read_text()
    failed = next((line for line in log.splitlines() if "relay failed" in line), "")
    check("its relays abort with ESignerNotTrusted", "ESignerNotTrusted" in failed, (failed or log[-300:])[:200])
    check("it relayed nothing", " relayed " not in log)
    after = {symbol: feed(storages[symbol]["price_feed_storage_obj_id"], source_id) for symbol in SYMBOLS}
    check("the feeds are unchanged", after == held)

    passed = sum(1 for _, ok in e2e.RESULTS if ok)
    print(f"\n{passed}/{len(e2e.RESULTS)} checks passed")
    return 0 if passed == len(e2e.RESULTS) else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except e2e.E2EError as error:
        print(f"\nERROR: {error}")
        sys.exit(2)

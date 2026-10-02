#!/usr/bin/env python3
# Copyright (c) 2026 Geunhwa Jeong
# SPDX-License-Identifier: Apache-2.0
"""Runs the price service against a localnet and checks what lands on chain.

Publishes the perp engine's packages with the helpers of its localnet suite and sets up the
`oracle_haneul` source with a throwaway signer and four storages (BTC, ETH, SOL and a fixed-price
RYUSD). The feeds are created the way a deployment would create them: the service runs without
a relayer, only signing, and the signed prices it serves go into `new_price_feed`. The service
is then run with live exchange prices and a freshly funded throwaway relayer, and the script
checks the feeds, the HTTP endpoint, a third-party relay of a served update, the step limit
(a signed price 30% away is refused, the package admin can force it, the pinned collateral
feed takes no other price), and what a service whose signer is not registered achieves.

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
import urllib.error
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
# Followed over WebSockets; the rest are asked over REST every round.
STREAMED = ["binance", "okx", "bybit", "coinbaseexchange", "kraken", "kucoin", "gate", "bitstamp"]


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
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}{path}", timeout=5) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def metrics():
    """The service's metrics as {'name{labels}': value}."""
    with urllib.request.urlopen(f"http://127.0.0.1:{HTTP_PORT}/metrics", timeout=5) as response:
        lines = response.read().decode().splitlines()
    return {line.rsplit(" ", 1)[0]: float(line.rsplit(" ", 1)[1]) for line in lines if line and not line.startswith("#")}


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
    env = dict(os.environ, ORACLE_SIGNER_SEED=seed.hex(), NODE_NO_WARNINGS="1")
    env.pop("RELAYER_KEY", None)
    if relayer_key is not None:
        env["RELAYER_KEY"] = relayer_key
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
        "streamExchanges": STREAMED,
        "quoteRates": {"USDT": {"minSources": 2, "sources": [{"exchange": ex, "market": "USDT/USD"} for ex in ("kraken", "coinbaseexchange", "bitstamp")]}},
        "feeds": feeds,
    }
    workdir = Path(tempfile.mkdtemp(prefix="price-service-check-"))
    config_path = workdir / "config.json"
    config_path.write_text(json.dumps(config, indent=2))
    log_path = workdir / "service.log"
    print(f"  config and logs in {workdir}")

    # A feed is created from a signed price like any update. With the default step limit a
    # placeholder would lock the feed out of the market price, so the first prices come from the
    # service itself, run without a relayer: it signs and serves, and relays nothing.
    signing_only = start_service(config_path, SIGNER_SEED, None, workdir / "signing-only.log")
    try:
        served = {}
        deadline = time.time() + 60
        while len(served) < len(SYMBOLS) and time.time() < deadline:
            time.sleep(1)
            try:
                served = {u["symbol"]: u for u in http("/v1/updates")[1]["updates"]}
            except OSError:
                pass
        check("without a relayer the service signs and serves every feed", set(served) == set(SYMBOLS))
        cmds = []
        for symbol in SYMBOLS:
            u = served[symbol]
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
                u64(60_000),
                CLOCK,
            )
        j = ptb("feeds from the prices the service signed", cmds)
        check("four feeds created", len(events(j, "::events::CreatedPriceFeed")) == 4)
    finally:
        stop_service(signing_only)
    check("it relayed nothing", " relayed " not in (workdir / "signing-only.log").read_text())

    # The collateral is worth its quote by construction: its feed takes no other price.
    ryusd_storage = int(storages["RYUSD/USD"]["storage_id"])
    j = ptb(
        "pin the collateral feed",
        call(f"{SIGNED}::source::set_step_limit", [ADMIN], obj(source), obj(oracle_config), obj(oracle_pkg_admin), f"{ryusd_storage}u32", u64(0), u64(0), u64(0)),
    )
    check("the collateral feed is pinned", len(events(j, "::events::SetStepLimit")) == 1)

    section("Relayer")
    relayer_key, relayer = new_relayer()
    out = cli("client", "faucet", "--address", relayer)
    deadline = time.time() + 90
    while balance(relayer) == 0 and time.time() < deadline:
        time.sleep(1)
    funded = balance(relayer)
    check("the throwaway relayer is funded by the faucet", funded > 0, f"{funded / 1e9:.2f} HANEUL; {out.stderr[-200:].strip()}" if funded == 0 else f"{funded / 1e9:.2f} HANEUL")

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
                check(f"{symbol}: the feed holds a market price", price > 2 * ONE, f"{price / ONE:,.2f}")
                drift = abs(price - int(served[symbol]["price"])) * 10_000 // price
                check(f"{symbol}: on chain within 1% of the latest served update", drift <= 100, f"{drift} bps")
        status, health = http("/healthz")
        check("the health endpoint reports every feed signed recently", status == 200 and health["healthy"], json.dumps(health)[:200] if status != 200 else "")
        landed = [f.get("relayedAgeMs") for f in health["feeds"]]
        check("and landed on chain recently", all(age is not None and age <= 3 * INTERVAL_MS for age in landed), str(landed))

        m = metrics()
        up = [ex for ex in STREAMED if m.get(f'oracle_stream_up{{exchange="{ex}"}}') == 1]
        check("the venues' streams are up", len(up) >= len(STREAMED) - 1, f"{len(up)} of {len(STREAMED)}: down {sorted(set(STREAMED) - set(up))}")
        by_transport = {t: sum(v for k, v in m.items() if k.startswith("oracle_source_quotes_total") and f'transport="{t}"' in k and 'result="ok"' in k) for t in ("stream", "rest")}
        check("most quotes came from the streams", by_transport["stream"] > by_transport["rest"], str(by_transport))
        print(f"  quotes taken: {by_transport['stream']:.0f} streamed, {by_transport['rest']:.0f} over REST")
        waits, rounds = m["oracle_fetch_duration_seconds_sum"], m["oracle_fetch_duration_seconds_count"]
        print(f"  a round waited {waits / rounds * 1000:.0f} ms for the venues on average ({rounds:.0f} rounds)")
        check("the metrics count the relays, none failed", m.get('oracle_relays_total{result="ok"}', 0) >= 10 and 'oracle_relays_total{result="failed"}' not in m, str({k: v for k, v in m.items() if k.startswith("oracle_relays_total")}))
        for symbol in SYMBOLS:
            label = f'{{feed="{symbol}"}}'
            signed_at, relayed_at = m.get(f"oracle_feed_last_signed_timestamp_seconds{label}", 0), m.get(f"oracle_feed_last_relayed_timestamp_seconds{label}", 0)
            now_s = time.time()
            check(f"{symbol}: the metrics say it was signed and landed within the last rounds", now_s - signed_at <= 10 and now_s - relayed_at <= 10, f"signed {now_s - signed_at:.1f} s ago, landed {now_s - relayed_at:.1f} s ago")
            if symbol != "RYUSD/USD":
                price_on_chain = feed(storages[symbol]["price_feed_storage_obj_id"], source_id)[0] / ONE
                check(f"{symbol}: the price metric is the price on chain to within 1%", abs(m[f"oracle_feed_price{label}"] - price_on_chain) <= price_on_chain / 100, f'{m[f"oracle_feed_price{label}"]} vs {price_on_chain}')
                check(f"{symbol}: it stands on at least six venues", m[f"oracle_feed_sources_used{label}"] >= 6, str(m[f"oracle_feed_sources_used{label}"]))

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

    section("Step limit")
    # A price the registered signer signed, 30% above the stored one: the default limit allows
    # 20% at most, however long the feed has been quiet.
    stored_price, _ = feed(btc_pfs, source_id)
    far_ms = int(time.time() * 1000)
    far_price = stored_price * 13 // 10
    signature = oracle_signing.sign_price_update(SIGNER_SEED, source, int(storages["BTC/USD"]["storage_id"]), far_price, 0, far_ms)
    far = [obj(btc_pfs), u128(far_price), u128(0), u64(far_ms), vec_u8(SIGNER), vec_u8(signature), CLOCK]
    ptb(
        "a signed BTC price 30% away",
        call(f"{SIGNED}::price_feed_storage::update_price_feed", [], obj(source), obj(oracle_config), *far),
        expect_abort=("price_feed_storage", 6),
    )
    check("the refused price is not on chain", feed(btc_pfs, source_id)[0] == stored_price)
    ptb(
        "the package admin forces it",
        call(f"{SIGNED}::price_feed_storage::force_update_price_feed", [ADMIN], obj(source), obj(oracle_config), obj(oracle_pkg_admin), *far),
    )
    check("the forced price is on chain", feed(btc_pfs, source_id) == (far_price, far_ms))
    # The pinned collateral feed refuses a signed price of 1.01.
    ryusd_pfs = storages["RYUSD/USD"]["price_feed_storage_obj_id"]
    off_ms = int(time.time() * 1000)
    off_price = ONE + ONE // 100
    signature = oracle_signing.sign_price_update(SIGNER_SEED, source, ryusd_storage, off_price, 0, off_ms)
    ptb(
        "a signed collateral price of 1.01",
        call(f"{SIGNED}::price_feed_storage::update_price_feed", [], obj(source), obj(oracle_config), obj(ryusd_pfs), u128(off_price), u128(0), u64(off_ms), vec_u8(SIGNER), vec_u8(signature), CLOCK),
        expect_abort=("price_feed_storage", 6),
    )

    section("A service whose signer is not registered")
    held = {symbol: feed(storages[symbol]["price_feed_storage_obj_id"], source_id) for symbol in SYMBOLS}
    rogue_log = workdir / "rogue.log"
    rogue = start_service(config_path, UNREGISTERED_SEED, relayer_key, rogue_log)
    try:
        time.sleep(20)
        # It signs every round, and nothing it signs lands: that is not a healthy service.
        status, health = http("/healthz")
        signing = all(f["ageMs"] is not None and f["ageMs"] <= 3 * INTERVAL_MS for f in health["feeds"])
        check("it signs, and the health endpoint still fails because nothing lands", status == 503 and signing and not health["healthy"], json.dumps(health)[:300])
        m = metrics()
        check("its failed relays are counted", m.get('oracle_relays_total{result="failed"}', 0) >= 3 and 'oracle_relays_total{result="ok"}' not in m, str({k: v for k, v in m.items() if k.startswith("oracle_relays_total")}))
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

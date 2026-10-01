// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The constants below are the fixtures of the `oracle_haneul` Move unit tests (seed 0x11 * 32),
// whose signatures the chain's own Ed25519 verification accepts. Ed25519 is deterministic, so
// producing the same bytes here means the service signs exactly what the contract checks.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ONE } from "../src/fixed.ts";
import { PriceSigner, objectIdBytes, priceUpdateMessage } from "../src/message.ts";

const SOURCE = "0x9ae707b98dfe186ddf62cbdaf35e030c4bcb1f74985af871b581098030e2cf82";
const SEED = "11".repeat(32);
const PUBLIC_KEY = "d04ab232742bb4ab3a1368bd4615e4e6d0224ab71a016baf8520a332c9778737";
const SIG_FIRST =
  "e9f2944160398b2b899b6131f323f024b5d59634dd196aba700371523c96cc5d8c3c45f8b72273e144ed87dff82fae15a85c9acf5517e3f5aaba9fffd2fb1201";
const SIG_OTHER_FEED =
  "9d48e4adb6d91bf9171b2f8c7ff8ae22b55a8a93f6537146b2d478a580297479209a9ab4f084ede820645037b5b5db63a2e416b78ae76597c87e7837db43c30c";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

test("the message is the BCS encoding the contract rebuilds", () => {
  const message = priceUpdateMessage({
    sourceId: SOURCE,
    storageId: 7,
    price: 68_000n * ONE,
    confidence: 10n * ONE,
    timestampMs: 1_000_000n,
  });
  assert.equal(message.length, 103);
  assert.equal(
    hex(message),
    "1a" +
      Buffer.from("haneul_oracle::PriceUpdate").toString("hex") +
      SOURCE.slice(2) +
      "07000000" +
      "000080228f289249660e000000000000" +
      "0000e8890423c78a0000000000000000" +
      "40420f0000000000",
  );
});

test("the signer derives the registered public key", () => {
  assert.equal(hex(PriceSigner.fromHex(SEED).publicKey), PUBLIC_KEY);
  assert.equal(hex(PriceSigner.fromHex(`0x${SEED}`).publicKey), PUBLIC_KEY);
});

test("signatures match the ones the chain accepts", () => {
  const signer = PriceSigner.fromHex(SEED);
  assert.equal(
    hex(signer.sign({ sourceId: SOURCE, storageId: 0, price: 68_000n * ONE, confidence: 10n * ONE, timestampMs: 1_000_000n })),
    SIG_FIRST,
  );
  assert.equal(
    hex(signer.sign({ sourceId: SOURCE, storageId: 1, price: 2_000n * ONE, confidence: ONE, timestampMs: 1_000_000n })),
    SIG_OTHER_FEED,
  );
});

test("out-of-range fields and malformed keys are refused", () => {
  const base = { sourceId: SOURCE, storageId: 0, price: ONE, confidence: 0n, timestampMs: 1n };
  assert.throws(() => priceUpdateMessage({ ...base, price: 2n ** 128n }), /price out of range/);
  assert.throws(() => priceUpdateMessage({ ...base, confidence: -1n }), /confidence out of range/);
  assert.throws(() => priceUpdateMessage({ ...base, timestampMs: 2n ** 64n }), /timestamp out of range/);
  assert.throws(() => priceUpdateMessage({ ...base, storageId: 2 ** 32 }), /storage id out of range/);
  assert.throws(() => priceUpdateMessage({ ...base, sourceId: "0xzz" }), /invalid object id/);
  assert.throws(() => PriceSigner.fromHex("abcd"), /64 hex characters/);
  assert.throws(() => new PriceSigner(new Uint8Array(31)), /32 bytes/);
});

test("short object ids are left-padded", () => {
  assert.equal(hex(objectIdBytes("0x6")), "0".repeat(63) + "6");
});

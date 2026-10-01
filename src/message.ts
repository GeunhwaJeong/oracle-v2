// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// The bytes the `oracle_haneul` source verifies a signature over, and the signer.
//
// The message is the BCS encoding of `oracle_haneul::price_feed_storage::PriceUpdate`:
//   domain: vector<u8>, source: ID, storage_id: u32, price: u128, confidence: u128,
//   timestamp_ms: u64
// `price_feed_storage::price_update_message` returns the same bytes on chain.

import { createPrivateKey, createPublicKey, sign as nodeSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const MESSAGE_DOMAIN = "haneul_oracle::PriceUpdate";

const U32_MAX = 2n ** 32n - 1n;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;

function littleEndian(value: bigint, bytes: number, max: bigint, name: string): Uint8Array {
  if (value < 0n || value > max) throw new Error(`${name} out of range: ${value}`);
  const out = new Uint8Array(bytes);
  let rest = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export function objectIdBytes(id: string): Uint8Array {
  const hex = id.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error(`invalid object id: ${id}`);
  return Uint8Array.from(Buffer.from(hex.padStart(64, "0"), "hex"));
}

export interface PriceUpdate {
  /** Object id of the `Source<HANEUL>` the update is for. */
  sourceId: string;
  storageId: number;
  price: bigint;
  confidence: bigint;
  timestampMs: bigint;
}

export function priceUpdateMessage(update: PriceUpdate): Uint8Array {
  const domain = Buffer.from(MESSAGE_DOMAIN, "ascii");
  // The domain is shorter than 128 bytes, so its ULEB128 length is a single byte.
  return Buffer.concat([
    Uint8Array.of(domain.length),
    domain,
    objectIdBytes(update.sourceId),
    littleEndian(BigInt(update.storageId), 4, U32_MAX, "storage id"),
    littleEndian(update.price, 16, U128_MAX, "price"),
    littleEndian(update.confidence, 16, U128_MAX, "confidence"),
    littleEndian(update.timestampMs, 8, U64_MAX, "timestamp"),
  ]);
}

// DER prefix of a PKCS#8 Ed25519 private key; the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class PriceSigner {
  readonly #key: KeyObject;
  /** The 32-byte Ed25519 public key registered on the source with `set_signer`. */
  readonly publicKey: Uint8Array;

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error("an Ed25519 seed is 32 bytes long");
    this.#key = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(this.#key).export({ format: "der", type: "spki" });
    this.publicKey = Uint8Array.from(spki.subarray(spki.length - 32));
  }

  static fromHex(seedHex: string): PriceSigner {
    const hex = seedHex.trim().replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("the signer seed is 64 hex characters (32 bytes)");
    }
    return new PriceSigner(Uint8Array.from(Buffer.from(hex, "hex")));
  }

  sign(update: PriceUpdate): Uint8Array {
    return Uint8Array.from(nodeSign(null, priceUpdateMessage(update), this.#key));
  }
}

// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

// Prices are 18-decimal fixed point in a bigint, the scale the on-chain feeds store. Floats
// only appear at the boundary, where an exchange hands one over.

export const DECIMALS = 18;
export const ONE = 10n ** 18n;
export const BPS = 10_000n;

/** Parses a non-negative decimal string, with or without an exponent, rounding down. */
export function parseFixed(text: string): bigint {
  const match = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text.trim());
  if (!match || (match[1] === "" && (match[2] ?? "") === "")) {
    throw new Error(`not a non-negative decimal: "${text}"`);
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  const shift = DECIMALS + Number(match[3] ?? 0) - fraction.length;
  const digits = BigInt(whole + fraction || "0");
  return shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift);
}

/**
 * Converts a price an exchange reported as a float. Fifteen significant digits is what a
 * double holds exactly, so the noise beyond them is cut rather than carried into the feed.
 */
export function fromNumber(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`not a non-negative finite number: ${value}`);
  }
  return parseFixed(value.toPrecision(15));
}

/** Decimal string of a fixed-point value, without trailing zeros. */
export function formatFixed(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const magnitude = value < 0n ? -value : value;
  const whole = magnitude / ONE;
  const fraction = (magnitude % ONE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  return (a * b) / denominator;
}

export function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** `|a - b|` in basis points of `b`, rounded up. */
export function deviationBps(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new Error("deviation from zero");
  const numerator = abs(a - b) * BPS;
  return (numerator + b - 1n) / b;
}

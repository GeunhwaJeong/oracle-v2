// Copyright (c) 2026 Geunhwa Jeong
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";

import { ONE, deviationBps, formatFixed, fromNumber, parseFixed } from "../src/fixed.ts";

test("parseFixed reads decimals and exponents, rounding down", () => {
  assert.equal(parseFixed("1"), ONE);
  assert.equal(parseFixed("83765.07"), 83_765_070_000_000_000_000_000n);
  assert.equal(parseFixed("0.99922"), 999_220_000_000_000_000n);
  assert.equal(parseFixed(".5"), ONE / 2n);
  assert.equal(parseFixed("5."), 5n * ONE);
  assert.equal(parseFixed("9.99220000000000e-1"), 999_220_000_000_000_000n);
  assert.equal(parseFixed("1.5e+3"), 1_500n * ONE);
  assert.equal(parseFixed("1e-18"), 1n);
  assert.equal(parseFixed("1e-19"), 0n);
  assert.equal(parseFixed("0.0000000000000000019"), 1n);
});

test("parseFixed refuses what is not a non-negative decimal", () => {
  for (const text of ["", ".", "-1", "1,5", "abc", "1e", "0x10", "NaN"]) {
    assert.throws(() => parseFixed(text), /not a non-negative decimal/, text);
  }
});

test("fromNumber drops float noise beyond fifteen significant digits", () => {
  assert.equal(fromNumber(83765.07), 83_765_070_000_000_000_000_000n);
  assert.equal(fromNumber(0.1 + 0.2), 300_000_000_000_000_000n);
  assert.equal(fromNumber(0.00001234), 12_340_000_000_000n);
  assert.equal(fromNumber(0), 0n);
  for (const value of [NaN, Infinity, -1]) assert.throws(() => fromNumber(value));
});

test("formatFixed prints without trailing zeros", () => {
  assert.equal(formatFixed(ONE), "1");
  assert.equal(formatFixed(83_765_070_000_000_000_000_000n), "83765.07");
  assert.equal(formatFixed(1n), "0.000000000000000001");
  assert.equal(formatFixed(-ONE / 2n), "-0.5");
});

test("deviationBps rounds up", () => {
  assert.equal(deviationBps(101n * ONE, 100n * ONE), 100n);
  assert.equal(deviationBps(99n * ONE, 100n * ONE), 100n);
  assert.equal(deviationBps(100n * ONE + 1n, 100n * ONE), 1n);
  assert.equal(deviationBps(100n * ONE, 100n * ONE), 0n);
  assert.throws(() => deviationBps(1n, 0n));
});

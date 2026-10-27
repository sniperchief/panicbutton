// Unit tests for the pure arithmetic (carried over from experiments/exp0, extended).

import { describe, expect, it } from "vitest";
import {
  SELECTORS,
  abs,
  capCrosses,
  classify,
  closeQuantity,
  closeSide,
  depthWithinCap,
  deviationBps,
  fingerprint,
  placeOrderForSelector,
  priceCap,
  unrealizedPnl,
  type DecisionFields,
} from "../server/engine/plan.js";

const E18 = 10n ** 18n;
const MAX = 300;

describe("selector", () => {
  it("placeOrderFor ABI matches the registry key the app grants", () => {
    expect(placeOrderForSelector()).toBe(SELECTORS.placeOrderFor);
  });
});

describe("closeSide", () => {
  it("sells to close a long, buys to close a short, refuses flat", () => {
    expect(closeSide(5n)).toEqual({ isBid: false, positionSide: "long" });
    expect(closeSide(-5n)).toEqual({ isBid: true, positionSide: "short" });
    expect(() => closeSide(0n)).toThrow(/flat/);
  });
});

describe("closeQuantity", () => {
  const eth = { tickSize: 10n ** 16n, lotSize: 10n ** 14n, minQuantity: 4n * 10n ** 15n }; // baseDecimals 18
  const hype = { tickSize: 10n ** 16n, lotSize: 10n ** 4n, minQuantity: 12n * 10n ** 4n }; // baseDecimals 6
  const near = { tickSize: 10n ** 14n, lotSize: 10n ** 23n, minQuantity: 51n * 10n ** 23n }; // baseDecimals 24

  it("is exactly |size| across 6, 18 and 24 decimal markets", () => {
    expect(closeQuantity(-4n * 10n ** 15n, eth)).toEqual({ ok: true, quantity: 4n * 10n ** 15n });
    expect(closeQuantity(-120_000n, hype)).toEqual({ ok: true, quantity: 120_000n });
    expect(closeQuantity(51n * 10n ** 23n, near)).toEqual({ ok: true, quantity: 51n * 10n ** 23n });
  });
  it("never rounds, never goes below minimum, never exceeds |size|", () => {
    expect(closeQuantity(4n * 10n ** 15n + 1n, eth).ok).toBe(false);
    expect(closeQuantity(10n ** 14n, eth).ok).toBe(false);
    for (const s of [4n * 10n ** 15n, -7n * 10n ** 15n, 123n * 10n ** 14n]) {
      const r = closeQuantity(s, eth);
      if (r.ok) expect(r.quantity <= abs(s)).toBe(true);
    }
  });
});

describe("priceCap", () => {
  const tick = 10n ** 16n;
  it("sell: below the bid by at most the slippage, aligned up", () => {
    const bid = 232792n * tick;
    const cap = priceCap({ isBid: false, touch: bid, slippageBps: 50, tickSize: tick, maxSlippageBps: MAX });
    expect(cap).toBe(231629n * tick);
    expect(deviationBps(cap, bid) <= 50n).toBe(true);
  });
  it("buy: above the ask by at most the slippage, aligned down", () => {
    const ask = 232817n * tick;
    const cap = priceCap({ isBid: true, touch: ask, slippageBps: 50, tickSize: tick, maxSlippageBps: MAX });
    expect(cap).toBe(233981n * tick);
    expect(deviationBps(cap, ask) <= 50n).toBe(true);
  });
  it("rejects slippage above the ceiling or non-integers", () => {
    expect(() => priceCap({ isBid: false, touch: E18, slippageBps: 301, tickSize: tick, maxSlippageBps: MAX })).toThrow();
    expect(() => priceCap({ isBid: false, touch: E18, slippageBps: 1.5, tickSize: tick, maxSlippageBps: MAX })).toThrow();
  });
  it("capCrosses matches the side", () => {
    expect(capCrosses(false, 99n, 100n)).toBe(true);
    expect(capCrosses(false, 101n, 100n)).toBe(false);
    expect(capCrosses(true, 101n, 100n)).toBe(true);
    expect(capCrosses(true, 99n, 100n)).toBe(false);
  });
});

describe("depthWithinCap", () => {
  it("counts only acceptable levels", () => {
    const bids = [
      { price: 100n, quantity: 3n },
      { price: 99n, quantity: 5n },
      { price: 97n, quantity: 7n },
    ];
    expect(depthWithinCap(bids, false, 99n)).toBe(8n);
    expect(depthWithinCap([{ price: 10n, quantity: 2n }, { price: 12n, quantity: 4n }], true, 11n)).toBe(2n);
  });
});

describe("unrealizedPnl", () => {
  it("is exact for longs and shorts across decimals", () => {
    // long 0.004 ETH (18 dec), entry 2300, mark 2328 -> +0.112 USDso
    expect(unrealizedPnl(4n * 10n ** 15n, 2300n * E18, 2328n * E18, 18)).toBe(112n * 10n ** 15n);
    // short 0.00013 BTC (8 dec), entry 80000, mark 80005 -> -0.00065 USDso
    expect(unrealizedPnl(-13000n, 80_000n * E18, 80_005n * E18, 8)).toBe(-65n * 10n ** 13n);
  });
});

describe("fingerprint", () => {
  const base: DecisionFields = {
    chainId: 50383,
    pool: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf",
    owner: "0x000000000000000000000000000000000000dEaD",
    operator: "0x0000000000000000000000000000000000000Bad",
    positionSize: 4n * 10n ** 15n,
    isBid: false,
    orderType: 2,
    quantity: 4n * 10n ** 15n,
    price: 231629n * 10n ** 16n,
    selfMatchingOption: 0,
  };
  it("changes when any decision field changes", () => {
    const fp = fingerprint(base);
    expect(fingerprint({ ...base })).toBe(fp);
    for (const changed of [
      { positionSize: base.positionSize + 1n },
      { quantity: base.quantity - 1n },
      { price: base.price + 1n },
      { isBid: true },
      { chainId: 50312 },
    ]) {
      expect(fingerprint({ ...base, ...changed })).not.toBe(fp);
    }
  });
});

describe("classify", () => {
  it("names every outcome", () => {
    expect(classify(5n, 0n)).toBe("CLOSED");
    expect(classify(5n, 2n)).toBe("PARTIAL");
    expect(classify(5n, -1n)).toBe("FLIPPED");
    expect(classify(-5n, 1n)).toBe("FLIPPED");
    expect(classify(5n, 5n)).toBe("UNCHANGED");
    expect(classify(5n, 6n)).toBe("INCREASED");
  });
});

import { describe, expect, it } from "vitest";
import {
  SELECTORS,
  abs,
  classify,
  closeQuantity,
  closeSide,
  depthWithinCap,
  deviationBps,
  fingerprint,
  placeOrderForSelector,
  priceCap,
  type DecisionFields,
} from "../src/plan.js";

const E18 = 10n ** 18n;

describe("selector", () => {
  it("placeOrderFor ABI matches the registry key the app grants", () => {
    expect(placeOrderForSelector()).toBe(SELECTORS.placeOrderFor);
  });
});

describe("closeSide", () => {
  it("sells to close a long, buys to close a short", () => {
    expect(closeSide(5n)).toEqual({ isBid: false, positionSide: "long" });
    expect(closeSide(-5n)).toEqual({ isBid: true, positionSide: "short" });
  });
  it("refuses a flat position", () => {
    expect(() => closeSide(0n)).toThrow(/flat/);
  });
});

describe("closeQuantity", () => {
  // ETH-PERP live rules: lot 1e14, min 4e15 (baseDecimals 18)
  const eth = { tickSize: 10n ** 16n, lotSize: 10n ** 14n, minQuantity: 4n * 10n ** 15n };
  // HYPE-PERP live rules: baseDecimals 6, lot 1e4, min 1.2e5
  const hype = { tickSize: 10n ** 16n, lotSize: 10n ** 4n, minQuantity: 12n * 10n ** 4n };
  // NEAR-PERP live rules: baseDecimals 24
  const near = { tickSize: 10n ** 14n, lotSize: 10n ** 23n, minQuantity: 51n * 10n ** 23n };

  it("is exactly |size| for long and short", () => {
    expect(closeQuantity(4n * 10n ** 15n, eth)).toEqual({ ok: true, quantity: 4n * 10n ** 15n });
    expect(closeQuantity(-4n * 10n ** 15n, eth)).toEqual({ ok: true, quantity: 4n * 10n ** 15n });
    expect(closeQuantity(-120_000n, hype)).toEqual({ ok: true, quantity: 120_000n });
    expect(closeQuantity(51n * 10n ** 23n, near)).toEqual({ ok: true, quantity: 51n * 10n ** 23n });
  });
  it("never rounds a non-lot-multiple size", () => {
    const r = closeQuantity(4n * 10n ** 15n + 1n, eth);
    expect(r.ok).toBe(false);
  });
  it("rejects below minimum", () => {
    expect(closeQuantity(10n ** 14n, eth).ok).toBe(false);
  });
  it("never exceeds |size|", () => {
    for (const s of [4n * 10n ** 15n, -7n * 10n ** 15n, 123n * 10n ** 14n]) {
      const r = closeQuantity(s, eth);
      if (r.ok) expect(r.quantity <= abs(s)).toBe(true);
    }
  });
});

describe("priceCap", () => {
  const tick = 10n ** 16n; // 0.01 USDso
  it("sell cap is below the bid by at most the slippage, aligned up", () => {
    const bid = 2327_92n * tick; // 2327.92
    const cap = priceCap({ isBid: false, touch: bid, slippageBps: 50, tickSize: tick });
    expect(cap % tick).toBe(0n);
    expect(cap <= bid).toBe(true);
    expect(deviationBps(cap, bid) <= 50n).toBe(true);
    expect(cap).toBe(2316_29n * tick); // 2327.92 * 0.995 = 2316.2804 -> up to 2316.29
  });
  it("buy cap is above the ask by at most the slippage, aligned down", () => {
    const ask = 2328_17n * tick;
    const cap = priceCap({ isBid: true, touch: ask, slippageBps: 50, tickSize: tick });
    expect(cap % tick).toBe(0n);
    expect(cap >= ask).toBe(true);
    expect(deviationBps(cap, ask) <= 50n).toBe(true);
    expect(cap).toBe(2339_81n * tick); // 2328.17 * 1.005 = 2339.81085 -> down to 2339.81
  });
  it("zero slippage still crosses on a tick-aligned touch", () => {
    expect(priceCap({ isBid: false, touch: 100n * E18, slippageBps: 0, tickSize: tick })).toBe(100n * E18);
  });
  it("rejects slippage above the ceiling or non-integers", () => {
    expect(() => priceCap({ isBid: false, touch: E18, slippageBps: 301, tickSize: tick })).toThrow();
    expect(() => priceCap({ isBid: false, touch: E18, slippageBps: 1.5, tickSize: tick })).toThrow();
  });
});

describe("depthWithinCap", () => {
  const bids = [
    { price: 100n, quantity: 3n },
    { price: 99n, quantity: 5n },
    { price: 97n, quantity: 7n },
  ];
  it("counts only levels the cap accepts", () => {
    expect(depthWithinCap(bids, false, 99n)).toBe(8n);
    expect(depthWithinCap([{ price: 10n, quantity: 2n }, { price: 12n, quantity: 4n }], true, 11n)).toBe(2n);
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
    price: 2316_29n * 10n ** 16n,
    selfMatchingOption: 0,
  };
  it("is stable and case-insensitive on addresses", () => {
    expect(fingerprint(base)).toBe(fingerprint({ ...base, pool: base.pool.toUpperCase().replace("0X", "0x") }));
  });
  it("changes when any decision field changes", () => {
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, positionSize: base.positionSize + 1n })).not.toBe(fp);
    expect(fingerprint({ ...base, quantity: base.quantity - 1n })).not.toBe(fp);
    expect(fingerprint({ ...base, price: base.price + 1n })).not.toBe(fp);
    expect(fingerprint({ ...base, isBid: true })).not.toBe(fp);
    expect(fingerprint({ ...base, chainId: 50312 })).not.toBe(fp);
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

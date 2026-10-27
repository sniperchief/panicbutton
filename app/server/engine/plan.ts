// Pure close-order arithmetic. Carried over from experiments/exp0/src/plan.ts
// (verified against SDK 0.32.1 and live market rows), plus unrealized PnL.
// No I/O and exact bigint arithmetic only.
//
//   price    raw quote units per whole base; every Hideki perp has quoteDecimals 18.
//   quantity raw base units, per-market baseDecimals (6..24), lotSize multiple, >= minQuantity.
//   orderType 2 = ImmediateOrCancel (SDK ORDER_TYPE.MARKET, src/trade.ts:439).

import { createHash } from "node:crypto";
import { toFunctionSelector } from "viem";

export const ORDER_TYPE_IOC = 2;
/** SELF_MATCHING_OPTION 0 = CANCEL_TAKER, the SDK default for placePerpOrder. */
export const SELF_MATCH_CANCEL_TAKER = 0;
export const BPS = 10_000n;

export const PLACE_ORDER_FOR_SIGNATURE =
  "placeOrderFor(address,bool,uint64,uint256,uint256,uint64,uint8,uint8,address,uint96)";
/** Registry keys from the dreamDEX Operators docs. */
export const SELECTORS = {
  placeOrderFor: "0x80054449",
  cancelOrderFor: "0xe37b444b",
  reduceOrderFor: "0x364c2587",
} as const;

export function placeOrderForSelector(): `0x${string}` {
  return toFunctionSelector(PLACE_ORDER_FOR_SIGNATURE);
}

export interface Level {
  price: bigint;
  quantity: bigint;
}

export interface MarketRules {
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
}

export const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Closing a long sells (isBid=false); closing a short buys (isBid=true). */
export function closeSide(size: bigint): { isBid: boolean; positionSide: "long" | "short" } {
  if (size === 0n) throw new Error("position is flat: nothing to close");
  return size > 0n ? { isBid: false, positionSide: "long" } : { isBid: true, positionSide: "short" };
}

/**
 * The close quantity is exactly |size|. It is never rounded: rounding down leaves a
 * remainder open, and anything above |size| could flip the position.
 */
export function closeQuantity(
  size: bigint,
  rules: MarketRules,
): { ok: true; quantity: bigint } | { ok: false; code: "flat" | "bad-rules" | "not-lot-multiple" | "below-minimum"; reason: string } {
  const q = abs(size);
  if (q === 0n) return { ok: false, code: "flat", reason: "position is flat" };
  if (rules.lotSize <= 0n) return { ok: false, code: "bad-rules", reason: `invalid lotSize ${rules.lotSize}` };
  if (q % rules.lotSize !== 0n) {
    return { ok: false, code: "not-lot-multiple", reason: `size ${q} is not a multiple of lotSize ${rules.lotSize}; a full close is not representable` };
  }
  if (q < rules.minQuantity) return { ok: false, code: "below-minimum", reason: `size ${q} is below the market minimum ${rules.minQuantity}` };
  return { ok: true, quantity: q };
}

const floorTo = (x: bigint, step: bigint) => (x / step) * step;
const ceilTo = (x: bigint, step: bigint) => ((x + step - 1n) / step) * step;

/**
 * The IOC limit price: the worst price the close may fill at.
 *
 * Buy (closing a short): cap = best ask * (1 + slip), aligned DOWN to the tick.
 * Sell (closing a long): cap = best bid * (1 - slip), aligned UP to the tick.
 * Alignment always moves toward the touch, so the cap never exceeds the slippage limit.
 */
export function priceCap(p: { isBid: boolean; touch: bigint; slippageBps: number; tickSize: bigint; maxSlippageBps: number }): bigint {
  if (p.touch <= 0n) throw new Error("touch price must be > 0");
  if (p.tickSize <= 0n) throw new Error("tickSize must be > 0");
  if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > p.maxSlippageBps) {
    throw new Error(`slippageBps must be an integer in [0, ${p.maxSlippageBps}]`);
  }
  const slip = BigInt(p.slippageBps);
  if (p.isBid) {
    const cap = floorTo((p.touch * (BPS + slip)) / BPS, p.tickSize);
    if (cap < p.touch) throw new Error("buy cap aligned below the best ask: it would not cross");
    return cap;
  }
  const cap = ceilTo((p.touch * (BPS - slip)) / BPS, p.tickSize);
  if (cap > p.touch) throw new Error("sell cap aligned above the best bid: it would not cross");
  if (cap <= 0n) throw new Error("sell cap is not positive");
  return cap;
}

/** Opposite-side quantity resting at prices the cap accepts. */
export function depthWithinCap(levels: readonly Level[], isBid: boolean, cap: bigint): bigint {
  let sum = 0n;
  for (const l of levels) {
    if (isBid ? l.price <= cap : l.price >= cap) sum += l.quantity;
  }
  return sum;
}

/** Whether a cap still crosses the current touch. */
export function capCrosses(isBid: boolean, cap: bigint, touch: bigint): boolean {
  return isBid ? touch <= cap : touch >= cap;
}

/** |a - b| / b in whole bps, rounded up. */
export function deviationBps(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("reference must be > 0");
  const d = abs(a - b) * BPS;
  return (d + b - 1n) / b;
}

/**
 * Unrealized PnL in raw quote units (18 decimals): (mark - entry) * size / 10^baseDecimals.
 * Truncates toward zero, matching the SDK's unrealized figure. Excludes pending funding.
 */
export function unrealizedPnl(size: bigint, entry: bigint, mark: bigint, baseDecimals: number): bigint {
  return ((mark - entry) * size) / 10n ** BigInt(baseDecimals);
}

/** Exactly the fields that decide what is sent. A change to any one changes the fingerprint. */
export interface DecisionFields {
  chainId: number;
  pool: string;
  owner: string;
  operator: string;
  positionSize: bigint;
  isBid: boolean;
  orderType: number;
  quantity: bigint;
  price: bigint;
  selfMatchingOption: number;
}

export function fingerprint(f: DecisionFields): string {
  const canonical = JSON.stringify([
    f.chainId,
    f.pool.toLowerCase(),
    f.owner.toLowerCase(),
    f.operator.toLowerCase(),
    f.positionSize.toString(),
    f.isBid,
    f.orderType,
    f.quantity.toString(),
    f.price.toString(),
    f.selfMatchingOption,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export type Outcome = "CLOSED" | "PARTIAL" | "FLIPPED" | "UNCHANGED" | "INCREASED";

/** Classify the before/after signed sizes. Only CLOSED is a full close. */
export function classify(before: bigint, after: bigint): Outcome {
  if (after === 0n) return "CLOSED";
  if (after === before) return "UNCHANGED";
  if ((before > 0n && after < 0n) || (before < 0n && after > 0n)) return "FLIPPED";
  return abs(after) < abs(before) ? "PARTIAL" : "INCREASED";
}

/** The SDK's resting-order expiry (src/writer.ts farFutureNs): fifty years out, in ns. */
export function farFutureNs(nowMs = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + 50 * 365 * 24 * 3600) * 1_000_000_000n;
}

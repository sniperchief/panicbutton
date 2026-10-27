// Deterministic in-memory Chain for MOCKED tests. Nothing here touches a network.
// Each test scripts the venue: positions, books, permissions, and what a send does.

import { getAddress, type Account, type Address, type Hex } from "viem";
import { BroadcastError, type Chain, type CloseCall, type MarketInfo, type PositionChangeRead, type ReceiptRead, type SimResult } from "../server/engine/chain.js";
import { HIDEKI } from "../server/engine/config.js";
import type { Level } from "../server/engine/plan.js";

export const OWNER = getAddress("0x1111111111111111111111111111111111111111");
export const E18 = 10n ** 18n;

/** Live Hideki rules for ETH-PERP and BTC-PERP (read from market rows, Oct 2026). */
export const ETH: MarketInfo = {
  symbol: "ETH/USDso:USDso",
  display: "ETH-PERP",
  pool: getAddress("0xd6cb1dd58580b84d76068ac21594219ce03aeddf"),
  marginBank: getAddress(HIDEKI.marginBank),
  quoteToken: getAddress(HIDEKI.usdso),
  baseDecimals: 18,
  quoteDecimals: 18,
  tickSize: 10n ** 16n,
  lotSize: 10n ** 14n,
  minQuantity: 4n * 10n ** 15n,
  active: true,
};
export const BTC: MarketInfo = {
  symbol: "BTC/USDso:USDso",
  display: "BTC-PERP",
  pool: getAddress("0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0"),
  marginBank: getAddress(HIDEKI.marginBank),
  quoteToken: getAddress(HIDEKI.usdso),
  baseDecimals: 8,
  quoteDecimals: 18,
  tickSize: 10n ** 17n,
  lotSize: 1000n,
  minQuantity: 13000n,
  active: true,
};

export type SendBehavior =
  | { kind: "fill" }
  | { kind: "partial"; remaining: bigint }
  | { kind: "flip"; to: bigint }
  | { kind: "revert" }
  | { kind: "no-fill" }
  | { kind: "timeout" }
  | { kind: "throw"; message: string }
  | { kind: "broadcast-error"; message: string }
  | { kind: "fill-but-fills-say"; filled: bigint };

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join("|");

export class FakeChain implements Chain {
  chainIdValue: number = HIDEKI.chainId;
  block = 1000n;
  /** Sorted by display name, as LiveChain returns them. */
  marketList: MarketInfo[] = [BTC, ETH];
  wiring = new Map<string, { marginBank: Address; registry: Address }>();
  sizes = new Map<string, bigint>();
  entries = new Map<string, bigint>();
  /** Overrides for reads pinned to a block: key owner|pool|block. */
  sizesAtBlock = new Map<string, bigint>();
  books = new Map<string, { bids: Level[]; asks: Level[] }>();
  openOrders = new Map<string, number>();
  feeds = new Map<string, { ok: boolean; mark: bigint }>();
  grants = new Set<string>();
  balances = new Map<string, bigint>();
  gasPriceValue = 6_000_000_000n;
  simOverride?: (call: CloseCall) => SimResult;
  sendBehavior = new Map<string, SendBehavior>();
  indexer: "agree" | "disagree" | "unavailable" | "empty" = "agree";

  sends: CloseCall[] = [];
  simulations: { call: CloseCall; block?: bigint }[] = [];
  private receipts = new Map<string, ReceiptRead | null>();
  private txOwner = new Map<string, { owner: Address; sizeAfter: bigint }>();

  setPosition(owner: Address, pool: Address, size: bigint, entry = 2300n * E18) {
    this.sizes.set(key(owner, pool), size);
    this.entries.set(key(owner, pool), entry);
  }
  grant(pool: Address, owner: Address, operator: Address) {
    this.grants.add(key(pool, owner, operator));
  }
  revoke(pool: Address, owner: Address, operator: Address) {
    this.grants.delete(key(pool, owner, operator));
  }
  setBook(pool: Address, bids: Level[], asks: Level[]) {
    this.books.set(pool.toLowerCase(), { bids, asks });
  }
  setFeed(pool: Address, ok: boolean, mark: bigint) {
    this.feeds.set(pool.toLowerCase(), { ok, mark });
  }

  /** A healthy two-market venue with the owner long ETH and short BTC. */
  static healthy(operator: Address): FakeChain {
    const c = new FakeChain();
    c.setPosition(OWNER, ETH.pool, 4n * 10n ** 15n); // long 0.004 ETH
    c.setPosition(OWNER, BTC.pool, -13000n, 80_000n * E18); // short 0.00013 BTC
    c.setBook(
      ETH.pool,
      [{ price: 232792n * 10n ** 16n, quantity: 4n * E18 / 10n }, { price: 232785n * 10n ** 16n, quantity: E18 }],
      [{ price: 232817n * 10n ** 16n, quantity: 4n * E18 / 10n }],
    );
    c.setFeed(ETH.pool, true, 232800n * 10n ** 16n);
    c.setBook(BTC.pool, [{ price: 80_000n * E18, quantity: 100_000n }], [{ price: 80_010n * E18, quantity: 100_000n }]);
    c.setFeed(BTC.pool, true, 80_005n * E18);
    for (const m of c.marketList) c.grant(m.pool, OWNER, operator);
    c.balances.set(operator.toLowerCase(), E18);
    return c;
  }

  async chainId() {
    return this.chainIdValue;
  }
  async blockNumber() {
    return this.block;
  }
  async markets() {
    return this.marketList;
  }
  async poolWiring(pool: Address) {
    return this.wiring.get(pool.toLowerCase()) ?? { marginBank: getAddress(HIDEKI.marginBank), registry: getAddress(HIDEKI.operatorRegistry) };
  }
  async position(owner: Address, pool: Address, block?: bigint) {
    if (block !== undefined) {
      const pinned = this.sizesAtBlock.get(key(owner, pool, block.toString()));
      if (pinned !== undefined) return { size: pinned, avgEntryPrice: this.entries.get(key(owner, pool)) ?? 0n };
    }
    return { size: this.sizes.get(key(owner, pool)) ?? 0n, avgEntryPrice: this.entries.get(key(owner, pool)) ?? 0n };
  }
  async book(pool: Address, isBid: boolean) {
    const b = this.books.get(pool.toLowerCase()) ?? { bids: [], asks: [] };
    return isBid ? b.bids : b.asks;
  }
  async openOrderCount(owner: Address, pool: Address) {
    return this.openOrders.get(key(owner, pool)) ?? 0;
  }
  async feed(pool: Address) {
    return this.feeds.get(pool.toLowerCase()) ?? { ok: false, mark: 0n };
  }
  async isAuthorized(pool: Address, owner: Address, operator: Address) {
    return this.grants.has(key(pool, owner, operator));
  }
  async balance(address: Address) {
    return this.balances.get(address.toLowerCase()) ?? 0n;
  }
  async gasPrice() {
    return this.gasPriceValue;
  }
  /** Estimated liquidation prices by owner|pool; unset means none (as for most fixtures). */
  liqPrices = new Map<string, bigint>();
  setLiquidation(owner: Address, pool: Address, price: bigint) {
    this.liqPrices.set(key(owner, pool), price);
  }
  async liquidationPrice(owner: Address, market: MarketInfo) {
    return this.liqPrices.get(key(owner, market.pool)) ?? null;
  }
  async simulateClose(call: CloseCall, _gas: bigint, block?: bigint): Promise<SimResult> {
    this.simulations.push({ call, block });
    if (this.simOverride) return this.simOverride(call);
    if (!this.grants.has(key(call.pool, call.owner, call.operator))) return { ok: false, error: "OnlyApprovedContracts" };
    return { ok: true, orderId: 7n };
  }
  async sendClose(call: CloseCall, _gas: bigint, signer: Account): Promise<Hex> {
    if (signer.address !== call.operator) throw new Error("signer mismatch");
    this.sends.push(call);
    const behavior = this.sendBehavior.get(call.pool.toLowerCase()) ?? { kind: "fill" };
    if (behavior.kind === "throw") throw new Error(behavior.message);
    const hash = `0x${(this.sends.length).toString(16).padStart(64, "0")}` as Hex;
    if (behavior.kind === "broadcast-error") {
      this.receipts.set(hash, null);
      throw new BroadcastError(hash, behavior.message);
    }
    this.block += 1n;
    const k = key(call.owner, call.pool);
    const before = this.sizes.get(k) ?? 0n;
    let after = before;
    let filled = 0n;
    let status: "success" | "reverted" = "success";
    switch (behavior.kind) {
      case "fill":
        after = 0n;
        filled = call.quantity;
        break;
      case "fill-but-fills-say":
        after = 0n;
        filled = behavior.filled;
        break;
      case "partial":
        after = behavior.remaining;
        filled = (before < 0n ? -before : before) - (behavior.remaining < 0n ? -behavior.remaining : behavior.remaining);
        break;
      case "flip":
        after = behavior.to;
        filled = call.quantity;
        break;
      case "no-fill":
        break;
      case "revert":
        status = "reverted";
        break;
      case "timeout":
        this.receipts.set(hash, null);
        return hash;
    }
    this.sizes.set(k, after);
    this.txOwner.set(hash, { owner: call.owner, sizeAfter: after });
    this.receipts.set(hash, {
      status,
      blockNumber: this.block,
      gasUsed: 1_500_000n,
      orderId: status === "success" ? 7n : undefined,
      fills: filled > 0n ? [{ quantityFilled: filled, fillPrice: call.price }] : [],
    });
    return hash;
  }
  async waitReceipt(hash: Hex) {
    return this.receipts.get(hash) ?? null;
  }
  /** A receipt that turns up after the engine stopped waiting. */
  deliverLateReceipt(hash: Hex, status: "success" | "reverted" = "success") {
    this.block += 1n;
    this.receipts.set(hash, { status, blockNumber: this.block, gasUsed: 1_500_000n, fills: [] });
  }
  pendingByAddress = new Map<string, number>();
  async pendingTxCount(address: Address) {
    return this.pendingByAddress.get(address.toLowerCase()) ?? 0;
  }
  async positionChanges(hash: Hex): Promise<PositionChangeRead[] | null> {
    if (this.indexer === "unavailable") return null;
    if (this.indexer === "empty") return [];
    const t = this.txOwner.get(hash);
    if (!t) return [];
    return [{ account: t.owner.toLowerCase(), kind: this.indexer === "agree" ? "CLOSE" : "REDUCE", sizeAfter: this.indexer === "agree" ? 0n : 1n }];
  }
}

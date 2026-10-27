// The engine's only view of the chain. LiveChain (live-chain.ts) implements it with
// viem + the markets SDK; tests implement it with a deterministic fake.

import type { Account, Address, Hex } from "viem";
import type { Level } from "./plan.js";

export interface MarketInfo {
  /** SDK symbol, e.g. "ETH/USDso:USDso". */
  symbol: string;
  /** App-style name, e.g. "ETH-PERP". */
  display: string;
  pool: Address;
  marginBank: Address;
  quoteToken: Address;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
  active: boolean;
}

export interface PositionRead {
  /** Signed raw base units: positive long, negative short, zero flat. */
  size: bigint;
  avgEntryPrice: bigint;
}

export interface FeedRead {
  /** The pool's own verdict (tryGetMarkPrice) and a non-zero mark. */
  ok: boolean;
  mark: bigint;
}

export interface CloseCall {
  pool: Address;
  owner: Address;
  operator: Address;
  isBid: boolean;
  price: bigint;
  quantity: bigint;
}

export interface SimResult {
  ok: boolean;
  /** Decoded revert name when the call reverted. */
  error?: string;
  orderId?: bigint;
}

export interface Fill {
  quantityFilled: bigint;
  fillPrice: bigint;
}

export interface ReceiptRead {
  status: "success" | "reverted";
  blockNumber: bigint;
  gasUsed: bigint;
  orderId?: bigint;
  fills: Fill[];
}

export interface PositionChangeRead {
  account: string;
  kind: string;
  sizeAfter: bigint;
}

/**
 * Thrown by sendClose when the transaction was already signed (so its hash is known)
 * but broadcasting failed. It may still have reached the network: treat as UNKNOWN.
 */
export class BroadcastError extends Error {
  constructor(
    readonly hash: Hex,
    message: string,
  ) {
    super(message);
  }
}

export interface Chain {
  chainId(): Promise<number>;
  blockNumber(): Promise<bigint>;
  markets(): Promise<MarketInfo[]>;
  poolWiring(pool: Address): Promise<{ marginBank: Address; registry: Address }>;
  position(owner: Address, pool: Address, block?: bigint): Promise<PositionRead>;
  book(pool: Address, isBid: boolean, levels: bigint, block?: bigint): Promise<Level[]>;
  openOrderCount(owner: Address, pool: Address, block?: bigint): Promise<number>;
  feed(pool: Address): Promise<FeedRead>;
  isAuthorized(pool: Address, owner: Address, operator: Address, selector: Hex, block?: bigint): Promise<boolean>;
  balance(address: Address): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  liquidationPrice(owner: Address, market: MarketInfo): Promise<bigint | null>;
  simulateClose(call: CloseCall, gas: bigint, block?: bigint): Promise<SimResult>;
  /**
   * Signs locally, then broadcasts. A plain Error means nothing was signed or sent;
   * BroadcastError means it was signed and may have been broadcast.
   */
  sendClose(call: CloseCall, gas: bigint, signer: Account): Promise<Hex>;
  /** Transactions from this address the node has seen but not yet mined (pending nonce - latest nonce). */
  pendingTxCount(address: Address): Promise<number>;
  /** null = no receipt within the timeout (outcome unknown). */
  waitReceipt(hash: Hex, pool: Address, timeoutMs: number): Promise<ReceiptRead | null>;
  /** Indexer rows for one transaction; null when the indexer cannot be read. */
  positionChanges(txHash: Hex): Promise<PositionChangeRead[] | null>;
}

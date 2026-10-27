// Chain implementation over viem + @somnia-chain/markets-sdk 0.32.1.
// Every read and ABI here was exercised in experiments/exp0 against Hideki v2.

import {
  SomniaMarkets,
  SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  contractErrorsAbi,
  decodePlaceOrder,
} from "@somnia-chain/markets-sdk";
import { hidekiTestnet } from "@somnia-chain/markets-sdk/chains";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  zeroAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { BroadcastError, type Chain, type CloseCall, type MarketInfo, type PositionChangeRead, type ReceiptRead, type SimResult } from "./chain.js";
import { HIDEKI, assertSdkMatchesPins } from "./config.js";
import { ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, farFutureNs, type Level } from "./plan.js";

const ABI = [
  ...parseAbi([
    // Operator entry point (bot kit packages/perp-core/src/operator.ts:48); selector tested == 0x80054449.
    "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)",
    "function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)",
    "function getOperatorPermissionsRegistry() view returns (address)",
    "function marginBank() view returns (address)",
    // SDK src/readsAbi.ts:34 (OrderBook base, shared by perp pools)
    "function getBookLevels(bool isBid, uint64 numLevels) view returns ((uint256 price, uint256 quantity)[])",
    // SDK src/readsAbi.ts:302 (MarginBank)
    "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  ]),
  ...contractErrorsAbi,
] as const;

const MARKETS_TTL_MS = 5 * 60_000;

/**
 * Retry an idempotent READ on transport failures (the public Hideki RPC times out
 * under bursts). Never used for sending.
 */
export async function retryRead<T>(fn: () => Promise<T>, attempts = 3, baseMs = 400): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 2 ** i));
    }
  }
  throw new Error(`Hideki RPC did not answer after ${attempts} attempts (${decodeRevert(last)})`);
}

/** True when the error is a decoded contract revert rather than a transport failure. */
function isRevert(e: unknown): boolean {
  const err = e as { walk?: (fn: (x: unknown) => boolean) => unknown };
  return Boolean(err.walk?.((x) => (x as { name?: string })?.name === "ContractFunctionRevertedError"));
}

function orderArgs(c: CloseCall) {
  return [c.owner, c.isBid, 0n, c.price, c.quantity, farFutureNs(), ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, zeroAddress, 0n] as const;
}

/** The named contract error when there is one, else the first line of the message. */
export function decodeRevert(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; walk?: (fn: (x: unknown) => boolean) => unknown };
  const named = err.walk?.((x) => typeof (x as { data?: { errorName?: string } })?.data?.errorName === "string") as
    | { data: { errorName: string } }
    | undefined;
  if (named) return named.data.errorName;
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 200);
}

export class LiveChain implements Chain {
  readonly pc: PublicClient;
  readonly exchange: SomniaMarkets;
  private marketCache?: { at: number; markets: MarketInfo[] };
  private wiringCache = new Map<string, { marginBank: Address; registry: Address }>();

  constructor() {
    assertSdkMatchesPins();
    // Multicall3 (canonical address, predeployed on Hideki v2 per the SDK chain definition)
    // folds the per-market sweeps into one eth_call per block tag.
    this.pc = createPublicClient({
      chain: hidekiTestnet,
      transport: http(HIDEKI.rpcUrl),
      batch: { multicall: true },
    }) as PublicClient;
    // No account: the SDK stays read-only. Writes go through viem with the operator key.
    this.exchange = new SomniaMarkets({
      chain: hidekiTestnet,
      wsRpcUrl: HIDEKI.wsRpcUrl,
      indexerUrl: HIDEKI.indexerUrl,
      addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
    });
  }

  async close(): Promise<void> {
    await Promise.race([Promise.resolve(this.exchange.close?.()), new Promise((r) => setTimeout(r, 3000))]);
  }

  private chainIdCache?: { at: number; id: number };
  /** The RPC URL is pinned, so a verified answer is reused briefly (one round trip saved per prepare). */
  async chainId() {
    if (this.chainIdCache && Date.now() - this.chainIdCache.at < 60_000) return this.chainIdCache.id;
    const id = await retryRead(() => this.pc.getChainId());
    this.chainIdCache = { at: Date.now(), id };
    return id;
  }

  blockNumber() {
    return retryRead(() => this.pc.getBlockNumber());
  }

  async markets(): Promise<MarketInfo[]> {
    if (this.marketCache && Date.now() - this.marketCache.at < MARKETS_TTL_MS) return this.marketCache.markets;
    const loaded = await retryRead(() => this.exchange.loadMarkets(Boolean(this.marketCache)));
    const markets = Object.values(loaded)
      .filter((m) => m.type === "swap")
      .map((m): MarketInfo => {
        const i = m.info as Record<string, unknown>;
        return {
          symbol: m.symbol,
          display: `${m.symbol.split("/")[0]}-PERP`,
          pool: getAddress(String(i.poolAddress)),
          marginBank: getAddress(String(i.marginBank)),
          quoteToken: getAddress(String(i.quoteToken)),
          baseDecimals: Number(i.baseDecimals),
          quoteDecimals: Number(i.quoteDecimals),
          tickSize: BigInt(String(i.tickSize)),
          lotSize: BigInt(String(i.lotSize)),
          minQuantity: BigInt(String(i.minQuantity)),
          active: m.active,
        };
      })
      .sort((a, b) => a.display.localeCompare(b.display));
    this.marketCache = { at: Date.now(), markets };
    return markets;
  }

  private read<T>(address: Address, functionName: string, args: readonly unknown[] = [], block?: bigint): Promise<T> {
    return retryRead(
      () =>
        this.pc.readContract({
          address,
          abi: ABI,
          functionName: functionName as never,
          args: args as never,
          ...(block !== undefined ? { blockNumber: block } : {}),
        }) as Promise<T>,
    );
  }

  async poolWiring(pool: Address) {
    const hit = this.wiringCache.get(pool);
    if (hit) return hit;
    const [marginBank, registry] = await Promise.all([
      this.read<Address>(pool, "marginBank"),
      this.read<Address>(pool, "getOperatorPermissionsRegistry"),
    ]);
    const wiring = { marginBank: getAddress(marginBank), registry: getAddress(registry) };
    this.wiringCache.set(pool, wiring);
    return wiring;
  }

  async position(owner: Address, pool: Address, block?: bigint) {
    const p = await this.read<{ size: bigint; avgEntryPrice: bigint }>(HIDEKI.marginBank, "getPosition", [owner, pool], block);
    return { size: p.size, avgEntryPrice: p.avgEntryPrice };
  }

  async book(pool: Address, isBid: boolean, levels: bigint, block?: bigint): Promise<Level[]> {
    const raw = await this.read<readonly Level[]>(pool, "getBookLevels", [isBid, levels], block);
    return raw.map((l) => ({ price: l.price, quantity: l.quantity }));
  }

  async openOrderCount(owner: Address, pool: Address, block?: bigint) {
    const res = await retryRead(() => this.exchange.client.getOpenOrdersOnchain([pool], owner, block !== undefined ? { blockNumber: block } : undefined));
    return res.orders.length;
  }

  async feed(pool: Address) {
    const f = await retryRead(() => this.exchange.client.getPerpFeedStatus(pool));
    return { ok: f.markPriceOk && f.markPrice > 0n, mark: f.markPrice };
  }

  isAuthorized(pool: Address, owner: Address, operator: Address, selector: Hex, block?: bigint) {
    return this.read<boolean>(pool, "isOperatorAuthorized", [owner, operator, selector], block);
  }

  balance(address: Address) {
    return retryRead(() => this.pc.getBalance({ address }));
  }

  gasPrice() {
    return retryRead(() => this.pc.getGasPrice());
  }

  async liquidationPrice(owner: Address, market: MarketInfo) {
    try {
      return await this.exchange.client.getLiquidationPrice({ marginBank: market.marginBank, pool: market.pool, account: owner });
    } catch {
      return null;
    }
  }

  async simulateClose(call: CloseCall, gas: bigint, block?: bigint): Promise<SimResult> {
    // A contract revert is an answer; only transport failures are retried.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.simulateOnce(call, gas, block);
      } catch (e) {
        if (isRevert(e) || attempt >= 3) return { ok: false, error: decodeRevert(e) };
        await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt - 1)));
      }
    }
  }

  private async simulateOnce(call: CloseCall, gas: bigint, block?: bigint): Promise<SimResult> {
    const sim = await this.pc.simulateContract({
      address: call.pool,
      abi: ABI,
      functionName: "placeOrderFor",
      args: orderArgs(call),
      account: call.operator,
      gas,
      ...(block !== undefined ? { blockNumber: block } : {}),
    });
    const [success, orderId] = sim.result as readonly [boolean, bigint];
    return success ? { ok: true, orderId } : { ok: false, error: "placeOrderFor returned success=false" };
  }

  async sendClose(call: CloseCall, gas: bigint, signer: Account): Promise<Hex> {
    if (signer.address !== call.operator) throw new Error("signer is not the session operator");
    const wallet = createWalletClient({ account: signer, chain: hidekiTestnet, transport: http(HIDEKI.rpcUrl) });
    // Sign locally first so the hash is known before anything leaves this process.
    const request = await wallet.prepareTransactionRequest({
      account: signer,
      chain: hidekiTestnet,
      to: call.pool,
      data: encodeFunctionData({ abi: ABI, functionName: "placeOrderFor", args: orderArgs(call) }),
      gas,
    });
    const serialized = await wallet.signTransaction(request as never);
    const hash = keccak256(serialized);
    try {
      return await this.pc.sendRawTransaction({ serializedTransaction: serialized });
    } catch (e) {
      throw new BroadcastError(hash, decodeRevert(e));
    }
  }

  async pendingTxCount(address: Address): Promise<number> {
    const [pending, latest] = await Promise.all([
      retryRead(() => this.pc.getTransactionCount({ address, blockTag: "pending" })),
      retryRead(() => this.pc.getTransactionCount({ address, blockTag: "latest" })),
    ]);
    return Math.max(0, pending - latest);
  }

  async waitReceipt(hash: Hex, pool: Address, timeoutMs: number): Promise<ReceiptRead | null> {
    let receipt;
    try {
      receipt = await this.pc.waitForTransactionReceipt({ hash, timeout: timeoutMs });
    } catch {
      return null;
    }
    const decoded = receipt.status === "success" ? decodePlaceOrder(receipt, pool) : { orderId: undefined, fills: [] };
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      orderId: decoded.orderId,
      fills: decoded.fills.map((f) => ({ quantityFilled: f.quantityFilled, fillPrice: f.fillPrice })),
    };
  }

  async positionChanges(txHash: Hex): Promise<PositionChangeRead[] | null> {
    try {
      const rows = await this.exchange.client.listPerpPositionChanges({ txHash });
      return rows.map((r) => ({ account: r.account, kind: r.kind, sizeAfter: r.sizeAfter }));
    } catch {
      return null;
    }
  }
}

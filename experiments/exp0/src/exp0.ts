// Experiment 0: prove an app-linked operator key can close one Hideki perp position.
//
//   npx tsx src/exp0.ts preflight                       read-only connectivity + market checks
//   npx tsx src/exp0.ts dry-run                         read-only plan + eth_call simulation, writes runs/plan-*.json
//   npx tsx src/exp0.ts execute --plan <file> --confirm <fingerprint>   SENDS ONE TRANSACTION
//   npx tsx src/exp0.ts verify-revoked [--simulate]     read-only revocation check
//
// Env: OWNER_ADDRESS, OPERATOR_ADDRESS, PERP_SYMBOL (e.g. ETH), MAX_SLIPPAGE_BPS (default 50).
// execute only: OPERATOR_PRIVATE_KEY. It is read from the environment, checked
// against OPERATOR_ADDRESS, and never printed, logged or written.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseAbi,
  zeroAddress,
  type Account,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HIDEKI, assertSdkMatchesPins } from "./config.js";
import {
  MAX_SLIPPAGE_BPS_CEILING,
  ORDER_TYPE_IOC,
  SELECTORS,
  SELF_MATCH_CANCEL_TAKER,
  abs,
  classify,
  closeQuantity,
  closeSide,
  depthWithinCap,
  deviationBps,
  farFutureNs,
  fingerprint,
  placeOrderForSelector,
  priceCap,
  type DecisionFields,
  type Level,
} from "./plan.js";

/** The SDK's perp order gas (TraderConfig.gas). Somnia bills gas used, not the limit. */
const ORDER_GAS = 10_000_000n;
const BOOK_LEVELS = 20n;
/** A plan older than this must be re-made with dry-run. */
const MAX_PLAN_AGE_MS = 15 * 60 * 1000;
const RUNS_DIR = join(process.cwd(), "runs");

const ABI = [
  ...parseAbi([
    // Operator entry point: bot kit packages/perp-core/src/operator.ts:48. Selector unit-tested == 0x80054449.
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

// ---------------------------------------------------------------------------
// env + clients

interface Env {
  owner: Address;
  operator: Address;
  symbol: string;
  slippageBps: number;
}

function readEnv(): Env {
  const need = (k: string) => {
    const v = (process.env[k] ?? "").trim();
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const addr = (k: string) => {
    const v = need(k);
    if (!isAddress(v)) throw new Error(`${k} is not an address`);
    return getAddress(v);
  };
  const owner = addr("OWNER_ADDRESS");
  const operator = addr("OPERATOR_ADDRESS");
  if (owner === operator) throw new Error("OWNER_ADDRESS and OPERATOR_ADDRESS must differ");
  const symbol = need("PERP_SYMBOL").toUpperCase().replace(/-PERP$/, "");
  const slipRaw = (process.env.MAX_SLIPPAGE_BPS ?? "50").trim();
  const slippageBps = Number(slipRaw);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS_CEILING) {
    throw new Error(`MAX_SLIPPAGE_BPS must be an integer 0..${MAX_SLIPPAGE_BPS_CEILING}`);
  }
  return { owner, operator, symbol, slippageBps };
}

interface Ctx {
  pc: PublicClient;
  exchange: SomniaMarkets;
}

function makeCtx(): Ctx {
  assertSdkMatchesPins();
  const pc = createPublicClient({ chain: hidekiTestnet, transport: http(HIDEKI.rpcUrl) }) as PublicClient;
  // No account: the SDK stays read-only. Writes go through viem with the operator key.
  const exchange = new SomniaMarkets({
    chain: hidekiTestnet,
    wsRpcUrl: HIDEKI.wsRpcUrl,
    indexerUrl: HIDEKI.indexerUrl,
    addresses: SOMNIA_HIDEKI_TESTNET_ADDRESSES,
  });
  return { pc, exchange };
}

async function closeCtx(ctx: Ctx) {
  await Promise.race([Promise.resolve(ctx.exchange.close?.()), new Promise((r) => setTimeout(r, 3000))]);
}

// ---------------------------------------------------------------------------
// reads

interface MarketInfo {
  symbol: string;
  pool: Address;
  marginBank: Address;
  quoteToken: Address;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: bigint;
  lotSize: bigint;
  minQuantity: bigint;
}

async function findMarket(ctx: Ctx, symbol: string): Promise<MarketInfo> {
  const markets = await ctx.exchange.loadMarkets();
  const hits = Object.values(markets).filter((m) => m.type === "swap" && m.symbol.split("/")[0]?.toUpperCase() === symbol);
  if (hits.length !== 1) {
    const names = Object.values(markets).filter((m) => m.type === "swap").map((m) => m.symbol.split("/")[0]);
    throw new Error(`PERP_SYMBOL=${symbol} matched ${hits.length} perp markets. Available: ${names.join(", ")}`);
  }
  const m = hits[0]!;
  const i = m.info as Record<string, unknown>;
  return {
    symbol: m.symbol,
    pool: getAddress(String(i.poolAddress)),
    marginBank: getAddress(String(i.marginBank)),
    quoteToken: getAddress(String(i.quoteToken)),
    baseDecimals: Number(i.baseDecimals),
    quoteDecimals: Number(i.quoteDecimals),
    tickSize: BigInt(String(i.tickSize)),
    lotSize: BigInt(String(i.lotSize)),
    minQuantity: BigInt(String(i.minQuantity)),
  };
}

interface Snapshot {
  chainId: number;
  block: bigint;
  market: MarketInfo;
  poolMarginBank: Address;
  poolRegistry: Address;
  positionSize: bigint;
  avgEntryPrice: bigint;
  sdkHeadSize: bigint;
  latestSize: bigint;
  restingOrders: { orderId: bigint; isBid: boolean; price: bigint; quantityRemaining: bigint }[];
  bids: Level[];
  asks: Level[];
  markOk: boolean;
  mark: bigint;
  auth: { place: boolean; cancel: boolean; reduce: boolean };
  operatorBalance: bigint;
  gasPrice: bigint;
  pendingStops: number | "unavailable";
}

async function snapshot(ctx: Ctx, env: Env): Promise<Snapshot> {
  const { pc, exchange } = ctx;
  const chainId = await pc.getChainId();
  if (chainId !== HIDEKI.chainId) throw new Error(`RPC chain id ${chainId}, expected ${HIDEKI.chainId}`);
  const market = await findMarket(ctx, env.symbol);
  const block = await pc.getBlockNumber();
  const at = { blockNumber: block } as const;
  const read = <T>(address: Address, functionName: string, args: readonly unknown[] = []) =>
    pc.readContract({ address, abi: ABI, functionName: functionName as never, args: args as never, ...at }) as Promise<T>;

  const [poolMarginBank, poolRegistry, pos, bidsRaw, asksRaw, place, cancel, reduce] = await Promise.all([
    read<Address>(market.pool, "marginBank"),
    read<Address>(market.pool, "getOperatorPermissionsRegistry"),
    read<{ size: bigint; avgEntryPrice: bigint }>(HIDEKI.marginBank, "getPosition", [env.owner, market.pool]),
    read<readonly Level[]>(market.pool, "getBookLevels", [true, BOOK_LEVELS]),
    read<readonly Level[]>(market.pool, "getBookLevels", [false, BOOK_LEVELS]),
    read<boolean>(market.pool, "isOperatorAuthorized", [env.owner, env.operator, SELECTORS.placeOrderFor]),
    read<boolean>(market.pool, "isOperatorAuthorized", [env.owner, env.operator, SELECTORS.cancelOrderFor]),
    read<boolean>(market.pool, "isOperatorAuthorized", [env.owner, env.operator, SELECTORS.reduceOrderFor]),
  ]);
  const [open, feed, sdkPos, operatorBalance, gasPrice] = await Promise.all([
    exchange.client.getOpenOrdersOnchain([market.pool], env.owner, { blockNumber: block }),
    exchange.client.getPerpFeedStatus(market.pool),
    exchange.client.getPerpPosition({ marginBank: HIDEKI.marginBank, account: env.owner, pool: market.pool }),
    pc.getBalance({ address: env.operator }),
    pc.getGasPrice(),
  ]);
  let pendingStops: number | "unavailable" = "unavailable";
  try {
    const stops = await exchange.client.listPerpStopOrders({
      account: env.owner.toLowerCase(),
      pool: market.pool.toLowerCase(),
      status: ["PENDING"],
    });
    pendingStops = stops.length;
  } catch {
    // indexer-only and informational
  }
  const latest = (await pc.readContract({
    address: HIDEKI.marginBank,
    abi: ABI,
    functionName: "getPosition",
    args: [env.owner, market.pool],
  })) as { size: bigint };

  return {
    chainId,
    block,
    market,
    poolMarginBank: getAddress(poolMarginBank),
    poolRegistry: getAddress(poolRegistry),
    positionSize: pos.size,
    avgEntryPrice: pos.avgEntryPrice,
    sdkHeadSize: sdkPos.size,
    latestSize: latest.size,
    restingOrders: open.orders.map((o) => ({
      orderId: o.orderId,
      isBid: o.isBid,
      price: o.price,
      quantityRemaining: o.quantityRemaining,
    })),
    bids: [...bidsRaw],
    asks: [...asksRaw],
    markOk: feed.markPriceOk && feed.markPrice > 0n,
    mark: feed.markPrice,
    auth: { place, cancel, reduce },
    operatorBalance,
    gasPrice,
    pendingStops,
  };
}

/** Configuration checks that must hold for any plan. */
function structuralProblems(s: Snapshot): string[] {
  const p: string[] = [];
  if (s.market.marginBank !== getAddress(HIDEKI.marginBank)) p.push(`market row marginBank ${s.market.marginBank} != pinned`);
  if (s.poolMarginBank !== getAddress(HIDEKI.marginBank)) p.push(`pool.marginBank() ${s.poolMarginBank} != pinned`);
  if (s.poolRegistry !== getAddress(HIDEKI.operatorRegistry)) p.push(`pool registry ${s.poolRegistry} != pinned`);
  if (s.market.quoteToken !== getAddress(HIDEKI.usdso)) p.push(`quoteToken ${s.market.quoteToken} != USDso`);
  if (s.market.quoteDecimals !== 18) p.push(`quoteDecimals ${s.market.quoteDecimals}: 18-decimal price rule unproven here`);
  if (s.market.tickSize <= 0n || s.market.lotSize <= 0n) p.push("invalid tick/lot");
  if (placeOrderForSelector() !== SELECTORS.placeOrderFor) p.push("placeOrderFor ABI selector mismatch");
  return p;
}

// ---------------------------------------------------------------------------
// simulation

function decodeRevert(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; walk?: (fn: (x: unknown) => boolean) => unknown };
  const named = err.walk?.((x) => typeof (x as { data?: { errorName?: string } })?.data?.errorName === "string") as
    | { data: { errorName: string; args?: readonly unknown[] } }
    | undefined;
  if (named) return `${named.data.errorName}${named.data.args?.length ? `(${named.data.args.join(", ")})` : ""}`;
  return (err.shortMessage ?? err.message ?? String(e)).split("\n")[0]!.slice(0, 200);
}

function orderArgs(owner: Address, f: { isBid: boolean; price: bigint; quantity: bigint }) {
  return [owner, f.isBid, 0n, f.price, f.quantity, farFutureNs(), ORDER_TYPE_IOC, SELF_MATCH_CANCEL_TAKER, zeroAddress, 0n] as const;
}

async function simulate(
  pc: PublicClient,
  pool: Address,
  account: Address | Account,
  args: ReturnType<typeof orderArgs>,
  blockNumber?: bigint,
) {
  try {
    const sim = await pc.simulateContract({
      address: pool,
      abi: ABI,
      functionName: "placeOrderFor",
      args,
      account,
      gas: ORDER_GAS,
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    });
    const [success, orderId] = sim.result as readonly [boolean, bigint];
    return { ok: success === true, success, orderId, request: sim.request, error: undefined as string | undefined };
  } catch (e) {
    return { ok: false, success: false, orderId: undefined, request: undefined, error: decodeRevert(e) };
  }
}

// ---------------------------------------------------------------------------
// plan

interface PlanFile {
  version: 1;
  createdAt: string;
  status: "READY" | "BLOCKED";
  blockers: string[];
  warnings: string[];
  fingerprint: string;
  slippageBps: number;
  decision: Record<keyof DecisionFields, string | number | boolean>;
  context: Record<string, string | number | boolean | null>;
}

const toStr = (f: DecisionFields): PlanFile["decision"] => ({
  chainId: f.chainId,
  pool: f.pool,
  owner: f.owner,
  operator: f.operator,
  positionSize: f.positionSize.toString(),
  isBid: f.isBid,
  orderType: f.orderType,
  quantity: f.quantity.toString(),
  price: f.price.toString(),
  selfMatchingOption: f.selfMatchingOption,
});

const fromStr = (d: PlanFile["decision"]): DecisionFields => ({
  chainId: Number(d.chainId),
  pool: String(d.pool),
  owner: String(d.owner),
  operator: String(d.operator),
  positionSize: BigInt(String(d.positionSize)),
  isBid: d.isBid === true,
  orderType: Number(d.orderType),
  quantity: BigInt(String(d.quantity)),
  price: BigInt(String(d.price)),
  selfMatchingOption: Number(d.selfMatchingOption),
});

async function dryRun(ctx: Ctx, env: Env): Promise<PlanFile> {
  const s = await snapshot(ctx, env);
  const blockers = structuralProblems(s);
  const warnings: string[] = [];
  const m = s.market;
  const px = (v: bigint) => formatUnits(v, 18);
  const qty = (v: bigint) => formatUnits(v, m.baseDecimals);

  if (s.sdkHeadSize !== s.positionSize || s.latestSize !== s.positionSize) {
    blockers.push(`position changed during preparation (block ${s.block}: ${s.positionSize}, head: ${s.latestSize}, sdk: ${s.sdkHeadSize})`);
  }
  if (s.restingOrders.length > 0) {
    blockers.push(
      `owner has ${s.restingOrders.length} resting order(s) on this pool; they reduce the purely-reducing capacity. ` +
        "Cancelling them needs separate approval",
    );
  }
  if (s.pendingStops !== "unavailable" && s.pendingStops > 0) {
    warnings.push(`${s.pendingStops} pending stop(s) on this pool; after a close they drop as ReduceOnlyNoPosition and keep 0.15 STT locked until cancelled in the app`);
  }
  if (s.pendingStops === "unavailable") warnings.push("pending stops could not be read (indexer)");
  if (!s.markOk) blockers.push("mark feed is not live (pool's tryGetMarkPrice verdict)");
  if (!s.auth.place) blockers.push("operator is NOT authorized for placeOrderFor on this pool (link it in the app: Link a bot -> Perps)");
  if (!s.auth.cancel) warnings.push("operator not authorized for cancelOrderFor (not needed for this IOC close)");

  let decision: DecisionFields | undefined;
  let depth = 0n;
  let touch = 0n;
  let touchVsMarkBps = 0n;
  if (s.positionSize === 0n) {
    blockers.push("owner has no position in this market");
  } else {
    const { isBid } = closeSide(s.positionSize);
    const q = closeQuantity(s.positionSize, m);
    const book = isBid ? s.asks : s.bids;
    if (!q.ok) blockers.push(q.reason);
    if (book.length === 0) blockers.push(`order book has no ${isBid ? "asks" : "bids"} to close against`);
    if (q.ok && book.length > 0) {
      touch = book[0]!.price;
      try {
        const cap = priceCap({ isBid, touch, slippageBps: env.slippageBps, tickSize: m.tickSize });
        depth = depthWithinCap(book, isBid, cap);
        if (depth < q.quantity) blockers.push(`book depth within cap ${qty(depth)} < close quantity ${qty(q.quantity)} (top ${BOOK_LEVELS} levels)`);
        if (s.markOk) {
          touchVsMarkBps = deviationBps(touch, s.mark);
          if (touchVsMarkBps > BigInt(env.slippageBps)) {
            blockers.push(`touch ${px(touch)} is ${touchVsMarkBps} bps from mark ${px(s.mark)}, beyond the ${env.slippageBps} bps limit`);
          }
        }
        decision = {
          chainId: s.chainId,
          pool: m.pool,
          owner: env.owner,
          operator: env.operator,
          positionSize: s.positionSize,
          isBid,
          orderType: ORDER_TYPE_IOC,
          quantity: q.quantity,
          price: cap,
          selfMatchingOption: SELF_MATCH_CANCEL_TAKER,
        };
      } catch (e) {
        blockers.push(`cannot price the close: ${(e as Error).message}`);
      }
    }
  }

  let sim: Awaited<ReturnType<typeof simulate>> | undefined;
  if (decision) {
    sim = await simulate(ctx.pc, m.pool, env.operator, orderArgs(env.owner, decision), s.block);
    if (!sim.ok) blockers.push(`simulation failed: ${sim.error ?? `success=${sim.success}`}`);
  }
  const gasBudget = ORDER_GAS * s.gasPrice;
  if (s.operatorBalance < gasBudget) {
    blockers.push(`operator STT ${formatEther(s.operatorBalance)} < ${formatEther(gasBudget)} needed for a ${ORDER_GAS} gas limit`);
  }

  const plan: PlanFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    status: blockers.length === 0 && decision ? "READY" : "BLOCKED",
    blockers,
    warnings,
    fingerprint: decision ? fingerprint(decision) : "",
    slippageBps: env.slippageBps,
    decision: decision ? toStr(decision) : ({} as PlanFile["decision"]),
    context: {
      network: "Hideki v2",
      rpc: HIDEKI.rpcUrl,
      block: s.block.toString(),
      market: m.symbol,
      pool: m.pool,
      baseDecimals: m.baseDecimals,
      tickSize: m.tickSize.toString(),
      lotSize: m.lotSize.toString(),
      minQuantity: m.minQuantity.toString(),
      positionSide: s.positionSize === 0n ? "flat" : s.positionSize > 0n ? "long" : "short",
      positionHuman: qty(abs(s.positionSize)),
      avgEntryPrice: px(s.avgEntryPrice),
      mark: s.markOk ? px(s.mark) : null,
      touch: touch ? px(touch) : null,
      touchVsMarkBps: touchVsMarkBps.toString(),
      priceCapHuman: decision ? px(decision.price) : null,
      depthWithinCap: qty(depth),
      authPlace: s.auth.place,
      authCancel: s.auth.cancel,
      authReduce: s.auth.reduce,
      operatorStt: formatEther(s.operatorBalance),
      gasPriceWei: s.gasPrice.toString(),
      restingOrders: s.restingOrders.length,
      pendingStops: String(s.pendingStops),
      simulation: sim ? (sim.ok ? `ok success=true orderId=${sim.orderId}` : `FAILED ${sim.error ?? ""}`) : "not run",
    },
  };
  return plan;
}

function printPlan(plan: PlanFile, file?: string) {
  const c = plan.context;
  const d = plan.decision;
  const lines = [
    "",
    "=== Experiment 0 dry-run ===",
    `network        ${c.network}, chain ${d.chainId ?? HIDEKI.chainId}, block ${c.block}`,
    `market         ${c.market}  pool ${c.pool}`,
    `rules          tick ${c.tickSize}  lot ${c.lotSize}  minQty ${c.minQuantity}  baseDecimals ${c.baseDecimals}`,
    `position       ${c.positionSide} ${c.positionHuman}  raw ${d.positionSize ?? "0"}  entry ${c.avgEntryPrice}`,
    `market data    mark ${c.mark}  touch ${c.touch}  (${c.touchVsMarkBps} bps from mark)`,
    `proposed order placeOrderFor(owner=${d.owner ?? "-"}, isBid=${d.isBid ?? "-"} [${d.isBid ? "BUY" : "SELL"}], qty=${d.quantity ?? "-"}, price=${d.price ?? "-"} [${c.priceCapHuman}], IOC(2), selfMatch=0)`,
    `slippage cap   ${plan.slippageBps} bps from touch; depth within cap ${c.depthWithinCap}`,
    `operator       ${d.operator ?? "-"}  place=${c.authPlace} cancel=${c.authCancel} reduce=${c.authReduce}  STT ${c.operatorStt}`,
    `resting/stops  ${c.restingOrders} resting order(s), ${c.pendingStops} pending stop(s)`,
    `simulation     ${c.simulation}`,
    `STATUS         ${plan.status}${plan.fingerprint ? `  fingerprint ${plan.fingerprint}` : ""}`,
    ...plan.blockers.map((b) => `  BLOCKER: ${b}`),
    ...plan.warnings.map((w) => `  warning: ${w}`),
  ];
  if (file) lines.push(`plan file      ${file}`);
  console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// execute

function loadOperatorKey(expected: Address): Account {
  const raw = (process.env.OPERATOR_PRIVATE_KEY ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Error("OPERATOR_PRIVATE_KEY is missing or malformed (value not shown)");
  const account = privateKeyToAccount(raw as `0x${string}`);
  if (account.address !== expected) throw new Error("OPERATOR_PRIVATE_KEY does not belong to OPERATOR_ADDRESS (value not shown)");
  return account;
}

async function execute(ctx: Ctx, env: Env, planPath: string, confirm: string) {
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanFile;
  if (plan.version !== 1 || plan.status !== "READY") throw new Error(`plan is not READY (${plan.status})`);
  const approved = fromStr(plan.decision);
  if (fingerprint(approved) !== plan.fingerprint) throw new Error("plan file was modified: fingerprint does not match its contents");
  if (confirm !== plan.fingerprint) throw new Error(`--confirm ${confirm} does not match plan fingerprint ${plan.fingerprint}`);
  if (Date.now() - Date.parse(plan.createdAt) > MAX_PLAN_AGE_MS) throw new Error("plan is older than 15 minutes; run dry-run again");
  if (approved.owner !== env.owner || approved.operator !== env.operator) throw new Error("env owner/operator differ from the plan");
  const account = loadOperatorKey(env.operator);

  // Fresh re-read immediately before sending. Abort on any difference.
  const s = await snapshot(ctx, env);
  const problems = structuralProblems(s);
  if (s.market.pool !== approved.pool) problems.push("pool differs");
  if (s.positionSize !== approved.positionSize || s.latestSize !== approved.positionSize) {
    problems.push(`position changed: approved ${approved.positionSize}, now ${s.positionSize}/${s.latestSize}`);
  }
  if (closeSide(approved.positionSize).isBid !== approved.isBid) problems.push("side inconsistent with position");
  const q = closeQuantity(s.positionSize, s.market);
  if (!q.ok || q.quantity !== approved.quantity) problems.push("quantity no longer equals |position|");
  if (!s.auth.place) problems.push("operator no longer authorized for placeOrderFor");
  if (!s.markOk) problems.push("mark feed not live");
  if (s.restingOrders.length > 0) problems.push("owner now has resting orders on this pool");
  const book = approved.isBid ? s.asks : s.bids;
  if (book.length === 0) problems.push("no opposite liquidity");
  else {
    const t = book[0]!.price;
    const crosses = approved.isBid ? t <= approved.price : t >= approved.price;
    if (!crosses) problems.push(`approved cap ${approved.price} no longer crosses touch ${t}`);
    const depth = depthWithinCap(book, approved.isBid, approved.price);
    if (depth < approved.quantity) problems.push(`depth within approved cap ${depth} < ${approved.quantity}`);
  }
  if (s.operatorBalance < ORDER_GAS * s.gasPrice) problems.push("operator STT below gas budget");
  if (problems.length) throw new Error(`ABORTED before sending:\n  - ${problems.join("\n  - ")}`);

  const args = orderArgs(env.owner, approved);
  const sim = await simulate(ctx.pc, approved.pool as Address, account, args);
  if (!sim.ok || !sim.request) throw new Error(`ABORTED: pre-send simulation failed: ${sim.error ?? `success=${sim.success}`}`);

  console.log(`sending placeOrderFor (fingerprint ${plan.fingerprint}) ...`);
  const wallet = createWalletClient({ account, chain: hidekiTestnet, transport: http(HIDEKI.rpcUrl) });
  const hash = await wallet.writeContract(sim.request as never);
  console.log(`tx hash ${hash}`);
  const evidence: Record<string, unknown> = { plan: planPath, fingerprint: plan.fingerprint, txHash: hash, sentAt: new Date().toISOString() };
  const save = () => {
    const f = join(RUNS_DIR, `evidence-${Date.now()}.json`);
    writeFileSync(f, JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return f;
  };

  let receipt;
  try {
    receipt = await ctx.pc.waitForTransactionReceipt({ hash, timeout: 120_000 });
  } catch (e) {
    evidence.verdict = "UNKNOWN: no receipt within 120 s. Do not retry; check the hash.";
    console.log(`${evidence.verdict}\nevidence ${save()}`);
    return;
  }
  evidence.receipt = { status: receipt.status, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  if (receipt.status !== "success") {
    evidence.verdict = "FAIL: transaction reverted on-chain";
    console.log(`${evidence.verdict}\nevidence ${save()}`);
    return;
  }

  const decoded = decodePlaceOrder(receipt, approved.pool as Address);
  const filled = decoded.fills.reduce((sum, f) => sum + f.quantityFilled, 0n);
  const readPos = (blockNumber?: bigint) =>
    ctx.pc.readContract({
      address: HIDEKI.marginBank,
      abi: ABI,
      functionName: "getPosition",
      args: [env.owner, approved.pool as Address],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
    }) as Promise<{ size: bigint }>;
  const [atReceipt, atHead, openAfter] = await Promise.all([
    readPos(receipt.blockNumber),
    readPos(),
    ctx.exchange.client.getOpenOrdersOnchain([approved.pool as Address], env.owner),
  ]);
  evidence.orderId = decoded.orderId;
  evidence.fills = decoded.fills;
  evidence.filledTotal = filled;
  evidence.sizeBefore = approved.positionSize;
  evidence.sizeAtReceiptBlock = atReceipt.size;
  evidence.sizeAtHead = atHead.size;
  evidence.restingOrdersAfter = openAfter.orders.length;

  // Indexer cross-check (development-grade; may lag).
  let changes: unknown[] = [];
  for (let i = 0; i < 20 && changes.length === 0; i++) {
    try {
      changes = await ctx.exchange.client.listPerpPositionChanges({ txHash: hash });
    } catch {
      // keep polling
    }
    if (changes.length === 0) await new Promise((r) => setTimeout(r, 3000));
  }
  evidence.positionChanges = changes;

  const outcome = classify(approved.positionSize, atReceipt.size);
  const headOutcome = classify(approved.positionSize, atHead.size);
  const ownChange = (changes as { account: string; kind: string; sizeAfter: bigint }[]).find(
    (c) => c.account.toLowerCase() === env.owner.toLowerCase(),
  );
  let verdict: string;
  if (outcome === "CLOSED" && headOutcome === "CLOSED" && filled === approved.quantity) {
    if (!ownChange) verdict = "PASS (chain state). Indexer cross-check not yet available";
    else if (ownChange.kind === "CLOSE" && ownChange.sizeAfter === 0n) verdict = "PASS (chain state + indexer CLOSE row agree)";
    else verdict = `AMBIGUOUS: chain says closed, indexer says ${ownChange.kind} sizeAfter ${ownChange.sizeAfter}`;
  } else if (outcome === "CLOSED" && headOutcome !== "CLOSED") {
    verdict = `AMBIGUOUS: closed at receipt block but head shows ${atHead.size} (another actor?)`;
  } else if (outcome === "CLOSED") {
    verdict = `AMBIGUOUS: position is zero but decoded fills ${filled} != ${approved.quantity}`;
  } else {
    verdict = `FAIL: ${outcome}. Size ${approved.positionSize} -> ${atReceipt.size}. No retry was attempted`;
  }
  evidence.verdict = verdict;
  console.log(
    [
      `receipt        ${receipt.status} block ${receipt.blockNumber} gasUsed ${receipt.gasUsed}`,
      `orderId        ${decoded.orderId ?? "-"}  fills ${decoded.fills.length}  filled ${filled} / ${approved.quantity}`,
      `position       ${approved.positionSize} -> ${atReceipt.size} (receipt block), ${atHead.size} (head)`,
      `indexer        ${ownChange ? `${ownChange.kind} sizeAfter ${ownChange.sizeAfter}` : "no row yet"}`,
      `VERDICT        ${verdict}`,
      `evidence       ${save()}`,
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------------
// revocation check (read-only)

async function verifyRevoked(ctx: Ctx, env: Env, withSim: boolean) {
  const market = await findMarket(ctx, env.symbol);
  const auth = async (sel: `0x${string}`) =>
    (await ctx.pc.readContract({
      address: market.pool,
      abi: ABI,
      functionName: "isOperatorAuthorized",
      args: [env.owner, env.operator, sel],
    })) as boolean;
  const [place, cancel, reduce] = await Promise.all([
    auth(SELECTORS.placeOrderFor),
    auth(SELECTORS.cancelOrderFor),
    auth(SELECTORS.reduceOrderFor),
  ]);
  console.log(`isOperatorAuthorized on ${market.symbol}: place=${place} cancel=${cancel} reduce=${reduce}`);
  if (withSim) {
    // eth_call only: nothing is signed or sent.
    const feed = await ctx.exchange.client.getPerpFeedStatus(market.pool);
    const price = (feed.markPrice / market.tickSize) * market.tickSize;
    const sim = await simulate(ctx.pc, market.pool, env.operator, orderArgs(env.owner, { isBid: true, price, quantity: market.minQuantity }));
    console.log(`eth_call placeOrderFor as operator: ${sim.ok ? "WOULD SUCCEED (not revoked!)" : `reverts ${sim.error}`}`);
  }
  console.log(`REVOCATION ${!place && !cancel && !reduce ? "PASS" : "FAIL"}`);
}

// ---------------------------------------------------------------------------

async function preflight(ctx: Ctx) {
  const chainId = await ctx.pc.getChainId();
  const block = await ctx.pc.getBlockNumber();
  console.log(`rpc            ${HIDEKI.rpcUrl} chain ${chainId} block ${block}`);
  if (chainId !== HIDEKI.chainId) throw new Error("wrong chain");
  const markets = await ctx.exchange.loadMarkets();
  const perps = Object.values(markets).filter((m) => m.type === "swap");
  console.log(`sdk (ws+indexer) loaded ${perps.length} perp markets`);
  console.log(`selector       placeOrderFor ${placeOrderForSelector()} (expected ${SELECTORS.placeOrderFor})`);
  const env = { symbol: (process.env.PERP_SYMBOL ?? "").trim().toUpperCase() };
  if (env.symbol) {
    const m = await findMarket(ctx, env.symbol);
    const [mb, reg] = await Promise.all([
      ctx.pc.readContract({ address: m.pool, abi: ABI, functionName: "marginBank" }),
      ctx.pc.readContract({ address: m.pool, abi: ABI, functionName: "getOperatorPermissionsRegistry" }),
    ]);
    const feed = await ctx.exchange.client.getPerpFeedStatus(m.pool);
    console.log(`market         ${m.symbol} pool ${m.pool}`);
    console.log(`pool wiring    marginBank ${mb} registry ${reg}`);
    console.log(`mark feed      ok=${feed.markPriceOk} mark=${formatUnits(feed.markPrice, 18)}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const ctx = makeCtx();
  try {
    if (cmd === "preflight") return await preflight(ctx);
    const env = readEnv();
    if (cmd === "dry-run") {
      const plan = await dryRun(ctx, env);
      mkdirSync(RUNS_DIR, { recursive: true });
      const file = join(RUNS_DIR, `plan-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(plan, null, 2));
      printPlan(plan, file);
      return;
    }
    if (cmd === "execute") {
      const planPath = flag("--plan");
      const confirm = flag("--confirm");
      if (!planPath || !confirm) throw new Error("execute needs --plan <file> --confirm <fingerprint>");
      mkdirSync(RUNS_DIR, { recursive: true });
      return await execute(ctx, env, planPath, confirm);
    }
    if (cmd === "verify-revoked") return await verifyRevoked(ctx, env, rest.includes("--simulate"));
    throw new Error("usage: exp0.ts preflight | dry-run | execute --plan <file> --confirm <fp> | verify-revoked [--simulate]");
  } finally {
    await closeCtx(ctx);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);

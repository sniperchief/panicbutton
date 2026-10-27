// The shared execution engine. Both the web API and any future channel go through
// this class; it is the only code that decides whether a transaction is sent.
//
// Flow: prepare() reads fresh chain state, pins it to one block, prices an IOC
// close for exactly |position|, simulates it and returns a quote. execute()
// accepts only unexpired, unused, READY quotes owned by the session, re-reads
// everything immediately before each send, and aborts on any difference. After a
// send it verifies the outcome from chain state. It never retries.

import { formatUnits, getAddress, type Account, type Address, type Hex } from "viem";
import { BroadcastError, type Chain, type MarketInfo } from "./chain.js";
import { HIDEKI, type EngineSettings } from "./config.js";
import {
  ORDER_TYPE_IOC,
  SELECTORS,
  SELF_MATCH_CANCEL_TAKER,
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
  type Level,
} from "./plan.js";

export interface SessionRef {
  id: string;
  owner: Address;
  operator: Address;
}

export interface PositionView {
  market: string;
  symbol: string;
  pool: Address;
  side: "long" | "short";
  size: string;
  sizeHuman: string;
  entryPrice: string;
  markPrice: string | null;
  markOk: boolean;
  unrealizedPnl: string | null;
  liquidationPrice: string | null;
  operatorAuthorized: boolean;
}

export interface Quote {
  id: string;
  sessionId: string;
  owner: Address;
  operator: Address;
  pool: Address;
  market: string;
  baseDecimals: number;
  status: "READY" | "BLOCKED";
  blockers: string[];
  warnings: string[];
  block: string;
  side: "long" | "short" | "flat";
  positionSize: string;
  isBid: boolean;
  quantity: string;
  priceCap: string;
  touch: string | null;
  mark: string | null;
  slippageBps: number;
  depthWithinCap: string;
  simulation: string;
  fingerprint: string;
  createdAt: number;
  expiresAt: number;
  human: { size: string; quantity: string; priceCap: string | null; touch: string | null; mark: string | null };
}

export type ItemState =
  | "PENDING"
  | "CHECKING"
  | "SIMULATING"
  | "SUBMITTING"
  | "CONFIRMING"
  | "VERIFYING"
  | "CLOSED"
  | "PARTIAL"
  | "ABORTED"
  | "FAILED"
  | "FLIPPED"
  | "UNKNOWN"
  | "AMBIGUOUS"
  | "SKIPPED";

export const FINAL_STATES: ReadonlySet<ItemState> = new Set([
  "CLOSED",
  "PARTIAL",
  "ABORTED",
  "FAILED",
  "FLIPPED",
  "UNKNOWN",
  "AMBIGUOUS",
  "SKIPPED",
]);

export interface JobItem {
  quoteId: string;
  pool: Address;
  market: string;
  baseDecimals: number;
  state: ItemState;
  message: string;
  quantity: string;
  sizeBefore: string;
  txHash?: string;
  receiptStatus?: "success" | "reverted";
  receiptBlock?: string;
  gasUsed?: string;
  orderId?: string;
  filled?: string;
  sizeAfter?: string;
  sizeAtHead?: string;
  indexer?: "agree" | "pending" | "disagree" | "unavailable";
  /** For an UNKNOWN item: the receipt that turned up afterwards. */
  lateReceipt?: { status: "success" | "reverted"; block: string };
  startedAt?: number;
  finishedAt?: number;
}

export interface Job {
  id: string;
  sessionId: string;
  idempotencyKey: string;
  createdAt: number;
  status: "RUNNING" | "DONE" | "HALTED";
  items: JobItem[];
}

export interface Repo {
  saveQuote(q: Quote): void;
  getQuote(id: string): Quote | undefined;
  /** Atomically marks a quote used; false if it already was. */
  markQuoteUsed(id: string): boolean;
  saveJob(job: Job): void;
  getJob(id: string): Job | undefined;
  findJobByIdempotencyKey(sessionId: string, key: string): Job | undefined;
  jobsForSession(sessionId: string): Job[];
}

export class EngineError extends Error {
  constructor(
    readonly code: "BAD_REQUEST" | "NOT_FOUND" | "EXECUTION_DISABLED" | "CONFLICT",
    message: string,
  ) {
    super(message);
  }
}

export interface EngineOptions {
  executionEnabled: boolean;
  now?: () => number;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const px = (v: bigint) => formatUnits(v, 18);

/** Map with at most `limit` calls in flight, results in input order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** A size blocker in the market's own units. */
function sizeProblem(code: string, size: bigint, m: MarketInfo): string | undefined {
  const base = m.display.replace(/-PERP$/, "");
  const human = (v: bigint) => `${formatUnits(v, m.baseDecimals)} ${base}`;
  if (code === "below-minimum") {
    return (
      `${human(abs(size))} is below this market's minimum order of ${human(m.minQuantity)}. ` +
      "The venue accepts no smaller order, so PanicButton cannot close it with one order"
    );
  }
  if (code === "not-lot-multiple") {
    return `${human(abs(size))} is not a whole number of ${human(m.lotSize)} lots, so no single order can close exactly this size`;
  }
  return undefined;
}

export class Engine {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    private readonly chain: Chain,
    private readonly repo: Repo,
    readonly settings: EngineSettings,
    private readonly opts: EngineOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (placeOrderForSelector() !== SELECTORS.placeOrderFor) throw new Error("placeOrderFor ABI selector mismatch");
  }

  get executionEnabled() {
    return this.opts.executionEnabled;
  }

  async status() {
    const [chainId, block] = await Promise.all([this.chain.chainId(), this.chain.blockNumber()]);
    return { chainId, block: block.toString(), chainOk: chainId === HIDEKI.chainId, executionEnabled: this.executionEnabled };
  }

  async marketByPool(pool: Address): Promise<MarketInfo> {
    const m = (await this.chain.markets()).find((x) => x.pool === getAddress(pool));
    if (!m) throw new EngineError("BAD_REQUEST", `unknown perp pool ${pool}`);
    return m;
  }

  /** Which perp markets the session operator may place orders on for the owner. */
  async coverage(s: SessionRef) {
    const markets = await this.chain.markets();
    const flags = await Promise.all(
      markets.map((m) => this.chain.isAuthorized(m.pool, s.owner, s.operator, SELECTORS.placeOrderFor).catch(() => false)),
    );
    return {
      total: markets.length,
      linked: markets.filter((_, i) => flags[i]).map((m) => m.display),
      missing: markets.filter((_, i) => !flags[i]).map((m) => m.display),
    };
  }

  async operatorFunds(operator: Address) {
    const [balance, gasPrice] = await Promise.all([this.chain.balance(operator), this.chain.gasPrice()]);
    const budget = this.settings.orderGas * gasPrice;
    return { balance: formatUnits(balance, 18), perCloseBudget: formatUnits(budget, 18), sufficient: balance >= budget };
  }

  async positions(s: SessionRef): Promise<PositionView[]> {
    const markets = await this.chain.markets();
    const block = await this.chain.blockNumber();
    const reads = await Promise.all(markets.map((m) => this.chain.position(s.owner, m.pool, block)));
    const held = markets.map((m, i) => ({ m, p: reads[i]! })).filter((x) => x.p.size !== 0n);
    return Promise.all(
      held.map(async ({ m, p }): Promise<PositionView> => {
        const [feed, liq, auth] = await Promise.all([
          this.chain.feed(m.pool).catch(() => ({ ok: false, mark: 0n })),
          this.chain.liquidationPrice(s.owner, m),
          this.chain.isAuthorized(m.pool, s.owner, s.operator, SELECTORS.placeOrderFor).catch(() => false),
        ]);
        const pnl = feed.ok ? unrealizedPnl(p.size, p.avgEntryPrice, feed.mark, m.baseDecimals) : null;
        return {
          market: m.display,
          symbol: m.symbol,
          pool: m.pool,
          side: p.size > 0n ? "long" : "short",
          size: p.size.toString(),
          sizeHuman: formatUnits(abs(p.size), m.baseDecimals),
          entryPrice: px(p.avgEntryPrice),
          markPrice: feed.ok ? px(feed.mark) : null,
          markOk: feed.ok,
          unrealizedPnl: pnl === null ? null : px(pnl),
          // 0 means this market's move alone cannot reach maintenance: no meaningful price.
          liquidationPrice: liq === null || liq <= 0n ? null : px(liq),
          operatorAuthorized: auth,
        };
      }),
    );
  }

  private structuralProblems(m: MarketInfo, wiring: { marginBank: Address; registry: Address }): string[] {
    const p: string[] = [];
    const bank = getAddress(HIDEKI.marginBank);
    if (m.marginBank !== bank) p.push(`market marginBank ${m.marginBank} is not the pinned Hideki MarginBank`);
    if (wiring.marginBank !== bank) p.push(`pool reports marginBank ${wiring.marginBank}, not the pinned one`);
    if (wiring.registry !== getAddress(HIDEKI.operatorRegistry)) p.push(`pool operator registry ${wiring.registry} is not the pinned one`);
    if (m.quoteToken !== getAddress(HIDEKI.usdso)) p.push(`quote token ${m.quoteToken} is not USDso`);
    if (m.quoteDecimals !== 18) p.push(`quoteDecimals ${m.quoteDecimals}: the 18-decimal price rule is unproven for this market`);
    if (m.tickSize <= 0n || m.lotSize <= 0n) p.push("invalid tick or lot size");
    return p;
  }

  private checkSlippage(slippageBps: number) {
    if (!Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > this.settings.maxSlippageBps) {
      throw new EngineError("BAD_REQUEST", `slippageBps must be an integer between 1 and ${this.settings.maxSlippageBps}`);
    }
  }

  /**
   * Prepare closes for the given pools, or every market with a position ("all").
   * Read-only: nothing is signed or sent.
   */
  async prepare(s: SessionRef, target: Address[] | "all", slippageBps = this.settings.defaultSlippageBps): Promise<Quote[]> {
    this.checkSlippage(slippageBps);
    const chainId = await this.chain.chainId();
    if (chainId !== HIDEKI.chainId) throw new EngineError("CONFLICT", `RPC is on chain ${chainId}, expected ${HIDEKI.chainId}`);
    const block = await this.chain.blockNumber();
    const all = await this.chain.markets();
    let markets: MarketInfo[];
    if (target === "all") {
      const sizes = await Promise.all(all.map((m) => this.chain.position(s.owner, m.pool, block)));
      markets = all.filter((_, i) => sizes[i]!.size !== 0n);
    } else {
      if (target.length === 0) throw new EngineError("BAD_REQUEST", "no pools given");
      const unique = [...new Set(target.map((p) => getAddress(p)))];
      markets = await Promise.all(unique.map((p) => this.marketByPool(p)));
    }
    const [balance, gasPrice] = await Promise.all([this.chain.balance(s.operator), this.chain.gasPrice()]);
    const budget = this.settings.orderGas * gasPrice;
    // A few markets at a time: fast enough for an emergency, gentle enough for the
    // public RPC. Quote order (= execution order) stays the market order.
    const quotes = await mapLimit(markets, 4, (m) => this.prepareOne(s, m, block, slippageBps, balance, budget));
    const outstanding = await this.outstanding(s.id, s.operator);
    if (outstanding.length) {
      for (const q of quotes) {
        q.blockers.unshift(...outstanding);
        q.status = "BLOCKED";
        q.fingerprint = "";
      }
    }
    const ready = quotes.filter((q) => q.status === "READY").length;
    if (ready > 1 && balance < budget * BigInt(ready)) {
      for (const q of quotes) {
        if (q.status === "READY") {
          q.warnings.push(
            `operator holds ${formatUnits(balance, 18)} STT; ${ready} sequential closes may need up to ${formatUnits(budget * BigInt(ready), 18)} STT of gas headroom`,
          );
        }
      }
    }
    for (const q of quotes) this.repo.saveQuote(q);
    return quotes;
  }

  private async prepareOne(
    s: SessionRef,
    m: MarketInfo,
    block: bigint,
    slippageBps: number,
    balance: bigint,
    budget: bigint,
  ): Promise<Quote> {
    const blockers: string[] = [];
    const warnings: string[] = [];
    const created = this.now();
    const base = {
      id: this.newId(),
      sessionId: s.id,
      owner: s.owner,
      operator: s.operator,
      pool: m.pool,
      market: m.display,
      baseDecimals: m.baseDecimals,
      block: block.toString(),
      slippageBps,
      createdAt: created,
      expiresAt: created + this.settings.quoteTtlMs,
    };
    const blocked = (extra: Partial<Quote> = {}): Quote => ({
      ...base,
      status: "BLOCKED",
      blockers,
      warnings,
      side: "flat",
      positionSize: "0",
      isBid: false,
      quantity: "0",
      priceCap: "0",
      touch: null,
      mark: null,
      depthWithinCap: "0",
      simulation: "not run",
      fingerprint: "",
      human: { size: "0", quantity: "0", priceCap: null, touch: null, mark: null },
      ...extra,
    });

    // Both book sides are read up front, in parallel with everything else: the side
    // needed depends on the position, and a second round trip costs ~0.7 s.
    let wiring, pos, latest, feed, auth, openOrders, bids: Level[], asks: Level[];
    try {
      [wiring, pos, latest, feed, auth, openOrders, bids, asks] = await Promise.all([
        this.chain.poolWiring(m.pool),
        this.chain.position(s.owner, m.pool, block),
        this.chain.position(s.owner, m.pool),
        this.chain.feed(m.pool),
        this.chain.isAuthorized(m.pool, s.owner, s.operator, SELECTORS.placeOrderFor, block),
        this.chain.openOrderCount(s.owner, m.pool, block),
        this.chain.book(m.pool, true, this.settings.bookLevels, block),
        this.chain.book(m.pool, false, this.settings.bookLevels, block),
      ]);
    } catch (e) {
      blockers.push(`could not read chain state, so nothing can be checked; try again (${(e as Error).message.slice(0, 140)})`);
      return blocked();
    }
    blockers.push(...this.structuralProblems(m, wiring));
    const size = pos.size;
    if (latest.size !== size) blockers.push(`position changed while preparing (${size} at block ${block}, ${latest.size} at head)`);
    if (size === 0n) {
      blockers.push("no open position in this market");
      return blocked();
    }
    const { isBid, positionSide } = closeSide(size);
    if (!auth) blockers.push("PanicButton's operator is not linked for this market (dreamDEX: Link a bot -> Perps)");
    if (openOrders > 0) {
      blockers.push(
        `${openOrders} resting order(s) on this market reduce how much an order can close without opening the other side; cancel them in dreamDEX first`,
      );
    }
    if (!m.active) warnings.push("market is not active (halted or close-only); reducing orders may still be accepted");
    if (!feed.ok) blockers.push("mark price is stale or unavailable");
    if (balance < budget) {
      blockers.push(`operator has ${formatUnits(balance, 18)} STT; one close needs ${formatUnits(budget, 18)} STT of gas headroom`);
    }
    const q = closeQuantity(size, m);
    if (!q.ok) blockers.push(sizeProblem(q.code, size, m) ?? q.reason);

    const book = isBid ? asks : bids;
    // Closing a long sells into bids (book side isBid=true); closing a short buys from asks.
    const touch = book[0]?.price;
    if (touch === undefined) blockers.push(`no ${isBid ? "asks" : "bids"} on the book to close against`);

    let cap = 0n;
    let depth = 0n;
    if (touch !== undefined && q.ok) {
      try {
        cap = priceCap({ isBid, touch, slippageBps, tickSize: m.tickSize, maxSlippageBps: this.settings.maxSlippageBps });
        depth = depthWithinCap(book, isBid, cap);
        if (depth < q.quantity) {
          blockers.push(
            `only ${formatUnits(depth, m.baseDecimals)} resting within the slippage cap, ${formatUnits(q.quantity, m.baseDecimals)} needed; a close would partially fill`,
          );
        }
        if (feed.ok) {
          const dev = deviationBps(touch, feed.mark);
          if (dev > BigInt(slippageBps)) blockers.push(`best price ${px(touch)} is ${dev} bps from mark ${px(feed.mark)}, beyond the ${slippageBps} bps limit`);
        }
      } catch (e) {
        blockers.push(`cannot price the close: ${(e as Error).message}`);
      }
    }

    const quantity = q.ok ? q.quantity : 0n;
    let simulation = "not run";
    if (blockers.length === 0) {
      const sim = await this.chain.simulateClose(
        { pool: m.pool, owner: s.owner, operator: s.operator, isBid, price: cap, quantity },
        this.settings.orderGas,
        block,
      );
      simulation = sim.ok ? `ok (orderId ${sim.orderId ?? "-"})` : `reverted: ${sim.error}`;
      if (!sim.ok) blockers.push(`simulation failed: ${sim.error}`);
    }

    const fp =
      blockers.length === 0
        ? fingerprint({
            chainId: HIDEKI.chainId,
            pool: m.pool,
            owner: s.owner,
            operator: s.operator,
            positionSize: size,
            isBid,
            orderType: ORDER_TYPE_IOC,
            quantity,
            price: cap,
            selfMatchingOption: SELF_MATCH_CANCEL_TAKER,
          })
        : "";
    return {
      ...base,
      status: blockers.length === 0 ? "READY" : "BLOCKED",
      blockers,
      warnings,
      side: positionSide,
      positionSize: size.toString(),
      isBid,
      quantity: quantity.toString(),
      priceCap: cap.toString(),
      touch: touch?.toString() ?? null,
      mark: feed.ok ? feed.mark.toString() : null,
      depthWithinCap: depth.toString(),
      simulation,
      fingerprint: fp,
      human: {
        size: formatUnits(abs(size), m.baseDecimals),
        quantity: formatUnits(quantity, m.baseDecimals),
        priceCap: cap ? px(cap) : null,
        touch: touch !== undefined ? px(touch) : null,
        mark: feed.ok ? px(feed.mark) : null,
      },
    };
  }

  /**
   * Start a job for confirmed quotes. Returns immediately; poll job(). Repeating the
   * same idempotency key returns the original job and sends nothing new.
   */
  execute(s: SessionRef, quoteIds: string[], idempotencyKey: string, signer: () => Account): Job {
    const existing = this.repo.findJobByIdempotencyKey(s.id, idempotencyKey);
    if (existing) return existing;
    if (!this.executionEnabled) {
      throw new EngineError("EXECUTION_DISABLED", "execution is disabled on this server (EXECUTION_ENABLED is not true); prepare and simulate still work");
    }
    if (quoteIds.length === 0) throw new EngineError("BAD_REQUEST", "no quotes given");
    const unique = [...new Set(quoteIds)];
    if (unique.length !== quoteIds.length) throw new EngineError("BAD_REQUEST", "duplicate quote ids");
    const now = this.now();
    const quotes = unique.map((id) => {
      const q = this.repo.getQuote(id);
      if (!q || q.sessionId !== s.id) throw new EngineError("NOT_FOUND", `quote ${id} not found`);
      if (q.owner !== s.owner || q.operator !== s.operator) throw new EngineError("CONFLICT", `quote ${id} was made for another account`);
      if (q.status !== "READY") throw new EngineError("CONFLICT", `quote ${id} for ${q.market} is blocked: ${q.blockers.join("; ")}`);
      if (now > q.expiresAt) throw new EngineError("CONFLICT", `quote for ${q.market} expired; prepare again`);
      return q;
    });
    if (new Set(quotes.map((q) => q.pool)).size !== quotes.length) throw new EngineError("BAD_REQUEST", "two quotes for one market");
    // Checks above are synchronous, so nothing can interleave before the quotes are consumed.
    for (const q of quotes) {
      if (!this.repo.markQuoteUsed(q.id)) throw new EngineError("CONFLICT", `quote for ${q.market} was already used`);
    }

    const job: Job = {
      id: this.newId(),
      sessionId: s.id,
      idempotencyKey,
      createdAt: now,
      status: "RUNNING",
      items: quotes.map((q) => ({
        quoteId: q.id,
        pool: q.pool,
        market: q.market,
        baseDecimals: q.baseDecimals,
        state: "PENDING",
        message: "waiting",
        quantity: q.quantity,
        sizeBefore: q.positionSize,
      })),
    };
    this.repo.saveJob(job);

    // One operator key per session, so one transaction at a time per session.
    const prev = this.queues.get(s.id) ?? Promise.resolve();
    const run = prev.then(() => this.runJob(job, quotes, signer)).catch(() => undefined);
    this.queues.set(s.id, run);
    this.running.set(job.id, run);
    return job;
  }

  job(id: string, sessionId: string): Job {
    const j = this.repo.getJob(id);
    if (!j || j.sessionId !== sessionId) throw new EngineError("NOT_FOUND", "job not found");
    return j;
  }

  /** Resolves when the job's run finishes. For tests and graceful shutdown. */
  async settle(jobId: string): Promise<void> {
    await this.running.get(jobId);
  }

  private async runJob(job: Job, quotes: Quote[], signer: () => Account) {
    let haltReason: string | undefined;
    for (let i = 0; i < job.items.length; i++) {
      const item = job.items[i]!;
      if (haltReason) {
        this.update(job, item, { state: "SKIPPED", message: `not attempted: ${haltReason}`, finishedAt: this.now() });
        continue;
      }
      let halt: string | undefined;
      try {
        halt = await this.runItem(job, item, quotes[i]!, signer);
      } catch (e) {
        // Unexpected engine error after possible submission: treat as unknown and stop.
        this.update(job, item, { state: "UNKNOWN", message: `engine error: ${(e as Error).message.slice(0, 200)}`, finishedAt: this.now() });
        halt = "an earlier close ended in an unknown state";
      }
      if (halt) haltReason = halt;
    }
    job.status = haltReason ? "HALTED" : "DONE";
    this.repo.saveJob(job);
  }

  private update(job: Job, item: JobItem, patch: Partial<JobItem>) {
    Object.assign(item, patch);
    this.repo.saveJob(job);
  }

  /**
   * Reasons this session must not send another close yet: an earlier transaction
   * whose outcome is unknown and still has no receipt, or the operator has
   * transactions the node has not mined. Closing again then could close twice
   * and reverse the position. A receipt found later resolves the earlier item.
   */
  private async outstanding(sessionId: string, operator: Address): Promise<string[]> {
    const problems: string[] = [];
    for (const job of this.repo.jobsForSession(sessionId)) {
      let changed = false;
      for (const item of job.items) {
        if (item.state !== "UNKNOWN" || !item.txHash || item.lateReceipt) continue;
        const r = await this.chain.waitReceipt(item.txHash as Hex, item.pool, 1500).catch(() => null);
        if (r) {
          item.lateReceipt = { status: r.status, block: r.blockNumber.toString() };
          item.message += ` (receipt found later: ${r.status} in block ${r.blockNumber}; current positions reflect it)`;
          changed = true;
        } else {
          problems.push(
            `an earlier transaction for ${item.market} (${item.txHash.slice(0, 10)}…) still has no receipt; closing again now could close twice and reverse the position`,
          );
        }
      }
      if (changed) this.repo.saveJob(job);
    }
    const pending = await this.chain.pendingTxCount(operator).catch(() => 0);
    if (pending > 0) problems.push(`the bot operator has ${pending} transaction(s) the network has not mined yet; wait for them to settle`);
    return problems;
  }

  /** Returns a halt reason when the remaining items must not be attempted. */
  private async runItem(job: Job, item: JobItem, q: Quote, signer: () => Account): Promise<string | undefined> {
    const s = this.settings;
    const m = await this.marketByPool(q.pool);
    const approvedSize = BigInt(q.positionSize);
    const quantity = BigInt(q.quantity);
    const cap = BigInt(q.priceCap);
    const call = { pool: q.pool, owner: q.owner, operator: q.operator, isBid: q.isBid, price: cap, quantity };
    const hs = (v: bigint) => formatUnits(v, m.baseDecimals);
    const abort = (message: string) => {
      this.update(job, item, { state: "ABORTED", message: `no transaction sent: ${message}`, finishedAt: this.now() });
      return undefined;
    };

    // 1. Fresh re-read immediately before sending. Any difference aborts this item.
    this.update(job, item, { state: "CHECKING", message: "re-reading position, book and permissions", startedAt: this.now() });
    const outstanding = await this.outstanding(job.sessionId, q.operator);
    if (outstanding.length) return abort(outstanding[0]!);
    let fresh;
    try {
      const [pos, auth, feed, openOrders, book, balance, gasPrice] = await Promise.all([
        this.chain.position(q.owner, q.pool),
        this.chain.isAuthorized(q.pool, q.owner, q.operator, SELECTORS.placeOrderFor),
        this.chain.feed(q.pool),
        this.chain.openOrderCount(q.owner, q.pool),
        this.chain.book(q.pool, !q.isBid, s.bookLevels),
        this.chain.balance(q.operator),
        this.chain.gasPrice(),
      ]);
      fresh = { pos, auth, feed, openOrders, book, balance, gasPrice };
    } catch (e) {
      return abort(`fresh chain read failed: ${(e as Error).message.slice(0, 160)}`);
    }
    if (fresh.pos.size !== approvedSize) return abort(`position changed since confirmation (${hs(approvedSize)} -> ${hs(fresh.pos.size)})`);
    const qty = closeQuantity(fresh.pos.size, m);
    if (!qty.ok || qty.quantity !== quantity || closeSide(fresh.pos.size).isBid !== q.isBid) return abort("close size or side no longer matches the position");
    if (!fresh.auth) return abort("operator is no longer authorized for this market");
    if (!fresh.feed.ok) return abort("mark price became stale");
    if (fresh.openOrders > 0) return abort("the account now has resting orders on this market");
    if (fresh.balance < s.orderGas * fresh.gasPrice) return abort("operator STT is below the gas headroom for one close");
    const touch = fresh.book[0]?.price;
    if (touch === undefined) return abort("no opposite liquidity on the book");
    if (!capCrosses(q.isBid, cap, touch)) return abort(`the market moved past the confirmed price limit (${px(cap)})`);
    if (depthWithinCap(fresh.book, q.isBid, cap) < quantity) return abort("not enough liquidity within the confirmed price limit");

    // 2. Simulate at head.
    this.update(job, item, { state: "SIMULATING", message: "simulating the close" });
    const sim = await this.chain.simulateClose(call, s.orderGas);
    if (!sim.ok) return abort(`simulation failed: ${sim.error}`);

    // 3. Submit.
    this.update(job, item, { state: "SUBMITTING", message: "signing and submitting" });
    let hash: Hex;
    try {
      hash = await this.chain.sendClose(call, s.orderGas, signer());
    } catch (e) {
      const msg = (e as Error).message.split("\n")[0]!.slice(0, 160);
      if (e instanceof BroadcastError) {
        // Signed, so it may have reached the network even though the RPC errored.
        this.update(job, item, {
          state: "UNKNOWN",
          txHash: e.hash,
          message: `signed but broadcasting reported an error (${msg}); it may still be mined. PanicButton will not close this account again until it resolves`,
          finishedAt: this.now(),
        });
        return "an earlier transaction may still be pending";
      }
      // Failed before signing: nothing can have been sent.
      this.update(job, item, { state: "FAILED", message: `not submitted: ${msg}`, finishedAt: this.now() });
      return undefined;
    }
    this.update(job, item, { state: "CONFIRMING", message: "waiting for the receipt", txHash: hash });

    // 4. Receipt.
    const receipt = await this.chain.waitReceipt(hash, q.pool, s.receiptTimeoutMs);
    if (!receipt) {
      this.update(job, item, {
        state: "UNKNOWN",
        message: `no receipt within ${s.receiptTimeoutMs / 1000}s. PanicButton will not close this account again until this transaction resolves`,
        finishedAt: this.now(),
      });
      return "an earlier transaction has no receipt yet";
    }
    const filled = receipt.fills.reduce((sum, f) => sum + f.quantityFilled, 0n);
    this.update(job, item, {
      state: "VERIFYING",
      message: "verifying the position on chain",
      receiptStatus: receipt.status,
      receiptBlock: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      orderId: receipt.orderId?.toString(),
      filled: filled.toString(),
    });

    // 5. Verify from chain state: at the receipt block and at head.
    let atReceipt, atHead;
    try {
      [atReceipt, atHead] = await Promise.all([
        this.chain.position(q.owner, q.pool, receipt.blockNumber),
        this.chain.position(q.owner, q.pool),
      ]);
    } catch (e) {
      this.update(job, item, { state: "UNKNOWN", message: `could not read the position after the transaction: ${(e as Error).message.slice(0, 120)}`, finishedAt: this.now() });
      return "an earlier close could not be verified";
    }
    const sizes = { sizeAfter: atReceipt.size.toString(), sizeAtHead: atHead.size.toString() };

    if (receipt.status === "reverted") {
      const unchanged = atReceipt.size === approvedSize;
      this.update(job, item, {
        ...sizes,
        state: unchanged ? "FAILED" : "AMBIGUOUS",
        message: unchanged ? "transaction reverted; position unchanged" : "transaction reverted but the position differs; inspect before acting",
        finishedAt: this.now(),
      });
      return unchanged ? undefined : "an earlier result is ambiguous";
    }

    const outcome = classify(approvedSize, atReceipt.size);
    if (outcome === "FLIPPED") {
      this.update(job, item, {
        ...sizes,
        state: "FLIPPED",
        message: `position reversed: ${hs(approvedSize)} -> ${hs(atReceipt.size)}. Remaining closes stopped; review the account in dreamDEX`,
        finishedAt: this.now(),
      });
      return "a position reversed";
    }
    if (outcome === "INCREASED") {
      this.update(job, item, { ...sizes, state: "AMBIGUOUS", message: `position grew: ${hs(approvedSize)} -> ${hs(atReceipt.size)}`, finishedAt: this.now() });
      return "a position grew unexpectedly";
    }
    if (outcome === "UNCHANGED") {
      this.update(job, item, { ...sizes, state: "FAILED", message: "transaction confirmed but nothing filled; position unchanged", finishedAt: this.now() });
      return undefined;
    }
    if (outcome === "PARTIAL") {
      this.update(job, item, {
        ...sizes,
        state: "PARTIAL",
        message: `partially closed: ${formatUnits(abs(atReceipt.size), m.baseDecimals)} remains open. Not retried; prepare a new close for the rest`,
        finishedAt: this.now(),
      });
      return undefined;
    }
    // CLOSED at the receipt block.
    if (atHead.size !== 0n) {
      this.update(job, item, { ...sizes, state: "AMBIGUOUS", message: `closed at the receipt block, but the position is ${hs(atHead.size)} now (another actor?)`, finishedAt: this.now() });
      return "an earlier result is ambiguous";
    }
    if (filled !== quantity) {
      this.update(job, item, { ...sizes, state: "AMBIGUOUS", message: `position is zero but decoded fills total ${hs(filled)}, expected ${hs(quantity)}`, finishedAt: this.now() });
      return "an earlier result is ambiguous";
    }

    // Chain says closed. The indexer is a secondary, development-grade cross-check.
    const indexer = await this.indexerCheck(hash, q.owner);
    if (indexer === "disagree") {
      this.update(job, item, { ...sizes, indexer, state: "AMBIGUOUS", message: "chain shows the position closed, but the indexer row disagrees", finishedAt: this.now() });
      return "data sources disagree";
    }
    this.update(job, item, {
      ...sizes,
      indexer,
      state: "CLOSED",
      message: indexer === "agree" ? "closed; verified on chain and by the indexer" : "closed; verified on chain (indexer row not yet available)",
      finishedAt: this.now(),
    });
    return undefined;
  }

  private async indexerCheck(hash: Hex, owner: Address): Promise<"agree" | "pending" | "disagree" | "unavailable"> {
    const deadline = this.now() + this.settings.indexerWaitMs;
    let sawUnavailable = false;
    for (;;) {
      const rows = await this.chain.positionChanges(hash);
      if (rows === null) sawUnavailable = true;
      const own = rows?.find((r) => r.account.toLowerCase() === owner.toLowerCase());
      if (own) return own.kind === "CLOSE" && own.sizeAfter === 0n ? "agree" : "disagree";
      if (this.now() >= deadline) return sawUnavailable ? "unavailable" : "pending";
      await this.sleep(3000);
    }
  }
}

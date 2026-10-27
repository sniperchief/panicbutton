// MOCKED integration tests of the execution engine over FakeChain.
// They prove the engine's decisions, not the venue's behavior: see README "Live verification".

import { beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { DEFAULT_SETTINGS } from "../server/engine/config.js";
import { Engine, EngineError, type Job, type Quote, type Repo, type SessionRef } from "../server/engine/engine.js";
import { BTC, ETH, E18, FakeChain, OWNER } from "./fake-chain.js";

class MemRepo implements Repo {
  quotes = new Map<string, { q: Quote; used: boolean }>();
  jobs = new Map<string, Job>();
  saveQuote(q: Quote) {
    this.quotes.set(q.id, { q: structuredClone(q), used: this.quotes.get(q.id)?.used ?? false });
  }
  getQuote(id: string) {
    const r = this.quotes.get(id);
    return r ? structuredClone(r.q) : undefined;
  }
  markQuoteUsed(id: string) {
    const r = this.quotes.get(id);
    if (!r || r.used) return false;
    r.used = true;
    return true;
  }
  saveJob(job: Job) {
    this.jobs.set(job.id, structuredClone(job));
  }
  getJob(id: string) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : undefined;
  }
  findJobByIdempotencyKey(sessionId: string, key: string) {
    return [...this.jobs.values()].find((j) => j.sessionId === sessionId && j.idempotencyKey === key);
  }
  jobsForSession(sessionId: string) {
    return [...this.jobs.values()].filter((j) => j.sessionId === sessionId).map((j) => structuredClone(j));
  }
}

const signer = privateKeyToAccount(generatePrivateKey());
const session: SessionRef = { id: "s1", owner: OWNER, operator: signer.address };

let chain: FakeChain;
let repo: MemRepo;
let clock: number;
let engine: Engine;

function makeEngine(executionEnabled = true) {
  return new Engine(chain, repo, { ...DEFAULT_SETTINGS, indexerWaitMs: 6_000 }, {
    executionEnabled,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
}

beforeEach(() => {
  chain = FakeChain.healthy(signer.address);
  repo = new MemRepo();
  clock = 1_000_000;
  engine = makeEngine();
});

async function run(quotes: Quote[], key: string = crypto.randomUUID()) {
  const job = engine.execute(session, quotes.map((q) => q.id), key, () => signer);
  await engine.settle(job.id);
  return engine.job(job.id, session.id);
}

describe("prepare", () => {
  it("prices a READY close for exactly |size| on the closing side", async () => {
    const [q] = await engine.prepare(session, [ETH.pool]);
    expect(q!.status).toBe("READY");
    expect(q!.side).toBe("long");
    expect(q!.isBid).toBe(false);
    expect(q!.quantity).toBe((4n * 10n ** 15n).toString());
    // best bid 2327.92 * (1 - 0.005) = 2316.2804 -> aligned up to 2316.29
    expect(q!.priceCap).toBe((231629n * 10n ** 16n).toString());
    expect(q!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(chain.simulations[0]!.block).toBe(1000n);
    expect(chain.sends).toHaveLength(0);
  });

  it("buys to close a short", async () => {
    const [q] = await engine.prepare(session, [BTC.pool]);
    expect(q!.status).toBe("READY");
    expect(q!.isBid).toBe(true);
    expect(q!.quantity).toBe("13000");
  });

  it("'all' prepares only markets with a position", async () => {
    chain.setPosition(OWNER, BTC.pool, 0n);
    const quotes = await engine.prepare(session, "all");
    expect(quotes.map((q) => q.market)).toEqual(["ETH-PERP"]);
  });

  const blockedCases: [string, () => void, RegExp][] = [
    ["stale mark", () => chain.setFeed(ETH.pool, false, 0n), /stale/],
    ["missing permission", () => chain.revoke(ETH.pool, OWNER, signer.address), /not linked/],
    ["resting orders", () => chain.openOrders.set(`${OWNER}|${ETH.pool}`.toLowerCase(), 2), /resting order/],
    ["thin book", () => chain.setBook(ETH.pool, [{ price: 232792n * 10n ** 16n, quantity: 10n ** 14n }], []), /partially fill/],
    ["empty book", () => chain.setBook(ETH.pool, [], []), /no bids/],
    ["insufficient gas", () => chain.balances.set(signer.address.toLowerCase(), 10n ** 15n), /gas headroom/],
    ["size not a lot multiple", () => chain.setPosition(OWNER, ETH.pool, 4n * 10n ** 15n + 1n), /not a whole number of 0.0001 ETH lots/],
    ["remainder below the minimum", () => chain.setPosition(OWNER, ETH.pool, 10n ** 15n), /0.001 ETH is below this market.s minimum order of 0.004 ETH/],
    ["simulation revert", () => (chain.simOverride = () => ({ ok: false, error: "InsufficientCollateral" })), /InsufficientCollateral/],
    ["touch far from mark", () => chain.setFeed(ETH.pool, true, 2400n * E18), /bps from mark/],
    ["wrong operator registry", () => chain.wiring.set(ETH.pool.toLowerCase(), { marginBank: ETH.marginBank, registry: getAddress("0x15C7e8CE38F021c5b45d098AaD788f63090bF20A") }), /registry/],
    ["flat position", () => chain.setPosition(OWNER, ETH.pool, 0n), /no open position/],
    ["position moving while preparing", () => chain.sizesAtBlock.set(`${OWNER}|${ETH.pool}|1000`.toLowerCase(), 8n * 10n ** 15n), /changed while preparing/],
  ];
  for (const [name, setup, reason] of blockedCases) {
    it(`blocks on ${name}`, async () => {
      setup();
      const [q] = await engine.prepare(session, [ETH.pool]);
      expect(q!.status).toBe("BLOCKED");
      expect(q!.blockers.join(" | ")).toMatch(reason);
      expect(q!.fingerprint).toBe("");
    });
  }

  it("rejects slippage above the server ceiling", async () => {
    await expect(engine.prepare(session, [ETH.pool], 301)).rejects.toBeInstanceOf(EngineError);
  });

  it("rejects unknown pools and the wrong chain", async () => {
    await expect(engine.prepare(session, [getAddress("0x000000000000000000000000000000000000beef")])).rejects.toThrow(/unknown perp pool/);
    chain.chainIdValue = 50312;
    await expect(engine.prepare(session, [ETH.pool])).rejects.toThrow(/expected 50383/);
  });
});

describe("execute: success and verification", () => {
  it("closes, verifies on chain, cross-checks the indexer, sends exactly once", async () => {
    const quotes = await engine.prepare(session, [ETH.pool]);
    const job = await run(quotes);
    const item = job.items[0]!;
    expect(job.status).toBe("DONE");
    expect(item.state).toBe("CLOSED");
    expect(item.txHash).toMatch(/^0x/);
    expect(item.sizeAfter).toBe("0");
    expect(item.sizeAtHead).toBe("0");
    expect(item.filled).toBe(item.quantity);
    expect(item.indexer).toBe("agree");
    expect(chain.sends).toHaveLength(1);
    expect(chain.sends[0]!.quantity).toBe(4n * 10n ** 15n);
  });

  it("reports CLOSED with indexer 'unavailable' when only chain state can be read", async () => {
    chain.indexer = "unavailable";
    const job = await run(await engine.prepare(session, [ETH.pool]));
    expect(job.items[0]!.state).toBe("CLOSED");
    expect(job.items[0]!.indexer).toBe("unavailable");
  });

  it("is AMBIGUOUS, not CLOSED, when the indexer disagrees", async () => {
    chain.indexer = "disagree";
    const job = await run(await engine.prepare(session, [ETH.pool]));
    expect(job.items[0]!.state).toBe("AMBIGUOUS");
  });

  it("is AMBIGUOUS when the position is zero but decoded fills do not match", async () => {
    chain.sendBehavior.set(ETH.pool.toLowerCase(), { kind: "fill-but-fills-say", filled: 10n ** 15n });
    const job = await run(await engine.prepare(session, [ETH.pool]));
    expect(job.items[0]!.state).toBe("AMBIGUOUS");
  });
});

describe("execute: guards before sending", () => {
  it("refuses when execution is disabled, and sends nothing", async () => {
    engine = makeEngine(false);
    const quotes = await engine.prepare(session, [ETH.pool]);
    expect(() => engine.execute(session, [quotes[0]!.id], crypto.randomUUID(), () => signer)).toThrow(/disabled/);
    expect(chain.sends).toHaveLength(0);
  });

  it("refuses blocked, expired, reused and foreign quotes", async () => {
    chain.setFeed(BTC.pool, false, 0n);
    const quotes = await engine.prepare(session, [ETH.pool, BTC.pool]);
    const eth = quotes.find((q) => q.market === "ETH-PERP")!;
    const btc = quotes.find((q) => q.market === "BTC-PERP")!;
    expect(() => engine.execute(session, [btc.id], crypto.randomUUID(), () => signer)).toThrow(/blocked/);
    expect(() => engine.execute({ ...session, id: "intruder" }, [eth.id], crypto.randomUUID(), () => signer)).toThrow(/not found/);
    clock += DEFAULT_SETTINGS.quoteTtlMs + 1;
    expect(() => engine.execute(session, [eth.id], crypto.randomUUID(), () => signer)).toThrow(/expired/);
    clock -= DEFAULT_SETTINGS.quoteTtlMs + 1;
    await run([eth]);
    expect(() => engine.execute(session, [eth.id], crypto.randomUUID(), () => signer)).toThrow(/already used/);
    expect(chain.sends).toHaveLength(1);
  });

  it("is idempotent: the same key returns the same job and sends once", async () => {
    const quotes = await engine.prepare(session, [ETH.pool]);
    const key = crypto.randomUUID();
    const a = engine.execute(session, [quotes[0]!.id], key, () => signer);
    const b = engine.execute(session, [quotes[0]!.id], key, () => signer);
    expect(b.id).toBe(a.id);
    await engine.settle(a.id);
    expect(chain.sends).toHaveLength(1);
  });

  const abortCases: [string, () => void, RegExp][] = [
    ["position changed after confirmation", () => chain.setPosition(OWNER, ETH.pool, 6n * 10n ** 15n), /position changed/],
    ["permission revoked after confirmation", () => chain.revoke(ETH.pool, OWNER, signer.address), /no longer authorized/],
    ["market moved past the confirmed price limit", () => chain.setBook(ETH.pool, [{ price: 2300n * E18, quantity: E18 }], []), /moved past/],
    ["mark went stale", () => chain.setFeed(ETH.pool, false, 0n), /stale/],
    ["gas ran low", () => chain.balances.set(signer.address.toLowerCase(), 0n), /gas headroom/],
    ["resting order appeared", () => chain.openOrders.set(`${OWNER}|${ETH.pool}`.toLowerCase(), 1), /resting orders/],
    ["simulation now reverts", () => (chain.simOverride = () => ({ ok: false, error: "MarketRestricted" })), /MarketRestricted/],
  ];
  for (const [name, change, reason] of abortCases) {
    it(`aborts without sending when the ${name}`, async () => {
      const quotes = await engine.prepare(session, [ETH.pool]);
      change();
      const job = await run(quotes);
      expect(job.items[0]!.state).toBe("ABORTED");
      expect(job.items[0]!.message).toMatch(reason);
      expect(job.items[0]!.message).toMatch(/no transaction sent/);
      expect(chain.sends).toHaveLength(0);
    });
  }
});

describe("execute: outcomes after sending", () => {
  it("reports PARTIAL with the remainder and never retries", async () => {
    chain.sendBehavior.set(ETH.pool.toLowerCase(), { kind: "partial", remaining: 10n ** 15n });
    const job = await run(await engine.prepare(session, [ETH.pool]));
    expect(job.items[0]!.state).toBe("PARTIAL");
    expect(job.items[0]!.sizeAfter).toBe((10n ** 15n).toString());
    expect(job.items[0]!.message).toMatch(/Not retried/);
    expect(chain.sends).toHaveLength(1);
  });

  it("reports FLIPPED and skips the remaining closes", async () => {
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "flip", to: 1000n });
    const job = await run(await engine.prepare(session, "all"));
    expect(job.status).toBe("HALTED");
    expect(job.items.map((i) => i.state)).toEqual(["FLIPPED", "SKIPPED"]);
    expect(chain.sends).toHaveLength(1);
  });

  it("reports FAILED on a revert with the position unchanged, then continues", async () => {
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "revert" });
    const job = await run(await engine.prepare(session, "all"));
    const byMarket = Object.fromEntries(job.items.map((i) => [i.market, i.state]));
    expect(byMarket).toEqual({ "BTC-PERP": "FAILED", "ETH-PERP": "CLOSED" });
    expect(job.status).toBe("DONE");
  });

  it("reports FAILED when confirmed with no fill", async () => {
    chain.sendBehavior.set(ETH.pool.toLowerCase(), { kind: "no-fill" });
    const job = await run(await engine.prepare(session, [ETH.pool]));
    expect(job.items[0]!.state).toBe("FAILED");
    expect(job.items[0]!.message).toMatch(/nothing filled/);
  });

  it("reports UNKNOWN on a receipt timeout and halts the rest", async () => {
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "timeout" });
    const job = await run(await engine.prepare(session, "all"));
    expect(job.items.map((i) => i.state)).toEqual(["UNKNOWN", "SKIPPED"]);
    expect(job.status).toBe("HALTED");
    expect(chain.sends).toHaveLength(1);
  });

  it("reports FAILED when submission fails before signing", async () => {
    chain.sendBehavior.set(ETH.pool.toLowerCase(), { kind: "throw", message: "insufficient funds for gas" });
    const job = await run(await engine.prepare(session, [ETH.pool]));
    expect(job.items[0]!.state).toBe("FAILED");
    expect(job.items[0]!.message).toMatch(/not submitted/);
  });

  it("treats a broadcast error after signing as UNKNOWN, keeps the hash, and halts", async () => {
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "broadcast-error", message: "request timed out" });
    const job = await run(await engine.prepare(session, "all"));
    expect(job.items.map((i) => i.state)).toEqual(["UNKNOWN", "SKIPPED"]);
    expect(job.items[0]!.txHash).toMatch(/^0x/);
  });
});

describe("no second close while an earlier one is unresolved", () => {
  it("blocks prepare after a receipt timeout until the receipt turns up", async () => {
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "timeout" });
    const first = await run(await engine.prepare(session, [BTC.pool]));
    expect(first.items[0]!.state).toBe("UNKNOWN");

    chain.sendBehavior.delete(BTC.pool.toLowerCase());
    const blocked = await engine.prepare(session, "all");
    expect(blocked.every((q) => q.status === "BLOCKED")).toBe(true);
    expect(blocked[0]!.blockers[0]).toMatch(/still has no receipt.*reverse the position/);

    chain.deliverLateReceipt(first.items[0]!.txHash as `0x${string}`);
    const again = await engine.prepare(session, [ETH.pool]);
    expect(again[0]!.status).toBe("READY");
    expect(engine.job(first.id, session.id).items[0]!.lateReceipt?.status).toBe("success");
  });

  it("blocks after a broadcast error, and aborts a confirmed quote whose run starts after it", async () => {
    const etQuote = await engine.prepare(session, [ETH.pool]);
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "broadcast-error", message: "connection reset" });
    const btcJob = engine.execute(session, (await engine.prepare(session, [BTC.pool])).map((q) => q.id), crypto.randomUUID(), () => signer);
    const ethJob = engine.execute(session, etQuote.map((q) => q.id), crypto.randomUUID(), () => signer);
    await engine.settle(btcJob.id);
    await engine.settle(ethJob.id);
    const eth = engine.job(ethJob.id, session.id).items[0]!;
    expect(eth.state).toBe("ABORTED");
    expect(eth.message).toMatch(/still has no receipt/);
    expect(chain.sends.map((s) => s.pool)).toEqual([BTC.pool]);
  });

  it("blocks while the operator has unmined transactions", async () => {
    const quotes = await engine.prepare(session, [ETH.pool]);
    chain.pendingByAddress.set(signer.address.toLowerCase(), 1);
    expect((await engine.prepare(session, [ETH.pool]))[0]!.blockers.join(" ")).toMatch(/not mined/);
    const job = await run(quotes);
    expect(job.items[0]!.state).toBe("ABORTED");
    expect(chain.sends).toHaveLength(0);
  });

  it("runs Close All sequentially in quote order and continues past an aborted item", async () => {
    const quotes = await engine.prepare(session, "all");
    chain.setPosition(OWNER, BTC.pool, -26000n); // BTC changes after confirmation
    const job = await run(quotes);
    expect(job.items.map((i) => [i.market, i.state])).toEqual([
      ["BTC-PERP", "ABORTED"],
      ["ETH-PERP", "CLOSED"],
    ]);
    expect(chain.sends.map((s) => s.pool)).toEqual([ETH.pool]);
  });
});

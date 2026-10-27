// MOCKED end-to-end tests of the HTTP API: real Store (in-memory SQLite), real
// Keystore, real Engine, FakeChain instead of the network.

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { CSRF_HEADER, SESSION_COOKIE, createApi } from "../server/api.js";
import { DEFAULT_SETTINGS } from "../server/engine/config.js";
import { Engine } from "../server/engine/engine.js";
import { Keystore } from "../server/keystore.js";
import { Store } from "../server/store.js";
import { BTC, ETH, FakeChain, OWNER } from "./fake-chain.js";

let chain: FakeChain;
let store: Store;
let keystore: Keystore;
let engine: Engine;
let app: ReturnType<typeof createApi>;
const responses: string[] = [];

function build(executionEnabled = true) {
  chain = new FakeChain();
  store = new Store(":memory:");
  keystore = new Keystore(randomBytes(32).toString("hex"));
  engine = new Engine(chain, store, { ...DEFAULT_SETTINGS, indexerWaitMs: 0 }, { executionEnabled, sleep: async () => {} });
  app = createApi({ engine, store, keystore, cookieSecure: false, log: () => {} });
}

beforeEach(() => {
  build();
  responses.length = 0;
});

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; csrf?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.csrf !== false) headers[CSRF_HEADER] = "1";
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  responses.push(text + (res.headers.get("set-cookie") ?? ""));
  return { status: res.status, json: text ? JSON.parse(text) : undefined, setCookie: res.headers.get("set-cookie") ?? "" };
}

async function connect(owner: Address = OWNER) {
  const r = await call("POST", "/api/session", { body: { owner } });
  expect(r.status).toBe(201);
  const token = /pb_session=([^;]+)/.exec(r.setCookie)![1]!;
  return { token, operator: r.json.operator as Address };
}

/** Make the venue healthy for this session's operator (the user linked it in dreamDEX). */
function linkAndFund(operator: Address) {
  const healthy = FakeChain.healthy(operator);
  Object.assign(chain, healthy);
}

describe("sessions", () => {
  it("rejects writes without the CSRF header", async () => {
    const r = await call("POST", "/api/session", { body: { owner: OWNER }, csrf: false });
    expect(r.status).toBe(403);
  });

  it("validates the owner address", async () => {
    expect((await call("POST", "/api/session", { body: { owner: "0x123" } })).status).toBe(400);
    expect((await call("POST", "/api/session", { body: { owner: "0x0000000000000000000000000000000000000000" } })).status).toBe(400);
  });

  it("issues an httpOnly, SameSite=Strict cookie and a unique operator per session", async () => {
    const a = await call("POST", "/api/session", { body: { owner: OWNER } });
    expect(a.setCookie).toMatch(/HttpOnly/);
    expect(a.setCookie).toMatch(/SameSite=Strict/);
    const b = await connect();
    expect(b.operator).not.toBe(a.json.operator);
  });

  it("requires a session for account routes", async () => {
    expect((await call("GET", "/api/positions")).status).toBe(401);
    expect((await call("POST", "/api/close/prepare", { body: { all: true } })).status).toBe(401);
  });
});

describe("close flow", () => {
  it("prepare -> execute -> verified CLOSED, and never leaks key material", async () => {
    const { token, operator } = await connect();
    linkAndFund(operator);

    const link = await call("GET", "/api/session/link", { cookie: token });
    expect(link.json.coverage.linked).toEqual(["BTC-PERP", "ETH-PERP"]);
    expect(link.json.funds.sufficient).toBe(true);

    const pos = await call("GET", "/api/positions", { cookie: token });
    expect(pos.json.positions.map((p: { market: string; side: string }) => `${p.market}:${p.side}`)).toEqual(["BTC-PERP:short", "ETH-PERP:long"]);

    const prep = await call("POST", "/api/close/prepare", { cookie: token, body: { pools: [ETH.pool], slippageBps: 50 } });
    expect(prep.status).toBe(200);
    const quote = prep.json.quotes[0];
    expect(quote.status).toBe("READY");

    const exec = await call("POST", "/api/close/execute", { cookie: token, body: { quoteIds: [quote.id], idempotencyKey: crypto.randomUUID() } });
    expect(exec.status).toBe(202);
    await engine.settle(exec.json.job.id);
    const job = await call("GET", `/api/jobs/${exec.json.job.id}`, { cookie: token });
    expect(job.json.job.items[0].state).toBe("CLOSED");
    expect(chain.sends).toHaveLength(1);

    // No response, header or cookie contains the operator's private key or its ciphertext.
    const row = store.sessionByToken(token)!;
    const privateKey = (keystore as unknown as { decrypt(e: string): string }).decrypt(row.encryptedKey);
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    const all = responses.join("\n").toLowerCase();
    expect(all).not.toContain(privateKey.slice(2).toLowerCase());
    expect(all).not.toContain(row.encryptedKey.toLowerCase());
  });

  it("blocks closes for an owner who never linked this session's operator", async () => {
    const victim = await connect();
    linkAndFund(victim.operator); // the real owner linked THEIR session's operator
    const intruder = await connect(); // same owner address typed by someone else
    const prep = await call("POST", "/api/close/prepare", { cookie: intruder.token, body: { all: true } });
    expect(prep.json.quotes.every((q: { status: string }) => q.status === "BLOCKED")).toBe(true);
    expect(prep.json.quotes[0].blockers.join(" ")).toMatch(/not linked/);
  });

  it("does not let one session read or execute another session's quotes or jobs", async () => {
    const a = await connect();
    linkAndFund(a.operator);
    const prep = await call("POST", "/api/close/prepare", { cookie: a.token, body: { pools: [BTC.pool] } });
    const b = await connect();
    const steal = await call("POST", "/api/close/execute", {
      cookie: b.token,
      body: { quoteIds: [prep.json.quotes[0].id], idempotencyKey: crypto.randomUUID() },
    });
    expect(steal.status).toBe(404);
    const exec = await call("POST", "/api/close/execute", {
      cookie: a.token,
      body: { quoteIds: [prep.json.quotes[0].id], idempotencyKey: crypto.randomUUID() },
    });
    await engine.settle(exec.json.job.id);
    expect((await call("GET", `/api/jobs/${exec.json.job.id}`, { cookie: b.token })).status).toBe(404);
  });

  it("returns 403 and sends nothing when execution is disabled", async () => {
    build(false);
    const { token, operator } = await connect();
    linkAndFund(operator);
    const prep = await call("POST", "/api/close/prepare", { cookie: token, body: { all: true } });
    expect(prep.json.quotes.every((q: { status: string }) => q.status === "READY")).toBe(true);
    const exec = await call("POST", "/api/close/execute", {
      cookie: token,
      body: { quoteIds: [prep.json.quotes[0].id], idempotencyKey: crypto.randomUUID() },
    });
    expect(exec.status).toBe(403);
    expect(chain.sends).toHaveLength(0);
  });

  it("concurrent duplicate confirmations submit exactly one close", async () => {
    const { token, operator } = await connect();
    linkAndFund(operator);
    const prep = await call("POST", "/api/close/prepare", { cookie: token, body: { pools: [ETH.pool] } });
    const quoteIds = [prep.json.quotes[0].id];
    const key = crypto.randomUUID();
    // Same idempotency key, fired together: one job.
    const same = await Promise.all([1, 2, 3].map(() => call("POST", "/api/close/execute", { cookie: token, body: { quoteIds, idempotencyKey: key } })));
    expect(new Set(same.map((r) => r.json.job.id)).size).toBe(1);
    // Different keys, same quote, fired together: the quote is consumed once.
    const other = await Promise.all([1, 2].map(() => call("POST", "/api/close/execute", { cookie: token, body: { quoteIds, idempotencyKey: crypto.randomUUID() } })));
    expect(other.map((r) => r.status)).toEqual([409, 409]);
    await engine.settle(same[0]!.json.job.id);
    expect(chain.sends).toHaveLength(1);
  });

  it("marks jobs cut off by a restart as halted, never as still running", async () => {
    const { token, operator } = await connect();
    linkAndFund(operator);
    const row = store.sessionByToken(token)!;
    store.saveJob({
      id: "j-interrupted",
      sessionId: row.id,
      idempotencyKey: "k",
      createdAt: 0,
      status: "RUNNING",
      items: [
        { quoteId: "a", pool: BTC.pool, market: "BTC-PERP", baseDecimals: 8, state: "CONFIRMING", message: "", quantity: "13000", sizeBefore: "-13000", txHash: "0xabc" },
        { quoteId: "b", pool: ETH.pool, market: "ETH-PERP", baseDecimals: 18, state: "PENDING", message: "", quantity: "1", sizeBefore: "1" },
      ],
    });
    expect(store.recoverInterruptedJobs()).toBe(1);
    const job = (await call("GET", "/api/jobs/j-interrupted", { cookie: token })).json.job;
    expect(job.status).toBe("HALTED");
    expect(job.items.map((i: { state: string }) => i.state)).toEqual(["UNKNOWN", "SKIPPED"]);
    // The unresolved hash now blocks new closes for this session.
    const prep = await call("POST", "/api/close/prepare", { cookie: token, body: { all: true } });
    expect(prep.json.quotes.every((q: { status: string }) => q.status === "BLOCKED")).toBe(true);
  });

  it("rejects requests for an unknown Host when an allowlist is set", async () => {
    const guarded = createApi({ engine, store, keystore, cookieSecure: false, allowedHosts: ["127.0.0.1", "localhost"], log: () => {} });
    expect((await guarded.request("http://evil.example/api/health")).status).toBe(421);
    expect((await guarded.request("http://localhost:8787/api/health")).status).toBe(200);
  });

  it("rejects malformed bodies and slippage above the ceiling", async () => {
    const { token, operator } = await connect();
    linkAndFund(operator);
    expect((await call("POST", "/api/close/prepare", { cookie: token, body: { pools: [ETH.pool], all: true } })).status).toBe(400);
    expect((await call("POST", "/api/close/prepare", { cookie: token, body: { pools: [ETH.pool], slippageBps: 301 } })).status).toBe(400);
    expect((await call("POST", "/api/close/execute", { cookie: token, body: { quoteIds: ["x"], idempotencyKey: "y" } })).status).toBe(400);
  });
});

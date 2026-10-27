// MOCK server for browser QA only. Real API + Engine + Store + Keystore over the
// scripted FakeChain, with delays so progress states are visible. Never touches a
// network and never sends a real transaction. Not part of the production build.
//
//   QA_SCENARIO=mixed npx tsx test/qa-server.ts     (then open http://127.0.0.1:8788)
//
// Scenarios: mixed (ETH fills, BTC partially fills), unlinked, empty, blocked
// (BTC mark stale), flip (BTC reverses, ETH skipped), timeout, disabled.
// Connect with owner 0x1111111111111111111111111111111111111111.

import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Account, Address, Hex } from "viem";
import { createApi } from "../server/api.js";
import type { CloseCall } from "../server/engine/chain.js";
import { DEFAULT_SETTINGS } from "../server/engine/config.js";
import { Engine } from "../server/engine/engine.js";
import { Keystore } from "../server/keystore.js";
import { Store } from "../server/store.js";
import { BTC, E18, ETH, FakeChain, OWNER } from "./fake-chain.js";

const scenario = process.env.QA_SCENARIO ?? "mixed";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

class QaChain extends FakeChain {
  override async isAuthorized(pool: Address, owner: Address) {
    return scenario !== "unlinked" && owner === OWNER && this.marketList.some((m) => m.pool === pool);
  }
  override async balance() {
    return scenario === "unlinked" ? 0n : E18 / 5n;
  }
  override async simulateClose(call: CloseCall, gas: bigint, block?: bigint) {
    await delay(400);
    return super.simulateClose(call, gas, block);
  }
  override async sendClose(call: CloseCall, gas: bigint, signer: Account): Promise<Hex> {
    await delay(700);
    return super.sendClose(call, gas, signer);
  }
  override async waitReceipt(hash: Hex) {
    await delay(1200);
    return super.waitReceipt(hash);
  }
  override async positionChanges(hash: Hex) {
    await delay(300);
    return super.positionChanges(hash);
  }
}

const chain = new QaChain();
const seed = FakeChain.healthy(OWNER);
for (const k of ["sizes", "entries", "books", "feeds"] as const) (chain as unknown as Record<string, unknown>)[k] = seed[k];
// The QA operator is generated per session, so the simulation ignores the fake's grant set.
chain.simOverride = () => (scenario === "unlinked" ? { ok: false, error: "OnlyApprovedContracts" } : { ok: true, orderId: 7n });

if (scenario === "empty") {
  chain.setPosition(OWNER, ETH.pool, 0n);
  chain.setPosition(OWNER, BTC.pool, 0n);
}
if (scenario === "mixed") chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "partial", remaining: -4000n });
if (scenario === "blocked") chain.setFeed(BTC.pool, false, 0n);
if (scenario === "flip") chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "flip", to: 2000n });
if (scenario === "timeout") chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "timeout" });

const store = new Store(":memory:");
const keystore = new Keystore(randomBytes(32).toString("hex"));
const engine = new Engine(chain, store, { ...DEFAULT_SETTINGS, indexerWaitMs: 0 }, { executionEnabled: scenario !== "disabled" });
// QA_TELEGRAM=1 shows the Telegram linking UI. No bot runs; POST /qa/telegram-link/CODE
// does what the bot does on "/link CODE" so the linked state can be clicked through.
const qaTelegram = process.env.QA_TELEGRAM === "1";
const app = createApi({ engine, store, keystore, cookieSecure: false, telegram: qaTelegram ? { username: "PanicButtonQaBot" } : undefined });
if (qaTelegram)
  app.post("/qa/telegram-link/:code", (c) => {
    const sessionId = store.consumeLinkCode(c.req.param("code"), Date.now());
    if (!sessionId) return c.json({ error: "invalid or expired code" }, 400);
    store.linkTelegram("424242", sessionId, Date.now());
    return c.json({ ok: true });
  });
app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("*", serveStatic({ root: "./dist/web", path: "index.html" }));

const port = Number(process.env.PORT ?? 8788);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.log(`QA MOCK server (${scenario}) on http://127.0.0.1:${port}`));

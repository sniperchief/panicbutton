// MOCKED tests of the Telegram bot: real Store (in-memory SQLite), real Keystore,
// real Engine and HTTP API, FakeChain instead of the venue and a recording fake
// instead of Telegram. Nothing touches a network.

import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Address } from "viem";
import { CSRF_HEADER, SESSION_COOKIE, createApi } from "../server/api.js";
import { DEFAULT_SETTINGS } from "../server/engine/config.js";
import { Engine } from "../server/engine/engine.js";
import { Keystore } from "../server/keystore.js";
import { Store, type TelegramAction } from "../server/store.js";
import { LINK_CODE_TTL_MS, TelegramBot } from "../server/telegram/bot.js";
import { HttpTelegram, type Button, type TelegramApi, type TgUpdate } from "../server/telegram/client.js";
import { decideAlert, liquidationDistanceBps, parseThreshold } from "../server/telegram/alerts.js";
import { BTC, E18, ETH, FakeChain, OWNER } from "./fake-chain.js";

class FakeTelegram implements TelegramApi {
  sent: { chatId: string; text: string; buttons?: Button[][]; messageId: number }[] = [];
  edits: { chatId: string; messageId: number; text: string }[] = [];
  answers: { id: string; text?: string }[] = [];
  private nextId = 100;
  async sendMessage(chatId: string, text: string, buttons?: Button[][]) {
    const messageId = this.nextId++;
    this.sent.push({ chatId, text, buttons, messageId });
    return { messageId };
  }
  async editMessage(chatId: string, messageId: number, text: string) {
    this.edits.push({ chatId, messageId, text });
  }
  async answerCallback(id: string, text?: string) {
    this.answers.push({ id, text });
  }
  last(chatId: number) {
    return [...this.sent].reverse().find((m) => m.chatId === String(chatId))!;
  }
  lastAnswer() {
    return this.answers[this.answers.length - 1]?.text;
  }
  everything() {
    return [...this.sent.map((m) => m.text + JSON.stringify(m.buttons ?? [])), ...this.edits.map((e) => e.text), ...this.answers.map((a) => a.text ?? "")].join("\n");
  }
}

let chain: FakeChain;
let store: Store;
let keystore: Keystore;
let engine: Engine;
let app: ReturnType<typeof createApi>;
let tg: FakeTelegram;
let bot: TelegramBot;
let clock: number;
let logs: string[];
let nextUpdate: number;
const responses: string[] = [];

function build(executionEnabled = true) {
  chain = new FakeChain();
  store = new Store(":memory:");
  keystore = new Keystore(randomBytes(32).toString("hex"));
  clock = Date.now();
  engine = new Engine(chain, store, { ...DEFAULT_SETTINGS, indexerWaitMs: 0 }, { executionEnabled, now: () => clock, sleep: async () => {} });
  logs = [];
  app = createApi({ engine, store, keystore, cookieSecure: false, log: (l) => logs.push(l), telegram: { username: "pb_test_bot" } });
  tg = new FakeTelegram();
  bot = newBot();
  nextUpdate = 1;
  responses.length = 0;
}

const newBot = () => new TelegramBot({ engine, store, keystore, tg, now: () => clock, log: (l) => logs.push(l) });

beforeEach(() => build());

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) {
  const headers: Record<string, string> = { [CSRF_HEADER]: "1" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${opts.cookie}`;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, json: text ? JSON.parse(text) : undefined, setCookie: res.headers.get("set-cookie") ?? "" };
}

async function connect() {
  const r = await call("POST", "/api/session", { body: { owner: "0x1111111111111111111111111111111111111111" } });
  const token = /pb_session=([^;]+)/.exec(r.setCookie)![1]!;
  return { token, operator: r.json.operator as Address, sessionId: store.sessionByToken(token)!.id };
}

const msg = (from: number, text: string, chat: { id?: number; type?: "private" | "group" } = {}): TgUpdate => ({
  update_id: nextUpdate++,
  message: { message_id: nextUpdate, from: { id: from }, chat: { id: chat.id ?? from, type: chat.type ?? "private" }, date: 0, text },
});

const press = (from: number, data: string, chat: { id?: number; type?: "private" | "group" } = {}): TgUpdate => ({
  update_id: nextUpdate++,
  callback_query: { id: `cb${nextUpdate}`, from: { id: from }, message: { message_id: 1, chat: { id: chat.id ?? from, type: chat.type ?? "private" }, date: 0 }, data },
});

const send = (u: TgUpdate) => bot.handleUpdate(u);

async function newCode(token: string) {
  const r = await call("POST", "/api/telegram/link-code", { cookie: token, body: {} });
  expect(r.status).toBe(200);
  return r.json.code as string;
}

/** A web session whose operator the owner linked in dreamDEX, linked to Telegram user `tgId`. */
async function linkedUser(tgId: number, opts: { fund?: boolean } = {}) {
  const s = await connect();
  if (opts.fund !== false) Object.assign(chain, FakeChain.healthy(s.operator));
  const code = await newCode(s.token);
  await send(msg(tgId, `/link ${code}`));
  expect(store.telegramSession(String(tgId))).toBe(s.sessionId);
  return { ...s, code };
}

/** The confirm / cancel callback data on the user's latest offer. */
function offerButtons(tgId: number) {
  const m = tg.last(tgId);
  expect(m.buttons, m.text).toBeDefined();
  return { ok: m.buttons![0]![0]!.data, no: m.buttons![0]![1]!.data, text: m.text };
}

function actions(): TelegramAction[] {
  return (["PENDING", "EXECUTING", "REPORTED", "CANCELLED", "EXPIRED"] as const).flatMap((s) => store.telegramActionsInState(s));
}

/** Let running jobs finish, then run the reporter. */
async function finish() {
  for (const a of store.telegramActionsInState("EXECUTING")) if (a.jobId) await engine.settle(a.jobId);
  await bot.tick();
}

async function prepareClose(tgId: number, pool: Address) {
  await send(msg(tgId, "/close"));
  await send(press(tgId, `sel:${pool}`));
  return offerButtons(tgId);
}

describe("linking", () => {
  it("/start explains the bot and the linking flow without touching any account", async () => {
    await send(msg(7, "/start"));
    expect(tg.last(7).text).toMatch(/one-time code/);
    expect(tg.last(7).text).toMatch(/\/link CODE/);
    expect(chain.simulations).toHaveLength(0);
  });

  it("only an authenticated web session can create a code", async () => {
    expect((await call("POST", "/api/telegram/link-code", { body: {} })).status).toBe(401);
    const s = await connect();
    const code = await newCode(s.token);
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
  });

  it("links with a valid code, bound to the numeric Telegram id, and reports the account", async () => {
    const s = await linkedUser(7);
    expect(tg.last(7).text).toMatch(/Linked to dreamDEX account 0x1111…1111/);
    expect((await call("GET", "/api/telegram", { cookie: s.token })).json).toMatchObject({ enabled: true, linked: true, botUsername: "pb_test_bot" });
  });

  it("supports the /start deep-link form", async () => {
    const s = await connect();
    const code = await newCode(s.token);
    await send(msg(7, `/start ${code}`));
    expect(store.telegramSession("7")).toBe(s.sessionId);
  });

  it("rejects a reused code: a second Telegram user cannot use it", async () => {
    const a = await linkedUser(7);
    await send(msg(8, `/link ${a.code}`));
    expect(tg.last(8).text).toMatch(/invalid, expired or already used/);
    expect(store.telegramSession("8")).toBeUndefined();
    expect(store.telegramSession("7")).toBe(a.sessionId);
  });

  it("rejects an expired code", async () => {
    const s = await connect();
    const code = await newCode(s.token);
    // The API stamps codes with the real clock.
    clock = Date.now() + LINK_CODE_TTL_MS + 1;
    await send(msg(7, `/link ${code}`));
    expect(tg.last(7).text).toMatch(/invalid, expired or already used/);
    expect(store.telegramSession("7")).toBeUndefined();
  });

  it("a new code invalidates the previous unused one", async () => {
    const s = await connect();
    const first = await newCode(s.token);
    await newCode(s.token);
    await send(msg(7, `/link ${first}`));
    expect(store.telegramSession("7")).toBeUndefined();
  });

  it("rate-limits guessing: after 5 wrong attempts even a valid code is refused", async () => {
    const s = await connect();
    const code = await newCode(s.token);
    for (let i = 0; i < 5; i++) await send(msg(7, "/link AAAAAAAAAA"));
    await send(msg(7, `/link ${code}`));
    expect(tg.last(7).text).toMatch(/Too many link attempts/);
    expect(store.telegramSession("7")).toBeUndefined();
    // The refused attempt did not consume the code.
    await send(msg(9, `/link ${code}`));
    expect(store.telegramSession("9")).toBe(s.sessionId);
  });

  it("refuses group chats and does not consume the code there", async () => {
    const s = await connect();
    const code = await newCode(s.token);
    await send(msg(7, `/link ${code}`, { id: -500, type: "group" }));
    expect(tg.last(-500).text).toMatch(/private chat/);
    expect(store.telegramSession("7")).toBeUndefined();
    await send(msg(7, `/link ${code}`));
    expect(store.telegramSession("7")).toBe(s.sessionId);
  });

  it("answers 409 for a code when the bot is not configured", async () => {
    app = createApi({ engine, store, keystore, cookieSecure: false, log: () => {} });
    const s = await connect();
    expect((await call("POST", "/api/telegram/link-code", { cookie: s.token, body: {} })).status).toBe(409);
    expect((await call("GET", "/api/telegram", { cookie: s.token })).json.enabled).toBe(false);
  });

  it("relinking a session to a new Telegram user removes the old user's access", async () => {
    const s = await linkedUser(7);
    const code = await newCode(s.token);
    await send(msg(8, `/link ${code}`));
    expect(store.telegramSession("8")).toBe(s.sessionId);
    expect(store.telegramSession("7")).toBeUndefined();
  });
});

describe("authorization", () => {
  it("an unlinked Telegram user gets no data and causes no chain activity", async () => {
    const s = await connect();
    Object.assign(chain, FakeChain.healthy(s.operator));
    for (const c of ["/positions", "/close", "/closeall"]) {
      await send(msg(7, c));
      expect(tg.last(7).text).toMatch(/not linked/);
    }
    await send(press(7, `sel:${ETH.pool}`));
    expect(tg.lastAnswer()).toMatch(/not linked/);
    expect(chain.simulations).toHaveLength(0);
  });

  it("another user cannot confirm or cancel someone else's pending close", async () => {
    await linkedUser(7);
    const { ok, no } = await prepareClose(7, ETH.pool);
    // A different linked user (own session) and an unlinked user try the victim's buttons.
    const other = await connect();
    await send(msg(8, `/link ${await newCode(other.token)}`));
    for (const data of [ok, no]) {
      await send(press(8, data));
      expect(tg.lastAnswer()).toMatch(/not valid for your account/);
      await send(press(9, data));
      expect(tg.lastAnswer()).toMatch(/not linked/);
    }
    // Same user, but the callback arrives from another chat.
    await send(press(7, ok, { id: -500, type: "group" }));
    expect(tg.lastAnswer()).toMatch(/Not available/);
    expect(chain.sends).toHaveLength(0);
    expect(store.telegramActionsInState("PENDING")).toHaveLength(1);
    // The owner can still confirm.
    await send(press(7, ok));
    await finish();
    expect(chain.sends).toHaveLength(1);
  });

  it("disconnecting the web session removes Telegram access", async () => {
    const s = await linkedUser(7);
    await call("DELETE", "/api/session", { cookie: s.token });
    await send(msg(7, "/positions"));
    expect(tg.last(7).text).toMatch(/not linked/);
  });
});

describe("commands", () => {
  it("/positions lists market, side, size and PnL", async () => {
    await linkedUser(7);
    await send(msg(7, "/positions"));
    const t = tg.last(7).text;
    expect(t).toMatch(/BTC-PERP SHORT 0\.00013 BTC/);
    expect(t).toMatch(/ETH-PERP LONG 0\.004 ETH/);
    expect(t).toMatch(/PnL .* USDso/);
  });

  it("/close shows side, quantity, price cap and expiry, and sends nothing until confirmed", async () => {
    await linkedUser(7);
    await send(msg(7, "/close"));
    expect(tg.last(7).buttons!.map((r) => r[0]!.data)).toEqual([`sel:${BTC.pool}`, `sel:${ETH.pool}`]);
    await send(press(7, `sel:${ETH.pool}`));
    const { text } = offerButtons(7);
    expect(text).toMatch(/Order: SELL 0\.004 ETH, immediate-or-cancel/);
    expect(text).toMatch(/Worst accepted price: 2316\.29/);
    expect(text).toMatch(/Confirm by \d\d:\d\d:\d\d UTC \(60 s\)/);
    expect(chain.sends).toHaveLength(0);
  });

  it("confirm -> verified CLOSED report with the tx hash; nothing is called success before verification", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    await send(press(7, ok));
    expect(tg.everything()).not.toMatch(/CLOSED/);
    expect(tg.edits[tg.edits.length - 1]!.text).toMatch(/not success/);
    await finish();
    const report = tg.last(7).text;
    expect(report).toMatch(/all 1 position\(s\) closed and verified on chain/);
    expect(report).toMatch(/ETH-PERP: ✅ CLOSED/);
    expect(report).toMatch(/tx 0x0{63}1/);
    expect(chain.sends).toHaveLength(1);
  });

  it("refuses with execution disabled and says nothing was sent", async () => {
    build(false);
    await linkedUser(7);
    const { ok, text } = await prepareClose(7, ETH.pool);
    expect(text).toMatch(/Execution is DISABLED/);
    await send(press(7, ok));
    expect(tg.edits[tg.edits.length - 1]!.text).toMatch(/Not executed: execution is disabled.*Nothing was sent/);
    expect(chain.sends).toHaveLength(0);
    expect(store.getTelegramAction(ok.slice(3))!.state).toBe("REPORTED");
  });

  it("/cancel cancels a pending confirmation before execution", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    await send(msg(7, "/cancel"));
    expect(tg.last(7).text).toMatch(/Cancelled 1 pending confirmation/);
    await send(press(7, ok));
    expect(tg.lastAnswer()).toMatch(/cancelled/);
    expect(chain.sends).toHaveLength(0);
    await send(msg(7, "/cancel"));
    expect(tg.last(7).text).toBe("Nothing to cancel.");
  });

  it("the Cancel button cancels, and a newer request replaces an older one", async () => {
    await linkedUser(7);
    const first = await prepareClose(7, ETH.pool);
    const second = await prepareClose(7, BTC.pool);
    await send(press(7, first.ok));
    expect(tg.lastAnswer()).toMatch(/cancelled/);
    await send(press(7, second.no));
    expect(tg.lastAnswer()).toBe("Cancelled.");
    expect(chain.sends).toHaveLength(0);
  });

  it("/cancel cannot stop a close that is already executing", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    await send(press(7, ok));
    await send(msg(7, "/cancel"));
    expect(tg.last(7).text).toMatch(/already executing and cannot be cancelled/);
    await finish();
  });

  it("an expired confirmation sends nothing", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    clock += DEFAULT_SETTINGS.quoteTtlMs + 1;
    await send(press(7, ok));
    expect(tg.lastAnswer()).toMatch(/Expired/);
    expect(chain.sends).toHaveLength(0);
    expect(store.getTelegramAction(ok.slice(3))!.state).toBe("EXPIRED");
  });

  it("the reporter expires stale confirmations and removes their buttons", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    clock += DEFAULT_SETTINGS.quoteTtlMs + 1;
    await bot.tick();
    expect(store.getTelegramAction(ok.slice(3))!.state).toBe("EXPIRED");
    expect(tg.edits[tg.edits.length - 1]!.text).toMatch(/Expired. Nothing was sent/);
  });

  it("a blocked quote offers no confirm button", async () => {
    await linkedUser(7);
    chain.openOrders.set(`${"0x1111111111111111111111111111111111111111"}|${ETH.pool.toLowerCase()}`, 2);
    await send(msg(7, "/close"));
    await send(press(7, `sel:${ETH.pool}`));
    expect(tg.last(7).buttons).toBeUndefined();
    expect(tg.last(7).text).toMatch(/cannot be closed right now. Nothing was sent[\s\S]*resting order/);
  });
});

describe("duplicates and outcomes", () => {
  it("a redelivered update is handled once", async () => {
    await linkedUser(7);
    const u = msg(7, "/positions");
    await send(u);
    const before = tg.sent.length;
    await send(u);
    expect(tg.sent.length).toBe(before);
    expect(logs.some((l) => /duplicate/.test(l))).toBe(true);
  });

  it("double-tapping confirm (separate updates, concurrently) sends exactly one close", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    await Promise.all([send(press(7, ok)), send(press(7, ok)), send(press(7, ok))]);
    await finish();
    expect(chain.sends).toHaveLength(1);
    expect(tg.answers.filter((a) => a.text === "Already confirmed.")).toHaveLength(2);
    // Exactly one report.
    await bot.tick();
    expect(tg.sent.filter((m) => /Close result/.test(m.text))).toHaveLength(1);
  });

  it("a partial fill is reported as PARTIAL with the hash, and not retried", async () => {
    await linkedUser(7);
    chain.sendBehavior.set(ETH.pool.toLowerCase(), { kind: "partial", remaining: 10n ** 15n });
    const { ok } = await prepareClose(7, ETH.pool);
    await send(press(7, ok));
    await finish();
    const r = tg.last(7).text;
    expect(r).toMatch(/1 PARTIAL/);
    expect(r).toMatch(/ETH-PERP: ⚠️ PARTIAL/);
    expect(r).toMatch(/tx 0x/);
    expect(r).toMatch(/position after: 0\.001 ETH/);
    expect(r).toMatch(/never retried automatically/);
    expect(r).not.toMatch(/closed and verified/);
    expect(chain.sends).toHaveLength(1);
  });

  it("an unknown outcome is reported as UNKNOWN, never success, and blocks the next close", async () => {
    await linkedUser(7);
    chain.sendBehavior.set(ETH.pool.toLowerCase(), { kind: "timeout" });
    const { ok } = await prepareClose(7, ETH.pool);
    await send(press(7, ok));
    await finish();
    const r = tg.last(7).text;
    expect(r).toMatch(/ETH-PERP: 🚨 UNKNOWN/);
    expect(r).toMatch(/tx 0x/);
    expect(r).toMatch(/Do not assume/);
    expect(r).not.toMatch(/closed and verified/);
    // The engine's unresolved-transaction guard applies to Telegram too.
    await send(msg(7, "/close"));
    await send(press(7, `sel:${BTC.pool}`));
    expect(tg.last(7).text).toMatch(/cannot be closed right now[\s\S]*still has no receipt/);
    expect(chain.sends).toHaveLength(1);
  });
});

describe("restart recovery", () => {
  it("reports a job cut off by a restart as UNKNOWN / SKIPPED, exactly once", async () => {
    const s = await linkedUser(7);
    const action: TelegramAction = {
      id: crypto.randomUUID(),
      tgUserId: "7",
      chatId: "7",
      sessionId: s.sessionId,
      kind: "closeall",
      state: "EXECUTING",
      quoteIds: ["a", "b"],
      idempotencyKey: "k",
      expiresAt: clock,
      createdAt: clock,
      jobId: "j1",
    };
    store.saveTelegramAction(action);
    store.saveJob({
      id: "j1",
      sessionId: s.sessionId,
      idempotencyKey: "k",
      createdAt: 0,
      status: "RUNNING",
      items: [
        { quoteId: "a", pool: BTC.pool, market: "BTC-PERP", baseDecimals: 8, state: "CONFIRMING", message: "", quantity: "13000", sizeBefore: "-13000", txHash: "0xabc" },
        { quoteId: "b", pool: ETH.pool, market: "ETH-PERP", baseDecimals: 18, state: "PENDING", message: "", quantity: "1", sizeBefore: "1" },
      ],
    });
    // "Restart": recover jobs, then a fresh bot over the same store.
    store.recoverInterruptedJobs();
    bot = newBot();
    await bot.tick();
    await bot.tick();
    const reports = tg.sent.filter((m) => /Close result/.test(m.text));
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toMatch(/BTC-PERP: 🚨 UNKNOWN[\s\S]*tx 0xabc/);
    expect(reports[0]!.text).toMatch(/ETH-PERP: ⏭ SKIPPED/);
    expect(reports[0]!.text).toMatch(/stopped early/);
    expect(store.getTelegramAction(action.id)!.state).toBe("REPORTED");
  });

  it("a confirmation claimed but not started before a restart reports that nothing was sent", async () => {
    const s = await linkedUser(7);
    store.saveTelegramAction({
      id: crypto.randomUUID(),
      tgUserId: "7",
      chatId: "7",
      sessionId: s.sessionId,
      kind: "close",
      state: "EXECUTING",
      quoteIds: ["a"],
      idempotencyKey: "never-started",
      expiresAt: clock,
      createdAt: clock,
    });
    bot = newBot();
    await bot.tick();
    expect(tg.last(7).text).toMatch(/interrupted by a server restart before it started. Nothing was sent/);
    expect(chain.sends).toHaveLength(0);
  });

  it("update de-duplication survives a restart", async () => {
    await linkedUser(7);
    const u = msg(7, "/positions");
    await send(u);
    const before = tg.sent.length;
    bot = newBot();
    await bot.handleUpdate(u);
    expect(tg.sent.length).toBe(before);
  });

  it("a confirm pressed after a restart still works once and only once", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    bot = newBot();
    await send(press(7, ok));
    await send(press(7, ok));
    await finish();
    expect(chain.sends).toHaveLength(1);
  });
});

describe("Close All", () => {
  it("lists eligible positions in order, explains sequencing, and closes them one at a time", async () => {
    await linkedUser(7);
    await send(msg(7, "/closeall"));
    const { ok, text } = offerButtons(7);
    expect(text).toMatch(/1\. BTC-PERP short 0\.00013 → BUY 0\.00013 BTC[\s\S]*2\. ETH-PERP long 0\.004 → SELL 0\.004 ETH/);
    expect(text).toMatch(/one at a time/);
    expect(text).toMatch(/the rest are skipped/);
    expect(tg.last(7).buttons![0]![0]!.text).toBe("Confirm Close All (2)");
    expect(chain.sends).toHaveLength(0);
    await send(press(7, ok));
    await finish();
    expect(chain.sends.map((c) => c.pool)).toEqual([BTC.pool, ETH.pool]);
    expect(tg.last(7).text).toMatch(/all 2 position\(s\) closed and verified on chain/);
  });

  it("lists blocked positions separately and never touches them", async () => {
    await linkedUser(7);
    chain.openOrders.set(`0x1111111111111111111111111111111111111111|${ETH.pool.toLowerCase()}`, 1);
    await send(msg(7, "/closeall"));
    const { ok, text } = offerButtons(7);
    expect(text).toMatch(/Blocked — will NOT be touched:\n• ETH-PERP: .*resting order/);
    expect(tg.last(7).buttons![0]![0]!.text).toBe("Confirm Close All (1)");
    await send(press(7, ok));
    await finish();
    expect(chain.sends.map((c) => c.pool)).toEqual([BTC.pool]);
  });

  it("stops after a flip: the rest are skipped and reported as not attempted", async () => {
    await linkedUser(7);
    chain.sendBehavior.set(BTC.pool.toLowerCase(), { kind: "flip", to: 13000n });
    await send(msg(7, "/closeall"));
    await send(press(7, offerButtons(7).ok));
    await finish();
    const r = tg.last(7).text;
    expect(r).toMatch(/BTC-PERP: 🚨 FLIPPED/);
    expect(r).toMatch(/ETH-PERP: ⏭ SKIPPED/);
    expect(chain.sends).toHaveLength(1);
  });

  it("offers no confirmation when nothing is eligible", async () => {
    await linkedUser(7, { fund: false });
    // Positions exist but the operator was never linked in dreamDEX.
    const healthy = FakeChain.healthy("0x2222222222222222222222222222222222222222");
    Object.assign(chain, healthy);
    await send(msg(7, "/closeall"));
    expect(tg.last(7).buttons).toBeUndefined();
    expect(tg.last(7).text).toMatch(/Nothing can be closed right now/);
  });
});

describe("unlinking and secrecy", () => {
  it("/unlink removes access without claiming the dreamDEX permission was revoked", async () => {
    await linkedUser(7);
    const { ok } = await prepareClose(7, ETH.pool);
    await send(msg(7, "/unlink"));
    const t = tg.last(7).text;
    expect(t).toMatch(/Telegram access removed/);
    expect(t).toMatch(/does NOT revoke/);
    expect(t).toMatch(/dreamDEX/);
    expect(store.getTelegramAction(ok.slice(3))!.state).toBe("CANCELLED");
    await send(msg(7, "/positions"));
    expect(tg.last(7).text).toMatch(/not linked/);
  });

  it("the web app can unlink too, with the same note", async () => {
    const s = await linkedUser(7);
    const r = await call("DELETE", "/api/telegram", { cookie: s.token });
    expect(r.json.removed).toBe(true);
    expect(r.json.note).toMatch(/does NOT revoke/);
    expect(store.telegramSession("7")).toBeUndefined();
  });

  it("no key, ciphertext, link code or session cookie appears in Telegram messages or logs", async () => {
    const s = await linkedUser(7);
    await send(msg(7, "/positions"));
    await send(msg(7, "/closeall"));
    await send(press(7, offerButtons(7).ok));
    await finish();
    const row = store.sessionByToken(s.token)!;
    const privateKey = (keystore as unknown as { decrypt(e: string): string }).decrypt(row.encryptedKey);
    const telegramSide = (tg.everything() + "\n" + logs.join("\n")).toLowerCase();
    for (const secret of [privateKey.slice(2), row.encryptedKey, s.code, s.token]) {
      expect(telegramSide).not.toContain(secret.toLowerCase());
    }
  });

  it("the HTTP client scrubs the bot token from transport errors", async () => {
    const token = `123456:${"A".repeat(35)}`;
    const failing = (async (url: string) => {
      throw new Error(`connect failed for ${url}`);
    }) as unknown as typeof fetch;
    const http = new HttpTelegram(token, failing);
    const err = await http.sendMessage("1", "x").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/<token>/);
    expect((err as Error).message).not.toContain(token);
  });
});

describe("liquidation alerts: rules", () => {
  const pos = (side: "long" | "short", mark: string | null, liq: string | null, markOk = true) => ({ side, markPrice: mark, liquidationPrice: liq, markOk });

  it("measures the distance from mark to liquidation for longs and shorts", () => {
    expect(liquidationDistanceBps(pos("long", "2000", "1900"))).toBe(500);
    expect(liquidationDistanceBps(pos("short", "2000", "2100"))).toBe(500);
    expect(liquidationDistanceBps(pos("long", "1800", "1900"))).toBe(0);
    expect(liquidationDistanceBps(pos("long", "2000", null))).toBeNull();
    expect(liquidationDistanceBps(pos("long", "2000", "1900", false))).toBeNull();
  });

  it("alerts once, again each time the distance halves, and re-arms after recovering past 1.5x", () => {
    expect(decideAlert(600, 500, null)).toEqual({ send: false, lastBps: null });
    expect(decideAlert(480, 500, null)).toEqual({ send: true, lastBps: 480, escalation: false });
    expect(decideAlert(300, 500, 480)).toEqual({ send: false, lastBps: 480 });
    expect(decideAlert(240, 500, 480)).toEqual({ send: true, lastBps: 240, escalation: true });
    expect(decideAlert(700, 500, 240)).toEqual({ send: false, lastBps: 240 });
    expect(decideAlert(760, 500, 240)).toEqual({ send: false, lastBps: null });
    // At or past liquidation: one alert, never a stream of them.
    expect(decideAlert(0, 500, 0)).toEqual({ send: false, lastBps: 0 });
  });

  it("parses thresholds between 1 and 50 percent only", () => {
    expect(parseThreshold("5")).toBe(500);
    expect(parseThreshold("2.5%")).toBe(250);
    expect(parseThreshold("0.5")).toBeUndefined();
    expect(parseThreshold("60")).toBeUndefined();
    expect(parseThreshold("five")).toBeUndefined();
  });
});

describe("liquidation alerts: bot", () => {
  // ETH long 0.004, mark 2328. Liquidation at 2230 is 4.2% away; at 2290 it is 1.6%.
  const liq = (price: bigint) => chain.setLiquidation(OWNER, ETH.pool, price * E18);
  const alerts = (tgId: number) => tg.sent.filter((m) => m.chatId === String(tgId) && m.text.startsWith("⚠️ Liquidation alert"));

  it("sends nothing while no position is near liquidation", async () => {
    await linkedUser(7);
    await bot.alertTick();
    liq(2000n); // 14% away
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(0);
  });

  it("alerts once within the threshold, with prepare and mute buttons, and sends no transaction", async () => {
    await linkedUser(7);
    liq(2230n);
    await bot.alertTick();
    await bot.alertTick();
    const a = alerts(7);
    expect(a).toHaveLength(1);
    expect(a[0]!.text).toMatch(/ETH-PERP LONG 0\.004 ETH/);
    expect(a[0]!.text).toMatch(/4\.2% from the estimated liquidation price/);
    expect(a[0]!.text).toMatch(/Nothing is sent unless you prepare a close/);
    expect(a[0]!.buttons).toEqual([[{ text: "Prepare close", data: `sel:${ETH.pool}` }, { text: "Mute 1h", data: `mute:${ETH.pool}` }]]);
    expect(chain.simulations).toHaveLength(0);
    expect(chain.sends).toHaveLength(0);
    expect(logs).toContain("tg liquidation alert sent");
  });

  it("escalates only when the distance halves, and re-arms after recovery", async () => {
    await linkedUser(7);
    liq(2230n);
    await bot.alertTick();
    liq(2250n); // 3.4%: closer, but not half
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(1);
    liq(2290n); // 1.6%
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(2);
    expect(alerts(7)[1]!.text).toMatch(/Getting closer: the mark is now 1\.6% from liquidation \(was 4\.2%\)/);
    liq(2000n); // recovered to 14%
    await bot.alertTick();
    liq(2230n);
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(3);
  });

  it("does not repeat an alert after a restart", async () => {
    await linkedUser(7);
    liq(2230n);
    await bot.alertTick();
    bot = newBot();
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(1);
  });

  it("covers shorts, whose liquidation price is above the mark", async () => {
    await linkedUser(7);
    chain.setLiquidation(OWNER, BTC.pool, 81_000n * E18); // mark 80,005: 1.2% away
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(1);
    expect(alerts(7)[0]!.text).toMatch(/BTC-PERP SHORT/);
  });

  it("Prepare close runs the normal quote flow and still needs a confirmation", async () => {
    await linkedUser(7);
    liq(2230n);
    await bot.alertTick();
    await send(press(7, `sel:${ETH.pool}`));
    const offer = offerButtons(7);
    expect(offer.text).toMatch(/Close ETH-PERP long/);
    expect(chain.sends).toHaveLength(0);
    await send(press(7, offer.ok));
    await finish();
    expect(chain.sends).toHaveLength(1);
  });

  it("Mute 1h silences that position until the hour is over", async () => {
    await linkedUser(7);
    liq(2230n);
    await bot.alertTick();
    await send(press(7, `mute:${ETH.pool}`));
    expect(tg.lastAnswer()).toMatch(/muted for 1 hour/);
    liq(2290n);
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(1);
    clock += 61 * 60_000;
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(2);
  });

  it("/alerts shows, changes and turns off the setting", async () => {
    const s = await linkedUser(7);
    expect(tg.last(7).text).toMatch(/Liquidation alerts are on: .* within 5% /);
    await send(msg(7, "/alerts"));
    expect(tg.last(7).text).toMatch(/Liquidation alerts are ON\. .* within 5% /);
    await send(msg(7, "/alerts 3"));
    expect(tg.last(7).text).toMatch(/ON at 3%/);
    expect((await call("GET", "/api/telegram", { cookie: s.token })).json.alerts).toEqual({ enabled: true, thresholdBps: 300 });
    liq(2230n); // 4.2%: outside 3%
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(0);
    await send(msg(7, "/alerts 99"));
    expect(tg.last(7).text).toMatch(/between 1 and 50 percent/);
    await send(msg(7, "/alerts off"));
    liq(2290n);
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(0);
    expect((await call("GET", "/api/telegram", { cookie: s.token })).json.alerts.enabled).toBe(false);
  });

  it("refuses /alerts from an unlinked Telegram user", async () => {
    await send(msg(9, "/alerts off"));
    expect(tg.last(9).text).toMatch(/not linked/);
  });

  it("offers no close button where the bot is not linked for the market", async () => {
    const s = await linkedUser(7);
    chain.revoke(ETH.pool, OWNER, s.operator);
    liq(2230n);
    await bot.alertTick();
    expect(alerts(7)[0]!.text).toMatch(/cannot close it/);
    expect(alerts(7)[0]!.buttons).toEqual([[{ text: "Mute 1h", data: `mute:${ETH.pool}` }]]);
  });

  it("stops after unlinking, and a failed send is retried", async () => {
    await linkedUser(7);
    liq(2230n);
    const realSend = tg.sendMessage.bind(tg);
    tg.sendMessage = async () => {
      throw new Error("telegram down");
    };
    await bot.alertTick();
    tg.sendMessage = realSend;
    expect(alerts(7)).toHaveLength(0);
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(1);
    await send(msg(7, "/unlink"));
    liq(2290n);
    await bot.alertTick();
    expect(alerts(7)).toHaveLength(1);
  });

  it("keeps account details and secrets out of alerts and logs", async () => {
    const s = await linkedUser(7);
    liq(2230n);
    await bot.alertTick();
    const text = alerts(7)[0]!.text;
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain(s.operator);
    expect(logs.join("\n")).not.toMatch(/ETH-PERP|2230|4\.2%/);
  });
});

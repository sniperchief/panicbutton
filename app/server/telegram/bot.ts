// Telegram interface over the shared engine. It adds no order or signing code: it
// calls Engine.positions / prepare / execute exactly as the web API does, with the
// linked session's own operator key.
//
// Identity: a Telegram user acts only through a link made with a short-lived,
// single-use code that an authenticated web session generated. The link is keyed by
// Telegram's numeric user id (never the username or a typed address). Only private
// chats are served, so nobody else can see or press another user's buttons.
//
// Confirmations are durable rows (Store tg_actions). A confirm press claims its row
// atomically (PENDING -> EXECUTING) and calls execute in the same synchronous step
// with the row's own idempotency key, so duplicate updates, double taps and restarts
// can never send twice. Outcomes are reported from the engine's verified job state.

import { randomInt } from "node:crypto";
import { formatUnits } from "viem";
import { EngineError, type Engine, type Job, type JobItem, type PositionView, type Quote, type SessionRef } from "../engine/engine.js";
import type { Keystore } from "../keystore.js";
import type { SessionRow, Store, TelegramAction } from "../store.js";
import { ALERT_DEFAULTS, ALERT_INTERVAL_MS, ALERT_MUTE_MS, decideAlert, liquidationDistanceBps, parseThreshold, pct } from "./alerts.js";
import type { Button, HttpTelegram, TelegramApi, TgCallbackQuery, TgMessage, TgUpdate } from "./client.js";

export const LINK_CODE_TTL_MS = 10 * 60_000;
export const LINK_ATTEMPT_WINDOW_MS = 15 * 60_000;
export const MAX_LINK_ATTEMPTS = 5;
/** No I, O, 0, 1: easy to read and type. 32 symbols x 10 = 50 bits. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

export function issueLinkCode(store: Store, sessionId: string, now = Date.now()) {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = now + LINK_CODE_TTL_MS;
  store.createLinkCode(sessionId, code, expiresAt);
  return { code, expiresAt };
}

export const UNLINK_NOTE =
  "This only removes Telegram access to PanicButton. It does NOT revoke the PanicButton bot operator's permission in dreamDEX: " +
  "to revoke that, open dreamDEX → Bots tab → Remove access.";

export interface BotDeps {
  engine: Engine;
  store: Store;
  keystore: Keystore;
  tg: TelegramApi;
  now?: () => number;
  newId?: () => string;
  log?: (line: string) => void;
}

const START_TEXT = [
  "PanicButton: emergency exit for dreamDEX Perps on Hideki testnet.",
  "",
  "To link this Telegram account:",
  "1. Open the PanicButton web app and connect your dreamDEX account.",
  "2. In the Account panel, press “Link Telegram” to get a one-time code (valid 10 minutes).",
  "3. Send it here: /link CODE",
  "",
  "Commands:",
  "/positions — open positions with size and PnL",
  "/close — close one position (you confirm the exact order first)",
  "/closeall — close every eligible position, one at a time",
  "/cancel — cancel a confirmation you have not pressed yet",
  "/alerts — liquidation-distance alerts: /alerts off, /alerts on, /alerts 3 (percent)",
  "/unlink — remove this Telegram account's access",
  "",
  "Nothing is ever sent without your explicit confirmation, and nothing is retried automatically.",
].join("\n");

const NOT_LINKED = "This Telegram account is not linked to PanicButton. Send /start for how to link it.";

const sideWord = (isBid: boolean) => (isBid ? "BUY" : "SELL");
const baseOf = (market: string) => market.replace(/-PERP$/, "");
const utc = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Decimal string to at most `dp` decimals, no float rounding surprises for display. */
function dec(v: string | null | undefined, dp: number): string {
  if (v === null || v === undefined) return "n/a";
  const neg = v.startsWith("-");
  const [i, f = ""] = (neg ? v.slice(1) : v).split(".");
  const frac = f.slice(0, dp).replace(/0+$/, "");
  return `${neg ? "-" : ""}${i}${frac ? `.${frac}` : ""}`;
}

const STATE_LABEL: Record<JobItem["state"], string> = {
  PENDING: "⏳ waiting",
  CHECKING: "⏳ checking",
  SIMULATING: "⏳ simulating",
  SUBMITTING: "⏳ submitting",
  CONFIRMING: "⏳ confirming",
  VERIFYING: "⏳ verifying",
  CLOSED: "✅ CLOSED (verified on chain)",
  PARTIAL: "⚠️ PARTIAL — position still open",
  ABORTED: "⛔ ABORTED — no transaction sent",
  FAILED: "❌ FAILED",
  FLIPPED: "🚨 FLIPPED — position reversed",
  UNKNOWN: "🚨 UNKNOWN — outcome not confirmed",
  AMBIGUOUS: "🚨 AMBIGUOUS — sources disagree",
  SKIPPED: "⏭ SKIPPED — not attempted",
};

export function formatJob(job: Job): string {
  const counts = new Map<string, number>();
  for (const i of job.items) counts.set(i.state, (counts.get(i.state) ?? 0) + 1);
  const allClosed = job.items.every((i) => i.state === "CLOSED");
  const head = allClosed
    ? `Close result: all ${job.items.length} position(s) closed and verified on chain.`
    : `Close result: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ")}.${job.status === "HALTED" ? " The run stopped early." : ""}`;
  const lines = [head, ""];
  for (const i of job.items) {
    lines.push(`${i.market}: ${STATE_LABEL[i.state]}`);
    lines.push(`  ${i.message}`);
    if (i.txHash) lines.push(`  tx ${i.txHash}`);
    if (i.filled !== undefined) lines.push(`  filled ${formatUnits(BigInt(i.filled), i.baseDecimals)} ${baseOf(i.market)}`);
    if (i.sizeAfter !== undefined) lines.push(`  position after: ${formatUnits(BigInt(i.sizeAfter), i.baseDecimals)} ${baseOf(i.market)}`);
    if (i.lateReceipt) lines.push(`  late receipt: ${i.lateReceipt.status} in block ${i.lateReceipt.block}`);
  }
  if (job.items.some((i) => i.state === "UNKNOWN")) {
    lines.push("", "Do not assume an UNKNOWN close happened or failed. PanicButton refuses new closes for this account until that transaction resolves. Check the account in dreamDEX.");
  }
  if (job.items.some((i) => i.state === "PARTIAL")) lines.push("", "Partial fills are never retried automatically. Use /close again to prepare a new close for the rest.");
  if (job.items.some((i) => i.state === "FLIPPED" || i.state === "AMBIGUOUS")) lines.push("", "Review the account in dreamDEX before doing anything else.");
  return lines.join("\n");
}

function quoteLine(q: Quote): string {
  return `${q.market} ${q.side} ${q.human.size} → ${sideWord(q.isBid)} ${q.human.quantity} ${baseOf(q.market)}, worst price ${dec(q.human.priceCap, 6)}`;
}

export class TelegramBot {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly log: (line: string) => void;
  private readonly perUser = new Map<string, Promise<void>>();
  private ticking = false;
  private alerting = false;

  constructor(private readonly deps: BotDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? ((l) => console.log(l));
  }

  /**
   * Handle one update. The update id is claimed durably before anything else, so a
   * redelivered update (Telegram retry, restart before the offset was saved) is ignored.
   * Updates from one user run one at a time, in order.
   */
  handleUpdate(u: TgUpdate): Promise<void> {
    if (!this.deps.store.claimUpdate(u.update_id, this.now())) {
      this.log(`tg update ${u.update_id} duplicate, ignored`);
      return Promise.resolve();
    }
    const from = u.message?.from ?? u.callback_query?.from;
    if (!from) return Promise.resolve();
    const key = String(from.id);
    const run = (this.perUser.get(key) ?? Promise.resolve())
      .then(() => this.dispatch(u))
      .catch((e) => this.log(`tg update ${u.update_id} error: ${(e as Error).message.split("\n")[0]!.slice(0, 160)}`));
    this.perUser.set(key, run);
    void run.then(() => {
      if (this.perUser.get(key) === run) this.perUser.delete(key);
    });
    return run;
  }

  private async dispatch(u: TgUpdate): Promise<void> {
    if (u.callback_query) await this.onCallback(u.callback_query);
    else if (u.message) await this.onMessage(u.message);
  }

  /** The linked session for a Telegram user, or undefined. A link to a deleted session is dropped. */
  private linked(tgUserId: string): SessionRow | undefined {
    const sid = this.deps.store.telegramSession(tgUserId);
    if (!sid) return undefined;
    const s = this.deps.store.sessionById(sid);
    if (!s) this.deps.store.unlinkTelegramUser(tgUserId);
    return s;
  }

  private ref(s: SessionRow): SessionRef {
    return { id: s.id, owner: s.owner, operator: s.operator };
  }

  private send(chatId: string, text: string, buttons?: Button[][]) {
    return this.deps.tg.sendMessage(chatId, text, buttons);
  }

  private async onMessage(m: TgMessage) {
    const from = m.from;
    if (!from || from.is_bot) return;
    const chatId = String(m.chat.id);
    if (m.chat.type !== "private" || m.chat.id !== from.id) {
      await this.send(chatId, "PanicButton only works in a private chat with the bot.");
      this.log("tg message outside private chat refused");
      return;
    }
    const uid = String(from.id);
    const match = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec((m.text ?? "").trim());
    if (!match) {
      await this.send(chatId, "Send /start for the list of commands.");
      return;
    }
    const cmd = match[1]!.toLowerCase();
    const arg = (match[2] ?? "").trim();
    // Command name only: message text can hold a link code.
    this.log(`tg command /${cmd}`);
    switch (cmd) {
      case "start":
        return arg ? this.link(uid, chatId, arg) : this.send(chatId, START_TEXT);
      case "help":
        return this.send(chatId, START_TEXT);
      case "link":
        return arg ? this.link(uid, chatId, arg) : this.send(chatId, "Send the code from the web app like this: /link CODE");
      case "unlink":
        return this.unlink(uid, chatId);
      case "cancel":
        return this.cancel(uid, chatId);
      case "alerts": {
        const s = this.linked(uid);
        if (!s) return this.send(chatId, NOT_LINKED);
        return this.alertsCommand(s, chatId, arg);
      }
      case "positions":
      case "close":
      case "closeall": {
        const s = this.linked(uid);
        if (!s) return this.send(chatId, NOT_LINKED);
        if (cmd === "positions") return this.positions(s, chatId);
        if (cmd === "close") return this.closeMenu(s, chatId);
        return this.prepareCloseAll(s, uid, chatId);
      }
      default:
        return this.send(chatId, "Unknown command. Send /start for the list of commands.");
    }
  }

  private async link(uid: string, chatId: string, raw: string) {
    const { store } = this.deps;
    const now = this.now();
    if (store.recordLinkAttempt(uid, now, now - LINK_ATTEMPT_WINDOW_MS) > MAX_LINK_ATTEMPTS) {
      this.log("tg link refused: too many attempts");
      return this.send(chatId, "Too many link attempts. Wait 15 minutes, then generate a new code in the web app.");
    }
    const code = raw.toUpperCase().replace(/[\s-]/g, "");
    const sessionId = /^[A-Z2-9]{10}$/.test(code) ? store.consumeLinkCode(code, now) : undefined;
    const session = sessionId ? store.sessionById(sessionId) : undefined;
    if (!session) {
      this.log("tg link failed");
      return this.send(chatId, "That code is invalid, expired or already used. Generate a new one in the PanicButton web app (Account → Link Telegram).");
    }
    const previous = store.telegramSession(uid);
    store.linkTelegram(uid, session.id, now);
    this.log("tg link ok");
    return this.send(
      chatId,
      `Linked to dreamDEX account ${shortAddr(session.owner)} (bot operator ${shortAddr(session.operator)}).` +
        (previous && previous !== session.id ? " Your earlier link was replaced." : "") +
        "\n\nCheck that this is your account. Send /positions to see open positions." +
        `\n\nLiquidation alerts are on: I message you when a position comes within ${pct(store.alertSettings(session.id, ALERT_DEFAULTS).thresholdBps)} of its liquidation price. /alerts to change.`,
    );
  }

  private async unlink(uid: string, chatId: string) {
    const removed = this.deps.store.unlinkTelegramUser(uid);
    return this.send(chatId, removed ? `Telegram access removed. ${UNLINK_NOTE}` : "This Telegram account is not linked.");
  }

  private async cancel(uid: string, chatId: string) {
    const cancelled = this.deps.store.cancelTelegramActions({ tgUserId: uid });
    for (const a of cancelled) await this.closeButtons(a, "Cancelled. Nothing was sent.");
    if (cancelled.length) return this.send(chatId, `Cancelled ${cancelled.length} pending confirmation(s). Nothing was sent.`);
    const executing = this.deps.store.telegramActionsInState("EXECUTING").some((a) => a.tgUserId === uid);
    return this.send(
      chatId,
      executing
        ? "A confirmed close is already executing and cannot be cancelled. I will report its verified outcome."
        : "Nothing to cancel.",
    );
  }

  private async closeButtons(a: TelegramAction, text: string) {
    if (a.messageId === undefined) return;
    await this.deps.tg.editMessage(a.chatId, a.messageId, text).catch(() => undefined);
  }

  private async positions(s: SessionRow, chatId: string) {
    let list: PositionView[];
    try {
      list = await this.deps.engine.positions(this.ref(s));
    } catch {
      return this.send(chatId, "Could not read positions from the chain right now. Try again shortly.");
    }
    if (list.length === 0) return this.send(chatId, `No open perp positions on ${shortAddr(s.owner)}.`);
    const lines = [`Open positions on ${shortAddr(s.owner)} (at ${utc(this.now())}):`, ""];
    for (const p of list) {
      lines.push(`${p.market} ${p.side.toUpperCase()} ${p.sizeHuman} ${baseOf(p.market)}`);
      lines.push(`  entry ${dec(p.entryPrice, 4)} · mark ${p.markOk ? dec(p.markPrice, 4) : "stale"} · PnL ${p.unrealizedPnl === null ? "n/a" : `${dec(p.unrealizedPnl, 2)} USDso`}`);
      if (p.liquidationPrice) lines.push(`  liquidation ≈ ${dec(p.liquidationPrice, 4)}`);
      if (!p.operatorAuthorized) lines.push("  ⚠️ bot not linked for this market in dreamDEX: cannot be closed");
    }
    return this.send(chatId, lines.join("\n"));
  }

  private async closeMenu(s: SessionRow, chatId: string) {
    let list: PositionView[];
    try {
      list = await this.deps.engine.positions(this.ref(s));
    } catch {
      return this.send(chatId, "Could not read positions from the chain right now. Try again shortly.");
    }
    if (list.length === 0) return this.send(chatId, "No open perp positions to close.");
    return this.send(
      chatId,
      "Which position should be closed? I will prepare a quote for you to check before anything is sent.",
      list.map((p) => [{ text: `${p.market} ${p.side} ${p.sizeHuman}`, data: `sel:${p.pool}` }]),
    );
  }

  private executionNote() {
    return this.deps.engine.executionEnabled ? "" : "\n\nExecution is DISABLED on this server: confirming will be refused and nothing will be sent.";
  }

  /** Creates a durable confirmation, replacing any earlier unconfirmed one for this user. */
  private async offer(s: SessionRow, uid: string, chatId: string, kind: TelegramAction["kind"], ready: Quote[], text: string, confirmLabel: string) {
    const { store } = this.deps;
    for (const old of store.cancelTelegramActions({ tgUserId: uid })) await this.closeButtons(old, "Replaced by a newer request. Nothing was sent.");
    const action: TelegramAction = {
      id: this.newId(),
      tgUserId: uid,
      chatId,
      sessionId: s.id,
      kind,
      state: "PENDING",
      quoteIds: ready.map((q) => q.id),
      idempotencyKey: this.newId(),
      expiresAt: Math.min(...ready.map((q) => q.expiresAt)),
      createdAt: this.now(),
    };
    store.saveTelegramAction(action);
    const secs = Math.max(0, Math.round((action.expiresAt - this.now()) / 1000));
    const { messageId } = await this.send(chatId, `${text}\n\nConfirm by ${utc(action.expiresAt)} (${secs} s), or it expires.${this.executionNote()}`, [
      [
        { text: confirmLabel, data: `ok:${action.id}` },
        { text: "Cancel", data: `no:${action.id}` },
      ],
    ]);
    // Only the message id changes; the state may have moved meanwhile, so re-read.
    const current = store.getTelegramAction(action.id);
    if (current) store.saveTelegramAction({ ...current, messageId });
  }

  private async prepareClose(s: SessionRow, uid: string, chatId: string, pool: string) {
    let q: Quote | undefined;
    try {
      [q] = await this.deps.engine.prepare(this.ref(s), [pool as `0x${string}`]);
    } catch (e) {
      return this.send(chatId, `Could not prepare the close: ${e instanceof EngineError ? e.message : "chain read failed; try again"}. Nothing was sent.`);
    }
    if (!q) return this.send(chatId, "Could not prepare the close. Nothing was sent.");
    if (q.status !== "READY") {
      return this.send(chatId, `${q.market} cannot be closed right now. Nothing was sent.\n\n${q.blockers.map((b) => `• ${b}`).join("\n")}`);
    }
    const text = [
      `Close ${q.market} ${q.side} ${q.human.size} ${baseOf(q.market)}`,
      "",
      `Order: ${sideWord(q.isBid)} ${q.human.quantity} ${baseOf(q.market)}, immediate-or-cancel`,
      `Worst accepted price: ${dec(q.human.priceCap, 6)} (${q.slippageBps} bps from best ${dec(q.human.touch, 6)}; mark ${dec(q.human.mark, 6)})`,
      `Simulation: ${q.simulation}`,
      ...q.warnings.map((w) => `⚠️ ${w}`),
      "",
      "Right before sending, PanicButton re-reads the position, book and permission and aborts on any change. The result is verified on chain. Nothing is retried.",
    ].join("\n");
    return this.offer(s, uid, chatId, "close", [q], text, "Confirm close");
  }

  private async prepareCloseAll(s: SessionRow, uid: string, chatId: string) {
    let quotes: Quote[];
    try {
      quotes = await this.deps.engine.prepare(this.ref(s), "all");
    } catch (e) {
      return this.send(chatId, `Could not prepare Close All: ${e instanceof EngineError ? e.message : "chain read failed; try again"}. Nothing was sent.`);
    }
    if (quotes.length === 0) return this.send(chatId, "No open perp positions to close.");
    const ready = quotes.filter((q) => q.status === "READY");
    const blocked = quotes.filter((q) => q.status !== "READY");
    const lines = [`Close All — ${quotes.length} position(s)`, ""];
    if (ready.length) {
      lines.push("Will close, one at a time, in this order:");
      ready.forEach((q, i) => lines.push(`${i + 1}. ${quoteLine(q)}`));
    }
    if (blocked.length) {
      lines.push("", "Blocked — will NOT be touched:");
      for (const q of blocked) lines.push(`• ${q.market}: ${q.blockers.join("; ")}`);
    }
    if (!ready.length) {
      lines.push("", "Nothing can be closed right now. Nothing was sent.");
      return this.send(chatId, lines.join("\n"));
    }
    lines.push(
      "",
      "Each close is re-checked right before sending and verified on chain afterwards. If one ends FLIPPED, UNKNOWN or AMBIGUOUS, the rest are skipped. Partial fills and failures are not retried.",
    );
    return this.offer(s, uid, chatId, "closeall", ready, lines.join("\n"), `Confirm Close All (${ready.length})`);
  }

  private async onCallback(cq: TgCallbackQuery) {
    const { tg } = this.deps;
    const uid = String(cq.from.id);
    const chat = cq.message?.chat;
    let answer: string | undefined;
    try {
      if (!chat || chat.type !== "private" || chat.id !== cq.from.id) {
        answer = "Not available here.";
        return;
      }
      const chatId = String(chat.id);
      const [kind, arg] = (cq.data ?? "").split(":", 2) as [string, string | undefined];
      this.log(`tg callback ${kind}`);
      const s = this.linked(uid);
      if (!s) {
        answer = "This Telegram account is not linked.";
        return;
      }
      if (kind === "sel" && arg) {
        answer = "Preparing…";
        await tg.answerCallback(cq.id, answer).catch(() => undefined);
        answer = undefined;
        return await this.prepareClose(s, uid, chatId, arg);
      }
      if (kind === "mute" && arg) {
        answer = this.mute(s, arg);
        return;
      }
      if ((kind === "ok" || kind === "no") && arg) {
        answer = kind === "ok" ? await this.confirm(s, uid, chatId, arg) : await this.reject(s, uid, chatId, arg);
        return;
      }
      answer = "Unknown action.";
    } finally {
      if (answer !== undefined) await tg.answerCallback(cq.id, answer).catch(() => undefined);
    }
  }

  /** The action, only if it belongs to this Telegram user, chat and linked session. */
  private ownAction(s: SessionRow, uid: string, chatId: string, id: string): TelegramAction | undefined {
    const a = this.deps.store.getTelegramAction(id);
    if (!a || a.tgUserId !== uid || a.chatId !== chatId || a.sessionId !== s.id) return undefined;
    return a;
  }

  private async reject(s: SessionRow, uid: string, chatId: string, id: string): Promise<string> {
    const a = this.ownAction(s, uid, chatId, id);
    if (!a) return "This confirmation is not valid for your account.";
    if (!this.deps.store.transitionTelegramAction(a.id, "PENDING", "CANCELLED")) return "Already handled.";
    await this.closeButtons(a, "Cancelled. Nothing was sent.");
    return "Cancelled.";
  }

  private async confirm(s: SessionRow, uid: string, chatId: string, id: string): Promise<string> {
    const { store, engine, keystore } = this.deps;
    const a = this.ownAction(s, uid, chatId, id);
    if (!a) {
      this.log("tg confirm refused: not the owner's action");
      return "This confirmation is not valid for your account.";
    }
    if (a.state !== "PENDING") return a.state === "EXECUTING" || a.state === "REPORTED" ? "Already confirmed." : `This confirmation was ${a.state.toLowerCase()}.`;
    if (this.now() > a.expiresAt) {
      if (store.transitionTelegramAction(a.id, "PENDING", "EXPIRED")) await this.closeButtons(a, "Expired. Nothing was sent. Run the command again for a fresh quote.");
      return "Expired. Nothing was sent.";
    }
    // Claim and execute with no await in between: nothing can interleave.
    if (!store.transitionTelegramAction(a.id, "PENDING", "EXECUTING")) return "Already handled.";
    let job: Job;
    try {
      job = engine.execute(this.ref(s), a.quoteIds, a.idempotencyKey, () => keystore.account(s.encryptedKey, s.operator));
    } catch (e) {
      store.saveTelegramAction({ ...a, state: "REPORTED" });
      const reason = e instanceof EngineError ? e.message : "internal error";
      this.log(`tg execute refused: ${e instanceof EngineError ? e.code : "error"}`);
      await this.closeButtons(a, `Not executed: ${reason}. Nothing was sent.`);
      return "Not executed.";
    }
    store.saveTelegramAction({ ...a, state: "EXECUTING", jobId: job.id });
    this.log("tg execute started");
    await this.closeButtons(
      a,
      `Confirmed. ${a.kind === "closeall" ? `Closing ${job.items.length} position(s) one at a time.` : `Closing ${job.items[0]?.market}.`} ` +
        "I will report the outcome once it is verified on chain. Submitting a transaction is not success.",
    );
    return "Confirmed.";
  }

  private alertsCommand(s: SessionRow, chatId: string, arg: string) {
    const { store } = this.deps;
    const current = store.alertSettings(s.id, ALERT_DEFAULTS);
    const a = arg.toLowerCase();
    if (a === "off") {
      store.setAlertSettings(s.id, false, current.thresholdBps);
      return this.send(chatId, "Liquidation alerts are OFF. Send /alerts on to turn them back on.");
    }
    if (a === "on" || a === "") {
      if (a === "on") store.setAlertSettings(s.id, true, current.thresholdBps);
      const on = a === "on" || current.enabled;
      return this.send(
        chatId,
        on
          ? `Liquidation alerts are ON. I check every ${ALERT_INTERVAL_MS / 1000} s and message you when a position's mark price comes within ${pct(current.thresholdBps)} of its estimated liquidation price, and again each time that distance halves.\n\nAlerts never send anything. /alerts 3 sets the distance (1–50%), /alerts off turns them off.`
          : "Liquidation alerts are OFF. Send /alerts on to turn them on.",
      );
    }
    const bps = parseThreshold(arg);
    if (bps === undefined) return this.send(chatId, "Send a distance between 1 and 50 percent, like /alerts 5, or /alerts off.");
    store.setAlertSettings(s.id, true, bps);
    return this.send(chatId, `Liquidation alerts are ON at ${pct(bps)} from the liquidation price.`);
  }

  private mute(s: SessionRow, pool: string): string {
    const { store } = this.deps;
    const st = store.alertStates(s.id).find((r) => r.pool === pool.toLowerCase());
    if (!st) return "Nothing to mute.";
    store.saveAlertState(s.id, st.pool, st.side, st.lastBps, this.now() + ALERT_MUTE_MS);
    return "Alerts for this position muted for 1 hour.";
  }

  private alertText(p: PositionView, bps: number, previousBps: number | null, thresholdBps: number) {
    const lines = [
      `⚠️ Liquidation alert: ${p.market} ${p.side.toUpperCase()} ${p.sizeHuman} ${baseOf(p.market)}`,
      "",
      bps === 0
        ? "The mark price is at or past the estimated liquidation price."
        : previousBps !== null
          ? `Getting closer: the mark is now ${pct(bps)} from liquidation (was ${pct(previousBps)}).`
          : `The mark is ${pct(bps)} from the estimated liquidation price.`,
      `Mark ${dec(p.markPrice, 4)} · liquidation ≈ ${dec(p.liquidationPrice, 4)} · PnL ${p.unrealizedPnl === null ? "n/a" : `${dec(p.unrealizedPnl, 2)} USDso`}`,
      "",
    ];
    if (!p.operatorAuthorized) lines.push("⚠️ The bot is not linked for this market in dreamDEX, so PanicButton cannot close it. Act in dreamDEX directly.", "");
    lines.push(
      "This is only an alert. Nothing is sent unless you prepare a close, check the quote and confirm it.",
      `Alerts within ${pct(thresholdBps)} · /alerts to change`,
    );
    return lines.join("\n");
  }

  /**
   * Liquidation-distance check, run periodically. Reads positions through the engine
   * exactly as /positions does. A failed send is not recorded, so it is retried next time.
   */
  async alertTick(): Promise<void> {
    if (this.alerting) return;
    this.alerting = true;
    try {
      const { store, engine, tg } = this.deps;
      for (const { tgUserId, sessionId } of store.telegramLinks()) {
        const settings = store.alertSettings(sessionId, ALERT_DEFAULTS);
        if (!settings.enabled) continue;
        const s = this.linked(tgUserId);
        if (!s || s.id !== sessionId) continue;
        let list: PositionView[];
        try {
          list = await engine.positions(this.ref(s));
        } catch {
          this.log("tg alert check skipped: positions read failed");
          continue;
        }
        const states = new Map(store.alertStates(sessionId).map((r) => [r.pool, r]));
        const now = this.now();
        for (const p of list) {
          const pool = p.pool.toLowerCase();
          let st = states.get(pool);
          states.delete(pool);
          // A reversed or reopened position starts over.
          if (st && st.side !== p.side) {
            store.deleteAlertState(sessionId, pool);
            st = undefined;
          }
          const bps = liquidationDistanceBps(p);
          if (bps === null) continue;
          const previous = st?.lastBps ?? null;
          const d = decideAlert(bps, settings.thresholdBps, previous);
          const mutedUntil = st?.mutedUntil ?? 0;
          if (d.send) {
            if (mutedUntil > now) continue;
            const buttons: Button[][] = [
              [...(p.operatorAuthorized ? [{ text: "Prepare close", data: `sel:${p.pool}` }] : []), { text: "Mute 1h", data: `mute:${p.pool}` }],
            ];
            try {
              await tg.sendMessage(tgUserId, this.alertText(p, bps, d.escalation ? previous : null, settings.thresholdBps), buttons);
            } catch (e) {
              this.log(`tg alert send failed, will retry: ${(e as Error).message.slice(0, 120)}`);
              continue;
            }
            store.saveAlertState(sessionId, pool, p.side, d.lastBps, mutedUntil);
            this.log("tg liquidation alert sent");
          } else if (d.lastBps !== previous || !st) {
            store.saveAlertState(sessionId, pool, p.side, d.lastBps, mutedUntil);
          }
        }
        // Positions that are gone (closed or liquidated) leave no alert state behind.
        for (const pool of states.keys()) store.deleteAlertState(sessionId, pool);
      }
    } finally {
      this.alerting = false;
    }
  }

  /**
   * Durable reporter, run periodically and once at startup. Reports every finished
   * job exactly once (at least once if Telegram is down), expires stale confirmations,
   * and resolves actions cut off by a restart.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { store, tg } = this.deps;
      const now = this.now();
      for (const a of store.telegramActionsInState("PENDING")) {
        if (now > a.expiresAt && store.transitionTelegramAction(a.id, "PENDING", "EXPIRED")) {
          await this.closeButtons(a, "Expired. Nothing was sent. Run the command again for a fresh quote.");
        }
      }
      for (const a of store.telegramActionsInState("EXECUTING")) {
        try {
          let jobId = a.jobId;
          if (!jobId) {
            // Claimed, then the process died before the job id was saved. execute() saves
            // the job before anything is sent, so no job means nothing was sent.
            jobId = store.findJobByIdempotencyKey(a.sessionId, a.idempotencyKey)?.id;
            if (!jobId) {
              await tg.sendMessage(a.chatId, "A confirmed close was interrupted by a server restart before it started. Nothing was sent. Run the command again if you still want it.");
              store.saveTelegramAction({ ...a, state: "REPORTED" });
              continue;
            }
            store.saveTelegramAction({ ...a, jobId });
          }
          const job = store.getJob(jobId);
          if (!job || job.sessionId !== a.sessionId) {
            store.saveTelegramAction({ ...a, state: "REPORTED" });
            continue;
          }
          if (job.status === "RUNNING") continue;
          await tg.sendMessage(a.chatId, formatJob(job));
          store.saveTelegramAction({ ...a, jobId, state: "REPORTED" });
          this.log(`tg job reported: ${job.status}`);
        } catch (e) {
          this.log(`tg report failed, will retry: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}

/**
 * Long-polling loop. The server has no public HTTPS endpoint (it binds 127.0.0.1),
 * so polling is the fit; it also keeps one process seeing every update, which the
 * engine's per-session queue requires.
 */
export function startPolling(http: HttpTelegram, bot: TelegramBot, store: Store, log: (l: string) => void) {
  let stopped = false;
  const reporter = setInterval(() => void bot.tick().catch((e) => log(`tg tick error: ${(e as Error).message.slice(0, 120)}`)), 2000);
  const alerts = setInterval(() => void bot.alertTick().catch((e) => log(`tg alert error: ${(e as Error).message.slice(0, 120)}`)), ALERT_INTERVAL_MS);
  const loop = async () => {
    await http.deleteWebhook().catch((e) => log(`tg deleteWebhook failed: ${(e as Error).message.slice(0, 120)}`));
    let offset = Number(store.getKv("tg_offset") ?? 0);
    let lastPrune = 0;
    while (!stopped) {
      let updates;
      try {
        updates = await http.getUpdates(offset, 25);
      } catch (e) {
        log(`tg poll failed: ${(e as Error).message.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        // handleUpdate claims the id synchronously; the work itself runs per user.
        void bot.handleUpdate(u);
      }
      store.setKv("tg_offset", String(offset));
      if (Date.now() - lastPrune > 3600_000) {
        store.pruneUpdates(Date.now() - 7 * 24 * 3600_000);
        lastPrune = Date.now();
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
    clearInterval(reporter);
    clearInterval(alerts);
  };
}

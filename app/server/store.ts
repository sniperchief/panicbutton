// SQLite persistence (node:sqlite, no native dependency): sessions, encrypted
// operator keys, quotes and jobs. Session tokens are stored only as SHA-256 hashes.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Address } from "viem";
import type { Job, Quote, Repo } from "./engine/engine.js";

export interface SessionRow {
  id: string;
  owner: Address;
  operator: Address;
  encryptedKey: string;
  createdAt: number;
}

/**
 * A Telegram confirmation, stored durably so a restart or a duplicate update can
 * never confirm it twice. PENDING -> EXECUTING (atomic claim) -> REPORTED;
 * PENDING -> CANCELLED | EXPIRED; EXECUTING -> REPORTED also when execute refused.
 */
export interface TelegramAction {
  id: string;
  tgUserId: string;
  chatId: string;
  sessionId: string;
  kind: "close" | "closeall";
  state: "PENDING" | "EXECUTING" | "REPORTED" | "CANCELLED" | "EXPIRED";
  quoteIds: string[];
  idempotencyKey: string;
  expiresAt: number;
  createdAt: number;
  /** The Telegram message holding the confirm buttons. */
  messageId?: number;
  jobId?: string;
}

export const hashToken =(token: string) => createHash("sha256").update(token).digest("hex");

export class Store implements Repo {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        owner TEXT NOT NULL,
        operator TEXT NOT NULL UNIQUE,
        encrypted_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (session_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS tg_link_codes (
        code_hash TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS tg_links (
        tg_user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        linked_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tg_link_attempts (
        tg_user_id TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tg_updates (
        update_id INTEGER PRIMARY KEY,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tg_actions (
        id TEXT PRIMARY KEY,
        tg_user_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tg_alert_settings (
        session_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        threshold_bps INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tg_alert_state (
        session_id TEXT NOT NULL,
        pool TEXT NOT NULL,
        side TEXT NOT NULL,
        last_bps INTEGER,
        muted_until INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, pool)
      );
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  createSession(row: SessionRow, token: string) {
    this.db
      .prepare("INSERT INTO sessions (id, token_hash, owner, operator, encrypted_key, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.id, hashToken(token), row.owner, row.operator, row.encryptedKey, row.createdAt);
  }

  sessionByToken(token: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token)) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      owner: String(r.owner) as Address,
      operator: String(r.operator) as Address,
      encryptedKey: String(r.encrypted_key),
      createdAt: Number(r.created_at),
    };
  }

  sessionById(id: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      owner: String(r.owner) as Address,
      operator: String(r.operator) as Address,
      encryptedKey: String(r.encrypted_key),
      createdAt: Number(r.created_at),
    };
  }

  /** Also drops the session's Telegram link, link codes and unconfirmed Telegram actions. */
  deleteSession(id: string) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    this.unlinkTelegramSession(id);
  }

  // ---- Telegram ----
  // Link codes are stored only as SHA-256 hashes; links are keyed by Telegram's
  // numeric user id (never the username), one session per Telegram user and vice versa.

  /** Stores a new code for the session and invalidates any older unused one. */
  createLinkCode(sessionId: string, code: string, expiresAt: number) {
    this.db.prepare("DELETE FROM tg_link_codes WHERE session_id = ?").run(sessionId);
    this.db.prepare("INSERT INTO tg_link_codes (code_hash, session_id, expires_at) VALUES (?, ?, ?)").run(hashToken(code), sessionId, expiresAt);
  }

  /** Consumes a code atomically. Returns its session id, or undefined if unknown, used or expired. */
  consumeLinkCode(code: string, now: number): string | undefined {
    const h = hashToken(code);
    const res = this.db.prepare("UPDATE tg_link_codes SET used = 1 WHERE code_hash = ? AND used = 0 AND expires_at > ?").run(h, now);
    if (Number(res.changes) !== 1) return undefined;
    const r = this.db.prepare("SELECT session_id FROM tg_link_codes WHERE code_hash = ?").get(h) as { session_id: string } | undefined;
    return r?.session_id;
  }

  /** Binds a Telegram user to a session, replacing any earlier link of either side. */
  linkTelegram(tgUserId: string, sessionId: string, now: number) {
    this.db.prepare("DELETE FROM tg_links WHERE tg_user_id = ? OR session_id = ?").run(tgUserId, sessionId);
    this.db.prepare("INSERT INTO tg_links (tg_user_id, session_id, linked_at) VALUES (?, ?, ?)").run(tgUserId, sessionId, now);
    this.cancelTelegramActions({ tgUserId });
    this.cancelTelegramActions({ sessionId });
  }

  telegramSession(tgUserId: string): string | undefined {
    const r = this.db.prepare("SELECT session_id FROM tg_links WHERE tg_user_id = ?").get(tgUserId) as { session_id: string } | undefined;
    return r?.session_id;
  }

  telegramLinkForSession(sessionId: string): { linkedAt: number } | undefined {
    const r = this.db.prepare("SELECT linked_at FROM tg_links WHERE session_id = ?").get(sessionId) as { linked_at: number } | undefined;
    return r ? { linkedAt: Number(r.linked_at) } : undefined;
  }

  unlinkTelegramUser(tgUserId: string): boolean {
    const sessionId = this.telegramSession(tgUserId);
    const res = this.db.prepare("DELETE FROM tg_links WHERE tg_user_id = ?").run(tgUserId);
    this.cancelTelegramActions({ tgUserId });
    if (sessionId) this.clearAlerts(sessionId);
    return Number(res.changes) > 0;
  }

  unlinkTelegramSession(sessionId: string): boolean {
    const res = this.db.prepare("DELETE FROM tg_links WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM tg_link_codes WHERE session_id = ?").run(sessionId);
    this.cancelTelegramActions({ sessionId });
    this.clearAlerts(sessionId);
    return Number(res.changes) > 0;
  }

  /** Every Telegram link. Private chats only, so the chat id equals the user id. */
  telegramLinks(): { tgUserId: string; sessionId: string }[] {
    const rows = this.db.prepare("SELECT tg_user_id, session_id FROM tg_links").all() as { tg_user_id: string; session_id: string }[];
    return rows.map((r) => ({ tgUserId: String(r.tg_user_id), sessionId: String(r.session_id) }));
  }

  // ---- Liquidation alerts (Telegram) ----

  alertSettings(sessionId: string, defaults: { enabled: boolean; thresholdBps: number }): { enabled: boolean; thresholdBps: number } {
    const r = this.db.prepare("SELECT enabled, threshold_bps FROM tg_alert_settings WHERE session_id = ?").get(sessionId) as
      | { enabled: number; threshold_bps: number }
      | undefined;
    return r ? { enabled: Number(r.enabled) === 1, thresholdBps: Number(r.threshold_bps) } : defaults;
  }

  /** Changing the settings re-arms every alert for the session. */
  setAlertSettings(sessionId: string, enabled: boolean, thresholdBps: number) {
    this.db
      .prepare("INSERT INTO tg_alert_settings (session_id, enabled, threshold_bps) VALUES (?, ?, ?) ON CONFLICT (session_id) DO UPDATE SET enabled = excluded.enabled, threshold_bps = excluded.threshold_bps")
      .run(sessionId, enabled ? 1 : 0, thresholdBps);
    this.db.prepare("UPDATE tg_alert_state SET last_bps = NULL WHERE session_id = ?").run(sessionId);
  }

  alertStates(sessionId: string): { pool: string; side: string; lastBps: number | null; mutedUntil: number }[] {
    const rows = this.db.prepare("SELECT pool, side, last_bps, muted_until FROM tg_alert_state WHERE session_id = ?").all(sessionId) as {
      pool: string;
      side: string;
      last_bps: number | null;
      muted_until: number;
    }[];
    return rows.map((r) => ({ pool: String(r.pool), side: String(r.side), lastBps: r.last_bps === null ? null : Number(r.last_bps), mutedUntil: Number(r.muted_until) }));
  }

  saveAlertState(sessionId: string, pool: string, side: string, lastBps: number | null, mutedUntil: number) {
    this.db
      .prepare(
        "INSERT INTO tg_alert_state (session_id, pool, side, last_bps, muted_until) VALUES (?, ?, ?, ?, ?) ON CONFLICT (session_id, pool) DO UPDATE SET side = excluded.side, last_bps = excluded.last_bps, muted_until = excluded.muted_until",
      )
      .run(sessionId, pool.toLowerCase(), side, lastBps, mutedUntil);
  }

  deleteAlertState(sessionId: string, pool: string) {
    this.db.prepare("DELETE FROM tg_alert_state WHERE session_id = ? AND pool = ?").run(sessionId, pool.toLowerCase());
  }

  clearAlerts(sessionId: string) {
    this.db.prepare("DELETE FROM tg_alert_settings WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM tg_alert_state WHERE session_id = ?").run(sessionId);
  }

  /** Records a link attempt and returns how many this user made since `since` (inclusive of this one). */
  recordLinkAttempt(tgUserId: string, now: number, since: number): number {
    this.db.prepare("DELETE FROM tg_link_attempts WHERE at < ?").run(since);
    this.db.prepare("INSERT INTO tg_link_attempts (tg_user_id, at) VALUES (?, ?)").run(tgUserId, now);
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM tg_link_attempts WHERE tg_user_id = ? AND at >= ?").get(tgUserId, since) as { n: number };
    return Number(r.n);
  }

  /** Claims an update id; false if it was already seen (Telegram redelivery). */
  claimUpdate(updateId: number, now: number): boolean {
    const res = this.db.prepare("INSERT OR IGNORE INTO tg_updates (update_id, at) VALUES (?, ?)").run(updateId, now);
    return Number(res.changes) === 1;
  }

  pruneUpdates(before: number) {
    this.db.prepare("DELETE FROM tg_updates WHERE at < ?").run(before);
  }

  getKv(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return r?.v;
  }

  setKv(k: string, v: string) {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  saveTelegramAction(a: TelegramAction) {
    this.db
      .prepare(
        "INSERT INTO tg_actions (id, tg_user_id, chat_id, session_id, state, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data",
      )
      .run(a.id, a.tgUserId, a.chatId, a.sessionId, a.state, JSON.stringify(a));
  }

  getTelegramAction(id: string): TelegramAction | undefined {
    const r = this.db.prepare("SELECT data FROM tg_actions WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as TelegramAction) : undefined;
  }

  /** Atomic state transition; false if the action was not in `from` (already used, cancelled, ...). */
  transitionTelegramAction(id: string, from: TelegramAction["state"], to: TelegramAction["state"]): boolean {
    const a = this.getTelegramAction(id);
    if (!a || a.state !== from) return false;
    const res = this.db.prepare("UPDATE tg_actions SET state = ?, data = ? WHERE id = ? AND state = ?").run(to, JSON.stringify({ ...a, state: to }), id, from);
    return Number(res.changes) === 1;
  }

  telegramActionsInState(state: TelegramAction["state"]): TelegramAction[] {
    const rows = this.db.prepare("SELECT data FROM tg_actions WHERE state = ?").all(state) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as TelegramAction);
  }

  /** Cancels every still-unconfirmed action for a user or a session. Returns the cancelled ones. */
  cancelTelegramActions(by: { tgUserId: string } | { sessionId: string }): TelegramAction[] {
    const rows = (
      "tgUserId" in by
        ? this.db.prepare("SELECT data FROM tg_actions WHERE tg_user_id = ? AND state = 'PENDING'").all(by.tgUserId)
        : this.db.prepare("SELECT data FROM tg_actions WHERE session_id = ? AND state = 'PENDING'").all(by.sessionId)
    ) as { data: string }[];
    const cancelled: TelegramAction[] = [];
    for (const r of rows) {
      const a = JSON.parse(r.data) as TelegramAction;
      if (this.transitionTelegramAction(a.id, "PENDING", "CANCELLED")) cancelled.push({ ...a, state: "CANCELLED" });
    }
    return cancelled;
  }

  saveQuote(q: Quote) {
    this.db
      .prepare("INSERT INTO quotes (id, session_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(q.id, q.sessionId, JSON.stringify(q));
  }

  getQuote(id: string): Quote | undefined {
    const r = this.db.prepare("SELECT data FROM quotes WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Quote) : undefined;
  }

  markQuoteUsed(id: string): boolean {
    const res = this.db.prepare("UPDATE quotes SET used = 1 WHERE id = ? AND used = 0").run(id);
    return Number(res.changes) === 1;
  }

  saveJob(job: Job) {
    this.db
      .prepare(
        "INSERT INTO jobs (id, session_id, idempotency_key, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
      )
      .run(job.id, job.sessionId, job.idempotencyKey, JSON.stringify(job));
  }

  getJob(id: string): Job | undefined {
    const r = this.db.prepare("SELECT data FROM jobs WHERE id = ?").get(id) as { data: string } | undefined;
    return r ? (JSON.parse(r.data) as Job) : undefined;
  }

  jobsForSession(sessionId: string): Job[] {
    const rows = this.db.prepare("SELECT data FROM jobs WHERE session_id = ?").all(sessionId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as Job);
  }

  /**
   * After a restart nothing is running, so any job still marked RUNNING was cut off.
   * Items that may have been signed become UNKNOWN (the engine then refuses new closes
   * until their receipt or the operator's pending nonce clears); the rest never sent.
   */
  recoverInterruptedJobs(now = Date.now()): number {
    const rows = this.db.prepare("SELECT data FROM jobs").all() as { data: string }[];
    let recovered = 0;
    for (const r of rows) {
      const job = JSON.parse(r.data) as Job;
      if (job.status !== "RUNNING") continue;
      for (const item of job.items) {
        if (["PENDING", "CHECKING", "SIMULATING"].includes(item.state)) {
          Object.assign(item, { state: "SKIPPED", message: "not attempted: the server restarted before this close was sent", finishedAt: now });
        } else if (["SUBMITTING", "CONFIRMING", "VERIFYING"].includes(item.state)) {
          Object.assign(item, { state: "UNKNOWN", message: "the server restarted during this close; outcome must be re-checked", finishedAt: now });
        }
      }
      job.status = "HALTED";
      this.saveJob(job);
      recovered++;
    }
    return recovered;
  }

  findJobByIdempotencyKey(sessionId: string, key: string): Job | undefined {
    const r = this.db.prepare("SELECT data FROM jobs WHERE session_id = ? AND idempotency_key = ?").get(sessionId, key) as
      | { data: string }
      | undefined;
    return r ? (JSON.parse(r.data) as Job) : undefined;
  }
}

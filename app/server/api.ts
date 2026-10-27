// HTTP API over the shared engine. Every check that bounds risk happens here or in
// the engine, never in the browser.
//
// Account binding: a session's operator key is generated server-side and is unique
// to that session. The owner address a visitor types in proves nothing by itself;
// the engine acts only where the owner has granted THIS operator on-chain, which
// only the owner can do. A visitor who types someone else's address gets an
// operator nobody linked, and every close is blocked.

import { randomBytes } from "node:crypto";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import { Engine, EngineError, type SessionRef } from "./engine/engine.js";
import type { Keystore } from "./keystore.js";
import type { SessionRow, Store } from "./store.js";
import { ALERT_DEFAULTS } from "./telegram/alerts.js";
import { UNLINK_NOTE, issueLinkCode } from "./telegram/bot.js";

export const SESSION_COOKIE = "pb_session";
export const CSRF_HEADER = "x-panicbutton";

export interface ApiDeps {
  engine: Engine;
  store: Store;
  keystore: Keystore;
  cookieSecure: boolean;
  /** Hostnames the server answers for (DNS-rebinding guard). Unset = no check (tests). */
  allowedHosts?: string[];
  log?: (line: string) => void;
  /** Present when the Telegram bot runs; the username is filled in once getMe answers. */
  telegram?: { username?: string };
}

type Env = { Variables: { session: SessionRow } };

const addressSchema = z
  .string()
  .trim()
  .refine((v) => isAddress(v), "not an address")
  .transform((v) => getAddress(v))
  .refine((v) => v !== zeroAddress, "zero address");

const prepareSchema = z
  .object({
    pools: z.array(addressSchema).min(1).max(50).optional(),
    all: z.boolean().optional(),
    slippageBps: z.number().int().min(1).max(10_000).optional(),
  })
  .refine((b) => Boolean(b.pools) !== Boolean(b.all), "send either pools or all: true");

const executeSchema = z.object({
  quoteIds: z.array(z.string().uuid()).min(1).max(50),
  idempotencyKey: z.string().uuid(),
});

const ref = (s: SessionRow): SessionRef => ({ id: s.id, owner: s.owner, operator: s.operator });

export function createApi(deps: ApiDeps) {
  const { engine, store, keystore } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const app = new Hono<Env>();

  app.use("/api/*", async (c, next) => {
    const started = Date.now();
    await next();
    // Method, path and status only: never bodies, cookies or headers.
    log(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`);
  });

  // DNS rebinding: a hostile page whose domain resolves to 127.0.0.1 would be
  // same-origin with itself, so the Host header is the only thing that differs.
  if (deps.allowedHosts) {
    const allowed = new Set(deps.allowedHosts.map((h) => h.toLowerCase()));
    app.use("*", async (c, next) => {
      // @hono/node-server builds the request URL from the Host header.
      const host = new URL(c.req.url).hostname.toLowerCase();
      if (!allowed.has(host)) return c.json({ error: "unknown host" }, 421);
      await next();
    });
  }

  // CSRF: browsers cannot attach a custom header cross-origin without a CORS
  // preflight, and this server answers no CORS requests.
  app.use("/api/*", async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header(CSRF_HEADER) !== "1") return c.json({ error: "missing request header" }, 403);
      if (c.req.method !== "DELETE" && !(c.req.header("content-type") ?? "").includes("application/json")) {
        return c.json({ error: "expected application/json" }, 415);
      }
    }
    await next();
  });

  const requireSession = async (c: Context<Env>, next: () => Promise<void>) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? store.sessionByToken(token) : undefined;
    if (!session) return c.json({ error: "no session; connect an account first" }, 401);
    c.set("session", session);
    await next();
  };

  app.onError((err, c) => {
    if (err instanceof EngineError) {
      const status = { BAD_REQUEST: 400, NOT_FOUND: 404, EXECUTION_DISABLED: 403, CONFLICT: 409 }[err.code] as 400 | 403 | 404 | 409;
      return c.json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => i.message) }, 400);
    log(`error ${c.req.method} ${c.req.path}: ${err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : "unknown"}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/api/health", async (c) => {
    try {
      return c.json(await engine.status());
    } catch {
      return c.json({ chainOk: false, executionEnabled: engine.executionEnabled }, 503);
    }
  });

  app.post("/api/session", async (c) => {
    const { owner } = z.object({ owner: addressSchema }).parse(await c.req.json());
    const token = getCookie(c, SESSION_COOKIE);
    const existing = token ? store.sessionByToken(token) : undefined;
    if (existing && existing.owner === owner) return c.json({ owner, operator: existing.operator, created: false });

    const { address, encrypted } = keystore.generate();
    if (address === owner) throw new EngineError("BAD_REQUEST", "generated operator collides with owner");
    const newToken = randomBytes(32).toString("base64url");
    store.createSession(
      { id: crypto.randomUUID(), owner: owner as Address, operator: address, encryptedKey: encrypted, createdAt: Date.now() },
      newToken,
    );
    setCookie(c, SESSION_COOKIE, newToken, {
      httpOnly: true,
      sameSite: "Strict",
      secure: deps.cookieSecure,
      path: "/",
      maxAge: 30 * 24 * 3600,
    });
    return c.json({ owner, operator: address, created: true }, 201);
  });

  // "Not connected" is an ordinary state on first visit, so it is a 200, not a 401.
  app.get("/api/session", (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    const s = token ? store.sessionByToken(token) : undefined;
    if (!s) return c.json({ connected: false });
    return c.json({
      connected: true,
      owner: s.owner,
      operator: s.operator,
      executionEnabled: engine.executionEnabled,
      limits: {
        defaultSlippageBps: engine.settings.defaultSlippageBps,
        maxSlippageBps: engine.settings.maxSlippageBps,
        quoteTtlMs: engine.settings.quoteTtlMs,
      },
    });
  });

  app.get("/api/session/link", requireSession, async (c) => {
    const s = c.get("session");
    const [coverage, funds] = await Promise.all([engine.coverage(ref(s)), engine.operatorFunds(s.operator)]);
    return c.json({ coverage, funds });
  });

  app.delete("/api/session", requireSession, (c) => {
    store.deleteSession(c.get("session").id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true, note: "Remove the bot in dreamDEX (Bots tab) to revoke its on-chain access." });
  });

  // Telegram linking. The code goes only to this authenticated session (never to logs),
  // is stored as a hash, expires in 10 minutes and works once.
  app.get("/api/telegram", requireSession, (c) => {
    const link = store.telegramLinkForSession(c.get("session").id);
    const alerts = store.alertSettings(c.get("session").id, ALERT_DEFAULTS);
    return c.json({ enabled: Boolean(deps.telegram), botUsername: deps.telegram?.username ?? null, linked: Boolean(link), linkedAt: link?.linkedAt ?? null, alerts });
  });

  app.post("/api/telegram/link-code", requireSession, (c) => {
    if (!deps.telegram) throw new EngineError("CONFLICT", "the Telegram bot is not configured on this server");
    const { code, expiresAt } = issueLinkCode(store, c.get("session").id);
    c.header("cache-control", "no-store");
    return c.json({ code, expiresAt, botUsername: deps.telegram.username ?? null });
  });

  app.delete("/api/telegram", requireSession, (c) => {
    const removed = store.unlinkTelegramSession(c.get("session").id);
    return c.json({ ok: true, removed, note: UNLINK_NOTE });
  });

  app.get("/api/positions", requireSession, async (c) => {
    return c.json({ positions: await engine.positions(ref(c.get("session"))), at: Date.now() });
  });

  app.post("/api/close/prepare", requireSession, async (c) => {
    const body = prepareSchema.parse(await c.req.json());
    const quotes = await engine.prepare(ref(c.get("session")), body.all ? "all" : (body.pools as Address[]), body.slippageBps);
    return c.json({ quotes });
  });

  app.post("/api/close/execute", requireSession, async (c) => {
    const s = c.get("session");
    const body = executeSchema.parse(await c.req.json());
    const job = engine.execute(ref(s), body.quoteIds, body.idempotencyKey, () => keystore.account(s.encryptedKey, s.operator));
    return c.json({ job }, 202);
  });

  app.get("/api/jobs/:id", requireSession, (c) => {
    return c.json({ job: engine.job(c.req.param("id"), c.get("session").id) });
  });

  return app;
}

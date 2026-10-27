// PanicButton server: API + built web UI, one persistent process.

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApi } from "./api.js";
import { DEFAULT_SETTINGS } from "./engine/config.js";
import { Engine } from "./engine/engine.js";
import { LiveChain } from "./engine/live-chain.js";
import { Keystore } from "./keystore.js";
import { Store } from "./store.js";
import { TelegramBot, startPolling } from "./telegram/bot.js";
import { HttpTelegram } from "./telegram/client.js";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "127.0.0.1";
const dataDir = resolve(env.DATA_DIR ?? ".data");
const executionEnabled = env.EXECUTION_ENABLED === "true";

const intEnv = (name: string, fallback: number, min: number, max: number) => {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  return n;
};

const settings = {
  ...DEFAULT_SETTINGS,
  maxSlippageBps: intEnv("MAX_SLIPPAGE_BPS", DEFAULT_SETTINGS.maxSlippageBps, 1, 300),
};
settings.defaultSlippageBps = intEnv("DEFAULT_SLIPPAGE_BPS", DEFAULT_SETTINGS.defaultSlippageBps, 1, settings.maxSlippageBps);

mkdirSync(dataDir, { recursive: true });
const keystore = new Keystore(env.KEYSTORE_KEY);
const store = new Store(join(dataDir, "panicbutton.sqlite"));
const interrupted = store.recoverInterruptedJobs();
if (interrupted) console.log(`marked ${interrupted} interrupted job(s) as halted`);
const chain = new LiveChain();
const engine = new Engine(chain, store, settings, { executionEnabled });
// The first market load takes ~10 s on the public RPC; do it before anyone needs it.
void chain
  .markets()
  .then((ms) => Promise.all(ms.map((m) => chain.poolWiring(m.pool))))
  .catch((e) => console.log(`market preload failed: ${(e as Error).message.slice(0, 120)}`));

// Telegram bot: optional, long polling, same process and engine as the web API.
let telegram: { username?: string } | undefined;
let stopTelegram = () => {};
if (env.TELEGRAM_BOT_TOKEN) {
  const http = new HttpTelegram(env.TELEGRAM_BOT_TOKEN);
  const bot = new TelegramBot({ engine, store, keystore, tg: http });
  telegram = {};
  const info = telegram;
  void http
    .getMe()
    .then((me) => {
      info.username = me.username;
      console.log(`telegram bot @${me.username} polling`);
    })
    .catch((e) => console.log(`telegram getMe failed: ${(e as Error).message.slice(0, 120)}`));
  // Report jobs that a restart cut off before anything else happens.
  void bot.tick().catch(() => undefined);
  stopTelegram = startPolling(http, bot, store, (l) => console.log(l));
}

const allowedHosts = ["127.0.0.1", "localhost", "[::1]", ...(env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean)];
const app = createApi({ engine, store, keystore, cookieSecure: env.COOKIE_SECURE === "true", allowedHosts, telegram });
// serveStatic resolves root relative to the working directory: run from app/.
const webRoot = env.WEB_ROOT ?? "./dist/web";
app.use("/*", serveStatic({ root: webRoot }));
app.get("*", serveStatic({ root: webRoot, path: "index.html" }));

serve({ fetch: app.fetch, port, hostname: host }, () => {
  console.log(`PanicButton on http://${host}:${port}  (Hideki 50383, execution ${executionEnabled ? "ENABLED" : "disabled"})`);
});

const shutdown = async () => {
  stopTelegram();
  await chain.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

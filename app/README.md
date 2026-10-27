# PanicButton MVP

An emergency exit terminal for **dreamDEX Perps on Hideki testnet (chain 50383)**. You can see an account's open perp positions and close one or all of them with immediate-or-cancel orders. Every close is checked on chain afterwards before it is reported.

**Testnet only.** Network config is pinned to Hideki v2 and `@somnia-chain/markets-sdk@0.32.1`, carried over from `experiments/exp0`.

## How it works

```
browser (React) ──HTTP──▶ server (Hono, persistent Node process)
                           ├─ API: sessions, positions, prepare, execute, jobs
                           ├─ Engine: the only code that decides to send
                           ├─ Keystore: per-session bot keys, AES-256-GCM at rest
                           └─ LiveChain: viem + markets SDK → Hideki RPC / WS / indexer
```

1. **Connect.** You enter your dreamDEX account address. The server creates a bot key for that session and shows only its address.
2. **Link.** In dreamDEX: wallet → **Link a bot** → paste the address → keep **Perps** ticked → **Add bot**, then send it ≥ 0.1 STT. The account panel shows how many markets the bot can trade (`isOperatorAuthorized`) and its STT balance.
3. **Close / Close All → prepare.** The server reads fresh state pinned to one block: the position, the opposite side of the order book, resting orders, the mark-price check, the bot's permission, and gas. It then prices an IOC order for **exactly |position|** within your slippage limit, simulates it with `eth_call`, and returns a quote valid for 60 s. Nothing is signed.
4. **Confirm → execute.** Only unexpired, unused, READY quotes for your session are accepted, under an idempotency key. For each one, sequentially:
   1. **Re-read** everything and abort if anything differs.
   2. **Simulate** again.
   3. **Sign and send** `placeOrderFor`.
   4. **Wait** for the receipt.
   5. **Verify** the position at the receipt block and at head, and compare the decoded fills.
   6. **Cross-check** the indexer's position-change row.

### Outcome states

| State | Meaning | Close All continues? |
|---|---|---|
| `CLOSED` | Position is zero at the receipt block and at head, and fills equal the order size. The indexer check is `agree`, `pending` or `unavailable` | yes |
| `PARTIAL` | Some of the position remains. **Not retried**; the UI offers a new prepare for the rest | yes |
| `ABORTED` | A pre-send check failed. **No transaction was sent** | yes |
| `FAILED` | Reverted, or confirmed with no fill, and the position is unchanged | yes |
| `FLIPPED` | The position reversed direction | **no**, the rest are skipped |
| `UNKNOWN` | No receipt within 120 s, or broadcasting failed after signing. **New closes for the session are refused** until a receipt appears or the operator's pending nonce clears | **no** |
| `AMBIGUOUS` | Data sources disagree (fills vs. position, receipt block vs. head, chain vs. indexer) | **no** |
| `SKIPPED` | Not attempted because an earlier item halted the run | n/a |

### Why there are no automatic retries

The venue has **no reduce-only flag** on `placeOrderFor` (verified in the SDK source and the ABI). An order larger than the position could flip it. So the size is always exactly the fresh |position| and never rounded. Resting orders on the market block the close. A partial fill is reported, and only a new prepare and confirm can send more.

## Setup

Requires Node ≥ 22.13 (tested on 24); SQLite is built into Node. From `app/`:

```bash
npm ci
cp .env.example .env
# put a fresh 32-byte hex secret into KEYSTORE_KEY without echoing it:
node -e "const fs=require('fs');const k=require('crypto').randomBytes(32).toString('hex');fs.writeFileSync('.env',fs.readFileSync('.env','utf8').replace(/^KEYSTORE_KEY=.*$/m,'KEYSTORE_KEY='+k))"
```

### Run

```bash
npm run dev            # API on :8787 + Vite on http://localhost:5173 (proxies /api)
# or production:
npm run build && npm start   # http://127.0.0.1:8787, serves dist/web
```

Routes (client-side; the server falls back to `index.html`):

| Path | Page |
|---|---|
| `/` | Landing page |
| `/app` | The terminal: connect, positions, Close / Close All, execution, Telegram linking |
| `/security` | Plain-language summary of [SECURITY.md](SECURITY.md) and the known limitations |

`EXECUTION_ENABLED` defaults to off, so everything except sending works: positions, link status, prepare and simulation. Set `EXECUTION_ENABLED=true` in `.env` only for an approved live test.

### Checks

```bash
npm test          # 125 tests, all MOCKED (no network)
npm run typecheck # server, tests, web
npm run build     # server (tsc) + web (vite)
```

## Telegram bot

A second interface to the same server process and the same `Engine`. It has no order-building or signing code of its own. It calls `positions`, `prepare` and `execute` exactly as the web API does, with the linked session's own bot key.

### Transport: long polling

The server binds `127.0.0.1` and has no public HTTPS endpoint, so the bot uses `getUpdates` long polling (any old webhook is removed at startup). Requirements:
- **Outbound HTTPS to `api.telegram.org` only.** There is no inbound port and no public URL.
- **Exactly one running process per bot token.** Telegram allows one poller per token. The engine's per-session send queue also assumes one process (see SECURITY.md).
- The poll offset and the processed update IDs are stored in SQLite, so a restart neither replays nor loses updates.

### Setup

1. In Telegram, message **@BotFather** → `/newbot`. Keep the token secret.
2. Add it to `.env` (git-ignored) without echoing it into your shell history, e.g. by editing the file: `TELEGRAM_BOT_TOKEN=<token>`.
3. `npm run build && npm start`. The log shows `telegram bot @<name> polling`. Without the variable, the bot does not start and the web app is unchanged.

| Variable | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | no | Bot token from BotFather. Unset = no bot |
| `EXECUTION_ENABLED` | — | Shared with the web app. Keep `false` while testing; Telegram confirmations are then refused and nothing is sent |

### Linking

1. In the web app, connect the account, then press **Account → Link Telegram**. You get a 10-character code. It is valid for **10 minutes**, works **once**, and is stored only as a hash. Generating a new code invalidates the old one.
2. In a **private chat** with the bot, send `/link CODE`. Group chats are refused.
3. The bot replies with the shortened dreamDEX account and bot-operator address. Check it is yours.

The link binds Telegram's numeric user ID (never the username) to that web session. A session has at most one Telegram user, and a Telegram user has at most one session; relinking replaces the old link. A user who sends more than 5 link codes within 15 minutes is refused. Disconnecting in the web app also removes the Telegram link.

**Unlinking** (`/unlink`, or **Unlink Telegram** in the web app) removes Telegram access only. **It does not revoke the bot operator's permission in dreamDEX.** To revoke that, use dreamDEX → Bots tab → Remove access.

### Commands

| Command | What it does |
|---|---|
| `/start` | Explains the bot and how to link |
| `/positions` | Open positions: market, side, size, entry, mark, PnL, liquidation price, and whether the bot is linked for that market |
| `/close` | Pick a position → the server prepares a quote → shows the order side, quantity, worst accepted price, simulation and expiry → **Confirm close** / **Cancel** |
| `/closeall` | Lists the positions that will be closed, in order, and the blocked ones that will not be touched. Explains sequential execution → **Confirm Close All (n)** / **Cancel** |
| `/cancel` | Cancels any confirmation you have not pressed yet. An executing close cannot be cancelled |
| `/alerts` | Shows the liquidation-alert setting. `/alerts off`, `/alerts on`, `/alerts 3` (distance in percent, 1–50) |
| `/unlink` | Removes Telegram access (see above) |

### Liquidation alerts

Every 30 s the bot reads each linked account's positions through the engine (the same read as `/positions`) and measures how far the mark price is from the estimated liquidation price: `(mark − liq) / mark` for longs, `(liq − mark) / mark` for shorts. Positions with a stale mark or no liquidation price are skipped.

- **On by default at 5%** after linking; `/alerts` changes or disables it, and the web app's Telegram panel shows the setting.
- **One alert per approach, not a stream.** A position alerts once when it comes within the threshold, again only each time the distance halves (5% → 2.5% → 1.25% …), and re-arms after it recovers past 1.5× the threshold. A reversed or closed position starts over. The state is stored in SQLite, so a restart does not repeat alerts.
- **Alerts never send anything.** The message has a **Prepare close** button, which runs the normal quote → review → **Confirm** flow, and **Mute 1h** for that position. Markets the bot is not linked for get no close button and a warning instead.
- A failed Telegram send is not recorded, so it is retried on the next check. Logs record only that an alert was sent, never the market or prices.

### Confirmation safety

- Each offer is a **durable row** in SQLite, bound to the Telegram user, the chat, the linked session and the quotes. Its expiry is no later than its quotes' 60 s TTL. A new offer cancels the user's previous unconfirmed one.
- **Confirm** checks that the row belongs to the pressing user, chat and session, is still `PENDING` and unexpired. It then claims the row atomically (`PENDING → EXECUTING`) and calls `Engine.execute` with the row's own idempotency key, in one synchronous step. Double taps, Telegram redeliveries and restarts therefore cannot send twice. The engine still enforces quote ownership, expiry, one-time use and the unresolved-transaction guard.
- **Reporting** comes from the engine's verified job state, never from submission. The "Confirmed" message says explicitly that submitting is not success. The final report gives each market's state (`CLOSED`, `PARTIAL`, `UNKNOWN`, …), the engine's message, the tx hash, the amount filled and the position afterwards. `PARTIAL`, `FAILED`, `UNKNOWN` and `AMBIGUOUS` are never retried.
- **Restarts:** at startup, jobs cut off mid-run become `UNKNOWN` / `SKIPPED` (existing behavior), and the bot reports them. A confirmation claimed but not yet started reports that nothing was sent. Expired offers lose their buttons.
- **Logs** contain only update IDs, command names and outcomes, never message text, link codes, tokens or keys. The bot token is scrubbed from transport errors.

### Safe manual testing (no transactions)

With `EXECUTION_ENABLED=false` (the default):
1. Start the server with a test bot token. Connect a test account in the web app, press **Link Telegram**, and send `/link CODE` to the bot.
2. Try `/positions`, `/close` (read the quote), `/closeall` (check the order and the blocked list), `/cancel`, and pressing **Confirm**. Confirm must answer *"Not executed: execution is disabled … Nothing was sent."*
3. Negative checks: reuse the same code from a second Telegram account (refused); wait more than 60 s and then confirm (expired); send a command in a group (refused); `/unlink`, then `/positions` (not linked).

The mock QA server (`test/qa-server.ts`) does not start the bot.

The 55 Telegram tests (15 of them for liquidation alerts) are mocked: a recording fake replaces the Telegram API and FakeChain replaces the venue. **Live:** two single-position closes (ETH-PERP, BTC-PERP) were confirmed from Telegram on Hideki and verified on chain; see [LIVE_TEST_RESULT.md](LIVE_TEST_RESULT.md). `/closeall` with real transactions, real partial fills, unknown outcomes and restarts mid-job have **not** been verified live. A liquidation alert was received live with a raised threshold (Phase 6 in LIVE_TEST_RESULT.md); an alert from a real adverse move at the default 5% has not.

## Tests: what is mocked and what is live

**All automated tests are mocked.** `test/fake-chain.ts` scripts the venue in memory. The tests prove the engine's and API's decisions, not dreamDEX's behavior.

| File | Covers |
|---|---|
| `test/plan.test.ts` | Selector = `0x80054449`, exact sizing at 6/18/24 decimals, price caps and tick alignment, depth, PnL, fingerprint, outcome classification |
| `test/engine.test.ts` | Refusing a second close while an earlier one is unresolved (receipt timeout, broadcast error, pending nonce, late receipt). Prepare blockers: stale mark, missing permission, resting orders, thin or empty book, gas, lot size, simulation revert, price far from mark, wrong registry, flat position, position moving mid-prepare. Execution: disabled mode, expired / reused / foreign / blocked quotes, idempotency, abort-before-send cases, partial fill without retry, flip halts, revert continues, no-fill, receipt timeout halts, send error, indexer disagree/unavailable, fill mismatch, sequential Close All |
| `test/api.test.ts` | Concurrent duplicate confirms submit once, restart recovery, Host allowlist, CSRF, address validation, cookie flags, auth, full prepare → execute → CLOSED flow, intruder blocked, cross-session isolation, execution-disabled 403, input bounds, **no key material in any response** |
| `test/keystore.test.ts` | Encryption round-trip, tamper and wrong-key rejection |
| `test/telegram.test.ts` | Linking (session-only code issue, valid / reused / expired / superseded codes, attempt limit, group chats refused, relink replaces), authorization (unlinked users, another user's or another chat's buttons, web disconnect), quote display, verified CLOSED report, execution disabled, `/cancel` and Cancel, expiry, duplicate updates and concurrent double confirm, partial fill and unknown outcome reporting plus the follow-up block, restart recovery (interrupted job, claimed-not-started, de-duplication after restart), Close All order, blocked list and halt on flip, unlink wording, no secrets in messages or logs, token scrubbing |

**Live, read-only checks** were run against Hideki with the built server and `EXECUTION_ENABLED=false`, using public accounts that held positions:
- Positions across up to 21 markets rendered in Edge.
- The coverage panel showed 0/21 linked, with gas 0.
- Close / Close All quotes were correctly blocked ("not linked", 0 STT, dust below minimum).
- A SOL-PERP quote matched the separate `experiments/exp0` harness exactly on raw size (`-94550000000`), side (BUY), quantity and cap rule. Only the book moved between the reads.

**No transaction has been sent by this app.**

### Browser QA (mock)

`test/qa-server.ts` runs the real API, engine, store and keystore over the scripted FakeChain, so every state can be clicked through without a network:

```bash
npm run build && QA_SCENARIO=mixed npx tsx test/qa-server.ts   # http://127.0.0.1:8788/app
# owner: 0x1111111111111111111111111111111111111111
# scenarios: mixed | unlinked | empty | blocked | flip | timeout | disabled
```

`QA_TELEGRAM=1` also shows the Telegram linking panel. No bot runs; `POST /qa/telegram-link/<code>` (mock server only) does what the bot does on `/link <code>`, so the linked state can be checked.

## Live testnet verification (still required)

None of the following has been verified on chain yet:

1. **An app-linked operator closing a real position** with `placeOrderFor` IOC (Experiment 0's core question).
2. **`decodePlaceOrder` fills** matching the position change on a real receipt.
3. **The indexer's position-change row** appearing for an operator-placed close (`listPerpPositionChanges({ txHash })`).
4. **A real partial fill,** and how the venue reports it.
5. **Revocation:** after **Remove access** in dreamDEX, coverage drops to 0 and prepare blocks with "not linked".
6. **Close All** across two markets with real sequential transactions.

### Procedure

The full step-by-step checklist with expected evidence is in [LIVE_TEST_CHECKLIST.md](LIVE_TEST_CHECKLIST.md). Summary:

Needs your explicit approval before step 4.

1. In dreamDEX on Hideki, with a **dedicated Somnia Account wallet**:
   - Fund its Perps account with a small amount of USDso.
   - Open the minimum-size position in one or two markets (e.g. ETH-PERP 0.004).
   - Leave **no resting orders or TP/SL** on those markets.
2. `npm run build && npm start` with `EXECUTION_ENABLED=false`. Connect the account, then link the shown bot address (Link a bot → Perps) and send it ≥ 0.1 STT.
3. Press **Close** and read the quote: side, quantity = |position|, best price, worst accepted price, and `simulation ok`. Cancel.
4. **After approval:** restart with `EXECUTION_ENABLED=true`, prepare again and confirm. Record the tx hash, final state and indexer result from the execution panel, plus the job JSON from `GET /api/jobs/:id`.
5. Independently confirm `MarginBank.getPosition(owner, pool)` returns size 0 (e.g. `experiments/exp0`'s reads, or `cast call`).
6. Remove the bot in dreamDEX and confirm the account panel shows 0 of 21 markets linked and prepare blocks.

## Known limitations

- **Simulation can't show the result.** The RPC lacks `eth_simulateV1`, so simulation proves the call would be accepted (`success`, `orderId`) but not the post-trade position. Only the real receipt and the reads after it show that.
- **A small race remains.** A liquidation or manual trade landing between the final re-check and inclusion can change the size. This is detected afterwards (`FLIPPED` / `AMBIGUOUS`) and never retried.
- **Resting orders block a close.** The bot could cancel them (`cancelOrderFor`), but PanicButton does not do it automatically. Cancel them in dreamDEX first.
- **TP/SL stops** armed by the account cannot be cancelled by the bot.
- **New markets need a re-link.** Permissions are per market, so a market listed after linking needs the bot added again; the account panel lists uncovered markets.
- **Development-grade indexer.** The Hideki indexer is only a secondary check; decisions use chain reads.
- **No public Hideki explorer** is listed by the SDK, so evidence is the tx hash, the receipt and chain reads.
- **Single process.** The per-session send queue is in-process (see SECURITY.md).
- **RPC latency.** The public Hideki RPC takes ≈0.7 s per round trip. A one-market prepare takes ≈2.5 s, and a 21-market Close All ≈12–20 s (measured). Markets are preloaded at startup, reads retry, and unreadable markets block rather than guess.
- **Dust is real.** Live accounts hold positions below the market minimum (e.g. 0.1 AVAX vs 1.4). No single order can close those; the quote says so.

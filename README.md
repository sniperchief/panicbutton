# PanicButton

**When the market turns, get out.**

PanicButton is an emergency exit for **dreamDEX Perps** on **Somnia Tokyo testnet** (Hideki, chain 50383). It closes your perp positions from a web terminal or a Telegram bot, warns you on Telegram before a position gets close to liquidation, and says **"closed"** only after it has checked on chain that the position is really zero.

**Live:** [panicbutton-production.up.railway.app](https://panicbutton-production.up.railway.app) · open the terminal at [/app](https://panicbutton-production.up.railway.app/app). It runs against Somnia testnet with execution enabled, so closes are real testnet transactions once you link its bot address in dreamDEX.

**Demo video:** [youtu.be/k-Kr7gaqwuA](https://youtu.be/k-Kr7gaqwuA)

Built for the [dreamDEX Perps Builder Bounty](https://dorahacks.io/hackathon/dreamdex-perps-bounty/detail), MVP track, category **trader tools**.

---

## Who it is for

**dreamDEX perps traders who need to get flat fast, and be sure they did.**

- **Traders away from their desk.** A fast move rarely waits until you are at your computer. With PanicButton you can close from Telegram on your phone, without connecting a wallet or signing in a browser.
- **Leveraged traders.** The bot messages you when the mark price comes within a set distance of your liquidation price, with the close one tap away.
- **Anyone who has wondered "did that actually close?"** Submitting a transaction is not success. PanicButton tracks every close to its final on-chain state and reports partial fills, failures and unknown outcomes honestly.

## What it does

| | |
|---|---|
| **Web terminal** (`/app`) | Positions with size, entry, mark, unrealized PnL and liquidation price. **Close** one position or **Close All**, with a confirmation that shows the exact order before anything is sent |
| **Telegram bot** | `/positions`, `/close`, `/closeall`, linked with a one-time code from the web app. The same engine and the same confirmations as the web |
| **Liquidation alerts** | The bot checks every 30 s and messages you when a position comes within 5% of liquidation (adjustable with `/alerts`), again each time that distance halves. Each alert has a **Prepare close** button |
| **Verified outcomes** | Every close is checked at the receipt block and at the chain head, fills are compared, and the indexer is cross-checked. You see `CLOSED`, `PARTIAL`, `FAILED`, `UNKNOWN` and other states, never a guess |
| **No wallet key** | You never give PanicButton your wallet key. You authorize a dedicated bot address with dreamDEX's own **Link a bot**, and can remove it at any time |

## How it works

```
   Web terminal ──┐
                  ├──▶ one server-side exit engine ──▶ dreamDEX Perps (Somnia testnet)
   Telegram bot ──┘     prepare → confirm → re-check → sign → verify
```

1. **Review.** Positions are read from chain for the account you protect.
2. **Prepare.** PanicButton reads the position, the order book, resting orders, the mark price, the bot's permission and gas at one block. It prices an immediate-or-cancel order for **exactly** the position size and simulates it. Nothing is signed yet; the quote is valid for 60 seconds.
3. **Confirm.** You see the side, quantity, worst accepted price and simulation result. Only your explicit confirmation sends.
4. **Verify.** Right before sending, the engine re-reads everything and aborts on any change. After sending, it waits for the receipt and checks the position at that block and at head, the fills and the indexer. Only full agreement is reported as closed.

**Nothing is retried automatically.** dreamDEX has no reduce-only flag on `placeOrderFor`, so an order larger than the position could flip it. A partial fill is reported and you prepare the rest yourself. An unknown outcome blocks new closes until it resolves, so a close is never sent twice.

## Live evidence on Somnia testnet

Four real closes, sent by PanicButton bot operators and verified on chain. Each position was **0** at the receipt block and at head, and the indexer agreed.

| Market | Closed from | Transaction | Filled |
|---|---|---|---|
| BTC-PERP | PanicButton server (first live close) | `0x2ea0efec65b60bc73bb9a50d60b343eaedea064816a19097f5fb1192dfa8527f` | 0.00217 / 0.00217 |
| ETH-PERP | Telegram `/close` | `0x12b80a6ac008d39a5ec2abc4cacadb599284bfc920036027b00cc54a1a2b0feb` | 0.2306 / 0.2306 |
| BTC-PERP | Telegram `/close` | `0x76a270787ba7f7dc3d0931f5e93e07eed643ee7e7dd486f505fc34dca7922fbd` | 0.00434 / 0.00434 |
| ETH-PERP | Telegram, after a liquidation alert test | `0x95423a5caa4562a6f25deeba9e81589d7554958b9b705edd7a1c55e3ab6e5663` | 3.9136 / 3.9136 |

Full records, including blocks, raw sizes, decoded fills and how to re-check them yourself with `cast`, are in [app/LIVE_TEST_RESULT.md](app/LIVE_TEST_RESULT.md).

## Run it

Requires **Node ≥ 22.13** (tested on 24). From `app/`:

```bash
npm ci
cp .env.example .env
# put a fresh 32-byte hex secret into KEYSTORE_KEY without echoing it:
node -e "const fs=require('fs');const k=require('crypto').randomBytes(32).toString('hex');fs.writeFileSync('.env',fs.readFileSync('.env','utf8').replace(/^KEYSTORE_KEY=.*$/m,'KEYSTORE_KEY='+k))"
npm run build && npm start      # http://127.0.0.1:8787
```

Then:

1. Open `http://127.0.0.1:8787/app` and enter your dreamDEX account address. PanicButton creates a bot key and shows its address.
2. In dreamDEX: wallet → **Link a bot** → paste that address → keep **Perps** ticked → **Add bot**. Send the bot at least 0.1 STT for gas.
3. The Account panel should show **21/21 markets linked**.
4. Optional: add a `TELEGRAM_BOT_TOKEN` from @BotFather to `.env`, restart, and press **Link Telegram**.

`EXECUTION_ENABLED` is off by default: everything works except sending, so you can try positions, quotes and simulations safely. Set it to `true` only when you want real closes.

To click through every state without a network or a wallet, run the mock QA server: `npm run build && QA_SCENARIO=mixed npx tsx test/qa-server.ts`, then open `http://127.0.0.1:8788/app` and connect `0x1111111111111111111111111111111111111111`.

The full setup, configuration and Telegram guide is in [app/README.md](app/README.md).

### Checks

```bash
npm test          # 125 tests, all mocked (no network)
npm run typecheck
npm run build
```

## Safety and honest limits

- **What the bot key can do.** dreamDEX's **Link a bot** has no close-only permission, so the bot key could place any order for the account. It **cannot withdraw** or transfer funds. What limits it to closing is PanicButton's code, not the protocol, so link it only to a dedicated trading wallet.
- **Revoking** is immediate: dreamDEX → Bots tab → remove the bot.
- **Partial fills** are reported, not retried. **Resting orders** on a market block a close until you cancel them in dreamDEX.
- **Liquidation alerts** use the venue's estimated liquidation price, and positions without one are skipped.
- **Not yet verified live:** Close All with real transactions, real partial fills, and recovery from an unknown outcome. These are covered by mocked tests only.
- **Testnet only, local-development grade.** A shared production deployment needs keys in a KMS, HTTPS, rate limits and monitoring. See [app/SECURITY.md](app/SECURITY.md).

## X posts

Posts about PanicButton, tagging [@DreamDEXSomnia](https://x.com/DreamDEXSomnia):

1. https://x.com/sniperchief_001/status/2115074087257051179
2. https://x.com/sniperchief_001/status/2115693271267545107

## Repository

| Path | Contents |
|---|---|
| [app/](app/) | The product: server (Hono, exit engine, Telegram bot, SQLite store), web app (React), tests |
| [app/LIVE_TEST_RESULT.md](app/LIVE_TEST_RESULT.md) | Live testnet evidence |
| [app/SECURITY.md](app/SECURITY.md) | Security model and review findings |
| [PHASE_0_FEASIBILITY.md](PHASE_0_FEASIBILITY.md) | The research that preceded the build: network, SDK and permission findings |
| [experiments/exp0/](experiments/exp0/) | The first standalone proof that a linked bot can close a position |

## License

[MIT](LICENSE)

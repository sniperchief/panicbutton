# PHASE 0: PanicButton Feasibility Audit

**Date:** 2026-10-25 · **Scope:** read-only audit. No trades, keys, links, installs or transactions.
**Inspected:** dreamDEX docs (perps dev/trader, Link a Bot, Operators, HTTP API auth, Orders), `somnia-chain/dreamdex-bot-kit` at commit `25798660` (2026-10-12), the `@somnia-chain/markets-sdk` 0.32.1 and 0.31.0 tarballs (their `src/` and `docs/` folders), and live **read-only** JSON-RPC and GraphQL pings to Hideki.

Labels used: **[V]** verified from source, docs or live read · **[I]** inference · **[U]** unresolved.

---

## 1. Verdict: **Feasible with constraints**

All the parts exist. dreamDEX's **Link a Bot** writes an on-chain operator grant. A server-held bot key can then call `placeOrderFor` / `cancelOrderFor` on Hideki perp pools for the user's account, with no browser and no withdrawal rights. That makes the Telegram flow possible in principle. The constraints:

- **No reduce-only flag on regular perp orders.** A close is an opposite-side IOC order, and an oversized one can flip the position.
- **The operator key can also open positions.** There is no "close-only" permission.
- **Grants are per market,** and every bot key needs STT for gas.
- **The bot kit's own network config contradicts the docs and the live chain.**
- **Nobody here has tested the Hideki perps operator path end to end yet.** One experiment (§10) must pass first.
- **Timeline [U]:** if the bounty really closes on 1 Nov 2026, that leaves about 7 days.

---

## 2. Network compatibility

### Correct configuration (Hideki v2)

| Item | Value | Evidence |
|---|---|---|
| Chain | **Hideki testnet, chain ID 50383**, gas token STT | Perps dev docs; SDK `chains/definitions/hidekiTestnet.ts`; live `eth_chainId` → `0xc4cf` [V] |
| RPC | `https://api.hideki2.infra.testnet.somnia.network` | docs + SDK [V]. Live: block ~32.7M |
| WebSocket (**required** by the SDK) | `wss://api.hideki2.infra.testnet.somnia.network/ws` | docs; live HTTP probe returns 426 Upgrade Required, so the endpoint is up [V] |
| Indexer (GraphQL) | `https://hideki-dev.smk.somnia.host/v1/graphql` | docs; live `{__typename}` OK [V] |
| SDK | `@somnia-chain/markets-sdk@0.32.1` (latest, 2026-10-13) + `SOMNIA_HIDEKI_TESTNET_ADDRESSES` | docs; npm registry [V] |
| MarginBank | `0x478769E1177C0773c43A593DCCc4Ad15F15F1394` | docs + SDK; has code on chain [V] |
| PerpPoolFactory | `0xE631fAEE547baeE07353E290f0562ea67d856560` | docs + SDK; has code [V] |
| OperatorPermissionsRegistry | `0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a` | docs + bot kit; has code [V] |
| Perps collateral (USDso) | `0xed7993A74dAe1e6656B704A424DcD8711aAf4F72`. **Read it from each market's `quoteToken`** | docs; has code [V] |
| Per-market pool / marginBank / stopRegistry | Read from the market row (`listPerpMarkets` / `loadMarkets`) | docs, bot kit [V] |

The app's wallets, Perps Arena and Link a Bot all live in the app's "DreamDEX" region, which is Hideki [V, trader docs].

### Contradictions found (none resolved silently)

1. **The bot kit's root `.env.example` and `.env.railway` set `NETWORK=testnet`, which is Shannon (50312).** `perp-core` defaults to `hideki` only when `NETWORK` is unset (`packages/perp-core/src/config.ts:145`). If you copy the example env, the bot talks to Shannon pools, where an app-linked key is not authorized. **Use Hideki.**
2. **The bot kit passes the Shannon address set on Hideki.** `packages/perp-core/src/exchange.ts` passes `SOMNIA_TESTNET_ADDRESSES` and claims "the singletons … sit at the same deterministic addresses there." **That is false for the perp singletons.** Live `eth_getCode` on Hideki returns **0 bytes** at the Shannon MarginBank `0xdd4A…5C4E` and Shannon PerpPoolFactory `0x516d…a07b` [V]. The SDK prefers a configured `addresses.perpPoolFactory` (`src/unified/exchange.ts:1714,1889`). Pool discovery against an empty address will therefore fail, and the SDK falls back to indexer rows. This is likely not fatal, but it is fragile [I]. **Use `SOMNIA_HIDEKI_TESTNET_ADDRESSES`.**
3. **SDK versions disagree.** The docs say 0.32.1. `perp-core` declares `^0.31.0`, and the lockfile resolves 0.31.0. **0.31.0 does not export `SOMNIA_HIDEKI_TESTNET_ADDRESSES`** [V]. `ec-core` and the root lockfile use 0.30.0.
4. **Two collateral addresses.** `SOMNIA_HIDEKI_TESTNET_ADDRESSES.collateral` is `0x9E94…148f`, but perps use USDso `0xed79…4F72`. The docs flag this explicitly: read `quoteToken`.
5. **The Hideki regenesis kept the same chain ID.** v1 (`api.hideki…`) and v2 (`api.hideki2…`) share chain ID 50383, yet hold different contracts at the same addresses, and signatures are valid on both (SDK `hidekiTestnet.ts` header). Pin the v2 endpoints.
6. **Explorer.** The docs give `explorer.testnet.somnia.network/tokyo`. The SDK says "No public block explorer is known for Hideki." [U] Check manually before relying on explorer links as evidence.
7. **Naming.** "Tokyo" means Hideki. At least one bounty repo labels 50312 as Tokyo. Treat chain ID as the source of truth.
8. **The HTTP API (SIWE → 1-hour JWT) lists only chains 5031 and 50312** and documents no perps. **There is no documented REST path for Hideki perps.** Use SDK chain reads and the indexer.
9. **Reduce-only.** The trader "Orders" page lists perps reduce-only orders. The SDK `PlacePerpOrderParams` (`src/trade.ts:803`) and the `placeOrderFor` ABI have **no reduce-only field** [V]. In the SDK, reduce-only exists only for TP/SL stop orders (stop registry).
10. **dreamBot Builder covers Spot and Event Contracts only** (fetched content). It is not a perps tool, and the bounty does not depend on it.

---

## 3. Position discovery

**Authentication: none needed for reads.** Positions are public chain state, so any address can be read [V]. Construct `new SomniaMarkets({ chain, wsRpcUrl, indexerUrl, addresses, account: OWNER })`. Passing a bare address makes the client read-only for that account (`packages/perp-core/src/exchange.ts:59-68`).

| Need | Method (SDK 0.32.1) | Notes |
|---|---|---|
| All open positions | `exchange.fetchPositions()` → `UnifiedPosition[]` | `src/unified/exchange.ts:5771`. Makes **one `getPerpPosition` chain read per perp market** (~21), plus a state read and a liquidation read per held position. Returns `symbol, side, contracts (float), entryPrice, markPrice?, unrealizedPnl?, liquidationPrice?, perpState: "ok"\|"degraded", info.position` (raw) |
| Exact raw size (for sizing orders) | `client.getPerpPosition({marginBank, account, pool})` | `somniaMarketsClient.ts:3605`. Signed bigint `size`, `avgEntryPrice`. **Size closes from this, never from the float `contracts`** |
| Positions table in one call | `client.listPerpPositions(account)` | `:3150`. Indexer snapshot, **not marked to market**. Signed `size`. `includeFlat` |
| Margin / health | `client.getMarginAccount(marginBank, account)` | `:3631`. `equity, lockedCollateral, imReq, mmReq, cmReq, marginStatus` |
| Per-position margin, leverage | `client.getPerpPositionAnalytics` / `listPerpPositionAnalytics` | `:3861`. Margin is **cross**. "Position margin" is its `initialMarginRequirement` |
| Liquidation price | `client.getLiquidationPrice({marginBank, pool, account})` | `:3796`. `null` when flat. Undefined if any mark in the account is stale |
| Close preview | `client.previewPerpClosePnl({pool, marginBank, account})` | `:3969`. `closedQuantity` (lot-aligned), `netProceeds`, `priceable` |
| Open / reduced / closed | `size == 0` means closed. `client.listPerpPositionChanges({account, pool})` returns `OPEN/INCREASE/REDUCE/CLOSE/FLIP` | `:3087`. "Partially closed" is not a state; it shows up as a `REDUCE` row |
| Owner's resting orders | `client.getPerpPortfolio(account)` (indexed open orders + recent trades) | `:2381` |

**Freshness and failure modes [V]:**
- Hideki produces a block every ~10 ms, and chain reads are at head.
- The indexer lags by an unknown amount [U].
- A stale mark gives `priceable:false` on previews and sizing.
- A dead oracle gives `perpState:"degraded"`: the position is still listed, without mark or PnL.
- In SDK 0.32.1, the SDK requires the WebSocket even for reads.

**Rate limits: not documented anywhere** in the docs, SDK or bot kit [U]. Assume public-RPC limits. Poll at a modest rate (e.g. 2–5 s) and cache market metadata.

---

## 4. Exit execution

### There is no native close operation [V]

A close is an **opposite-side IOC order** on the position's pool. The bot kit's version is `closePosition` (`packages/perp-core/src/orders.ts:234`). Through a linked bot it uses:

```
placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity,
              uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption,
              address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)
```
(ABI: `packages/perp-core/src/operator.ts:48`; selector `0x80054449`)

**The SDK has no perp `…For` writes.** The bot kit sends them directly with viem: `simulateContract` → `writeContract` → `waitForTransactionReceipt` (`operator.ts:143-163`).

### Order parameters

| Parameter | Rule | Evidence |
|---|---|---|
| `isBid` | `true` to close a short, `false` to close a long | `orders.ts:282` |
| `orderType` | `2` = MARKET (IOC). `1` = FOK. `0` = LIMIT (**rests the remainder**, so never use it for a panic close) | SDK `ORDER_TYPE`, `trade.ts:439` |
| `price` | **18 decimals**, aligned down to `tickSize`. For IOC it is the worst acceptable price: the touch ± slippage. The bot kit defaults to 20 bps, which is too tight for a panic. Make it configurable (e.g. 100–300 bps) | docs; `orders.ts:151-159` |
| `quantity` | Raw base units, **per-market decimals (6–24)**, aligned to `lotSize`, at least `minQuantity`. Wrong scale reverts as an opaque `InsufficientCollateral()` | docs |
| Gas | 10,000,000 gas limit; billed on gas used. Observed up to ~1.56M per call | docs; `operator.ts:60` |

### Safety rules the code must enforce (none is provided by the venue)

1. **Prevent flips.** A close is purely reducing only up to `_reducingCapacity` = `|size|` minus resting reduce-side orders (SDK `docs/PERPS.md` §previewPerpClosePnl).
   - First cancel the owner's resting orders on that pool with `cancelOrderFor`, using order IDs from `getPerpPortfolio`.
   - Then size from a fresh `getPerpPosition` read taken immediately before sending.
   - Never send more than `|size|`.
   - A liquidation or manual close landing between the read and inclusion could still flip a small amount. Re-read afterwards and close any flip.
2. **Partial fills.** IOC cancels the remainder, so loop: re-read → re-send, up to N attempts, and stop on an empty book.
3. **Reverts arrive as named errors through the simulation:**

   | Error | Meaning |
   |---|---|
   | `ImmediateOrCancelNoFill` | Book moved or empty |
   | `OnlyApprovedContracts` | Bot key not linked for this market |
   | `InsufficientCollateral` | Wrong decimals, or the order has an increasing leg |
   | `IsolatedMarketBlocked` | Isolated account, other market |
   | `MaxPositionSizeExceeded` | Over the per-market cap |
   | `MarketRestricted` | **Increases only.** Closes still work on close-only markets |

   An on-chain failure shows status 0 with no reason; replay it with `eth_call` at the parent block.
4. **Un-priceable markets.** The bot kit's `closePosition` **gives up** when `previewPerpClosePnl.priceable` is false, yet the venue still accepts reducing orders during an oracle outage (`orders.ts:245-256`). PanicButton should fall back to sizing from `getPerpPosition` (§3).
5. **Lot dust.** Closing aligns the size down to `lotSize`. A position that is not a lot multiple (possible after a partial liquidation [I]) can leave dust that cannot be closed.
6. **Do not copy blindly.** The bot kit builds the price as `BigInt(Math.round(touch * 1e18))` from a float. Use exact bigint math.
7. **Stops.** TP/SL armed by the owner cannot be cancelled by the bot. After a close they drop as `ReduceOnlyNoPosition`, and their 0.15 STT stays locked until the owner cancels them. Tell the user.

### Closing several positions

Send one transaction per pool, sequentially from one operator key, with explicit nonce handling. Batch `placeOrdersFor` exists, but each call targets a single pool (`src/perp/history.ts:1108`). At 10 ms blocks a sequential close of a handful of markets should take seconds [I].

### Verification evidence (all obtainable) [V]

| Evidence | Source |
|---|---|
| Transaction hash | `writeContract` |
| Receipt status | `waitForTransactionReceipt` |
| `orderId` + `fills[]` | `decodePlaceOrder(receipt, pool)` (SDK `src/decode/orders.ts:196`) |
| Final size == 0 | Post-close `getPerpPosition` |
| `CLOSE` row with `orderId`, `closedSize`, `exitPrice`, `realizedPnl` | `listPerpPositionChanges` |
| Order status | `listPerpOrderHistory` (`:2563`) |

---

## 5. Telegram feasibility: **Supported in principle; proven by docs and source, not yet by a test**

| Question | Answer | Evidence |
|---|---|---|
| How is a bot linked? | In the dreamDEX app: Wallet → **Link a bot** (or Manage → Bot access) → paste the bot's **address** → tick **Perps** → Add bot. The app signs the change itself, with no wallet prompt. **Requires a Somnia Account wallet; Legacy accounts cannot link** | Link a Bot docs [V] |
| What does the bot receive? | An OperatorPermissionsRegistry grant for `placeOrderFor` (`0x80054449`), `cancelOrderFor` (`0xe37b444b`) and `reduceOrderFor` (`0x364c2587`) **on each perp pool that exists at link time** | docs; `operator.ts:9-20, 40-44` [V] |
| Can it act without a browser signature per action? | **Yes.** The bot signs with its **own** key and pays its own STT gas. Orders, margin and fills belong to the owner | `docs/perps.md`; `operator.ts` [V] |
| Can it read positions? | Yes, but reads need no permission at all | §3 |
| Mechanism type | Operator / split-key ("session key") grant enforced inside the pool. **No** API keys, no JWT, no delegated EIP-712 signatures | `docs/session-keys.md`; Operators docs [V] |
| Key storage | The bot key is the builder's responsibility. "The bot keeps its own key. You never share yours." The docs set no storage requirements | Link a Bot docs [V] |
| Can it withdraw? | **No.** "Cannot withdraw or send." Fills, cancels and reduces always pay the owner | docs [V] |
| Revocation | Bots tab → red X → Remove access. "Removal takes effect straight away." Resting orders stay on the book | docs [V]. No expiry is documented [U] |
| Limits | No TP/SL arming. No leverage changes. No `autoPull` from the wallet, so margin must already be in the Perps account. **Markets listed after linking need a re-link** | `docs/perps.md`; `margin.ts:189` [V] |
| Live on Hideki? | The registry has code on Hideki [V]. The bot kit's `perp-guard` and `perp-starter` run in trading-key mode on Hideki, and third-party bounty repos report using it. The only "verified live" claim in the bot kit (`docs/session-keys.md`) is for **spot on mainnet**. **Perps on Hideki is not verified by this audit** [U] | |
| Ownership check | `pool.isOperatorAuthorized(owner, operator, selector)`, or SDK `client.isOperatorAuthorized` (`:5231`) | `operator.ts:110-124` |

**Security caveat [I].** "Cannot withdraw" does not mean "cannot lose funds." A stolen operator key can open positions or trade the account into an attacker's resting orders at bad prices. Mitigations:
- One operator key **per user**, never shared.
- Keys encrypted at rest.
- Server code that only ever builds reducing orders.
- Recommend that users link PanicButton to a dedicated trading wallet, as the docs advise.

### Minimum secure linking architecture

1. **Web: user enters their dreamDEX account address.** No wallet-connect is needed, and it may not even be possible: Somnia Accounts sign inside the app [U].
2. **Server: generate a fresh operator key K_u for that user.** Store it encrypted with a master key held in an env var or KMS, and show only its address.
3. **User: links K_u's address in the dreamDEX app (Perps) and sends it some STT for gas.** The same screen can send the STT.
4. **Server: polls `isOperatorAuthorized(owner, K_u, place/cancel)` on every perp pool.** The on-chain grant **is the ownership proof**: only the owner can grant K_u, so no separate SIWE step is needed.
5. **Web: shows a one-time code / `t.me/<bot>?start=<code>`.** The bot binds `chat_id` to the user. The code expires after 10 minutes and is single use.
6. **Telegram `/exit`: the bot lists positions with a "Confirm" button** that carries a request nonce and expires after 60 s. Confirmation goes to the shared execution service, which is idempotent per nonce.
7. **To unlink, the user removes the bot in the dreamDEX app.** The server detects the missing grant and marks the link revoked.

---

## 6. Recommended architecture

| Component | Responsibility | Hosting |
|---|---|---|
| **Web UI** (Next.js/Vite) | Address entry, link wizard, positions view, close-one / close-all with confirmation, evidence view | Static or serverless is fine |
| **Read API** | `fetchPositions`, margin, grant coverage | Serverless *possible*, but the SDK needs a WebSocket, so cold starts plus WS setup hurt latency [I]. Simpler to serve from the persistent service |
| **Execution service** (Node, persistent) | Holds encrypted operator keys. Validates the request, then: cancel resting orders → fresh size → simulate → IOC `placeOrderFor` → verify → retry. Per-user mutex, nonce manager, idempotency keys, evidence log | **Must be persistent** (Railway/Fly/Render/VPS). Multi-transaction runs, nonce serialization and SDK WebSocket sessions are a poor fit for serverless |
| **Telegram bot** | `/start <code>`, `/positions`, `/exit` [all\|symbol] → confirmation buttons → results with tx hashes | Same persistent process (long polling is simplest) |
| **DB** (SQLite or Postgres) | users, owner address, encrypted operator key, telegram binding, exit_requests (unique nonce, state machine), execution evidence | Alongside the service |

**One shared backend is safe** if both interfaces only *request* exits and the execution service alone holds keys and enforces confirmation, idempotency and reducing-only logic [I].

---

## 7. Critical blockers and risks

| # | Item | Severity |
|---|---|---|
| 1 | **Untested here:** an app-linked operator key closing a Hideki perp position with IOC `placeOrderFor` | **Gating**: run the §10 experiment |
| 2 | **Bounty window [U]:** third-party repos say **19 Oct – 1 Nov 2026**, MVP and Feedback tracks, on DoraHacks. The official page could not be fetched (HTTP 405). About 7 days remain if correct | **High.** Confirm on DoraHacks today |
| 3 | **No reduce-only for regular orders:** flip risk | Mitigated by the §4 rules |
| 4 | **Testnet liquidity:** an IOC close needs resting depth. An empty book means no fill | High for the demo. Check book depth on target markets |
| 5 | **Test funds:** the account needs USDso in its **Perps account** (Perps Arena voucher: 1,000 paper USDso, allowlisted markets only for increases). The bot key needs STT | Setup |
| 6 | **Somnia Account required** to link. Legacy accounts cannot | Setup |
| 7 | **Per-market grants:** new markets need a re-link. Show coverage via `isOperatorAuthorized` per pool | Medium |
| 8 | **Bot kit misconfiguration** (§2 items 1–3): building on its defaults would target the wrong addresses or network | Medium. Use SDK 0.32.1 + Hideki addresses |
| 9 | **Rate limits and indexer lag undocumented** | Low–Medium |
| 10 | **Crowded idea space:** the bot kit already ships `perp-guard` (automatic reduce/flatten), and several bounty entries are liquidation guards (e.g. Dreamcatcher, perps-shield, risk-sentinel). The differentiator has to be a manual, verified, two-channel panic exit | Product |

---

## 8. MVP scope

**Must have:**
- Hideki-only.
- One user flow: address entry → generate operator key → link-coverage check.
- Positions table showing size, side, entry, mark, uPnL, liquidation price, account health.
- **Close one** and **Close all** (web) with a confirmation step.
- Telegram: `/start <code>`, `/positions`, `/exit` with a confirm button.
- Shared execution service applying the §4 safety rules.
- An evidence page per exit: tx hashes, orderIds, fills, post-close size == 0, `CLOSE` change rows.

**Cut:** automatic triggers, TP/SL, leverage, multiple accounts per user, mainnet, wallet-connect, notifications beyond replies to commands.

---

## 9. Evidence

**Documentation**
- Perps dev: https://app.testnet.dreamdex.io/docs/developers/perps-testnet (chain, RPC, indexer, contracts, sizing, `placeOrderFor`, errors)
- Perps trader: https://app.testnet.dreamdex.io/docs/trading/perps-testnet
- Perps orders: https://app.testnet.dreamdex.io/docs/trading/perps-testnet/orders
- Link a Bot: https://app.testnet.dreamdex.io/docs/trading/common/link-a-bot
- Operators & Session Keys: https://app.testnet.dreamdex.io/docs/trading/spot/operators (selectors, revocation, per-pool vs global)
- HTTP API auth: https://app.testnet.dreamdex.io/docs/developers/http-api/authentication (SIWE/JWT; 5031/50312 only)
- dreamBot Builder: https://app.testnet.dreamdex.io/dreambot-builder (Spot/EC; client-rendered)
- Somnia Markets docs: https://somnia-platform-docs.vercel.app/markets/somnia-markets (no network detail)

**dreamdex-bot-kit @ `25798660`**
- `docs/perps.md`: trading-key workflow on Hideki
- `docs/session-keys.md`: operator model; "verified live" only for spot on mainnet
- `packages/perp-core/src/config.ts:80-107,145`: endpoints, registry addresses, default network
- `packages/perp-core/src/exchange.ts:41-81`: SDK built with `SOMNIA_TESTNET_ADDRESSES`; owner-as-address read mode
- `packages/perp-core/src/operator.ts:40-205`: selectors, `placeOrderFor` / `cancelOrderFor` / `reduceOrderFor` ABI, `isOperatorAuthorized`, simulate → send → receipt, `decodePlaceOrder`
- `packages/perp-core/src/orders.ts:85-114` (`sizeOrder`), `:148-200` (`placePerp`), `:234-298` (`closePosition`)
- `packages/perp-core/src/margin.ts:39-56,175-196`
- `strategies/perp-guard/src/index.ts`: closest existing prior art
- `.env.example:8`: `NETWORK=testnet`
- `package-lock.json:978,2575`: SDK 0.30.0 and 0.31.0

**@somnia-chain/markets-sdk 0.32.1 (`src/`)**
- `addresses.ts:70`: `SOMNIA_HIDEKI_TESTNET_ADDRESSES` (absent in 0.31.0)
- `chains/definitions/hidekiTestnet.ts`: regenesis note, 10 ms blocks, no known explorer
- `trade.ts:439` (`ORDER_TYPE`), `:803` (`PlacePerpOrderParams`, no reduce-only), `:2883` (`placePerpOrder`)
- `somniaMarketsClient.ts`: `getPerpPortfolio:2381`, `listPerpOrderHistory:2563`, `listPerpPositionChanges:3087`, `listPerpPositions:3150`, `getPerpPosition:3605`, `getMarginAccount:3631`, `getLiquidationPrice:3796`, `getPerpPositionAnalytics:3861`, `getMaxPerpOrderSize:3929`, `previewPerpClosePnl:3969`, `isOperatorAuthorized:5231`
- `unified/exchange.ts:1714,1889` (factory resolution), `:5771-5831` (`fetchPositions`)
- `unified/structs.ts:581` (`UnifiedPosition`)
- `decode/orders.ts:196` (`decodePlaceOrder`)
- `docs/PERPS.md` (reducing capacity, close preview, position changes, autoPull)

**Live read-only probes (2026-10-25)**
- `eth_chainId` → `0xc4cf`
- `eth_getCode`: Hideki MarginBank, PerpPoolFactory and OperatorRegistry have code (176-byte proxies); USDso `0xed79…` has code. Shannon MarginBank `0xdd4A…` and PerpPoolFactory `0x516d…` have **0 bytes** on Hideki.
- Indexer GraphQL responds. The WebSocket endpoint answers 426 Upgrade Required (up).

**Bounty (secondhand only)**
- [kaminariouji/dreamdex-perp-runner](https://github.com/kaminariouji/dreamdex-perp-runner): "MVP track (19 October – 1 November 2026)"
- [MarwanWidjaya/dreamdex-perps-feedback](https://github.com/MarwanWidjaya/dreamdex-perps-feedback)
- [zachbuilds26/dreamdex-perps-feedback](https://github.com/zachbuilds26/dreamdex-perps-feedback)
- [successaje/dreamdex-perps](https://github.com/successaje/dreamdex-perps)
- [Risingtell/dreamdex-perps-shield](https://github.com/Risingtell/dreamdex-perps-shield)
- [dorahacks.io/build/50102](https://dorahacks.io/build/50102)

**Bounty suitability (§6 of the brief)**
- **[V]** Hideki 50383 testnet perps are the target network; PanicButton fits.
- **[I] Likely mandatory (unconfirmed):** a working testnet build, a public repo, and verifiable on-chain execution: tx hashes plus orderIds/fills.
- **[U]** The official judging criteria and evidence format must be read from the DoraHacks listing.
- **Optional:** feedback-track reports. The §2 contradictions are themselves candidate feedback items.

---

## 10. Phase 1 recommendation

### Gate: Experiment 0 (one session; needs your explicit go-ahead because it places testnet trades)

1. **Prepare the account.** In the dreamDEX app (Hideki), on a **dedicated Somnia Account wallet**, get paper USDso into the Perps account and manually open the minimum-size position in a liquid, voucher-allowlisted market.
2. **Generate a fresh bot key locally.** Never print it; record only its address. Link it via **Link a bot → Perps** and send it a little STT.
3. **Run a standalone script** (SDK 0.32.1, `SOMNIA_HIDEKI_TESTNET_ADDRESSES`, `account: OWNER`, viem wallet for the bot key) that does:
   1. `isOperatorAuthorized` → true for place and cancel on that pool.
   2. `getPerpPosition` → raw size.
   3. Simulate `placeOrderFor(owner, !long, 0, touch±200bps aligned, |size|, farFuture, 2, 0, 0x0, 0)`, then send it.
   4. Record the tx hash, `decodePlaceOrder` orderId and fills.
   5. `getPerpPosition` → 0.
   6. `listPerpPositionChanges` → a `CLOSE` row.
4. **Revoke in the app.** Confirm `isOperatorAuthorized` is false and that a fresh simulation reverts `OnlyApprovedContracts`.

**Pass criteria:** steps 3.1–3.6 succeed with the browser closed, and step 4 shows revocation working. **If it fails,** the fallback is web-only closing (the user signs in the dreamDEX app). The Telegram channel would then only notify and deep-link, without executing.

### Phase 1 plan (if it passes; sized for an approximately 1 Nov deadline)

| Day | Work |
|---|---|
| 1 | Execution core: market loader, `getPositions(owner)`, `closePosition(owner, pool)` with the §4 rules (cancel → size → simulate → IOC → verify → retry), `closeAll`, evidence record. Unit tests for sizing and alignment (decimals 6/18/24) |
| 2 | Persistent service: DB schema, encrypted per-user operator keys, link-coverage poller, per-user mutex + nonce manager, idempotent `exit_requests` state machine |
| 3 | Web: address entry → link wizard → positions → close-one / close-all confirmation → evidence page |
| 4 | Telegram: `/start <code>` binding, `/positions`, `/exit` with expiring confirm buttons; results with tx hashes |
| 5 | End-to-end testnet runs (single and multi-position, partial fill, empty book, revoked key, un-priceable market), demo recording, README with evidence table, submission. File the §2 contradictions as feedback if that track allows |

---

## Direct answers

- **Can we build PanicButton on existing dreamDEX infrastructure?**
  **Yes, with constraints.** Positions are readable through the SDK, closes are opposite-side IOC orders, and results are verifiable through receipts, decoded fills and position-change rows. Use SDK 0.32.1 with the Hideki address set, not the bot kit's network defaults. Enforce close-only behaviour in our own code, because the venue gives a regular order no reduce-only flag.

- **Can Telegram trigger a real, authorized position close when the user is away from their laptop?**
  **Yes, according to the docs and source code, though not yet proven by a test.** Link a Bot grants a server-held key `placeOrderFor` / `cancelOrderFor` on the user's perp pools. The key signs on its own, pays its own gas, cannot withdraw, and the user can revoke it instantly. The open risk is that I have not personally run the Hideki perps operator path. It also requires a Somnia Account, a link per market, and STT in the bot key.

- **What is the smallest technical experiment to pass before implementing?**
  **Experiment 0 (§10).** An app-linked bot key, run from a script with no browser, closes a minimum-size Hideki perp position via an IOC `placeOrderFor`. We capture the tx hash, orderId and fills, confirm `getPerpPosition` returns 0, and confirm that revoking the link makes the next attempt revert `OnlyApprovedContracts`.

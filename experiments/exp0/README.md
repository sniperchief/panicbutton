# Experiment 0: Hideki perps operator close proof

Goal: show that a bot key linked through dreamDEX (**Link a bot → Perps**) can close one small, manually opened perp position on **Hideki v2 (chain 50383)**. The test then checks the result from chain state and checks that revoking the link removes the key's access.

This is a test harness, not PanicButton. It covers one market, one position, one IOC order, and has no automation.

## Pinned stack

- **Packages:** `@somnia-chain/markets-sdk@0.32.1` and `viem@2.38.0`, exact versions.
- **Network config:** the chain comes from `@somnia-chain/markets-sdk/chains` (`hidekiTestnet`), and the addresses come from `SOMNIA_HIDEKI_TESTNET_ADDRESSES`. `src/config.ts` pins the RPC, WebSocket, indexer, MarginBank, OperatorPermissionsRegistry and USDso addresses, and refuses to start if the SDK disagrees with them.
- **No fallback network:** there is no `NETWORK` variable and none of the bot kit's defaults are used.

## What the order is, and where each rule comes from

| Field | Value | Source |
|---|---|---|
| Call | `placeOrderFor(owner, isBid, 0, price, quantity, expiry, 2, 0, 0x0, 0)` on the market's pool | bot kit `packages/perp-core/src/operator.ts:48`. The selector is unit-tested to equal the registry key `0x80054449` from the dreamDEX Operators docs |
| Direction | long → `isBid=false` (sell), short → `isBid=true` (buy) | SDK `PlacePerpOrderParams.isBid` (`src/trade.ts:803`) |
| Order type | `2` = ImmediateOrCancel. The unfilled remainder is cancelled and never rests | SDK `ORDER_TYPE.MARKET` (`src/trade.ts:439`) |
| Price | Raw quote units per whole base. All 21 Hideki perps have `quoteDecimals = 18`, so 18 decimals. Aligned to `tickSize`, always toward the touch, within `MAX_SLIPPAGE_BPS` of the best opposite price | SDK docs; live market rows |
| Quantity | **Exactly `abs(signed size)`** from `MarginBank.getPosition`. Must be a `lotSize` multiple and ≥ `minQuantity`; otherwise the script aborts. It never rounds | SDK `src/readsAbi.ts:302`; perps dev docs |
| Expiry | `now + 50y` in ns, the SDK's own default (`src/writer.ts` `farFutureNs`). Irrelevant for IOC | SDK |
| Self-match | `0` (CANCEL_TAKER), the SDK default | SDK |
| Gas limit | 10,000,000. Somnia bills gas used, not the limit | SDK `TraderConfig.gas`; docs |

**No reduce-only flag exists** on `placeOrderFor`. The script guards against flipping the position in these ways:
1. The quantity always equals |size| from a fresh read and never exceeds it.
2. It aborts if the owner has resting orders on the pool, because they reduce the purely reducing capacity.
3. It re-reads everything immediately before sending and aborts on any change.
4. It reads the position at the receipt block and at head, and classifies the result as CLOSED, PARTIAL, FLIPPED, UNCHANGED or INCREASED.

## Commands

From `experiments/exp0` (Git Bash). Addresses are public. Never put the private key in a file.

```bash
npm ci                     # pinned versions from package-lock.json
npm test                   # 15 unit tests on sizing, pricing, selector, fingerprint, outcome
npm run typecheck

# 1. read-only: RPC, chain id, SDK websocket + indexer, market wiring
PERP_SYMBOL=ETH npx tsx src/exp0.ts preflight

# 2. read-only: plan + eth_call simulation, writes runs/plan-<ts>.json
OWNER_ADDRESS=0x<dreamDEX test account> \
OPERATOR_ADDRESS=0x<bot key address> \
PERP_SYMBOL=ETH MAX_SLIPPAGE_BPS=50 \
npx tsx src/exp0.ts dry-run

# 3. ONLY after explicit approval: sends ONE transaction
#    read -s keeps the key out of shell history and off the screen
read -rs OPERATOR_PRIVATE_KEY && export OPERATOR_PRIVATE_KEY
OWNER_ADDRESS=0x... OPERATOR_ADDRESS=0x... PERP_SYMBOL=ETH \
npx tsx src/exp0.ts execute --plan runs/plan-<ts>.json --confirm <fingerprint>
unset OPERATOR_PRIVATE_KEY

# 4. after revoking in the dreamDEX app: read-only check (--simulate adds one eth_call, nothing is sent)
OWNER_ADDRESS=0x... OPERATOR_ADDRESS=0x... PERP_SYMBOL=ETH \
npx tsx src/exp0.ts verify-revoked --simulate
```

`execute` refuses to send unless all of these hold:
- The plan is `READY`, less than 15 minutes old, and unmodified (its fingerprint is recomputed).
- `--confirm` equals the fingerprint.
- The key derives to `OPERATOR_ADDRESS`.
- A fresh read shows the same pool, the same signed size, no resting orders, the operator still authorized, a live mark, and the approved price cap still crossing the book with enough depth.
- A fresh simulation succeeds.

`execute` never retries. Evidence is written to `runs/evidence-<ts>.json`.

## Abort conditions (dry-run reports them as BLOCKERS)

- **Network and wiring:** wrong chain ID; the SDK disagrees with the pins; pool `marginBank()` or registry differs; quote token isn't USDso; `quoteDecimals` ≠ 18.
- **Position:** flat, or changed between the pinned block and head; |size| isn't a lot multiple or is below the minimum.
- **Account state:** the owner has resting orders on the pool.
- **Market data:** the mark feed isn't live (the pool's own `tryGetMarkPrice` verdict); no opposite liquidity; touch further from the mark than the slippage limit; book depth within the cap is smaller than the close quantity.
- **Operator:** not authorized for `placeOrderFor`; STT balance below the gas budget (≈0.06 STT at current gas price).
- **Simulation:** reverts or returns `success=false`.

## Manual setup you do (in the dreamDEX app, Hideki)

1. Use a **dedicated Somnia Account wallet** (Legacy accounts cannot link bots).
2. Put a small amount of USDso in its **Perps account** (Perps ⇆ Spot).
3. Open the **minimum-size position** in the chosen market (ETH: 0.004 ETH ≈ $9). Place **no resting orders and no TP/SL** on that market.
4. Generate a fresh bot key on your machine. Give me only its **address**.
5. **Link a bot →** paste the bot key's address **→** tick Perps **→** Add bot.
6. Send the bot address **≥ 0.1 STT** for gas.

## Known limitations

- **The simulation proves only the return value.** The RPC has no `eth_simulateV1`, so `eth_call` shows `(success, orderId)` but not the post-trade position. The position effect is verified only after the real transaction.
- **A small race remains.** A liquidation or manual trade landing between the final read and inclusion could change the size. The post-trade classification catches this, and nothing is retried.
- **Indexer data is a cross-check only.** The indexer is development-grade and may lag. Go/no-go decisions use chain reads only; position-change rows are a secondary check.
- **No public Hideki explorer** is listed in the SDK, so the evidence is the tx hash, the receipt and chain reads.

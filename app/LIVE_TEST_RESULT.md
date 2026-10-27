# Live testnet result: first PanicButton close

**Result: PASS.** A bot key linked through dreamDEX's standard **Link a bot** flow closed a real perp position from the PanicButton server, with no browser signature. The outcome was verified from chain state.

- **Network:** Somnia Hideki testnet v2, chain ID 50383, RPC `https://api.hideki2.infra.testnet.somnia.network`
- **Funds:** paper USDso from Perps Arena (testnet only)
- **Test account (dreamDEX Somnia wallet):** `0x88088ed6FdD078871CCD9c633E8f5749fc2B6C4d`
- **PanicButton bot (operator):** `0x5eCDD91c08074BFfBeCe3C094394A3EE82d0e4d8`
- **Market:** BTC-PERP, pool `0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0`

## All transactions in the test

Times are UTC. Transactions 1 to 5 were made by the account owner in the dreamDEX app. The app's relayer (`0xedd5…7707`) submits them to the Somnia smart wallet; transaction 1 was sent by the Perps Arena distributor. Transaction 6 is the only one PanicButton sent; it is the bot's first and only transaction (nonce 0).

| # | Time | Block | Transaction hash | What it was |
|---|---|---|---|---|
| 1 | 2026-10-26 14:24:49 | — | `0x18622f6ace01ec739fb55049726ed18e25a6d0f8e49c5c6185d9996b6833230c` | Perps Arena credit: **1,000 USDso** credited to the Perps account (MarginBank `Credited`, granter `0x2acd…42c4`, the VoucherDistributor) |
| 2 | 2026-10-27 02:37:38 | 34,164,799 | `0x9a0d292875580fe41bb9c6e50fd3d44c426a94ea0f7d96e6d30d1afde572a2b1` | Owner opened **BTC-PERP LONG 0.00217** (raw `217000`) at 79,947.7; ≈9.99 USDso margin locked |
| 3 | 2026-10-27 02:49:08 | 34,171,689 | `0x9e1bd78d9c9d4209c88c5a14ba5d34295e170e3b2b2f1839306d6e10d0d5f2eb` | **Link a bot**, part 1: OperatorPermissionsRegistry grants to the bot (54 registry logs) |
| 4 | 2026-10-27 02:49:13 | 34,171,748 | `0xdb82803c87b71577d5b49f6cab755b16985295f3f4a90f299f4f906699b6dd4d` | **Link a bot**, part 2: remaining grants (9 registry logs); PanicButton then showed 21/21 markets linked |
| 5 | 2026-10-27 02:49:22 | 34,171,835 | `0xc24ab0abf7e02f1ac842717171f6a99cb6cdbd0e596b2d889d47e06a93d38c04` | Owner sent the bot **5 STT** for gas |
| 6 | 2026-10-27 02:58:23 | 34,177,243 | `0x2ea0efec65b60bc73bb9a50d60b343eaedea064816a19097f5fb1192dfa8527f` | **PanicButton close**: the bot sent `placeOrderFor`, SELL 0.00217 IOC; position closed |
| 7 | after 02:58:23 | — | *(not recorded)* | Owner removed the bot in dreamDEX (revocation). PanicButton then showed the bot as unlinked. By request, this transaction was not looked up or checked on-chain |

## Evidence for the close (transaction 6), independently verified on chain

| Evidence | Value |
|---|---|
| Sender / target | bot `0x5ecd…e4d8` → BTC-PERP pool `0x4181…94c0`, chain 50383 |
| Call (decoded input) | `placeOrderFor(owner=0x8808…6C4d, isBid=false, price=79438.4, quantity=217000, orderType=2 /* IOC */)` |
| Receipt | `success`, block 34,177,243, gas used 1,575,162 |
| Decoded fills (`decodePlaceOrder`) | 1 fill: **217000 / 217000** at **79,860.4**; order ID `16343815249306670757627` |
| Raw position (`MarginBank.getPosition`) | block 34,177,242: `217000` → block 34,177,243: **`0`** → head: **`0`** |
| Indexer (`listPerpPositionChanges`) | owner row: `CLOSE`, sizeBefore `217000`, sizeAfter `0`, exit 79,860.4, realized PnL −0.189441 USDso |
| PanicButton job record | state `CLOSED`, message "closed; verified on chain and by the indexer", indexer `agree` |
| Open positions after | none |

Before the close:
- The independent `experiments/exp0` harness produced the same plan: SELL `217000`, IOC, 50 bps cap.
- An `eth_call` simulation returned `success=true`.
- The bot held place, cancel and reduce permissions on BTC-PERP.

## How to re-check

The SDK lists no public block explorer for Hideki, so verify against the RPC:

```bash
RPC=https://api.hideki2.infra.testnet.somnia.network
cast receipt 0x2ea0efec65b60bc73bb9a50d60b343eaedea064816a19097f5fb1192dfa8527f --rpc-url $RPC
cast tx      0x2ea0efec65b60bc73bb9a50d60b343eaedea064816a19097f5fb1192dfa8527f --rpc-url $RPC
# raw position before and after the close block
cast call 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 "getPosition(address,address)((int128,uint128,int256,uint64))" \
  0x88088ed6FdD078871CCD9c633E8f5749fc2B6C4d 0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0 --block 34177242 --rpc-url $RPC
cast call 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 "getPosition(address,address)((int128,uint128,int256,uint64))" \
  0x88088ed6FdD078871CCD9c633E8f5749fc2B6C4d 0x4181dd08E73BbCdd1Ba3E615A18f6abD941b94C0 --block 34177243 --rpc-url $RPC
```

The explorer at `explorer.testnet.somnia.network/tokyo`, named in the dreamDEX docs, may also show these; it was not checked.

---

# Live testnet result: closes confirmed from the Telegram bot (Phase 3)

**Result: PASS.** Two positions were closed from Telegram (`/close` → pick a position → read the quote → **Confirm**), by the same bot operator and the same shared engine as the web app. Both outcomes were verified on chain by the engine and then independently re-read.

- **Account:** `0x88088ed6FdD078871CCD9c633E8f5749fc2B6C4d`, **bot operator:** `0x5eCDD91c08074BFfBeCe3C094394A3EE82d0e4d8` (linked again in dreamDEX before this test)
- **Telegram:** linked with a one-time code from the web app. The link is bound to the numeric Telegram user ID (not recorded here)
- **Execution switch:** turned on by the account owner at 12:05:44 UTC, before the approval step in the agreed procedure. It was set back to `false` after the test (the running server needs a restart to pick it up)

## Before execution was enabled (EXECUTION_ENABLED=false)

- `/close` on BTC-PERP long 0.00434 prepared a READY quote: SELL 0.00434 IOC, cap 79,480.4 (50 bps), simulation ok
- Confirm was refused with "Not executed: execution is disabled … Nothing was sent". No job was created
- Other confirmations in this window: one cancelled and two refused before execution was enabled. None created a job

## The two closes (two separate `/close` commands, not `/closeall`)

Times are UTC, 2026-10-27.

| | ETH-PERP | BTC-PERP |
|---|---|---|
| Position before | long 0.2306 (raw `230600000000000000`) | long 0.00434 (raw `434000`) |
| Quote (block) | SELL 0.2306 IOC, cap 2,299.04, best 2,310.59, mark 2,309.96, sim ok (34,506,088) | SELL 0.00434 IOC, cap 79,508.9, best 79,908.4, mark 79,725.70, sim ok (34,506,351) |
| Quote → Confirm | 12:06:40.9 → 12:06:47.4 | 12:07:07.4 → 12:07:12.9 |
| Transaction | `0x12b80a6ac008d39a5ec2abc4cacadb599284bfc920036027b00cc54a1a2b0feb` | `0x76a270787ba7f7dc3d0931f5e93e07eed643ee7e7dd486f505fc34dca7922fbd` |
| Sender / target | bot (nonce 1) → ETH-PERP pool `0xd6cb…aeddf` | bot (nonce 2) → BTC-PERP pool `0x4181…94c0` |
| Receipt | `success`, block 34,506,219 (12:06:52), gas 1,617,922 | `success`, block 34,506,466 (12:07:17), gas 1,643,703 |
| Decoded fills | 0.2306 / 0.2306 at 2,310.43 | 0.00434 / 0.00434 at 79,906.6 |
| Position (block before → receipt block → head) | `230600000000000000` → **`0`** → **`0`** | `434000` → **`0`** → **`0`** |
| Engine job | `CLOSED`, "closed; verified on chain and by the indexer", indexer `agree` | same |

After both closes, a read of all 21 markets showed **no open positions** for the account.

## What this verifies

- Telegram linking, `/positions`, `/close`, the quote display, Confirm and the execution-disabled refusal, against the real chain
- A close confirmed from Telegram goes through the shared engine and is reported only after on-chain verification
- The bot's nonces 1 and 2 follow Phase 2's nonce 0: no other transaction was sent by the bot

## Still not verified live

- `/closeall` with real sequential transactions across two markets
- A real partial fill, an unknown outcome, or a restart during a Telegram job (mock-tested only)
- The bot's exact final Telegram report text was not captured in this record. Outcomes come from the engine's job records and the chain reads above

---

# Live testnet result: liquidation alert and Telegram close (Phase 6)

**Result: PASS** (alert reported by the tester; close verified). On 2026-10-27, after Telegram liquidation alerts were added, the tester re-linked a new bot operator, raised the alert threshold to 50% (`/alerts 50`) so an ordinary position would trigger it, and reported receiving the alert in Telegram with its **Prepare close** and **Mute 1h** buttons. A close was then prepared and confirmed from Telegram.

- **Network:** Somnia Hideki testnet v2, chain ID 50383
- **Account:** `0x88088ed6FdD078871CCD9c633E8f5749fc2B6C4d` (same as above)
- **New bot operator:** `0xa437fa83016b62B72c3001b8F6fA2e513d30Fe3e`, linked 21/21 markets, funded with 5 STT. The earlier operator `0x5eCD…e4d8` was removed in dreamDEX first (0/21 linked afterwards)

## The close

| Evidence | Value |
|---|---|
| Transaction | `0x95423a5caa4562a6f25deeba9e81589d7554958b9b705edd7a1c55e3ab6e5663` |
| Confirmed from | Telegram (`close` confirmation, 2026-10-27 14:03:05 UTC) |
| Receipt (independent `eth_getTransactionReceipt`) | `success`, block 34,576,190, from the new operator, gas used 4,043,147 |
| Market | ETH-PERP |
| Filled | `3913600000000000000` / `3913600000000000000` raw (3.9136 ETH) |
| Position | before `3913600000000000000` → at the receipt block **`0`** → at head **`0`** |
| Engine job | `CLOSED`, "closed; verified on chain and by the indexer", indexer `agree` |

## What this verifies

- The alert loop runs against the real chain: the tester reported the alert and its buttons in Telegram
- A Telegram close by a newly linked operator is verified on chain and by the indexer, as in Phase 3

## Not verified by this record

- The alert message itself was not captured here, and the server's database does not keep alert history. Its receipt is the tester's report; the server log line `tg liquidation alert sent` is the only machine trace
- Whether the close was started from the alert's **Prepare close** button or from `/close`: both use the same callback, so the records cannot tell them apart
- An alert triggered by a real adverse move at the default 5% threshold, and the "getting closer" escalation, live

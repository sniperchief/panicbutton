# First live close: checklist

Goal: one minimum-size position closed by PanicButton on Hideki (chain 50383), verified independently. Every step marked **[approval]** needs explicit sign-off before it is done.

## A. Prepare (no on-chain changes by PanicButton)

1. **Account.** In dreamDEX on Hideki, use a **dedicated Somnia Account wallet**; a Legacy account cannot link bots. Put ~20 USDso into its **Perps account** (Perps ⇆ Spot).
2. **Position.** Open the **minimum-size position** in one liquid market. Suggested: **ETH-PERP, 0.004 ETH long** (minimum 0.004, ≈ $9). Place **no resting orders and no TP/SL** on that market.
3. **Start the server.** In `app/`: `npm run build && npm start` with `EXECUTION_ENABLED=false`. Allow ~20 s for the market preload.
4. **Connect.** Open `http://127.0.0.1:8787` and connect the account address. Copy the **Bot operator** address.
5. **Link.** In dreamDEX: wallet → **Link a bot** → paste the operator address → **Perps** ticked → **Add bot**, and send it **0.1 STT**. *(This changes the account's permissions: it is your action in dreamDEX.)*
6. **Check the account panel:**
   - **Authorization: 21/21 markets linked** (at least ETH-PERP).
   - **Gas ≥ 0.06 STT.**
   - ETH-PERP row shows **LONG 0.004** and no "bot not linked".
7. **Read-only quote.** Press **Close** on ETH-PERP and record the dialog:
   - Action **SELL 0.004** (= |position|)
   - Best price, mark, worst accepted price (50 bps), **Simulation ok**
   - Status **ready**, and the confirm button reading "simulation-only mode"

   Cancel.
8. **Record "before" independently:**
   ```bash
   cast call 0x478769E1177C0773c43A593DCCc4Ad15F15F1394 \
     "getPosition(address,address)((int128,uint128,int256,uint64))" <OWNER> 0xd6cb1dd58580b84d76068ac21594219ce03aeddf \
     --rpc-url https://api.hideki2.infra.testnet.somnia.network
   ```
   Or the harness: `cd experiments/exp0 && OWNER_ADDRESS=<OWNER> OPERATOR_ADDRESS=<OPERATOR> PERP_SYMBOL=ETH npx tsx src/exp0.ts dry-run`

   **Expected:** size `4000000000000000`.

## B. Execute **[approval]**

9. Stop the server. Set `EXECUTION_ENABLED=true` in `.env` and start it again. The header chip should read **live execution**.
10. Press **Close** on ETH-PERP, check that the quote matches step 7 (same size, a fresh price), and press **Confirm 1 close** within 60 s.
11. Watch the execution panel: Re-check → Simulate → Submit → Receipt → Verify. **Do not** press anything else while it runs.
12. Immediately afterwards, set `EXECUTION_ENABLED=false` again and restart.

## C. Evidence to capture (all required for PASS)

| Evidence | Where | PASS condition |
|---|---|---|
| Transaction hash | Execution panel → Transaction (Copy) | Present |
| Receipt status and block | Panel → Receipt | `success`, block number shown |
| Decoded fills | Panel → Filled | `0.004 / 0.004` (raw `4000000000000000`) |
| Raw size before | Panel → Size before; step 8 | `4000000000000000` |
| Raw size after, receipt block | Panel → Size after (on chain) | `0` |
| Raw size after, head | `GET /api/jobs/<id>` → `sizeAtHead`; re-run the step 8 command | `0` |
| Indexer result | Panel → Indexer check | `agree`, or `pending`/`unavailable` (record which) |
| Final state | Panel badge | **Closed · verified** |
| Job record | `curl -b <cookie> http://127.0.0.1:8787/api/jobs/<id>` | Saved as JSON |
| Positions table | Refreshes | ETH-PERP gone |

**FAIL or stop conditions.** Record the evidence and do not retry if the state is any of the following:
- `PARTIAL`: record the remainder.
- `FAILED`, `ABORTED`: record the message.
- `FLIPPED`, `UNKNOWN`, `AMBIGUOUS`.

Investigate before any further transaction.

## D. Revocation check **[approval]**

13. In dreamDEX → Bots tab → red X on the operator → **Remove access**.
14. In PanicButton press **Check again**. Expected: **0/21 markets linked**, and Close buttons show "bot not linked".
15. Optionally run `cd experiments/exp0 && … npx tsx src/exp0.ts verify-revoked --simulate`. Expected: `place=false cancel=false reduce=false`, and the eth_call reverts `OnlyApprovedContracts`. Nothing is sent.

## Known blockers and risks for the first test

- **Thin book or wide spread.** If the best price is further from the mark than the slippage setting, or depth within the cap is short, the quote blocks. Pick a liquid market, or raise slippage (max 300 bps).
- **Dust.** A position below the market minimum (live example: 0.1 AVAX vs a 1.4 minimum) cannot be closed by any single order.
- **RPC latency.** Each round trip is ≈0.7 s. A one-market prepare takes ≈2.5 s, and a 21-market Close All ≈12–20 s. Transient RPC failures are retried; persistent ones block with "could not read chain state".
- **Leftover orders.** Any resting order or pending stop on the market blocks the close or remains locked. Clear them in dreamDEX first.

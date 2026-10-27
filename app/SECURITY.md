# PanicButton security model

## What linking grants, and what it means

dreamDEX's **Link a bot** writes three grants per perp market to the OperatorPermissionsRegistry for the bot address: `placeOrderFor`, `cancelOrderFor` and `reduceOrderFor`.

- **It can** place *any* order for the account: open, increase, flip or close, up to the account's margin. **There is no close-only permission.** It can also cancel and shrink the account's resting orders.
- **It cannot** withdraw, transfer, change leverage, or arm TP/SL stops. Fills always settle to the account.
- **What protects you is our code.** PanicButton's code only builds reducing IOC orders of exactly the freshly read |position|. The protocol does **not** enforce that. Anyone holding the bot key could trade the account into losses, for example by selling into their own resting orders at a bad price.
- **Revocation** is the Bots tab → red X → Remove access. It is immediate and covers every market. Orders the bot already placed stay on the book; PanicButton places only IOC orders, which never rest. **Disconnecting in PanicButton deletes our copy of the key but does not revoke the grant;** only dreamDEX can do that.
- **Coverage is per market.** Markets listed after linking need the bot added again; the account panel lists uncovered markets.
- **Recommendation:** link PanicButton only to a dedicated trading wallet, as dreamDEX itself advises.

## Request-to-signature path (reviewed)

```
browser ─(cookie + x-panicbutton header)─▶ api.ts
  Host allowlist (DNS rebinding) → CSRF header + JSON content type → session from SHA-256(cookie)
  zod validation: owner address, ≤50 pools, slippage int ≤ server max, uuid quote ids + idempotency key
POST /api/close/prepare → Engine.prepare(session)
  chain id pinned, unresolved-transaction guard, fresh reads pinned to one block,
  exact |size|, cap, depth, eth_call simulation → quote bound to session + owner + operator, 60 s TTL
POST /api/close/execute → Engine.execute (synchronous checks)
  idempotency key → same job; quote must belong to the session, match owner/operator,
  be READY, unexpired and unused; consumed atomically (UPDATE … WHERE used = 0)
  job queued per session (one operator key = one transaction at a time)
runItem: unresolved-transaction guard → re-read position/permission/mark/book/gas/resting orders
  (abort on any difference) → simulate → keystore.account(encryptedKey, operator)
  (AES-GCM decrypt, address must equal the session operator) → sign locally (hash known) → broadcast
  → receipt → verify position at the receipt block and head + fills + indexer
```

## Findings and fixes (Phase 2 review)

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | **Double close after an unknown outcome.** After a receipt timeout, a second close could be prepared and confirmed while the first transaction might still mine. Two closes could reverse the position | High | **Fixed.** Prepare and execute refuse while any earlier transaction for the session lacks a receipt, or the operator has a pending nonce. A receipt found later resolves the block (`lateReceipt`) |
| 2 | **"Not submitted" could be wrong.** A send error was classified as "not submitted" whenever the position looked unchanged, but an RPC error can occur *after* broadcast | High | **Fixed.** The transaction is signed locally first, so its hash is known. Any error after signing is `UNKNOWN` and keeps the hash (finding 1's guard applies); only errors before signing are `FAILED` |
| 3 | **A restart left jobs `RUNNING` forever.** UI polling never ended, and in-flight state was lost | Medium | **Fixed.** At startup, interrupted items become `SKIPPED` (never sent) or `UNKNOWN` (possibly signed), and the job becomes `HALTED` |
| 4 | **No DNS-rebinding guard** on the localhost server | Low | **Fixed.** Host allowlist (`localhost`, `127.0.0.1`, `[::1]`, plus `ALLOWED_HOSTS`); others get 421 |
| 5 | **Raw SDK/RPC errors shown to users,** and transient RPC timeouts blocked every quote | Low | **Fixed.** Idempotent reads retry with backoff; simulation retries only on transport errors, never on reverts; messages are plain |
| 6 | **Stacked polling.** UI polling could overlap slow refreshes and load the RPC | Low | **Fixed.** In-flight guard; polling pauses while a confirmation is open |

**Verified with no change needed:**
- **Sessions are isolated:** quotes and jobs are scoped to the session, and another session gets 404.
- **Quotes expire and are consumed once.** Idempotency returns the same job, and concurrent duplicate confirms (same key, or different keys for one quote) submit exactly one close (API test).
- **CSRF** header and SameSite=Strict cookie.
- **Permission is re-checked** for the quote's owner + operator + pool immediately before every send.
- **Partial fills are not retried.** A new prepare uses the fresh, smaller size, so it cannot flip the position. A remainder below the market minimum is blocked with an explanation.

**Key exposure.**
- The generated key is never in an API response, cookie, log line or error message. An automated test decrypts the key and asserts that neither it nor its ciphertext appears in any response.
- QA server logs were scanned for 64-hex strings; none were found.
- Logs contain method, path, status and duration only.

## How the MVP holds keys (local development)

- **One key per session,** generated server-side and encrypted at rest with AES-256-GCM under `KEYSTORE_KEY` (an environment secret) in SQLite (`.data/`). It is decrypted in memory only at signing time.
- **Session tokens** are 32 random bytes in an `HttpOnly; SameSite=Strict` cookie, stored as SHA-256 hashes.
- **Account binding.** A session can act only where the owner granted *that session's* operator on-chain. Typing someone else's address yields an unlinked operator, and every close is blocked.
- **Execution switch.** `EXECUTION_ENABLED` must be exactly `true` for anything to be sent.

## Telegram interface

- **Proof of ownership is the web session, not Telegram.** Only a session holding the httpOnly cookie can issue a link code (10 characters, about 50 bits, SHA-256 at rest, 10 min TTL, single use, consumed atomically). A wallet address or Telegram username is never accepted as proof. Links are keyed by Telegram's numeric user ID.
- **Brute force:** more than 5 link attempts per Telegram user in 15 minutes are refused.
- **Private chats only,** for both messages and button presses. Every callback is checked against the pressing user, the chat, the user's current linked session, the action's state and its expiry.
- **Possession of a code = control.** Anyone who sends a valid code can close that account's positions from Telegram, and nothing else; they cannot withdraw or open positions. The web UI says so next to the code.
- **Durable state:** links, codes, attempt counters, processed update IDs, the poll offset and pending confirmations are all in SQLite. Nothing security-critical lives only in memory.
- **Unlinking does not revoke on-chain permission.** Every message about unlinking says so.
- **Liquidation alerts only inform.** They never place an order; their Prepare close button runs the normal quote and confirm flow. Alert messages contain the market, side, size, mark, liquidation price and PnL, which Telegram can see. Logs record only that an alert was sent.
- **Secrets:** `TELEGRAM_BOT_TOKEN` is read from the environment only and scrubbed from transport errors. Telegram messages never include keys, ciphertexts, codes or cookies; an automated test checks this.
- **Telegram itself** sees every message, including positions and shortened addresses. Do not use the bot if that is unacceptable.

## Required before any production or shared deployment

1. **Keys in a KMS or HSM.** Use a signing service (AWS KMS secp256k1, GCP KMS, Vault Transit, or an HSM) so plaintext keys never exist in application memory.
2. **Per-user keys only.** Never share one operator across users.
3. **Master secret in a secret manager,** never in a file on the host; plan rotation.
4. **HTTPS only,** with `COOKIE_SECURE=true`, HSTS, and `ALLOWED_HOSTS` set.
5. **Rate limits** on session creation, prepare and execute. Session creation is unthrottled today.
6. **Audit log** of prepare and execute (session, owner, fingerprint, tx hash), never keys or tokens.
7. **Lifecycle.** Expire sessions and delete their keys; prompt users to revoke in dreamDEX.
8. **Monitoring.** Alert on `UNKNOWN`, `FLIPPED`, `AMBIGUOUS` and low operator STT.
9. **One process,** or a distributed lock per operator. The per-session queue and the unresolved-transaction guard rely on one process seeing all jobs.

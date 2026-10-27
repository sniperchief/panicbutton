// A plain-language summary of SECURITY.md and the README's limitations. Keep it in
// step with those files; they remain the source of truth.

import { Link } from "./router";
import { SiteFooter, SiteNav } from "./site";

const GRANTS = {
  can: [
    "Place any order for the account (open, increase, flip or close) up to its margin",
    "Cancel and shrink the account's resting orders",
  ],
  cannot: ["Withdraw or transfer funds", "Change leverage", "Arm TP/SL stops"],
};

export function Security() {
  return (
    <div className="site">
      <SiteNav />
      <main id="main" className="doc">
        <header className="doc-head">
          <span className="eyebrow">Security model</span>
          <h1 className="display-2">What PanicButton can do, and what protects you.</h1>
          <p className="lede">
            PanicButton never sees your wallet key. It signs with a dedicated bot key that you authorize in dreamDEX. Here is exactly what
            that key is allowed to do, how a close is guarded, and what is not yet verified.
          </p>
        </header>

        <section className="doc-sec" aria-labelledby="grants-h">
          <h2 id="grants-h">What linking grants</h2>
          <p>
            dreamDEX&apos;s <em>Link a bot</em> grants the bot address order permissions per perp market. There is no close-only permission
            on the venue.
          </p>
          <div className="grant-grid">
            <div className="grant can">
              <h3>The bot key can</h3>
              <ul>
                {GRANTS.can.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
            <div className="grant cannot">
              <h3>The bot key cannot</h3>
              <ul>
                {GRANTS.cannot.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="callout-line">
            <strong>What protects you is PanicButton&apos;s code, not the protocol.</strong> The code only builds immediate-or-cancel orders
            for exactly the freshly read position size. Anyone holding the bot key could trade the account into losses, so link it only to a
            dedicated trading wallet.
          </p>
          <p>
            <strong>Revoking</strong> is immediate: dreamDEX, Bots tab, then the red X (Remove access). Disconnecting in PanicButton deletes
            our copy of the key but does not revoke the grant. Permissions are per market, so markets listed after you link need the bot added
            again.
          </p>
        </section>

        <section className="doc-sec" aria-labelledby="guard-h">
          <h2 id="guard-h">How a close is guarded</h2>
          <ol className="guard-list">
            <li>
              <strong>Prepare</strong> reads position, order book, resting orders, mark price, permission and gas at one block, sizes the
              order to exactly the position, and simulates it. The quote is bound to your session and expires in 60 seconds.
            </li>
            <li>
              <strong>Confirm</strong> accepts only your own unexpired, unused, ready quotes, under an idempotency key. Duplicate clicks
              submit once.
            </li>
            <li>
              <strong>Execute</strong> re-reads everything and aborts if anything changed, simulates again, then signs and sends. One
              transaction at a time per bot key.
            </li>
            <li>
              <strong>Verify</strong> checks the receipt, the position at the receipt block and at head, the decoded fills and the indexer.
              Only full agreement is reported as closed.
            </li>
            <li>
              <strong>Unresolved outcomes block new closes.</strong> If a transaction has no receipt, nothing else is sent for that session
              until it resolves, so a close cannot be doubled.
            </li>
          </ol>
        </section>

        <section className="doc-sec" aria-labelledby="keys-h">
          <h2 id="keys-h">Keys and sessions</h2>
          <ul className="plain-list">
            <li>One bot key per session, generated on the server and encrypted at rest with AES-256-GCM. It is never returned by the API.</li>
            <li>Sessions use an HttpOnly, SameSite=Strict cookie stored as a hash. Requests need a CSRF header and an allowed Host.</li>
            <li>Typing someone else&apos;s address gives you an operator they never authorized, so every close is blocked.</li>
            <li>
              The server sends nothing unless <span className="mono">EXECUTION_ENABLED=true</span>.
            </li>
          </ul>
        </section>

        <section id="telegram" className="doc-sec" aria-labelledby="tg-h">
          <h2 id="tg-h">Telegram linking</h2>
          <ul className="plain-list">
            <li>Only your logged-in web session can issue a link code. It works once, expires in 10 minutes and is stored as a hash.</li>
            <li>
              <strong>Whoever sends the code controls closes from Telegram</strong> for that account. They cannot withdraw or open
              positions. Never share it.
            </li>
            <li>Private chats only. Every button press is checked against the user, the chat, the linked session and the expiry.</li>
            <li>
              <strong>Liquidation alerts only inform.</strong> An alert never sends an order; its Prepare close button starts the same
              quote-and-confirm flow as /close. Turn alerts off with /alerts off.
            </li>
            <li>Unlinking Telegram does not revoke the bot&apos;s permission in dreamDEX.</li>
            <li>Telegram itself sees your messages, including positions and shortened addresses.</li>
          </ul>
        </section>

        <section id="limits" className="doc-sec" aria-labelledby="limits-h">
          <h2 id="limits-h">Known limitations</h2>
          <ul className="plain-list">
            <li>
              <strong>Testnet only.</strong> Hideki (chain 50383). Single-position closes from the web and Telegram were verified live. Close
              All with real transactions, real partial fills and unknown-outcome recovery are tested only against mocks.
            </li>
            <li>
              <strong>Partial fills</strong> are reported, not retried. A remainder below the market minimum cannot be closed by any single
              order.
            </li>
            <li>
              <strong>Resting orders block a close.</strong> Cancel them in dreamDEX first. TP/SL stops cannot be cancelled by the bot.
            </li>
            <li>
              <strong>A small race remains:</strong> a liquidation or manual trade between the final check and inclusion is detected afterwards
              (reversed or needs review), never retried.
            </li>
            <li>
              <strong>Simulation cannot show the final position;</strong> only the receipt and later reads can.
            </li>
            <li>
              <strong>Local development grade.</strong> Production use needs keys in a KMS/HSM, HTTPS, rate limits, audit logs and
              monitoring.
            </li>
          </ul>
        </section>

        <div className="doc-cta">
          <Link href="/app" className="btn btn-primary btn-lg">
            Open PanicButton <span className="arrow" aria-hidden>→</span>
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function NotFound() {
  return (
    <div className="site">
      <SiteNav />
      <main id="main" className="doc doc-404">
        <span className="eyebrow">404</span>
        <h1 className="display-2">No exit here.</h1>
        <p className="lede">This page does not exist.</p>
        <div className="cta-row">
          <Link href="/" className="btn btn-outline btn-lg">
            Home
          </Link>
          <Link href="/app" className="btn btn-primary btn-lg">
            Open PanicButton
          </Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}

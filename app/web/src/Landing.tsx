import { EngineVisual, LedgerVisual, PressureVisual, TerminalVisual } from "./illustrations";
import { Link } from "./router";
import { SiteFooter, SiteNav } from "./site";

const STEPS = [
  { n: "01", title: "Review positions", body: "Size, entry, mark, unrealized PnL and liquidation price, read from chain for the account you protect." },
  { n: "02", title: "Prepare a close", body: "Fresh reads pinned to one block, an immediate-or-cancel order for exactly the position size, simulated. Nothing is signed." },
  { n: "03", title: "Confirm explicitly", body: "You see the side, quantity, worst accepted price and a 60-second expiry. Only your confirmation sends." },
  { n: "04", title: "Verify the result", body: "The engine waits for the receipt and checks the position at that block and at head before calling it closed." },
];

const LIMITS = [
  {
    title: "Partial fills",
    body: "If the order book is thin, part of the position can remain. It is reported as partial and never retried automatically. You prepare the remainder yourself.",
  },
  {
    title: "Network failures",
    body: "If no receipt arrives, the outcome is marked unknown and new closes are refused until it resolves, so a close is never sent twice.",
  },
  {
    title: "Operator permissions",
    body: "The bot key can trade the account in any direction, not just close. Our code only builds closes; the protocol does not enforce that. It cannot withdraw. Revoke it in dreamDEX at any time.",
  },
];

export function Landing() {
  return (
    <div className="site">
      <SiteNav />
      <main id="main">
        {/* ── Hero 1 · The hook ─────────────────────────────── */}
        <section id="hook" className="hero hero-hook" aria-labelledby="hook-h">
          <div className="hero-inner hook-grid">
            <div className="hook-copy">
              <span className="eyebrow">Emergency exit terminal · dreamDEX Perps</span>
              <h1 id="hook-h" className="display">
                When the market turns, <em>get out.</em>
              </h1>
              <p className="lede">
                PanicButton helps you prepare and execute emergency exits from your dreamDEX perpetual positions, from a web terminal or
                Telegram, and then verifies on chain that each position actually closed.
              </p>
              <div className="cta-row">
                <Link href="/app" className="btn btn-primary btn-lg">
                  Open PanicButton <span className="arrow" aria-hidden>→</span>
                </Link>
                <a href="#how" className="btn btn-outline btn-lg">
                  How it works
                </a>
              </div>
              <p className="hook-note mono">
                <span className="dot" aria-hidden /> Hideki testnet · no wallet key required
              </p>
            </div>
            <TerminalVisual />
          </div>
          <div className="exit-rule" aria-hidden />
        </section>

        {/* ── Hero 2 · The problem ──────────────────────────── */}
        <section id="problem" className="hero hero-problem" aria-labelledby="problem-h">
          <div className="hero-inner">
            <div className="problem-head">
              <span className="eyebrow">02 · The problem</span>
              <h2 id="problem-h" className="display-2">
                Every second of uncertainty matters.
              </h2>
              <div className="problem-copy">
                <p>
                  A fast move rarely waits until you are at your desk. Closing a perp position under pressure means finding the venue, the
                  wallet, the right market, the right side and the exact size, then signing and hoping the order filled.
                </p>
                <p className="muted">
                  Get the size wrong and you can flip the position instead of closing it. Lose the connection after signing and you do not
                  know whether you are still exposed. PanicButton turns that into a short, rehearsed path that ends in a verified answer.
                </p>
              </div>
            </div>
            <PressureVisual />
          </div>
        </section>

        {/* ── Hero 3 · How it works ─────────────────────────── */}
        <section id="how" className="hero hero-how" aria-labelledby="how-h">
          <div className="hero-inner">
            <div className="how-head">
              <span className="eyebrow">03 · How it works</span>
              <h2 id="how-h" className="display-2">
                One exit engine. <br />
                Two ways to act.
              </h2>
              <p className="lede">
                The web terminal and the Telegram bot are two interfaces to the same server-side engine. Neither has its own order logic,
                so every close follows the same four steps. The bot also watches your positions and messages you when one comes close to
                liquidation, with the close one tap away.
              </p>
            </div>
            <ol className="steps-rail">
              {STEPS.map((s) => (
                <li key={s.n}>
                  <span className="step-n mono">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </li>
              ))}
            </ol>
            <EngineVisual />
          </div>
        </section>

        {/* ── Hero 4 · Trust and conversion ─────────────────── */}
        <section id="trust" className="hero hero-trust" aria-labelledby="trust-h">
          <div className="hero-inner">
            <div className="trust-grid">
              <div className="trust-copy">
                <span className="eyebrow">04 · Verification</span>
                <h2 id="trust-h" className="display-2">
                  Know what happened. Not just what you clicked.
                </h2>
                <p className="lede">
                  Submitting a transaction is not success. PanicButton tracks each close by its transaction hash, reads the receipt, checks the
                  position size at the receipt block and at the chain head, compares the fills and cross-checks the indexer. Only then does it
                  say <strong>closed</strong>.
                </p>
              </div>
              <LedgerVisual />
            </div>

            <div className="limits">
              <h3 className="limits-h">What it cannot promise</h3>
              <ul>
                {LIMITS.map((l) => (
                  <li key={l.title}>
                    <h4>{l.title}</h4>
                    <p>{l.body}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className="final-cta">
              <div>
                <p className="final-kicker mono">Ready before you need it</p>
                <p className="final-line">Link once. Exit in seconds when it counts.</p>
              </div>
              <div className="final-actions">
                <Link href="/app" className="btn btn-primary btn-lg">
                  Open PanicButton <span className="arrow" aria-hidden>→</span>
                </Link>
                <Link href="/security" className="text-link">
                  Read the security model
                </Link>
              </div>
              <p className="testnet-note small">
                <strong>Testnet status.</strong> Runs on dreamDEX Perps on Hideki testnet (chain 50383) only. Single-position closes from the web
                and Telegram have been verified on testnet. Close All with real transactions, real partial fills and recovery from unknown
                outcomes have not yet been verified live.
              </p>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

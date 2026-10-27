// Landing-page compositions. Everything here is an illustration with sample values,
// labelled as such on screen; none of it reads from the API.

import { Mark } from "./brand";
import { Badge, ITEM_STATUS, PHASE } from "./status";

// A market that grinds up, rolls over and falls toward liquidation. x: 0–640, y: 0–260.
const FALL = [
  [0, 128], [24, 120], [48, 124], [72, 108], [96, 114], [120, 98], [144, 104], [168, 86], [192, 92], [216, 78],
  [240, 84], [264, 72], [288, 80], [312, 68], [336, 76], [360, 70], [384, 94], [400, 90], [416, 112], [432, 106],
  [452, 140], [470, 134], [492, 166], [512, 160], [534, 192], [556, 186], [580, 214], [604, 208], [640, 226],
] as const;
const path = (pts: readonly (readonly [number, number])[]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");

function ExitChart({ exitLabel = "EXIT" }: { exitLabel?: string }) {
  return (
    <svg className="exit-chart" viewBox="0 0 640 260" role="presentation" aria-hidden focusable="false">
      {[40, 90, 140, 190, 240].map((y) => (
        <line key={y} x1="0" x2="640" y1={y} y2={y} className="ec-grid" />
      ))}
      {[128, 256, 384, 512].map((x) => (
        <line key={x} x1={x} x2={x} y1="0" y2="260" className="ec-grid" />
      ))}
      <line x1="0" x2="640" y1="96" y2="96" className="ec-entry" />
      <text x="6" y="90" className="ec-label">ENTRY</text>
      <line x1="0" x2="640" y1="246" y2="246" className="ec-liq" />
      <text x="6" y="240" className="ec-label ec-label-bad">LIQUIDATION</text>
      <path d={path(FALL)} className="ec-price" pathLength={1} />
      <line x1="416" x2="640" y1="112" y2="112" className="ec-exit" pathLength={1} />
      <circle cx="416" cy="112" r="5" className="ec-exit-dot" />
      <g className="ec-exit-tag">
        <rect x="574" y="99" width="62" height="26" rx="2" />
        <text x="605" y="116.5" textAnchor="middle">
          {exitLabel}
        </text>
      </g>
    </svg>
  );
}

const SAMPLE_ROWS = [
  { market: "ETH-PERP", side: "long", size: "0.004", mark: "2,301.55", pnl: "-0.47", state: "closed" },
  { market: "BTC-PERP", side: "short", size: "0.0002", mark: "80,225.62", pnl: "+0.31", state: "open" },
  { market: "SOL-PERP", side: "long", size: "0.42", mark: "168.25", pnl: "-1.08", state: "open" },
] as const;

/** Hero 1: the terminal, mid-exit. */
export function TerminalVisual() {
  return (
    <figure className="term" aria-labelledby="term-cap">
      <div className="term-bar">
        <span className="term-dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="mono term-path">panicbutton / terminal</span>
        <span className="sample-tag">Illustration · sample values</span>
      </div>
      <div className="term-body">
        <div className="term-chart">
          <div className="term-chart-head mono">
            <span>ETH-PERP · mark</span>
            <span className="bad">▼ adverse move</span>
          </div>
          <ExitChart />
        </div>
        <div className="term-stats mono">
          <div>
            <span>Operator</span>
            <strong className="good">linked</strong>
          </div>
          <div>
            <span>Gas</span>
            <strong>0.42 STT</strong>
          </div>
          <div>
            <span>Chain</span>
            <strong className="good">ok</strong>
          </div>
        </div>
        <ul className="term-rows" aria-hidden>
          {SAMPLE_ROWS.map((r) => (
            <li key={r.market} className={r.state === "closed" ? "is-closed" : ""}>
              <span className="tr-mkt">{r.market}</span>
              <span className={`tr-side ${r.side}`}>{r.side.toUpperCase()}</span>
              <span className="mono tr-num">{r.size}</span>
              <span className="mono tr-num tr-hide">{r.mark}</span>
              <span className={`mono tr-num ${r.pnl.startsWith("-") ? "bad" : "good"}`}>{r.pnl}</span>
              {r.state === "closed" ? <Badge status={ITEM_STATUS.CLOSED} /> : <span className="tr-close">Close</span>}
            </li>
          ))}
        </ul>
        <div className="term-result mono">
          <span>ETH-PERP</span>
          <span className="muted">size after</span>
          <strong>0</strong>
          <span className="muted">tx</span>
          <span>0x8f3a…c21e</span>
        </div>
      </div>
      <figcaption id="term-cap" className="sr-only">
        Illustration with sample values: a falling ETH-PERP price chart with an exit line drawn before liquidation, three sample
        positions, and the first one marked verified closed with a position size of zero after the transaction.
      </figcaption>
    </figure>
  );
}

const SLOW = ["Find the venue", "Connect wallet", "Find the position", "Work out side & size", "Set a price", "Sign", "Did it close?"];
const FAST = ["Open terminal", "Review quote", "Confirm", "Verified"];

/** Hero 2: the same adverse move, two very different paths to flat. */
export function PressureVisual() {
  return (
    <figure className="pressure" aria-labelledby="pressure-cap">
      <div className="pressure-chart">
        <span className="sample-tag">Schematic · not to scale</span>
        <ExitChart exitLabel="FLAT" />
      </div>
      <div className="tracks">
        <div className="track track-slow">
          <span className="track-label mono">Improvised</span>
          <ol>
            {SLOW.map((s, i) => (
              <li key={s} className={i === SLOW.length - 1 ? "is-question" : ""}>
                {s}
              </li>
            ))}
          </ol>
        </div>
        <div className="track track-fast">
          <span className="track-label mono">Prepared</span>
          <ol>
            {FAST.map((s, i) => (
              <li key={s} className={i === FAST.length - 1 ? "is-done" : ""}>
                {s}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <figcaption id="pressure-cap" className="sr-only">
        Schematic: a price falls toward the liquidation level. An improvised exit takes seven steps and ends with the question of
        whether it closed. A prepared exit takes four and ends verified.
      </figcaption>
    </figure>
  );
}

/** Hero 3: two interfaces, one engine. */
export function EngineVisual() {
  return (
    <figure className="engine" aria-labelledby="engine-cap">
      <div className="iface iface-web">
        <div className="iface-head">
          <span className="mono">Web terminal</span>
          <Badge status={PHASE.awaiting} />
        </div>
        <div className="mock-dialog">
          <strong className="mock-title">Close ETH-PERP</strong>
          <dl className="mock-kv">
            <dt>Action</dt>
            <dd>SELL 0.004 to close a long</dd>
            <dt>Order</dt>
            <dd>Immediate-or-cancel</dd>
            <dt>Worst accepted</dt>
            <dd className="mono">2,290.04 · 50 bps</dd>
            <dt>Simulation</dt>
            <dd className="good">ok</dd>
          </dl>
          <span className="mock-btn">Confirm 1 close · 54s</span>
        </div>
      </div>

      <div className="engine-core">
        <span className="engine-wire" aria-hidden />
        <div className="core-box">
          <Mark size={30} />
          <strong>Exit engine</strong>
          <ol className="mono">
            <li>Re-read</li>
            <li>Simulate</li>
            <li>Sign</li>
            <li>Receipt</li>
            <li>Verify</li>
          </ol>
        </div>
        <span className="engine-wire" aria-hidden />
        <div className="chain-box mono">dreamDEX Perps · Hideki testnet</div>
      </div>

      <div className="iface iface-tg">
        <div className="iface-head">
          <span className="mono">Telegram bot</span>
          <span className="sample-tag">private chat</span>
        </div>
        <div className="chat">
          <div className="msg msg-bot msg-alert">
            <p>
              <strong>⚠️ Liquidation alert</strong> ETH-PERP LONG 0.004
            </p>
            <p className="muted">The mark is 4.2% from the estimated liquidation price.</p>
            <div className="chat-btns">
              <span>Prepare close</span>
              <span>Mute 1h</span>
            </div>
          </div>
          <div className="msg msg-bot">
            <p>
              <strong>ETH-PERP</strong> LONG 0.004
            </p>
            <p className="muted">SELL 0.004 · IOC · worst 2,290.04 · simulation ok · expires in 60 s</p>
            <div className="chat-btns">
              <span>Confirm close</span>
              <span>Cancel</span>
            </div>
          </div>
          <p className="msg msg-bot">
            <span className="good">✓ CLOSED</span>, verified on chain. Size after: 0
          </p>
        </div>
      </div>
      <figcaption id="engine-cap" className="sr-only">
        Illustration: the web terminal's confirmation dialog and the Telegram bot's liquidation alert, with its prepare and confirm
        steps, both feed the same exit engine,
        which re-reads, simulates, signs, waits for the receipt and verifies against dreamDEX Perps on Hideki testnet.
      </figcaption>
    </figure>
  );
}

const LEDGER = [
  ["Receipt", "success · block 18,204,331"],
  ["Filled", "0.004 / 0.004"],
  ["Position at receipt block", "0"],
  ["Position at head", "0"],
  ["Indexer cross-check", "agree"],
] as const;

/** Hero 4: what "done" means. */
export function LedgerVisual() {
  return (
    <figure className="ledger" aria-labelledby="ledger-cap">
      <div className="ledger-head">
        <span className="mono">Verification record</span>
        <span className="sample-tag">Illustration</span>
      </div>
      <div className="ledger-tx mono">
        <span className="muted">tx</span> 0x8f3a1d…b07c21e
      </div>
      <ol className="ledger-rows">
        {LEDGER.map(([k, v]) => (
          <li key={k}>
            <span className="ledger-check" aria-hidden>
              ✓
            </span>
            <span className="ledger-k">{k}</span>
            <span className="ledger-v mono">{v}</span>
          </li>
        ))}
      </ol>
      <div className="ledger-final">
        <Badge status={ITEM_STATUS.CLOSED} />
        <span className="muted small">only after every check above agrees</span>
      </div>
      <figcaption id="ledger-cap" className="sr-only">
        Illustration of a verification record: a successful receipt, a full fill, a position size of zero at the receipt block and at
        the chain head, and an agreeing indexer check, after which the close is marked verified closed.
      </figcaption>
    </figure>
  );
}

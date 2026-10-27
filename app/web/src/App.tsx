import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Job, type JobItem, type LinkStatus, type Position, type Quote, type Session, type TelegramStatus } from "./api";
import { Mark, Wordmark } from "./brand";
import { ConfirmDialog, type DialogState } from "./ConfirmDialog";
import { JobPanel } from "./JobPanel";
import { num, price, short, signed } from "./format";
import { Link } from "./router";
import { Badge, ITEM_STATUS } from "./status";

type Health = Awaited<ReturnType<typeof api.health>> | { chainOk: false; executionEnabled: false; unreachable: true };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [link, setLink] = useState<LinkStatus | null>(null);
  const [positions, setPositions] = useState<Position[] | null>(null);
  const [positionsAt, setPositionsAt] = useState<number | null>(null);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [slippage, setSlippage] = useState(50);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [job, setJob] = useState<Job | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const s = await api.session();
      setSessionError(null);
      if (!s.connected) return setSession(null);
      setSession(s);
      setSlippage(s.limits.defaultSlippageBps);
    } catch (e) {
      setSession(null);
      setSessionError((e as Error).message);
    }
  }, []);

  // A refresh can take longer than the poll interval on the public RPC; never stack them.
  const positionsInFlight = useRef(false);
  const loadPositions = useCallback(async () => {
    if (positionsInFlight.current) return;
    positionsInFlight.current = true;
    try {
      const r = await api.positions();
      setPositions(r.positions);
      setPositionsAt(r.at);
      setPositionsError(null);
    } catch (e) {
      setPositionsError((e as Error).message);
    } finally {
      positionsInFlight.current = false;
    }
  }, []);

  const loadLink = useCallback(async () => {
    try {
      setLink(await api.link());
    } catch {
      // shown as unknown
    }
  }, []);

  const loadHealth = useCallback(() => {
    api.health().then(setHealth, () => setHealth({ chainOk: false, executionEnabled: false, unreachable: true }));
  }, []);

  useEffect(() => {
    loadHealth();
    void loadSession();
    const h = setInterval(loadHealth, 30000);
    return () => clearInterval(h);
  }, [loadSession, loadHealth]);

  // Background refreshes pause while a close is being reviewed, so the quote's
  // reads do not compete with them on the public RPC.
  const dialogOpen = useRef(false);
  dialogOpen.current = dialog !== null;
  useEffect(() => {
    if (!session) return;
    void loadPositions();
    void loadLink();
    const p = setInterval(() => !dialogOpen.current && loadPositions(), 5000);
    const l = setInterval(() => !dialogOpen.current && loadLink(), 15000);
    return () => {
      clearInterval(p);
      clearInterval(l);
    };
  }, [session, loadPositions, loadLink]);

  // Poll the running job until it settles, then refresh positions.
  const jobId = job?.id;
  const jobRunning = job?.status === "RUNNING";
  useEffect(() => {
    if (!jobId || !jobRunning) return;
    const t = setInterval(async () => {
      try {
        const r = await api.job(jobId);
        setJob(r.job);
        if (r.job.status !== "RUNNING") void loadPositions();
      } catch {
        // keep polling
      }
    }, 1000);
    return () => clearInterval(t);
  }, [jobId, jobRunning, loadPositions]);

  const openClose = async (target: { pools: string[] } | { all: true }, label: string) => {
    setDialog({ target, label, loading: true, quotes: [], idempotencyKey: crypto.randomUUID() });
    try {
      const r = await api.prepare(target, slippage);
      setDialog((d) => d && { ...d, loading: false, quotes: r.quotes, idempotencyKey: crypto.randomUUID() });
    } catch (e) {
      setDialog((d) => d && { ...d, loading: false, error: (e as Error).message });
    }
  };

  const confirm = async (quotes: Quote[], idempotencyKey: string) => {
    setDialog((d) => d && { ...d, submitting: true });
    try {
      const r = await api.execute(
        quotes.map((q) => q.id),
        idempotencyKey,
      );
      setJob(r.job);
      setDialog(null);
    } catch (e) {
      setDialog((d) => d && { ...d, submitting: false, error: (e as Error).message });
    }
  };

  const busy = job?.status === "RUNNING";
  const jobByPool = new Map<string, JobItem>(job ? job.items.map((i) => [i.pool.toLowerCase(), i]) : []);

  return (
    <div className="term-app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-bar">
        <Link href="/" className="nav-brand" aria-label="PanicButton home">
          <Wordmark />
        </Link>
        <span className="app-bar-sep" aria-hidden />
        <span className="app-bar-title mono">Terminal</span>
        <div className="app-chips" role="status" aria-live="polite">
          {session && (
            <span className={`chip mono chip-${session.executionEnabled ? "exit" : "warn"}`}>
              {session.executionEnabled ? "live execution" : "simulation only"}
            </span>
          )}
        </div>
      </header>

      <main id="main" className="app-main">
        {session === undefined && <LoadingScreen />}
        {session === null && sessionError && (
          <div className="state-box state-error" role="alert">
            <strong>Server unreachable</strong>
            <p>{sessionError}</p>
            <button type="button" className="btn btn-sm" onClick={() => void loadSession()}>
              Try again
            </button>
          </div>
        )}
        {session === null && <Connect onConnected={loadSession} />}
        {session && (
          <>
            <StatusStrip
              session={session}
              link={link}
              health={health}
              positions={positions}
              positionsAt={positionsAt}
              positionsError={positionsError}
            />
            <div className="app-grid">
              <div className="app-col">
                <section className="panel" aria-labelledby="pos-h">
                  <div className="panel-head">
                    <div>
                      <h1 id="pos-h" className="panel-title">
                        Open positions
                        {positions && <span className="count mono">{positions.length}</span>}
                      </h1>
                      <p className="muted small">
                        {positionsAt ? `Updated ${new Date(positionsAt).toLocaleTimeString()} · refreshes every 5 s` : "Reading from chain…"}
                      </p>
                    </div>
                  </div>
                  {positionsError && positions && (
                    <p className="inline-warn small" role="status">
                      Refresh failed: {positionsError}. Showing the last values read.
                    </p>
                  )}

                  <div className="toolbar">
                    <fieldset className="slip">
                      <legend>Max slippage</legend>
                      <div className="seg">
                        {[25, 50, 100]
                          .filter((v) => v <= session.limits.maxSlippageBps)
                          .map((v) => (
                            <button key={v} type="button" aria-pressed={slippage === v} className={slippage === v ? "on" : ""} onClick={() => setSlippage(v)}>
                              {v / 100}%
                            </button>
                          ))}
                        <label className="seg-custom">
                          <input
                            aria-label="Custom slippage in basis points"
                            type="number"
                            inputMode="numeric"
                            min={1}
                            max={session.limits.maxSlippageBps}
                            value={slippage}
                            onChange={(e) =>
                              setSlippage(Math.max(1, Math.min(session.limits.maxSlippageBps, Math.trunc(Number(e.target.value) || 1))))
                            }
                          />
                          <span className="muted">bps · max {session.limits.maxSlippageBps}</span>
                        </label>
                      </div>
                    </fieldset>
                    <button
                      type="button"
                      className="btn btn-panic btn-lg close-all"
                      disabled={!positions?.length || busy}
                      onClick={() => openClose({ all: true }, "Close all positions")}
                    >
                      Close all
                    </button>
                  </div>

                  <Positions
                    positions={positions}
                    error={positionsError}
                    disabled={busy}
                    jobByPool={jobByPool}
                    onRetry={() => void loadPositions()}
                    onClose={(p) => openClose({ pools: [p.pool] }, `Close ${p.market}`)}
                  />
                </section>

                {job && (
                  <section className="panel" aria-labelledby="job-h">
                    <JobPanel
                      job={job}
                      onDismiss={job.status === "RUNNING" ? undefined : () => setJob(null)}
                      onCloseRemaining={(pool, market) => openClose({ pools: [pool] }, `Close remaining ${market}`)}
                    />
                  </section>
                )}
              </div>

              <aside className="app-side" aria-label="Account and access">
                <AccountPanel
                  session={session}
                  link={link}
                  onRefresh={loadLink}
                  onDisconnect={async () => {
                    await api.disconnect().catch(() => undefined);
                    setSession(null);
                    setPositions(null);
                    setPositionsAt(null);
                    setLink(null);
                    setJob(null);
                  }}
                />
              </aside>
            </div>
          </>
        )}
      </main>

      {dialog && session && (
        <ConfirmDialog
          state={dialog}
          executionEnabled={session.executionEnabled}
          onCancel={() => setDialog(null)}
          onRetry={() => openClose(dialog.target, dialog.label)}
          onConfirm={confirm}
        />
      )}

      <footer className="app-foot small muted">
        Testnet only. PanicButton never asks for your wallet key. It signs with a dedicated bot key that you authorize in dreamDEX and can
        remove at any time. That key cannot withdraw, but the protocol does not limit it to closing. <Link href="/security">Security model</Link>
      </footer>
    </div>
  );
}

function LoadingScreen() {
  return (
    <div className="state-box" role="status">
      <span className="spinner" aria-hidden />
      <span>Loading session…</span>
    </div>
  );
}

function StatusStrip({
  session,
  link,
  health,
  positions,
  positionsAt,
  positionsError,
}: {
  session: Session;
  link: LinkStatus | null;
  health: Health | null;
  positions: Position[] | null;
  positionsAt: number | null;
  positionsError: string | null;
}) {
  const cov = link?.coverage;
  const linkedAll = cov && cov.missing.length === 0;
  const linkedNone = cov && cov.linked.length === 0;
  const stale = positions?.filter((p) => !p.markOk).length ?? 0;
  return (
    <dl className="status-strip">
      <div>
        <dt>dreamDEX account</dt>
        <dd className="mono" title={session.owner}>
          {short(session.owner, 8, 6)}
        </dd>
      </div>
      <div>
        <dt>Operator access</dt>
        <dd>
          {!cov ? (
            <span className="muted">checking…</span>
          ) : (
            <span className={linkedAll ? "good" : linkedNone ? "bad" : "warn"}>
              <span aria-hidden>{linkedAll ? "✓ " : linkedNone ? "✕ " : "◑ "}</span>
              {cov.linked.length}/{cov.total} markets
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>Gas balance</dt>
        <dd className="mono">
          {link ? (
            <span className={link.funds.sufficient ? "" : "bad"}>
              {num(link.funds.balance, 4)} STT{link.funds.sufficient ? "" : " · low"}
            </span>
          ) : (
            <span className="muted">checking…</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Market status</dt>
        <dd>
          {health === null ? (
            <span className="muted">checking…</span>
          ) : !health.chainOk ? (
            <span className="bad">✕ chain unreachable</span>
          ) : positions === null ? (
            <span className="good">✓ chain ok</span>
          ) : stale > 0 ? (
            <span className="warn">! {stale} stale mark{stale > 1 ? "s" : ""}</span>
          ) : (
            <span className="good">✓ marks fresh</span>
          )}
        </dd>
      </div>
      <div>
        <dt>Positions</dt>
        <dd>
          {positions === null ? (
            <span className="muted">{positionsError ? "unavailable" : "reading…"}</span>
          ) : (
            <span>
              <span className="mono">{positions.length}</span> open
              {positionsAt && <span className="muted small"> · {new Date(positionsAt).toLocaleTimeString()}</span>}
            </span>
          )}
        </dd>
      </div>
    </dl>
  );
}

function Connect({ onConnected }: { onConnected: () => void }) {
  const [owner, setOwner] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="connect">
      <section className="connect-card" aria-labelledby="connect-h">
        <span className="eyebrow">Connect</span>
        <h1 id="connect-h" className="connect-title">
          Which account should PanicButton protect?
        </h1>
        <p className="muted">
          Enter the dreamDEX account address whose perp positions you want to protect. You will not connect a wallet or paste any key.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api.connect(owner.trim());
              onConnected();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="owner">dreamDEX account address</label>
          <input
            id="owner"
            className="field mono"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            required
            pattern="^0x[0-9a-fA-F]{40}$"
            title="A 0x-prefixed address of 40 hex characters"
            aria-describedby={error ? "owner-err" : "owner-hint"}
            aria-invalid={error ? true : undefined}
          />
          <p id="owner-hint" className="small muted">
            Use a dedicated trading wallet, as dreamDEX itself advises.
          </p>
          {error && (
            <p id="owner-err" className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy}>
            {busy ? "Connecting…" : "Continue"}
          </button>
        </form>
      </section>
      <section className="connect-next" aria-labelledby="next-h">
        <h2 id="next-h" className="side-h">
          What happens next
        </h2>
        <ol className="next-steps">
          <li>
            <strong>A bot key is created for you</strong>
            <span>On PanicButton&apos;s server. Only its public address is shown to you.</span>
          </li>
          <li>
            <strong>You authorize it in dreamDEX</strong>
            <span>Link a bot, Perps, then send it a little STT for gas.</span>
          </li>
          <li>
            <strong>Until then, read-only</strong>
            <span>PanicButton can show positions but cannot close anything.</span>
          </li>
        </ol>
      </section>
    </div>
  );
}

function AccountPanel({
  session,
  link,
  onRefresh,
  onDisconnect,
}: {
  session: Session;
  link: LinkStatus | null;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number>();
  const cov = link?.coverage;
  const linkedAll = cov && cov.missing.length === 0;
  const linkedNone = cov && cov.linked.length === 0;
  return (
    <>
      <section className="panel" aria-labelledby="acct-h">
        <div className="panel-head">
          <h2 id="acct-h" className="side-h">
            Account
          </h2>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDisconnect}>
            Disconnect
          </button>
        </div>
        <dl className="kv">
          <dt>dreamDEX account</dt>
          <dd className="mono" title={session.owner}>
            {short(session.owner, 8, 6)}
          </dd>
          <dt>Bot operator</dt>
          <dd className="mono">
            <span title={session.operator}>{short(session.operator, 8, 6)}</span>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              aria-label={copied ? "Operator address copied" : "Copy bot operator address"}
              onClick={() => {
                void navigator.clipboard.writeText(session.operator);
                setCopied(true);
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </dd>
          <dt>Authorization</dt>
          <dd>
            {!cov ? (
              <span className="muted">checking…</span>
            ) : (
              <span className={linkedAll ? "good" : linkedNone ? "bad" : "warn"}>
                {cov.linked.length}/{cov.total} markets linked
              </span>
            )}
          </dd>
          <dt>Gas (STT)</dt>
          <dd>
            {link ? (
              <span className={link.funds.sufficient ? "good" : "bad"}>
                {num(link.funds.balance, 4)} {link.funds.sufficient ? "" : `(need ≥ ${num(link.funds.perCloseBudget, 3)} per close)`}
              </span>
            ) : (
              <span className="muted">checking…</span>
            )}
          </dd>
        </dl>
        {cov && !linkedAll && (
          <div className={`callout ${linkedNone ? "callout-bad" : "callout-warn"}`}>
            <strong>{linkedNone ? "Authorize PanicButton to close positions" : "Some markets are not covered"}</strong>
            <ol className="small">
              <li>
                Open dreamDEX (Hideki testnet), open this account&apos;s wallet, choose <em>Link a bot</em>.
              </li>
              <li>
                Paste the bot operator address above, keep <em>Perps</em> ticked, press <em>Add bot</em>.
              </li>
              <li>Send the bot at least 0.1 STT for gas (the same screen can do it).</li>
            </ol>
            {cov.missing.length > 0 && !linkedNone && (
              <p className="small muted">Not covered: {cov.missing.join(", ")}. Add the same bot again to cover new markets.</p>
            )}
            <button type="button" className="btn btn-outline btn-sm" onClick={onRefresh}>
              Check again
            </button>
          </div>
        )}
        <p className="small muted revoke-note">To revoke, remove the bot in dreamDEX (Bots tab, red X). Removal is immediate.</p>
      </section>
      <TelegramLink />
    </>
  );
}

function TelegramLink() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number; botUsername: string | null } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.telegram().then(setStatus, () => setStatus(null));
  }, []);
  useEffect(load, [load]);
  // Show the link as soon as the bot confirms it.
  useEffect(() => {
    if (!code || status?.linked) return;
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [code, status?.linked, load]);
  useEffect(() => {
    if (status?.linked) setCode(null);
  }, [status?.linked]);
  if (!status?.enabled) return null;
  const bot = code?.botUsername ?? status.botUsername;
  return (
    <section className="panel" aria-labelledby="tg-h">
      <div className="panel-head">
        <h2 id="tg-h" className="side-h">
          Telegram
        </h2>
        {status.linked ? <Badge status={{ label: "Linked", tone: "good", glyph: "✓" }} /> : <Badge status={{ label: "Not linked", tone: "muted", glyph: "○" }} />}
      </div>
      <div aria-live="polite">
        {status.linked ? (
          <>
            <p className="small">Use /positions, /close and /closeall in the bot chat. Every close there still needs your confirmation.</p>
            <p className="alert-line small">
              {status.alerts.enabled ? (
                <>
                  <Badge status={{ label: "Alerts on", tone: "exit", glyph: "!" }} /> The bot messages you when a position comes within{" "}
                  <strong>{status.alerts.thresholdBps / 100}%</strong> of its liquidation price. Change it with /alerts in the chat.
                </>
              ) : (
                <>
                  <Badge status={{ label: "Alerts off", tone: "muted", glyph: "○" }} /> Send /alerts on in the chat to get liquidation-distance alerts.
                </>
              )}
            </p>
            <button
              type="button"
              className="btn btn-outline btn-sm tg-btn"
              onClick={async () => {
                const r = await api.telegramUnlink().catch((e: Error) => setError(e.message));
                if (r) setNote(r.note);
                load();
              }}
            >
              Unlink Telegram
            </button>
          </>
        ) : code ? (
          <>
            <p className="small">
              Send this to{" "}
              {bot ? (
                <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">
                  @{bot}
                </a>
              ) : (
                "the PanicButton bot"
              )}{" "}
              in a private chat, before {new Date(code.expiresAt).toLocaleTimeString()}:
            </p>
            <p className="link-code mono">/link {code.code}</p>
            <p className="callout callout-bad small">
              <strong>Single use. Never share it:</strong> whoever sends it can close this account&apos;s positions from Telegram.
            </p>
            <p className="small muted">
              <span className="spinner spinner-sm" aria-hidden /> Waiting for the bot to confirm…
            </p>
          </>
        ) : (
          <>
            <p className="small muted">
              Get liquidation-distance alerts and close positions from a private Telegram chat, through the same engine and the same
              confirmations.
            </p>
            <button
              type="button"
              className="btn btn-outline btn-sm tg-btn"
              onClick={async () => {
                setError(null);
                setNote(null);
                const r = await api.telegramCode().catch((e: Error) => setError(e.message));
                if (r) setCode(r);
              }}
            >
              Link Telegram
            </button>
          </>
        )}
        {note && <p className="small muted">{note}</p>}
        {error && (
          <p className="small error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function RowState({ item }: { item: JobItem | undefined }) {
  if (!item) return null;
  return <Badge status={ITEM_STATUS[item.state]} />;
}

function Positions({
  positions,
  error,
  disabled,
  jobByPool,
  onRetry,
  onClose,
}: {
  positions: Position[] | null;
  error: string | null;
  disabled: boolean;
  jobByPool: Map<string, JobItem>;
  onRetry: () => void;
  onClose: (p: Position) => void;
}) {
  if (positions === null && error)
    return (
      <div className="state-box state-error" role="alert">
        <strong>Could not read positions</strong>
        <p className="small">{error}</p>
        <button type="button" className="btn btn-outline btn-sm" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  if (positions === null)
    return (
      <div className="skeleton" role="status" aria-label="Reading positions from chain">
        {[0, 1, 2].map((i) => (
          <span key={i} />
        ))}
        <p className="muted small">Reading positions from chain…</p>
      </div>
    );
  if (positions.length === 0)
    return (
      <div className="state-box state-empty">
        <Mark size={36} />
        <strong>No open perp positions</strong>
        <p className="small muted">This account has nothing open on dreamDEX Perps. New positions appear here within a few seconds.</p>
      </div>
    );

  const closeLabel = (p: Position) => `Close ${p.market} ${p.side} position`;
  const pnlOf = (p: Position) => (p.unrealizedPnl === null ? null : Number(p.unrealizedPnl));

  return (
    <>
      <div className="table-wrap">
        <table className="pos-table">
          <caption className="sr-only">Open perp positions</caption>
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Side</th>
              <th scope="col" className="r">
                Size
              </th>
              <th scope="col" className="r">
                Entry
              </th>
              <th scope="col" className="r">
                Mark
              </th>
              <th scope="col" className="r">
                uPnL <span className="unit">USDso</span>
              </th>
              <th scope="col" className="r">
                Liq. price
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const pnl = pnlOf(p);
              const item = jobByPool.get(p.pool.toLowerCase());
              return (
                <tr key={p.pool} className={!p.operatorAuthorized ? "is-unlinked" : ""}>
                  <th scope="row">
                    <span className="mkt">
                      <strong>{p.market}</strong>
                      {!p.operatorAuthorized && <span className="sub bad">bot not linked</span>}
                    </span>
                  </th>
                  <td>
                    <span className={`side ${p.side}`}>{p.side.toUpperCase()}</span>
                  </td>
                  <td className="r mono">{num(p.sizeHuman, 6)}</td>
                  <td className="r mono">{price(p.entryPrice)}</td>
                  <td className="r mono">{p.markOk ? price(p.markPrice) : <span className="warn">stale</span>}</td>
                  <td className={`r mono ${pnl === null ? "" : pnl >= 0 ? "good" : "bad"}`}>{pnl === null ? "-" : signed(p.unrealizedPnl)}</td>
                  <td className="r mono">{price(p.liquidationPrice)}</td>
                  <td className="r">
                    <div className="actions-cell">
                      <RowState item={item} />
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        disabled={disabled || !p.operatorAuthorized}
                        aria-label={closeLabel(p)}
                        onClick={() => onClose(p)}
                      >
                        Close
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="pos-cards" aria-label="Open perp positions">
        {positions.map((p) => {
          const pnl = pnlOf(p);
          const item = jobByPool.get(p.pool.toLowerCase());
          return (
            <li key={p.pool} className={`pos-card ${p.side}`}>
              <div className="pc-head">
                <strong className="pc-mkt">{p.market}</strong>
                <span className={`side ${p.side}`}>{p.side.toUpperCase()}</span>
                <RowState item={item} />
              </div>
              <div className="pc-pnl">
                <span className="muted small">Unrealized PnL · USDso</span>
                <span className={`mono ${pnl === null ? "" : pnl >= 0 ? "good" : "bad"}`}>{pnl === null ? "-" : signed(p.unrealizedPnl)}</span>
              </div>
              <dl className="pc-grid">
                <div>
                  <dt>Size</dt>
                  <dd className="mono">{num(p.sizeHuman, 6)}</dd>
                </div>
                <div>
                  <dt>Entry</dt>
                  <dd className="mono">{price(p.entryPrice)}</dd>
                </div>
                <div>
                  <dt>Mark</dt>
                  <dd className="mono">{p.markOk ? price(p.markPrice) : <span className="warn">stale</span>}</dd>
                </div>
                <div>
                  <dt>Liq. price</dt>
                  <dd className="mono">{price(p.liquidationPrice)}</dd>
                </div>
              </dl>
              {!p.operatorAuthorized && <p className="small bad">Bot not linked for this market. Closing is disabled.</p>}
              <button
                type="button"
                className="btn btn-danger pc-close"
                disabled={disabled || !p.operatorAuthorized}
                aria-label={closeLabel(p)}
                onClick={() => onClose(p)}
              >
                Close position
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

import { useEffect, useRef, useState } from "react";
import type { Quote } from "./api";
import { num, price } from "./format";
import { Badge, PHASE } from "./status";

export interface DialogState {
  target: { pools: string[] } | { all: true };
  label: string;
  loading: boolean;
  submitting?: boolean;
  error?: string;
  quotes: Quote[];
  idempotencyKey: string;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ConfirmDialog({
  state,
  executionEnabled,
  onCancel,
  onRetry,
  onConfirm,
}: {
  state: DialogState;
  executionEnabled: boolean;
  onCancel: () => void;
  onRetry: () => void;
  onConfirm: (quotes: Quote[], idempotencyKey: string) => void;
}) {
  const [now, setNow] = useState(Date.now());
  const box = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // Modal behavior: focus moves in, stays in, and returns to the opener; the page behind does not scroll.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    title.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !state.submitting) return onCancel();
      if (e.key !== "Tab" || !box.current) return;
      const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return e.preventDefault();
      if (e.shiftKey && (document.activeElement === first || document.activeElement === title.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, state.submitting]);

  const ready = state.quotes.filter((q) => q.status === "READY");
  const blocked = state.quotes.filter((q) => q.status === "BLOCKED");
  const expiresAt = ready.length ? Math.min(...ready.map((q) => q.expiresAt)) : 0;
  const secondsLeft = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const expired = ready.length > 0 && secondsLeft === 0;
  const isAll = "all" in state.target;
  // The expiry bar's full width is the time left when this quote arrived.
  const window0 = useRef({ expiresAt: 0, seconds: 1 });
  if (expiresAt && window0.current.expiresAt !== expiresAt) window0.current = { expiresAt, seconds: Math.max(1, (expiresAt - Date.now()) / 1000) };
  const ttl = window0.current.seconds;

  const phase = state.loading
    ? PHASE.preparing
    : state.submitting
      ? PHASE.submitting
      : ready.length > 0 && !expired
        ? executionEnabled
          ? PHASE.awaiting
          : PHASE.preview
        : state.quotes.length > 0 && ready.length === 0
          ? PHASE.blocked
          : PHASE.preview;

  return (
    <div className="backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && !state.submitting && onCancel()}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-desc">
        <div className="dialog-head">
          <h2 id="dlg-title" ref={title} tabIndex={-1}>
            {state.label}
          </h2>
          <Badge status={expired ? { label: "Quote expired", tone: "muted", glyph: "◷" } : phase} />
        </div>
        <p id="dlg-desc" className="small muted">
          {state.loading
            ? "Reading fresh positions and order books, simulating each close…"
            : "Review each order. Nothing is signed or sent until you confirm."}
        </p>
        {state.loading && (
          <div className="skeleton skeleton-dialog" aria-hidden>
            <span />
            <span />
          </div>
        )}

        {!state.loading && state.quotes.length === 0 && !state.error && <p className="muted">There is nothing to close.</p>}

        {isAll && state.quotes.length > 1 && (
          <div className="callout callout-warn small">
            <strong>Closes run one at a time, in this order, not atomically.</strong> Each position is a separate transaction. Some may close while
            others fail or are skipped. If one ends in an unknown or reversed state, the rest are not attempted.
          </div>
        )}

        {state.quotes.length > 0 && (
          <ol className="quotes">
            {state.quotes.map((q) => (
              <li key={q.id} className={q.status === "READY" ? "ready" : "blocked"}>
                <div className="q-head">
                  <strong>{q.market}</strong>
                  <Badge status={q.status === "READY" ? { label: "Ready", tone: "good", glyph: "✓" } : PHASE.blocked} />
                </div>
                {q.status === "READY" ? (
                  <dl className="kv tight small">
                    <dt>Action</dt>
                    <dd>
                      <strong>{q.isBid ? "BUY" : "SELL"}</strong> {num(q.human.quantity, 8)} to close a {q.side} of {num(q.human.size, 8)}
                    </dd>
                    <dt>Order</dt>
                    <dd>Immediate-or-cancel; any unfilled part is cancelled, never left resting</dd>
                    <dt>Best price now</dt>
                    <dd className="mono">
                      {price(q.human.touch)} (mark {price(q.human.mark)})
                    </dd>
                    <dt>Worst accepted</dt>
                    <dd className="mono">
                      {q.human.priceCap ?? "-"} ({q.slippageBps} bps from the best price)
                    </dd>
                    <dt>Simulation</dt>
                    <dd>{q.simulation}</dd>
                  </dl>
                ) : (
                  <ul className="reasons small">
                    {q.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                )}
                {q.warnings.length > 0 && (
                  <ul className="reasons warn small">
                    {q.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}

        {blocked.length > 0 && ready.length > 0 && <p className="small muted">{blocked.length} blocked position(s) will not be attempted.</p>}
        {!executionEnabled && (
          <p className="callout callout-warn small">This server runs in simulation-only mode (EXECUTION_ENABLED is not set). Nothing will be sent.</p>
        )}
        {state.error && (
          <p className="error" role="alert">
            {state.error}
          </p>
        )}

        {ready.length > 0 && !state.submitting && (
          <div className={`expiry${expired ? " is-expired" : ""}`} aria-hidden>
            <span style={{ width: `${Math.min(100, (secondsLeft / ttl) * 100)}%` }} />
          </div>
        )}

        <div className="actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={state.submitting}>
            Cancel
          </button>
          {expired || (state.error && !state.loading) ? (
            <button type="button" className="btn btn-outline" onClick={onRetry} disabled={state.submitting}>
              Prepare again
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-panic"
            disabled={state.loading || state.submitting || ready.length === 0 || expired || !executionEnabled}
            onClick={() => onConfirm(ready, state.idempotencyKey)}
          >
            {state.submitting
              ? "Submitting…"
              : ready.length === 0
                ? "Nothing to confirm"
                : `Confirm ${ready.length} close${ready.length > 1 ? "s" : ""}${expired ? "" : ` · ${secondsLeft}s`}`}
          </button>
        </div>
      </div>
    </div>
  );
}

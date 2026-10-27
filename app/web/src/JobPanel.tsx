import { useState } from "react";
import type { ItemState, Job, JobItem } from "./api";
import { short, units } from "./format";
import { Badge, FINAL, ITEM_STATUS, OUTCOME_HELP } from "./status";

const STEPS: ItemState[] = ["CHECKING", "SIMULATING", "SUBMITTING", "CONFIRMING", "VERIFYING"];
const STEP_LABEL: Record<string, string> = {
  CHECKING: "Re-check",
  SIMULATING: "Simulate",
  SUBMITTING: "Submit",
  CONFIRMING: "Receipt",
  VERIFYING: "Verify",
};

function stepIndex(state: ItemState, item: JobItem): number {
  const i = STEPS.indexOf(state);
  if (i >= 0) return i;
  if (state === "PENDING") return -1;
  // Final: how far it got.
  if (item.sizeAfter !== undefined) return STEPS.length;
  if (item.txHash) return 3;
  return 0;
}

/** Filled share of the order in tenths of a percent, from the raw integer strings. */
function fillPermille(filled: string, quantity: string): number {
  try {
    const q = BigInt(quantity);
    if (q === 0n) return 0;
    const f = BigInt(filled);
    return Number(((f < 0n ? -f : f) * 1000n) / (q < 0n ? -q : q));
  } catch {
    return 0;
  }
}

function CopyHash({ hash }: { hash: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-outline btn-sm"
      aria-label={copied ? "Transaction hash copied" : "Copy transaction hash"}
      onClick={() => {
        void navigator.clipboard.writeText(hash);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function JobPanel({
  job,
  onDismiss,
  onCloseRemaining,
}: {
  job: Job;
  onDismiss?: () => void;
  onCloseRemaining: (pool: string, market: string) => void;
}) {
  const done = job.items.filter((i) => i.state === "CLOSED").length;
  const summary = job.items.map((i) => `${i.market}: ${ITEM_STATUS[i.state].label}`).join(". ");
  return (
    <>
      <div className="panel-head">
        <div>
          <h2 id="job-h" className="panel-title">
            Execution {job.status === "RUNNING" ? "in progress" : job.status === "HALTED" ? "halted" : "finished"}
          </h2>
          <p className="muted small">
            {done}/{job.items.length} verified closed
            {job.status === "HALTED" ? " · remaining closes were not attempted" : ""}
          </p>
        </div>
        {onDismiss && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {summary}
      </p>
      <ol className="job-items">
        {job.items.map((item) => {
          const status = ITEM_STATUS[item.state];
          const final = FINAL.includes(item.state);
          const at = stepIndex(item.state, item);
          const help = OUTCOME_HELP[item.state];
          const permille = item.filled !== undefined ? fillPermille(item.filled, item.quantity) : null;
          return (
            <li key={item.quoteId} className={`job-item tone-edge-${status.tone}${status.dashed ? " is-dashed" : ""}`}>
              <div className="q-head">
                <strong className="job-mkt">{item.market}</strong>
                <Badge status={status} />
              </div>
              <ol className="steps-row" aria-label="Progress">
                {STEPS.map((s, i) => {
                  const state = i < at ? "done" : i === at && !final ? "now" : "";
                  return (
                    <li key={s} className={`step ${state}`} aria-current={state === "now" ? "step" : undefined}>
                      <span className="step-bar" aria-hidden />
                      <span className="step-label">
                        {STEP_LABEL[s]}
                        <span className="sr-only">{state === "done" ? " (done)" : state === "now" ? " (in progress)" : ""}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
              <p className="job-msg">{item.message}</p>
              {final && help && <p className="small muted job-help">{help}</p>}

              {permille !== null && item.state === "PARTIAL" && (
                <div className="fill" aria-label={`Filled ${(permille / 10).toFixed(1)} percent of the order`}>
                  <span className="fill-bar" aria-hidden>
                    <span style={{ width: `${Math.min(100, permille / 10)}%` }} />
                  </span>
                  <span className="mono small">{(permille / 10).toFixed(1)}% filled</span>
                </div>
              )}

              <dl className="kv tight small">
                <dt>Size before</dt>
                <dd className="mono">{units(item.sizeBefore, item.baseDecimals)}</dd>
                {item.filled !== undefined && (
                  <>
                    <dt>Filled</dt>
                    <dd className="mono">
                      {units(item.filled, item.baseDecimals)} / {units(item.quantity, item.baseDecimals)}
                    </dd>
                  </>
                )}
                {item.sizeAfter !== undefined && (
                  <>
                    <dt>Size after (on chain)</dt>
                    <dd className={`mono ${item.state === "PARTIAL" ? "warn" : ""}`}>
                      {units(item.sizeAfter, item.baseDecimals)}
                      {item.sizeAtHead !== undefined && item.sizeAtHead !== item.sizeAfter ? ` · now ${units(item.sizeAtHead, item.baseDecimals)}` : ""}
                    </dd>
                  </>
                )}
                {item.txHash && (
                  <>
                    <dt>Transaction</dt>
                    <dd className="mono">
                      <span title={item.txHash}>{short(item.txHash, 10, 8)}</span>
                      <CopyHash hash={item.txHash} />
                    </dd>
                  </>
                )}
                {item.receiptStatus && (
                  <>
                    <dt>Receipt</dt>
                    <dd>
                      {item.receiptStatus} · block {item.receiptBlock}
                      {item.orderId ? ` · order ${item.orderId}` : ""}
                    </dd>
                  </>
                )}
                {item.lateReceipt && (
                  <>
                    <dt>Late receipt</dt>
                    <dd>
                      {item.lateReceipt.status} · block {item.lateReceipt.block} (check the positions table for the current size)
                    </dd>
                  </>
                )}
                {item.indexer && (
                  <>
                    <dt>Indexer check</dt>
                    <dd>{item.indexer}</dd>
                  </>
                )}
              </dl>
              {item.state === "PARTIAL" && (
                <button type="button" className="btn btn-danger btn-sm" onClick={() => onCloseRemaining(item.pool, item.market)}>
                  Prepare close of the remainder
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

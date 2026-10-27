// Liquidation-distance alerts for linked Telegram users. Alerts only inform: the
// message offers the normal prepare -> review -> confirm flow and never sends anything.
//
// Per position: alert once when the mark comes within the threshold of the estimated
// liquidation price, again only each time the distance halves, and re-arm once it
// recovers past 1.5x the threshold. State is durable, so a restart does not re-alert.

import type { PositionView } from "../engine/engine.js";

export const ALERT_DEFAULTS = { enabled: true, thresholdBps: 500 };
export const ALERT_INTERVAL_MS = 30_000;
export const ALERT_MUTE_MS = 60 * 60_000;
export const MIN_ALERT_BPS = 100;
export const MAX_ALERT_BPS = 5000;

/** Distance from mark to the estimated liquidation price, as a share of mark in bps. 0 at or past it; null if unknown. */
export function liquidationDistanceBps(p: Pick<PositionView, "side" | "markOk" | "markPrice" | "liquidationPrice">): number | null {
  if (!p.markOk || p.markPrice === null || p.liquidationPrice === null) return null;
  const mark = Number(p.markPrice);
  const liq = Number(p.liquidationPrice);
  if (!(mark > 0) || !(liq > 0)) return null;
  const d = p.side === "long" ? (mark - liq) / mark : (liq - mark) / mark;
  return Math.max(0, Math.floor(d * 10_000));
}

export type AlertDecision = { send: false; lastBps: number | null } | { send: true; lastBps: number; escalation: boolean };

/** `lastBps` is the distance at the last alert for this position, or null when armed. */
export function decideAlert(distanceBps: number, thresholdBps: number, lastBps: number | null): AlertDecision {
  if (distanceBps > thresholdBps * 1.5) return { send: false, lastBps: null };
  if (lastBps === null) return distanceBps <= thresholdBps ? { send: true, lastBps: distanceBps, escalation: false } : { send: false, lastBps: null };
  if (lastBps > 0 && distanceBps <= Math.floor(lastBps / 2)) return { send: true, lastBps: distanceBps, escalation: true };
  return { send: false, lastBps };
}

/** 500 -> "5%", 425 -> "4.3%". */
export const pct = (bps: number) => `${Number((bps / 100).toFixed(1))}%`;

/** "5", "5%", "2.5" -> bps, or undefined if outside the allowed range. */
export function parseThreshold(raw: string): number | undefined {
  const m = /^(\d{1,2}(?:\.\d{1,2})?)\s*%?$/.exec(raw.trim());
  if (!m) return undefined;
  const bps = Math.round(Number(m[1]) * 100);
  return bps >= MIN_ALERT_BPS && bps <= MAX_ALERT_BPS ? bps : undefined;
}

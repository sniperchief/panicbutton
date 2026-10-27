// One visual vocabulary for every close state. Each state has a tone, a glyph and
// words, so it never relies on color alone. Labels describe what the engine reported;
// "closed" appears only for the engine's verified CLOSED state.

import type { ItemState } from "./api";

export type Tone = "good" | "bad" | "warn" | "info" | "exit" | "muted";

export interface StatusStyle {
  label: string;
  tone: Tone;
  glyph: string;
  /** Unresolved outcomes get a dashed outline so they read differently from failures. */
  dashed?: boolean;
}

export const PHASE = {
  preparing: { label: "Preparing", tone: "info", glyph: "◌" },
  preview: { label: "Preview", tone: "muted", glyph: "◇" },
  awaiting: { label: "Awaiting confirmation", tone: "exit", glyph: "!" },
  blocked: { label: "Blocked", tone: "bad", glyph: "■" },
  submitting: { label: "Submitting", tone: "info", glyph: "◐" },
} satisfies Record<string, StatusStyle>;

const EXECUTING: StatusStyle = { label: "Executing", tone: "info", glyph: "◐" };

export const ITEM_STATUS: Record<ItemState, StatusStyle> = {
  PENDING: { label: "Queued", tone: "muted", glyph: "○" },
  CHECKING: EXECUTING,
  SIMULATING: EXECUTING,
  SUBMITTING: EXECUTING,
  CONFIRMING: EXECUTING,
  VERIFYING: { label: "Verifying", tone: "info", glyph: "◐" },
  CLOSED: { label: "Verified closed", tone: "good", glyph: "✓" },
  PARTIAL: { label: "Partially closed", tone: "warn", glyph: "◑" },
  ABORTED: { label: "Aborted · nothing sent", tone: "muted", glyph: "–" },
  FAILED: { label: "Failed", tone: "bad", glyph: "✕" },
  FLIPPED: { label: "Position reversed", tone: "bad", glyph: "⇄" },
  UNKNOWN: { label: "Outcome unknown", tone: "bad", glyph: "?", dashed: true },
  AMBIGUOUS: { label: "Needs review", tone: "warn", glyph: "≠", dashed: true },
  SKIPPED: { label: "Skipped", tone: "muted", glyph: "»" },
};

export const FINAL: ItemState[] = ["CLOSED", "PARTIAL", "ABORTED", "FAILED", "FLIPPED", "UNKNOWN", "AMBIGUOUS", "SKIPPED"];

/** What each final state means for the person reading it, in plain words. */
export const OUTCOME_HELP: Partial<Record<ItemState, string>> = {
  CLOSED: "Position size is zero at the receipt block and at head, and the fills match the order.",
  PARTIAL: "Some of the position remains. Nothing is retried automatically; prepare a new close for the remainder.",
  ABORTED: "A pre-send check failed. No transaction was sent.",
  FAILED: "The transaction reverted or filled nothing. The position is unchanged.",
  FLIPPED: "The position changed direction. Remaining closes were not attempted. Review it in dreamDEX.",
  UNKNOWN: "No receipt yet. New closes are refused until this transaction resolves, so it cannot be doubled.",
  AMBIGUOUS: "Data sources disagree. Check the position in dreamDEX before acting again.",
  SKIPPED: "Not attempted because an earlier close halted the run.",
};

export function Badge({ status, className = "" }: { status: StatusStyle; className?: string }) {
  return (
    <span className={`badge tone-${status.tone}${status.dashed ? " badge-dashed" : ""} ${className}`}>
      <span className="badge-glyph" aria-hidden>
        {status.glyph}
      </span>
      {status.label}
    </span>
  );
}

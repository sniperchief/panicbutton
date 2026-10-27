// Browser API client. The browser never holds keys; it only holds an httpOnly
// session cookie it cannot read.

export interface Session {
  owner: string;
  operator: string;
  executionEnabled: boolean;
  limits: { defaultSlippageBps: number; maxSlippageBps: number; quoteTtlMs: number };
}

export interface LinkStatus {
  coverage: { total: number; linked: string[]; missing: string[] };
  funds: { balance: string; perCloseBudget: string; sufficient: boolean };
}

export interface Position {
  market: string;
  symbol: string;
  pool: string;
  side: "long" | "short";
  size: string;
  sizeHuman: string;
  entryPrice: string;
  markPrice: string | null;
  markOk: boolean;
  unrealizedPnl: string | null;
  liquidationPrice: string | null;
  operatorAuthorized: boolean;
}

export interface Quote {
  id: string;
  pool: string;
  market: string;
  status: "READY" | "BLOCKED";
  blockers: string[];
  warnings: string[];
  side: "long" | "short" | "flat";
  isBid: boolean;
  slippageBps: number;
  simulation: string;
  fingerprint: string;
  expiresAt: number;
  human: { size: string; quantity: string; priceCap: string | null; touch: string | null; mark: string | null };
}

export type ItemState =
  | "PENDING"
  | "CHECKING"
  | "SIMULATING"
  | "SUBMITTING"
  | "CONFIRMING"
  | "VERIFYING"
  | "CLOSED"
  | "PARTIAL"
  | "ABORTED"
  | "FAILED"
  | "FLIPPED"
  | "UNKNOWN"
  | "AMBIGUOUS"
  | "SKIPPED";

export interface JobItem {
  quoteId: string;
  pool: string;
  market: string;
  baseDecimals: number;
  state: ItemState;
  message: string;
  quantity: string;
  sizeBefore: string;
  txHash?: string;
  receiptStatus?: string;
  receiptBlock?: string;
  orderId?: string;
  filled?: string;
  sizeAfter?: string;
  sizeAtHead?: string;
  indexer?: string;
  lateReceipt?: { status: string; block: string };
}

export interface Job {
  id: string;
  status: "RUNNING" | "DONE" | "HALTED";
  items: JobItem[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-panicbutton": "1" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  health: () => request<{ chainOk: boolean; chainId?: number; block?: string; executionEnabled: boolean }>("GET", "/api/health"),
  session: () => request<({ connected: true } & Session) | { connected: false }>("GET", "/api/session"),
  connect: (owner: string) => request<{ owner: string; operator: string }>("POST", "/api/session", { owner }),
  disconnect: () => request<{ ok: boolean; note: string }>("DELETE", "/api/session"),
  link: () => request<LinkStatus>("GET", "/api/session/link"),
  positions: () => request<{ positions: Position[]; at: number }>("GET", "/api/positions"),
  prepare: (target: { pools: string[] } | { all: true }, slippageBps: number) =>
    request<{ quotes: Quote[] }>("POST", "/api/close/prepare", { ...target, slippageBps }),
  execute: (quoteIds: string[], idempotencyKey: string) =>
    request<{ job: Job }>("POST", "/api/close/execute", { quoteIds, idempotencyKey }),
  job: (id: string) => request<{ job: Job }>("GET", `/api/jobs/${id}`),
  telegram: () => request<TelegramStatus>("GET", "/api/telegram"),
  telegramCode: () => request<{ code: string; expiresAt: number; botUsername: string | null }>("POST", "/api/telegram/link-code", {}),
  telegramUnlink: () => request<{ ok: boolean; note: string }>("DELETE", "/api/telegram"),
};

export interface TelegramStatus {
  enabled: boolean;
  botUsername: string | null;
  linked: boolean;
  linkedAt: number | null;
  /** Liquidation-distance alerts sent by the bot; changed with /alerts in Telegram. */
  alerts: { enabled: boolean; thresholdBps: number };
}

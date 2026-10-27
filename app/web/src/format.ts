// Display-only formatting. Exact raw values stay strings end to end; these helpers
// never feed anything back to the server.

export function units(raw: string | undefined, decimals: number): string {
  if (raw === undefined) return "-";
  const neg = raw.startsWith("-");
  const digits = (neg ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const int = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** A decimal string trimmed for display, e.g. "2316.290000" -> "2,316.29". */
export function num(value: string | null | undefined, maxFraction = 4): string {
  if (value === null || value === undefined) return "-";
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  const abs = Math.abs(n);
  const digits = abs !== 0 && abs < 1 ? Math.max(maxFraction, 6) : maxFraction;
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

/** Prices: fewer decimals as the magnitude grows (80,225.62 · 738.64 · 0.168252). */
export function price(value: string | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const abs = Math.abs(Number(value));
  return num(value, abs >= 1000 ? 2 : abs >= 1 ? 4 : 6);
}

export function signed(value: string | null): string {
  if (value === null) return "-";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${num(value, 4)}`;
}

export const short = (hex: string, head = 6, tail = 4) => (hex.length > head + tail + 2 ? `${hex.slice(0, head)}…${hex.slice(-tail)}` : hex);

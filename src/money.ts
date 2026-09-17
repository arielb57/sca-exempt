/** Formats EUR minor units without ever dividing into a float. */
export function formatEur(minor: number): string {
  if (!Number.isSafeInteger(minor)) throw new RangeError(`not an integer amount: ${String(minor)}`);
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}€${String(Math.trunc(abs / 100))}.${cents}`;
}

/**
 * Parses a percentage such as "0.13%", "0.005" or "1%" into parts per million
 * by shifting the decimal point in the string, so "0.13%" is exactly 1300.
 * More than four decimal places cannot be represented and is rejected.
 */
export function parsePercentToPpm(text: string): number {
  const match = /^\s*(\d+)(?:\.(\d{1,4}))?\s*%?\s*$/.exec(text);
  if (!match) throw new RangeError(`not a percentage with at most 4 decimals: "${text}"`);
  const whole = Number(match[1]);
  const frac = Number((match[2] ?? "").padEnd(4, "0"));
  const ppm = whole * 10_000 + frac;
  if (!Number.isSafeInteger(ppm)) throw new RangeError(`percentage out of range: "${text}"`);
  return ppm;
}

/** Inverse of parsePercentToPpm, for display. */
export function formatPpm(ppm: number): string {
  const frac = String(ppm % 10_000).padStart(4, "0").replace(/0+$/, "");
  return `${String(Math.trunc(ppm / 10_000))}${frac ? `.${frac}` : ""}%`;
}

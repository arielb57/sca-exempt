import fc from "fast-check";
import type { Transaction } from "../src/index.js";

// Bounded runs: a failing property reports its counterexample within a minute
// instead of shrinking for an unbounded time.
export const FC_OPTIONS = {
  numRuns: 400,
  interruptAfterTimeLimit: 60_000,
  markInterruptAsFailure: true,
} as const;

let seq = 0;

export function remote(amountMinor: number, extra: Partial<Transaction> = {}): Transaction {
  return {
    id: `r${String(++seq)}`,
    instrument: "card-1",
    amountMinor,
    currency: "EUR",
    channel: "remote",
    paymentType: "card",
    ...extra,
  };
}

export function contactless(amountMinor: number, extra: Partial<Transaction> = {}): Transaction {
  return remote(amountMinor, { channel: "contactless", ...extra });
}

export { fc };

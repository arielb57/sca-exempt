import fc from "fast-check";
import type { Decision, Rejection, Transaction } from "../src/index.js";

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

/**
 * Narrow a decision to the variant a test is about, failing loudly otherwise.
 *
 * Decisions are a union of three outcomes, and a test that reaches for
 * `.rejected` or `.reason` is asserting which one it got. Saying so makes the
 * failure message name the outcome it actually saw instead of throwing on
 * undefined.
 */
export function asRejections(decision: Decision | undefined): readonly Rejection[] {
  if (decision === undefined) throw new Error("expected a decision, got none");
  if (decision.outcome === "blocked") {
    throw new Error(`expected a decision with rejections, got blocked: ${decision.detail}`);
  }
  return decision.rejected;
}

export function label(decision: Decision): string {
  switch (decision.outcome) {
    case "exempt":
      return `exempt:${decision.exemption}`;
    case "blocked":
      return "blocked";
    default:
      return `sca:${decision.reason}`;
  }
}

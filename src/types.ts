import type { PaymentType } from "./rules.js";

export type Channel = "remote" | "contactless";

/** Art. 18(2)(c)(i)-(vi): factors that rule out a low-risk classification. */
export const RISK_FLAGS = [
  "abnormal-spending",
  "unusual-device-or-software",
  "malware",
  "known-fraud-scenario",
  "abnormal-payer-location",
  "high-risk-payee-location",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export interface Transaction {
  readonly id: string;
  /** Payment instrument (card token, account id) the accumulators are keyed on. */
  readonly instrument: string;
  readonly amountMinor: number;
  readonly currency: "EUR";
  readonly channel: Channel;
  readonly paymentType: PaymentType;
  readonly payee?: string;
  /** Payee is on an unattended terminal for transport fares or parking fees (Art. 12). */
  readonly unattendedTerminal?: "transport-fare" | "parking-fee";
  /** Payer and payee accounts belong to the same person at this PSP (Art. 15). */
  readonly ownAccountTransfer?: boolean;
  /** Payer adds the payee to their trusted-beneficiary list with this payment (Art. 13). */
  readonly addPayeeToTrusted?: boolean;
  /** Payment belongs to a series of same-amount, same-payee payments (Art. 14). */
  readonly recurringSeriesId?: string;
  /** The PSP's real-time risk analysis classified this payment as low risk (Art. 18(1)). */
  readonly traLowRisk?: boolean;
  readonly riskFlags?: readonly RiskFlag[];
  /** What happens if SCA is requested. Defaults to "success". */
  readonly scaOutcome?: "success" | "failure";
}

export interface Accumulator {
  readonly cumulativeMinor: number;
  readonly count: number;
}

export interface InstrumentState {
  readonly remote: Accumulator;
  readonly contactless: Accumulator;
  readonly trustedPayees: readonly string[];
  readonly recurringSeries: Readonly<Record<string, { readonly payee: string; readonly amountMinor: number }>>;
  /** Art. 4(3)(b): consecutive failed SCA attempts. A success resets it to 0. */
  readonly failedAttempts: number;
  /** Art. 10(2)(b): when SCA was last applied to an account-information access. */
  readonly lastAccessScaAt?: string;
}

/**
 * Art. 10: the payer looking at their own account rather than paying.
 *
 * ``scope`` decides whether Art. 10 can cover the access at all. The article
 * covers the balance and the transactions of the last 90 days, and only
 * "without disclosure of sensitive payment data".
 */
export interface AccountAccess {
  readonly id: string;
  readonly instrument: string;
  /** ISO-8601 date or date-time. The 90-day window is measured from this. */
  readonly at: string;
  readonly scope: "balance" | "recent-transactions" | "older-transactions" | "sensitive-payment-data";
  /** What happens if SCA is requested. Defaults to "success". */
  readonly scaOutcome?: "success" | "failure";
}

export interface EngineState {
  readonly instruments: Readonly<Record<string, InstrumentState>>;
}

/**
 * Art. 11(b)/(c) and 16(b)/(c) are alternatives: a PSP bounds either the
 * cumulative amount or the consecutive count. "both" enforces the two.
 */
export type CounterMode = "amount" | "count" | "both";

/** The exemptions a *payment* can take, in the order the engine tries them. */
export type PaymentExemptionId =
  | "unattended-terminal"
  | "own-account"
  | "trusted-beneficiary"
  | "recurring"
  | "contactless"
  | "low-value"
  | "tra";

/**
 * Art. 10 is an exemption too, but it applies to looking at an account rather
 * than paying out of it, so it is never a candidate in the payment chain.
 */
export type ExemptionId = PaymentExemptionId | "account-information";

export interface EngineConfig {
  readonly counterMode: CounterMode;
  /** Art. 4(3)(b), default 5. Zero disables blocking. */
  readonly maxConsecutiveFailures?: number;
  /** Art. 10(2)(b), default 90. */
  readonly accessScaValidityDays?: number;
  /** The PSP's rolling fraud rate per payment type (Art. 19), in ppm. Absent: TRA unavailable. */
  readonly fraudRatePpm: Readonly<Partial<Record<PaymentType, number>>>;
  /** Payment exemptions the PSP has chosen to apply. Absent: all. */
  readonly enabledExemptions?: readonly PaymentExemptionId[];
}

export interface Rejection {
  readonly exemption: PaymentExemptionId;
  /** False when the exemption's scope does not cover this transaction at all. */
  readonly inScope: boolean;
  readonly code: string;
  readonly detail: string;
}

export type ScaReason =
  | "first-access"
  | "access-sca-expired"
  | "out-of-article-10-scope"
  | "risk-signal"
  | "trusted-beneficiary-list-change"
  | "recurring-series-created"
  | "recurring-series-amended"
  | "no-exemption-applies";

export type Decision =
  | {
      readonly outcome: "blocked";
      readonly article: string;
      readonly detail: string;
      readonly failedAttempts: number;
    }
  | {
      readonly outcome: "exempt";
      readonly exemption: ExemptionId;
      readonly article: string;
      readonly detail: string;
      readonly rejected: readonly Rejection[];
    }
  | {
      readonly outcome: "sca-required";
      readonly reason: ScaReason;
      readonly article: string;
      readonly detail: string;
      readonly rejected: readonly Rejection[];
    };

export interface EvaluationResult {
  readonly decision: Decision;
  /** Whether the payment went through: exempt, or SCA requested and passed. */
  readonly executed: boolean;
  readonly state: EngineState;
}

export interface AccessResult {
  readonly decision: Decision;
  /** Whether the information was disclosed. */
  readonly granted: boolean;
  readonly state: EngineState;
}

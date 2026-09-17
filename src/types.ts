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
}

export interface EngineState {
  readonly instruments: Readonly<Record<string, InstrumentState>>;
}

/**
 * Art. 11(b)/(c) and 16(b)/(c) are alternatives: a PSP bounds either the
 * cumulative amount or the consecutive count. "both" enforces the two.
 */
export type CounterMode = "amount" | "count" | "both";

export type ExemptionId =
  | "unattended-terminal"
  | "own-account"
  | "trusted-beneficiary"
  | "recurring"
  | "contactless"
  | "low-value"
  | "tra";

export interface EngineConfig {
  readonly counterMode: CounterMode;
  /** The PSP's rolling fraud rate per payment type (Art. 19), in ppm. Absent: TRA unavailable. */
  readonly fraudRatePpm: Readonly<Partial<Record<PaymentType, number>>>;
  /** Exemptions the PSP has chosen to apply. Absent: all. */
  readonly enabledExemptions?: readonly ExemptionId[];
}

export interface Rejection {
  readonly exemption: ExemptionId;
  /** False when the exemption's scope does not cover this transaction at all. */
  readonly inScope: boolean;
  readonly code: string;
  readonly detail: string;
}

export type ScaReason =
  | "risk-signal"
  | "trusted-beneficiary-list-change"
  | "recurring-series-created"
  | "recurring-series-amended"
  | "no-exemption-applies";

export type Decision =
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

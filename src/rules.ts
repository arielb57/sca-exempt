/**
 * Rule tables from Commission Delegated Regulation (EU) 2018/389, the
 * Regulatory Technical Standards on strong customer authentication (RTS).
 *
 * All money is EUR minor units (cents). All rates are parts per million
 * (1% = 10_000 ppm), so 0.005% is exactly 50 and nothing is a float.
 */

export const REGULATION = "Commission Delegated Regulation (EU) 2018/389";

export interface CumulativeLimit {
  readonly article: string;
  /** Art. text: "the amount ... does not exceed" — inclusive. */
  readonly maxSingleMinor: number;
  /** Cumulative amount since the last SCA, including the new transaction. */
  readonly maxCumulativeMinor: number;
  /** Consecutive transactions executed without SCA, including the new one. */
  readonly maxConsecutiveCount: number;
}

/** Art. 11 — contactless payments at the point of sale. */
export const CONTACTLESS: CumulativeLimit = {
  article: "RTS Art. 11",
  maxSingleMinor: 5_000,
  maxCumulativeMinor: 15_000,
  maxConsecutiveCount: 5,
};

/** Art. 16 — low-value remote electronic payment transactions. */
export const LOW_VALUE: CumulativeLimit = {
  article: "RTS Art. 16",
  maxSingleMinor: 3_000,
  maxCumulativeMinor: 10_000,
  maxConsecutiveCount: 5,
};

export type PaymentType = "card" | "credit-transfer";

export interface EtvBand {
  readonly etvMinor: number;
  readonly referenceFraudRatePpm: Readonly<Record<PaymentType, number>>;
}

/**
 * Art. 18(2)(a)-(b) and the Annex: exemption threshold values (ETV) and the
 * reference fraud rate a PSP's own rate must be "equivalent to or below".
 * Ordered from most to least permissive band.
 */
export const TRA_BANDS: readonly EtvBand[] = [
  { etvMinor: 50_000, referenceFraudRatePpm: { card: 100, "credit-transfer": 50 } },
  { etvMinor: 25_000, referenceFraudRatePpm: { card: 600, "credit-transfer": 100 } },
  { etvMinor: 10_000, referenceFraudRatePpm: { card: 1_300, "credit-transfer": 150 } },
];

export const ARTICLES = {
  monitoring: "RTS Art. 2, Art. 18(2)(c)",
  unattended: "RTS Art. 12",
  trustedBeneficiary: "RTS Art. 13",
  recurring: "RTS Art. 14",
  ownAccount: "RTS Art. 15",
  contactless: CONTACTLESS.article,
  lowValue: LOW_VALUE.article,
  tra: "RTS Art. 18",
  sca: "PSD2 Art. 97(1), RTS Art. 4",
} as const;

/**
 * Returns the most permissive ETV band whose reference fraud rate is at or
 * above the PSP's measured rate (Art. 18(2)(a): "equivalent to or below"),
 * or undefined when the rate is above every reference rate.
 */
export function etvBandFor(paymentType: PaymentType, fraudRatePpm: number): EtvBand | undefined {
  if (!Number.isSafeInteger(fraudRatePpm) || fraudRatePpm < 0) {
    throw new RangeError(`fraud rate must be a non-negative integer ppm, got ${String(fraudRatePpm)}`);
  }
  return TRA_BANDS.find((band) => fraudRatePpm <= band.referenceFraudRatePpm[paymentType]);
}

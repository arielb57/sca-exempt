import { formatEur, formatPpm } from "./money.js";
import { ARTICLES, CONTACTLESS, LOW_VALUE, etvBandFor, type CumulativeLimit } from "./rules.js";
import type {
  Accumulator,
  CounterMode,
  Decision,
  EngineConfig,
  EngineState,
  EvaluationResult,
  ExemptionId,
  InstrumentState,
  Rejection,
  Transaction,
} from "./types.js";

export const EMPTY_STATE: EngineState = { instruments: {} };

const ZERO: Accumulator = { cumulativeMinor: 0, count: 0 };

export const EMPTY_INSTRUMENT: InstrumentState = {
  remote: ZERO,
  contactless: ZERO,
  trustedPayees: [],
  recurringSeries: {},
};

export const DEFAULT_CONFIG: EngineConfig = { counterMode: "both", fraudRatePpm: {} };

/**
 * Exemptions are tried in this order and the first that applies wins. The RTS
 * does not rank exemptions against each other; this order puts the ones with
 * no amount ceiling first and Transaction Risk Analysis last, because TRA
 * volume is what Art. 20 audits against the reference fraud rate.
 */
export const PRECEDENCE: readonly ExemptionId[] = [
  "unattended-terminal",
  "own-account",
  "trusted-beneficiary",
  "recurring",
  "contactless",
  "low-value",
  "tra",
];

export function instrumentState(state: EngineState, instrument: string): InstrumentState {
  return state.instruments[instrument] ?? EMPTY_INSTRUMENT;
}

/**
 * Decides whether `txn` needs SCA, then advances the per-instrument state as if
 * the payment were processed: an exempt payment adds to its channel's
 * accumulator, a successful SCA zeroes both accumulators, a failed SCA leaves
 * everything untouched. Never mutates its inputs.
 */
export function evaluate(
  txn: Transaction,
  state: EngineState = EMPTY_STATE,
  config: EngineConfig = DEFAULT_CONFIG,
): EvaluationResult {
  assertValid(txn);
  const inst = instrumentState(state, txn.instrument);
  const decision = decide(txn, inst, config);

  if (decision.outcome === "exempt") {
    const key = txn.channel;
    const next: InstrumentState = { ...inst, [key]: accumulate(inst[key], txn.amountMinor) };
    return { decision, executed: true, state: withInstrument(state, txn.instrument, next) };
  }

  if ((txn.scaOutcome ?? "success") === "failure") {
    return { decision, executed: false, state };
  }

  const next: InstrumentState = {
    remote: ZERO,
    contactless: ZERO,
    trustedPayees:
      txn.addPayeeToTrusted && txn.payee !== undefined && !inst.trustedPayees.includes(txn.payee)
        ? [...inst.trustedPayees, txn.payee]
        : inst.trustedPayees,
    recurringSeries:
      txn.recurringSeriesId !== undefined && txn.payee !== undefined
        ? {
            ...inst.recurringSeries,
            [txn.recurringSeriesId]: { payee: txn.payee, amountMinor: txn.amountMinor },
          }
        : inst.recurringSeries,
  };
  return { decision, executed: true, state: withInstrument(state, txn.instrument, next) };
}

function decide(txn: Transaction, inst: InstrumentState, config: EngineConfig): Decision {
  const mandated = mandatedSca(txn, inst);
  if (mandated) return mandated;

  const enabled = new Set(config.enabledExemptions ?? PRECEDENCE);
  const rejected: Rejection[] = [];
  for (const exemption of PRECEDENCE) {
    if (!enabled.has(exemption)) {
      rejected.push({ exemption, inScope: false, code: "disabled", detail: `${exemption} disabled by PSP policy` });
      continue;
    }
    const result = CHECKS[exemption](txn, inst, config);
    if ("applies" in result) {
      return { outcome: "exempt", exemption, article: result.article, detail: result.applies, rejected };
    }
    rejected.push(result);
  }

  const relevant = rejected.filter((r) => r.inScope).map((r) => r.detail);
  return {
    outcome: "sca-required",
    reason: "no-exemption-applies",
    article: ARTICLES.sca,
    detail: relevant.length > 0 ? relevant.join("; ") : "no enabled exemption covers this payment",
    rejected,
  };
}

/** Triggers under which the RTS requires SCA even if an exemption would otherwise fit. */
function mandatedSca(txn: Transaction, inst: InstrumentState): Decision | undefined {
  const sca = (reason: Extract<Decision, { outcome: "sca-required" }>["reason"], article: string, detail: string) =>
    ({ outcome: "sca-required", reason, article, detail, rejected: [] }) as const;

  if (txn.riskFlags && txn.riskFlags.length > 0) {
    return sca("risk-signal", ARTICLES.monitoring, `transaction monitoring raised: ${txn.riskFlags.join(", ")}`);
  }
  if (txn.addPayeeToTrusted) {
    return sca(
      "trusted-beneficiary-list-change",
      ARTICLES.trustedBeneficiary,
      `adding ${String(txn.payee)} to the trusted-beneficiary list requires SCA`,
    );
  }
  if (txn.recurringSeriesId !== undefined) {
    const series = inst.recurringSeries[txn.recurringSeriesId];
    if (!series) {
      return sca(
        "recurring-series-created",
        ARTICLES.recurring,
        `first payment of recurring series ${txn.recurringSeriesId} requires SCA`,
      );
    }
    if (series.payee !== txn.payee || series.amountMinor !== txn.amountMinor) {
      return sca(
        "recurring-series-amended",
        ARTICLES.recurring,
        `series ${txn.recurringSeriesId} was ${formatEur(series.amountMinor)} to ${series.payee}, now ${formatEur(txn.amountMinor)} to ${String(txn.payee)}`,
      );
    }
  }
  return undefined;
}

type CheckResult = { applies: string; article: string } | Rejection;
type Check = (txn: Transaction, inst: InstrumentState, config: EngineConfig) => CheckResult;

const CHECKS: Readonly<Record<ExemptionId, Check>> = {
  "unattended-terminal": (txn) => {
    if (txn.unattendedTerminal === undefined) {
      return out("unattended-terminal", "not-unattended", "not an unattended transport or parking terminal");
    }
    if (txn.channel === "remote") {
      return reject("unattended-terminal", "remote", "unattended-terminal exemption covers point-of-sale payments only");
    }
    return { applies: `unattended ${txn.unattendedTerminal} terminal`, article: ARTICLES.unattended };
  },

  "own-account": (txn) => {
    if (!txn.ownAccountTransfer) return out("own-account", "not-own-account", "not a transfer between own accounts");
    if (txn.paymentType !== "credit-transfer") {
      return reject("own-account", "not-credit-transfer", "own-account exemption covers credit transfers only");
    }
    return { applies: "credit transfer between the payer's own accounts at this PSP", article: ARTICLES.ownAccount };
  },

  "trusted-beneficiary": (txn, inst) => {
    if (txn.payee === undefined) return out("trusted-beneficiary", "no-payee", "no payee given");
    if (!inst.trustedPayees.includes(txn.payee)) {
      return out("trusted-beneficiary", "payee-not-trusted", `${txn.payee} is not a trusted beneficiary`);
    }
    return { applies: `${txn.payee} is on the payer's trusted-beneficiary list`, article: ARTICLES.trustedBeneficiary };
  },

  recurring: (txn) => {
    if (txn.recurringSeriesId === undefined) return out("recurring", "not-recurring", "not part of a recurring series");
    return {
      applies: `recurring series ${txn.recurringSeriesId}: same amount, same payee`,
      article: ARTICLES.recurring,
    };
  },

  contactless: (txn, inst, config) => {
    if (txn.channel !== "contactless") return out("contactless", "not-contactless", "not a contactless payment");
    return cumulative("contactless", CONTACTLESS, inst.contactless, txn.amountMinor, config.counterMode);
  },

  "low-value": (txn, inst, config) => {
    if (txn.channel !== "remote") return out("low-value", "not-remote", "not a remote payment");
    return cumulative("low-value", LOW_VALUE, inst.remote, txn.amountMinor, config.counterMode);
  },

  tra: (txn, _inst, config) => {
    if (txn.channel !== "remote") return out("tra", "not-remote", "TRA covers remote payments only");
    const rate = config.fraudRatePpm[txn.paymentType];
    if (rate === undefined) return reject("tra", "no-fraud-rate", `no ${txn.paymentType} fraud rate configured for TRA`);
    const band = etvBandFor(txn.paymentType, rate);
    if (!band) {
      return reject("tra", "fraud-rate-above-reference", `${txn.paymentType} fraud rate ${formatPpm(rate)} is above every TRA reference rate`);
    }
    if (!txn.traLowRisk) return reject("tra", "not-low-risk", "risk analysis did not classify the payment as low risk");
    if (txn.amountMinor > band.etvMinor) {
      return reject("tra", "amount-above-etv", `${formatEur(txn.amountMinor)} > TRA ETV ${formatEur(band.etvMinor)} at fraud rate ${formatPpm(rate)}`);
    }
    return {
      applies: `low risk, ${formatEur(txn.amountMinor)} <= ETV ${formatEur(band.etvMinor)} at fraud rate ${formatPpm(rate)}`,
      article: ARTICLES.tra,
    };
  },
};

function cumulative(
  exemption: "contactless" | "low-value",
  limit: CumulativeLimit,
  acc: Accumulator,
  amountMinor: number,
  mode: CounterMode,
): CheckResult {
  if (amountMinor > limit.maxSingleMinor) {
    return reject(exemption, "amount-above-limit", `${formatEur(amountMinor)} > ${exemption} limit ${formatEur(limit.maxSingleMinor)}`);
  }
  const total = acc.cumulativeMinor + amountMinor;
  const count = acc.count + 1;
  const parts = [`${formatEur(amountMinor)} <= ${formatEur(limit.maxSingleMinor)}`];
  if (mode !== "count") {
    if (total > limit.maxCumulativeMinor) {
      return reject(
        exemption,
        "cumulative-amount-exceeded",
        `${exemption} cumulative ${formatEur(total)} since last SCA > ${formatEur(limit.maxCumulativeMinor)}`,
      );
    }
    parts.push(`cumulative ${formatEur(total)} <= ${formatEur(limit.maxCumulativeMinor)}`);
  }
  if (mode !== "amount") {
    if (count > limit.maxConsecutiveCount) {
      return reject(
        exemption,
        "consecutive-count-exceeded",
        `${exemption} payment #${String(count)} since last SCA > ${String(limit.maxConsecutiveCount)}`,
      );
    }
    parts.push(`count ${String(count)} <= ${String(limit.maxConsecutiveCount)}`);
  }
  return { applies: parts.join(", "), article: limit.article };
}

function reject(exemption: ExemptionId, code: string, detail: string): Rejection {
  return { exemption, inScope: true, code, detail };
}

function out(exemption: ExemptionId, code: string, detail: string): Rejection {
  return { exemption, inScope: false, code, detail };
}

function accumulate(acc: Accumulator, amountMinor: number): Accumulator {
  // Saturate instead of overflowing: any value past every limit behaves the same.
  return {
    cumulativeMinor: Math.min(acc.cumulativeMinor + amountMinor, Number.MAX_SAFE_INTEGER),
    count: Math.min(acc.count + 1, Number.MAX_SAFE_INTEGER),
  };
}

function withInstrument(state: EngineState, instrument: string, next: InstrumentState): EngineState {
  return { instruments: { ...state.instruments, [instrument]: next } };
}

function assertValid(txn: Transaction): void {
  const fail = (msg: string): never => {
    throw new TypeError(`transaction ${String(txn.id)}: ${msg}`);
  };
  if (!Number.isSafeInteger(txn.amountMinor) || txn.amountMinor <= 0) {
    fail("amountMinor must be a positive integer number of cents");
  }
  if (txn.currency !== "EUR") fail(`currency must be EUR, got ${String(txn.currency)}`);
  if (txn.channel === "contactless" && txn.paymentType !== "card") fail("contactless payments must be card payments");
  if ((txn.addPayeeToTrusted || txn.recurringSeriesId !== undefined) && txn.payee === undefined) {
    fail("a payee is required to trust a payee or run a recurring series");
  }
}

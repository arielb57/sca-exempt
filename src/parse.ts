import { RISK_FLAGS, type RiskFlag, type Transaction } from "./types.js";

const KNOWN_FIELDS = new Set([
  "id",
  "instrument",
  "amountMinor",
  "currency",
  "channel",
  "paymentType",
  "payee",
  "unattendedTerminal",
  "ownAccountTransfer",
  "addPayeeToTrusted",
  "recurringSeriesId",
  "traLowRisk",
  "riskFlags",
  "scaOutcome",
]);

export class InputError extends Error {}

/**
 * Validates one decoded JSON value as a Transaction. Unknown fields are
 * rejected rather than ignored: a misspelt "riskFlag" silently dropped would
 * turn a mandated SCA into an exemption.
 */
export function parseTransaction(value: unknown): Transaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputError("expected a JSON object");
  }
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!KNOWN_FIELDS.has(key)) throw new InputError(`unknown field "${key}"`);
  }

  const str = (key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) throw new InputError(`"${key}" must be a non-empty string`);
    return v;
  };
  const optStr = (key: string): string | undefined => (o[key] === undefined ? undefined : str(key));
  const optBool = (key: string): boolean | undefined => {
    const v = o[key];
    if (v !== undefined && typeof v !== "boolean") throw new InputError(`"${key}" must be a boolean`);
    return v;
  };
  const oneOf = <T extends string>(key: string, allowed: readonly T[], optional: boolean): T | undefined => {
    const v = o[key];
    if (v === undefined && optional) return undefined;
    if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
      throw new InputError(`"${key}" must be one of ${allowed.join(", ")}`);
    }
    return v as T;
  };

  const amount = o["amountMinor"];
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
    throw new InputError(`"amountMinor" must be a positive integer number of cents`);
  }

  let riskFlags: RiskFlag[] | undefined;
  if (o["riskFlags"] !== undefined) {
    const flags = o["riskFlags"];
    if (!Array.isArray(flags)) throw new InputError(`"riskFlags" must be an array`);
    riskFlags = flags.map((f) => {
      if (typeof f !== "string" || !(RISK_FLAGS as readonly string[]).includes(f)) {
        throw new InputError(`unknown risk flag ${JSON.stringify(f)}; expected one of ${RISK_FLAGS.join(", ")}`);
      }
      return f as RiskFlag;
    });
  }

  const fields: Record<string, unknown> = {
    id: str("id"),
    instrument: str("instrument"),
    amountMinor: amount,
    currency: oneOf("currency", ["EUR"], false),
    channel: oneOf("channel", ["remote", "contactless"], false),
    paymentType: oneOf("paymentType", ["card", "credit-transfer"], false),
    payee: optStr("payee"),
    unattendedTerminal: oneOf("unattendedTerminal", ["transport-fare", "parking-fee"], true),
    ownAccountTransfer: optBool("ownAccountTransfer"),
    addPayeeToTrusted: optBool("addPayeeToTrusted"),
    recurringSeriesId: optStr("recurringSeriesId"),
    traLowRisk: optBool("traLowRisk"),
    riskFlags,
    scaOutcome: oneOf("scaOutcome", ["success", "failure"], true),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as unknown as Transaction;
}

/**
 * Article 10: looking at your own account, rather than paying out of it.
 *
 * This is the exemption most people meet without noticing — checking a balance
 * in an app does not ask for a code every time, but does after a few months.
 * Art. 10(1) covers the balance and the transactions of the last 90 days,
 * "without disclosure of sensitive payment data". Art. 10(2) makes that
 * conditional on SCA having been applied for the first access, and on no more
 * than 90 days having passed since the last one.
 *
 * Three readings had to be settled, all in the direction that asks for SCA
 * more often, matching the rest of this engine:
 *
 *  - **Only an account-access SCA restarts the 90 days.** The article ties the
 *    clock to "the last time the payment service user accessed ... and strong
 *    customer authentication was applied", not to any SCA the payer happened
 *    to pass while paying for something.
 *  - **The 90 days are a closed window.** Day 90 exactly is still inside it;
 *    day 91 is not. The article says "more than 90 days have elapsed".
 *  - **The clock runs from the access, not from the request.** Only one
 *    timestamp exists per access, so these are the same thing here, but the
 *    distinction matters if a caller batches.
 */

import { ACCOUNT_INFORMATION, ARTICLES } from "./rules.js";
import type { AccessResult, AccountAccess, Decision, EngineConfig, EngineState, InstrumentState } from "./types.js";
import { DEFAULT_CONFIG, EMPTY_STATE, blockedDecision, instrumentState, withInstrument } from "./engine.js";

const DAY_MS = 86_400_000;

/** Scopes Art. 10 can cover at all. The other two are outside the article. */
const IN_SCOPE = new Set(["balance", "recent-transactions"]);

export function parseInstant(text: string, what: string): number {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new TypeError(`${what} must be an ISO-8601 date or date-time, got ${JSON.stringify(text)}`);
  return ms;
}

/**
 * Decides whether an account-information access needs SCA, and advances the
 * instrument's state. A successful SCA restarts the 90 days; a failed one
 * counts towards the Art. 4(3)(b) attempt limit, exactly as for a payment.
 */
export function evaluateAccess(
  access: AccountAccess,
  state: EngineState = EMPTY_STATE,
  config: EngineConfig = DEFAULT_CONFIG,
): AccessResult {
  assertValidAccess(access);
  const inst = instrumentState(state, access.instrument);
  const at = parseInstant(access.at, "at");

  const blocked = blockedDecision(inst, config);
  if (blocked) return { decision: blocked, granted: false, state };

  const decision = decideAccess(access, inst, config, at);
  if (decision.outcome === "exempt") {
    return { decision, granted: true, state };
  }

  if ((access.scaOutcome ?? "success") === "failure") {
    const next: InstrumentState = { ...inst, failedAttempts: inst.failedAttempts + 1 };
    return { decision, granted: false, state: withInstrument(state, access.instrument, next) };
  }

  // A passed SCA restarts the window even when the access itself was outside
  // Art. 10: the user has now authenticated, which is what the clock measures.
  const next: InstrumentState = { ...inst, failedAttempts: 0, lastAccessScaAt: access.at };
  return { decision, granted: true, state: withInstrument(state, access.instrument, next) };
}

function decideAccess(access: AccountAccess, inst: InstrumentState, config: EngineConfig, at: number): Decision {
  const sca = (reason: "first-access" | "access-sca-expired" | "out-of-article-10-scope", detail: string) =>
    ({ outcome: "sca-required", reason, article: ARTICLES.accountInformation, detail, rejected: [] }) as const;

  if (!IN_SCOPE.has(access.scope)) {
    return sca(
      "out-of-article-10-scope",
      access.scope === "sensitive-payment-data"
        ? "Art. 10 covers access without disclosure of sensitive payment data"
        : "Art. 10 covers transactions of the last 90 days, not older ones",
    );
  }

  if (inst.lastAccessScaAt === undefined) {
    return sca("first-access", "Art. 10(2)(b) requires SCA for the first access to this account");
  }

  const days = config.accessScaValidityDays ?? ACCOUNT_INFORMATION.scaValidityDays;
  const elapsed = (at - parseInstant(inst.lastAccessScaAt, "lastAccessScaAt")) / DAY_MS;
  if (elapsed > days) {
    return sca(
      "access-sca-expired",
      `${elapsed.toFixed(1)} days since the last authenticated access, over the ${days}-day limit`,
    );
  }

  return {
    outcome: "exempt",
    exemption: "account-information",
    article: ARTICLES.accountInformation,
    detail: `${elapsed.toFixed(1)} days since the last authenticated access, within ${days}`,
    rejected: [],
  };
}

function assertValidAccess(access: AccountAccess): void {
  if (typeof access.instrument !== "string" || access.instrument.length === 0) {
    throw new TypeError("instrument must be a non-empty string");
  }
  parseInstant(access.at, "at");
}

import { describe, expect, it } from "vitest";
import {
  ACCOUNT_INFORMATION,
  ATTEMPT_LIMIT,
  EMPTY_STATE,
  evaluate,
  evaluateAccess,
  instrumentState,
  type AccountAccess,
  type EngineState,
} from "../src/index.js";
import { remote } from "./helpers.js";

function look(at: string, extra: Partial<AccountAccess> = {}): AccountAccess {
  return { id: "a", instrument: "card-1", at, scope: "balance", ...extra };
}

/** Walk a list of accesses through the engine, returning every decision. */
function stream(accesses: readonly AccountAccess[]): { labels: string[]; state: EngineState } {
  let state: EngineState = EMPTY_STATE;
  const labels: string[] = [];
  for (const access of accesses) {
    const result = evaluateAccess(access, state);
    state = result.state;
    labels.push(
      result.decision.outcome === "exempt" ? "exempt" : result.decision.outcome === "blocked" ? "blocked" : result.decision.reason,
    );
  }
  return { labels, state };
}

describe("Article 10: looking at your own account", () => {
  it("asks for SCA the first time and not the second", () => {
    expect(stream([look("2026-01-01"), look("2026-01-02")]).labels).toEqual(["first-access", "exempt"]);
  });

  it("holds for exactly 90 days, and not 91", () => {
    const { scaValidityDays: days } = ACCOUNT_INFORMATION;
    expect(days).toBe(90);
    // "more than 90 days have elapsed" (Art. 10(2)(b)): day 90 is still inside.
    expect(stream([look("2026-01-01T00:00:00Z"), look("2026-04-01T00:00:00Z")]).labels).toEqual([
      "first-access",
      "exempt",
    ]);
    expect(stream([look("2026-01-01T00:00:00Z"), look("2026-04-02T00:00:01Z")]).labels).toEqual([
      "first-access",
      "access-sca-expired",
    ]);
  });

  it("checking often does not push the deadline back", () => {
    // Art. 10(2)(b) measures from the last access at which SCA *was applied*,
    // so an exempt look does not restart the clock. The practical consequence
    // is that the challenge comes round at least every 90 days however often
    // the account is opened — which is what banking apps actually do.
    const labels = stream([
      look("2026-01-01T00:00:00Z"),
      look("2026-03-01T00:00:00Z"), // 59 days
      look("2026-05-01T00:00:00Z"), // 120 days since the SCA, not 61
      look("2026-05-02T00:00:00Z"), // the challenge above restarted it
    ]).labels;
    expect(labels).toEqual(["first-access", "exempt", "access-sca-expired", "exempt"]);
  });

  it("does not cover sensitive payment data or transactions older than 90 days", () => {
    const seed = [look("2026-01-01")];
    expect(stream([...seed, look("2026-01-02", { scope: "sensitive-payment-data" })]).labels[1]).toBe(
      "out-of-article-10-scope",
    );
    expect(stream([...seed, look("2026-01-02", { scope: "older-transactions" })]).labels[1]).toBe(
      "out-of-article-10-scope",
    );
  });

  it("a payment SCA does not restart the account-information clock", () => {
    // Art. 10(2)(b) ties the clock to an authenticated *access*, not to any
    // SCA the payer happened to pass while paying for something.
    const paid = evaluate(remote(900_00), EMPTY_STATE);
    expect(paid.executed).toBe(true);
    expect(evaluateAccess(look("2026-01-01"), paid.state).decision).toMatchObject({ reason: "first-access" });
  });

  it("rejects a timestamp that is not a date", () => {
    expect(() => evaluateAccess(look("not-a-date"))).toThrow(/ISO-8601/);
  });
});

describe("Article 4(3)(b): five failed attempts block the instrument", () => {
  const failing = (n: number) => Array.from({ length: n }, () => remote(900_00, { scaOutcome: "failure" }));

  it("blocks on the sixth attempt, not the fifth", () => {
    expect(ATTEMPT_LIMIT.maxConsecutiveFailures).toBe(5);
    let state: EngineState = EMPTY_STATE;
    const outcomes = failing(6).map((txn) => {
      const r = evaluate(txn, state);
      state = r.state;
      return r.decision.outcome;
    });
    expect(outcomes).toEqual([
      "sca-required",
      "sca-required",
      "sca-required",
      "sca-required",
      "sca-required",
      "blocked",
    ]);
    expect(instrumentState(state, "card-1").failedAttempts).toBe(5);
  });

  it("a passed SCA resets the count", () => {
    let state: EngineState = EMPTY_STATE;
    for (const txn of failing(4)) state = evaluate(txn, state).state;
    expect(instrumentState(state, "card-1").failedAttempts).toBe(4);
    state = evaluate(remote(900_00), state).state;
    expect(instrumentState(state, "card-1").failedAttempts).toBe(0);
  });

  it("an exempt payment does not reset the count, because it is not an attempt", () => {
    let state: EngineState = EMPTY_STATE;
    for (const txn of failing(4)) state = evaluate(txn, state).state;
    state = evaluate(remote(10_00), state).state; // exempt, low value
    expect(instrumentState(state, "card-1").failedAttempts).toBe(4);
    state = evaluate(remote(900_00, { scaOutcome: "failure" }), state).state;
    expect(evaluate(remote(10_00), state).decision.outcome).toBe("blocked");
  });

  it("blocking is per instrument", () => {
    let state: EngineState = EMPTY_STATE;
    for (const txn of failing(5)) state = evaluate(txn, state).state;
    expect(evaluate(remote(10_00), state).decision.outcome).toBe("blocked");
    expect(evaluate(remote(10_00, { instrument: "card-2" }), state).decision.outcome).toBe("exempt");
  });

  it("a blocked instrument cannot look at the account either", () => {
    let state: EngineState = EMPTY_STATE;
    for (const txn of failing(5)) state = evaluate(txn, state).state;
    expect(evaluateAccess(look("2026-01-01"), state).decision.outcome).toBe("blocked");
  });

  it("a PSP can widen or disable the limit", () => {
    let state: EngineState = EMPTY_STATE;
    const config = { counterMode: "both" as const, fraudRatePpm: {}, maxConsecutiveFailures: 0 };
    for (const txn of failing(20)) state = evaluate(txn, state, config).state;
    expect(evaluate(remote(10_00), state, config).decision.outcome).toBe("exempt");
  });
});

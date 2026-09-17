import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  EMPTY_STATE,
  evaluate,
  replay,
  type EngineConfig,
  type Transaction,
} from "../src/index.js";
import { contactless, remote } from "./helpers.js";

function lastOf(txns: Transaction[], config: EngineConfig = DEFAULT_CONFIG) {
  const { steps } = replay(txns, config);
  const last = steps[steps.length - 1];
  if (!last) throw new Error("empty sequence");
  return last;
}

describe("low-value single-amount boundary (Art. 16(a): does not exceed EUR 30)", () => {
  it.each([
    [2999, "exempt"],
    [3000, "exempt"],
    [3001, "sca-required"],
  ])("%i cents on a fresh instrument -> %s", (amount, outcome) => {
    const { decision } = evaluate(remote(amount));
    expect(decision.outcome).toBe(outcome);
    if (decision.outcome === "sca-required") {
      expect(decision.rejected.find((r) => r.exemption === "low-value")?.code).toBe("amount-above-limit");
    }
  });
});

describe("low-value cumulative boundary (Art. 16(b): EUR 100 including the new payment)", () => {
  it.each([
    [999, "exempt"],
    [1000, "exempt"],
    [1001, "sca-required"],
  ])("€90 already spent, then %i cents -> %s", (amount, outcome) => {
    const step = lastOf([remote(3000), remote(3000), remote(3000), remote(amount)], {
      counterMode: "amount",
      fraudRatePpm: {},
    });
    expect(step.decision.outcome).toBe(outcome);
    if (outcome === "sca-required") {
      expect(step.decision.rejected.find((r) => r.exemption === "low-value")?.code).toBe("cumulative-amount-exceeded");
    }
  });
});

describe("consecutive count boundary (5th vs 6th payment since last SCA)", () => {
  for (const [label, make] of [
    ["remote", remote],
    ["contactless", contactless],
  ] as const) {
    it(`${label}: 5th payment exempt, 6th requires SCA`, () => {
      const { steps } = replay(Array.from({ length: 6 }, () => make(100)), { counterMode: "count", fraudRatePpm: {} });
      expect(steps.map((s) => s.decision.outcome)).toEqual([
        "exempt",
        "exempt",
        "exempt",
        "exempt",
        "exempt",
        "sca-required",
      ]);
      expect(steps[4]?.after[label].count).toBe(5);
      expect(steps[5]?.decision.rejected.find((r) => r.inScope)?.code).toBe("consecutive-count-exceeded");
      expect(steps[5]?.after[label]).toEqual({ cumulativeMinor: 0, count: 0 });
    });
  }

  it("amount mode ignores the count: the 6th and 20th small payments stay exempt under €100", () => {
    const { steps } = replay(Array.from({ length: 20 }, () => remote(100)), { counterMode: "amount", fraudRatePpm: {} });
    expect(steps.every((s) => s.decision.outcome === "exempt")).toBe(true);
    expect(steps[19]?.after.remote).toEqual({ cumulativeMinor: 2000, count: 20 });
  });

  it("count mode ignores the amount: five €30 payments are €150 cumulative and still exempt", () => {
    const { steps } = replay(Array.from({ length: 5 }, () => remote(3000)), { counterMode: "count", fraudRatePpm: {} });
    expect(steps.every((s) => s.decision.outcome === "exempt")).toBe(true);
  });

  it("both mode stops at whichever limit is reached first", () => {
    const both: EngineConfig = { counterMode: "both", fraudRatePpm: {} };
    const byAmount = lastOf([remote(3000), remote(3000), remote(3000), remote(1001)], both);
    expect(byAmount.decision.rejected.find((r) => r.exemption === "low-value")?.code).toBe("cumulative-amount-exceeded");
    const byCount = lastOf(Array.from({ length: 6 }, () => remote(1)), both);
    expect(byCount.decision.rejected.find((r) => r.exemption === "low-value")?.code).toBe("consecutive-count-exceeded");
  });
});

describe("contactless boundaries (Art. 11: EUR 50 single, EUR 150 cumulative)", () => {
  it.each([
    [4999, "exempt"],
    [5000, "exempt"],
    [5001, "sca-required"],
  ])("single tap of %i cents -> %s", (amount, outcome) => {
    expect(evaluate(contactless(amount)).decision.outcome).toBe(outcome);
  });

  it.each([
    [4999, "exempt"],
    [5000, "exempt"],
    [5001, "sca-required"],
  ])("€100 already tapped, then %i cents -> %s (€150 cap)", (amount, outcome) => {
    const step = lastOf([contactless(5000), contactless(5000), contactless(amount)]);
    expect(step.decision.outcome).toBe(outcome);
  });

  it("the remote €30 limit does not apply to contactless and vice versa", () => {
    expect(evaluate(contactless(4000)).decision.outcome).toBe("exempt");
    expect(evaluate(remote(4000)).decision.outcome).toBe("sca-required");
  });
});

describe("TRA exemption threshold values (Art. 18 and Annex)", () => {
  const cfg = (card: number): EngineConfig => ({ counterMode: "both", fraudRatePpm: { card } });

  it.each([
    // [fraud rate ppm, amount, outcome]
    [100, 50_000, "exempt"],
    [100, 50_001, "sca-required"],
    [101, 50_000, "sca-required"],
    [101, 25_000, "exempt"],
    [600, 25_000, "exempt"],
    [601, 25_000, "sca-required"],
    [601, 10_000, "exempt"],
    [1300, 10_000, "exempt"],
    [1300, 10_001, "sca-required"],
    [1301, 3_100, "sca-required"],
  ])("card fraud rate %i ppm, amount %i cents -> %s", (rate, amount, outcome) => {
    const { decision } = evaluate(remote(amount, { traLowRisk: true }), EMPTY_STATE, cfg(rate));
    expect(decision.outcome).toBe(outcome);
    if (outcome === "exempt") expect(decision).toMatchObject({ exemption: "tra" });
  });

  it("uses the credit-transfer reference rates for credit transfers", () => {
    const txn = remote(50_000, { paymentType: "credit-transfer", traLowRisk: true });
    const at = (ct: number) => evaluate(txn, EMPTY_STATE, { counterMode: "both", fraudRatePpm: { "credit-transfer": ct } });
    expect(at(50).decision.outcome).toBe("exempt");
    expect(at(51).decision.outcome).toBe("sca-required");
    // A card rate says nothing about credit transfers.
    expect(evaluate(txn, EMPTY_STATE, cfg(0)).decision.outcome).toBe("sca-required");
  });

  it("requires a low-risk classification from real-time risk analysis", () => {
    const { decision } = evaluate(remote(5_000), EMPTY_STATE, cfg(0));
    expect(decision.outcome).toBe("sca-required");
    expect(decision.rejected.find((r) => r.exemption === "tra")?.code).toBe("not-low-risk");
  });

  it("never applies to contactless payments", () => {
    const { decision } = evaluate(contactless(6_000, { traLowRisk: true }), EMPTY_STATE, cfg(0));
    expect(decision.outcome).toBe("sca-required");
    expect(decision.rejected.find((r) => r.exemption === "tra")?.inScope).toBe(false);
  });
});

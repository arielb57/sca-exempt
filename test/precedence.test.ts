import { describe, expect, it } from "vitest";
import { PRECEDENCE, evaluate, replay, type Decision, type EngineConfig, type Transaction } from "../src/index.js";
import { contactless, remote, asRejections, label } from "./helpers.js";

const TRA: EngineConfig = { counterMode: "both", fraudRatePpm: { card: 0 } };

function summary(d: Decision): string {
  return label(d);
}

function outcomes(...groups: Transaction[][]): string[] {
  return replay(groups.flat(), TRA).steps.map((s) => summary(s.decision));
}

describe("mandated SCA beats any exemption that would otherwise fit", () => {
  it("first payment of a recurring series needs SCA even at €9.99 (Art. 14 over Art. 16)", () => {
    const first = remote(999, { payee: "gym", recurringSeriesId: "s" });
    expect(summary(evaluate(first, undefined, TRA).decision)).toBe("sca:recurring-series-created");
  });

  it("adding a trusted beneficiary needs SCA even at €1 with TRA available (Art. 13 over 16 and 18)", () => {
    const add = remote(100, { payee: "mum", addPayeeToTrusted: true, traLowRisk: true });
    expect(summary(evaluate(add, undefined, TRA).decision)).toBe("sca:trusted-beneficiary-list-change");
  });

  it("a risk signal beats a trusted beneficiary, an established series and an unattended terminal", () => {
    expect(
      outcomes([
        remote(5000, { payee: "mum", addPayeeToTrusted: true }),
        remote(5000, { payee: "mum", riskFlags: ["abnormal-spending"] }),
        remote(999, { payee: "gym", recurringSeriesId: "s" }),
        remote(999, { payee: "gym", recurringSeriesId: "s", riskFlags: ["known-fraud-scenario"] }),
        contactless(100, { unattendedTerminal: "parking-fee", riskFlags: ["abnormal-payer-location"] }),
      ]),
    ).toEqual([
      "sca:trusted-beneficiary-list-change",
      "sca:risk-signal",
      "sca:recurring-series-created",
      "sca:risk-signal",
      "sca:risk-signal",
    ]);
  });

  it("risk signal is checked before a trusted-list change, which is checked before a new series", () => {
    const both = remote(500, { payee: "p", addPayeeToTrusted: true, recurringSeriesId: "s" });
    expect(summary(evaluate(both, undefined, TRA).decision)).toBe("sca:trusted-beneficiary-list-change");
    const all = { ...both, riskFlags: ["malware"] as const };
    expect(summary(evaluate(all, undefined, TRA).decision)).toBe("sca:risk-signal");
  });

  it("changing the amount or the payee of a series is an amendment that needs SCA", () => {
    expect(
      outcomes([
        remote(999, { payee: "gym", recurringSeriesId: "s" }),
        remote(999, { payee: "gym", recurringSeriesId: "s" }),
        remote(999, { payee: "other-gym", recurringSeriesId: "s" }),
        remote(999, { payee: "other-gym", recurringSeriesId: "s" }),
        remote(1000, { payee: "other-gym", recurringSeriesId: "s" }),
      ]),
    ).toEqual([
      "sca:recurring-series-created",
      "exempt:recurring",
      "sca:recurring-series-amended",
      "exempt:recurring",
      "sca:recurring-series-amended",
    ]);
  });

  it("a failed SCA does not register the series or the trusted payee", () => {
    expect(
      outcomes([
        remote(999, { payee: "gym", recurringSeriesId: "s", scaOutcome: "failure" }),
        remote(999, { payee: "gym", recurringSeriesId: "s" }),
        remote(90000, { payee: "mum", addPayeeToTrusted: true, scaOutcome: "failure" }),
        remote(90000, { payee: "mum" }),
      ]),
    ).toEqual([
      "sca:recurring-series-created",
      "sca:recurring-series-created",
      "sca:trusted-beneficiary-list-change",
      "sca:no-exemption-applies",
    ]);
  });
});

describe("engine precedence between exemptions", () => {
  it("pins the documented order", () => {
    expect(PRECEDENCE).toEqual([
      "unattended-terminal",
      "own-account",
      "trusted-beneficiary",
      "recurring",
      "contactless",
      "low-value",
      "tra",
    ]);
  });

  it("unattended terminal wins over contactless and survives an exhausted contactless counter", () => {
    const taps = Array.from({ length: 5 }, () => contactless(100));
    const steps = outcomes(taps, [contactless(100, { unattendedTerminal: "transport-fare" }), contactless(100)]);
    expect(steps.slice(5)).toEqual(["exempt:unattended-terminal", "sca:no-exemption-applies"]);
    expect(outcomes([contactless(100, { unattendedTerminal: "parking-fee" })])).toEqual(["exempt:unattended-terminal"]);
  });

  it("trusted beneficiary wins over low-value, recurring and TRA for a payment all four could cover", () => {
    const steps = outcomes([
      remote(500, { payee: "mum", addPayeeToTrusted: true }),
      remote(500, { payee: "mum", recurringSeriesId: "s" }),
      remote(500, { payee: "mum", recurringSeriesId: "s", traLowRisk: true }),
    ]);
    expect(steps).toEqual(["sca:trusted-beneficiary-list-change", "sca:recurring-series-created", "exempt:trusted-beneficiary"]);
  });

  it("low-value wins over TRA, and TRA takes over once low-value is exhausted", () => {
    const steps = outcomes(Array.from({ length: 7 }, () => remote(2000, { traLowRisk: true })));
    expect(steps).toEqual([
      "exempt:low-value",
      "exempt:low-value",
      "exempt:low-value",
      "exempt:low-value",
      "exempt:low-value",
      "exempt:tra",
      "exempt:tra",
    ]);
  });

  it("payments under any exemption count towards the Art. 16 accumulator", () => {
    const { steps } = replay(
      [
        remote(5000, { payee: "mum", addPayeeToTrusted: true }),
        remote(9000, { payee: "mum" }),
        remote(1500),
      ],
      TRA,
    );
    expect(steps[1]?.after.remote).toEqual({ cumulativeMinor: 9000, count: 1 });
    expect(summary(steps[2]!.decision)).toBe("sca:no-exemption-applies");
    expect(asRejections(steps[2]?.decision).find((r) => r.exemption === "low-value")?.code).toBe("cumulative-amount-exceeded");
  });

  it("own-account applies to credit transfers only; unattended terminals to point-of-sale only", () => {
    const ct = remote(900000, { paymentType: "credit-transfer", ownAccountTransfer: true });
    expect(summary(evaluate(ct).decision)).toBe("exempt:own-account");
    const card = evaluate(remote(900000, { ownAccountTransfer: true })).decision;
    expect(summary(card)).toBe("sca:no-exemption-applies");
    expect(asRejections(card).find((r) => r.exemption === "own-account")?.code).toBe("not-credit-transfer");
    const online = evaluate(remote(9000, { unattendedTerminal: "parking-fee" })).decision;
    expect(asRejections(online).find((r) => r.exemption === "unattended-terminal")?.code).toBe("remote");
  });

  it("a disabled exemption is skipped and the next one in order is tried", () => {
    const cfg: EngineConfig = { ...TRA, enabledExemptions: ["tra"] };
    expect(summary(evaluate(remote(100), undefined, cfg).decision)).toBe("sca:no-exemption-applies");
    expect(summary(evaluate(remote(100, { traLowRisk: true }), undefined, cfg).decision)).toBe("exempt:tra");
    const none = evaluate(remote(100), undefined, { ...TRA, enabledExemptions: [] }).decision;
    expect(none.detail).toBe("no enabled exemption covers this payment");
  });
});

describe("input validation", () => {
  it.each([
    ["zero amount", remote(0)],
    ["fractional amount", remote(12.5)],
    ["non-EUR currency", { ...remote(100), currency: "USD" as "EUR" }],
    ["contactless credit transfer", contactless(100, { paymentType: "credit-transfer" })],
    ["recurring series without payee", remote(100, { recurringSeriesId: "s" })],
    ["trusted-list change without payee", remote(100, { addPayeeToTrusted: true })],
  ])("rejects %s", (_label, txn) => {
    expect(() => evaluate(txn)).toThrow(TypeError);
  });
});

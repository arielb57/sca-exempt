import { describe, expect, it } from "vitest";
import {
  CONTACTLESS,
  EMPTY_STATE,
  LOW_VALUE,
  etvBandFor,
  evaluate,
  instrumentState,
  replay,
  type CounterMode,
  type EngineConfig,
  type EngineState,
  type Transaction,
} from "../src/index.js";
import { FC_OPTIONS, fc } from "./helpers.js";

const txnArb: fc.Arbitrary<Transaction> = fc
  .record({
    instrument: fc.constantFrom("card-1", "card-2"),
    channel: fc.constantFrom("remote", "contactless") as fc.Arbitrary<"remote" | "contactless">,
    // Mostly small amounts, so runs long enough to hit the count and cumulative
    // limits are common; the rest probe the single-amount and ETV edges.
    amountMinor: fc.oneof(
      { arbitrary: fc.integer({ min: 1, max: 1_000 }), weight: 6 },
      { arbitrary: fc.integer({ min: 1, max: 5_500 }), weight: 2 },
      {
        arbitrary: fc.constantFrom(2_999, 3_000, 3_001, 4_999, 5_000, 5_001, 10_000, 10_001, 25_000, 50_000),
        weight: 1,
      },
      { arbitrary: fc.integer({ min: 1, max: 60_000 }), weight: 1 },
    ),
    traLowRisk: fc.boolean(),
    scaOutcome: fc.constantFrom("success", "failure") as fc.Arbitrary<"success" | "failure">,
  })
  .map((r) => ({ ...r, id: "t", currency: "EUR", paymentType: "card" }) as Transaction);

const configArb: fc.Arbitrary<EngineConfig> = fc.record({
  counterMode: fc.constantFrom<CounterMode>("amount", "count", "both"),
  fraudRatePpm: fc.oneof(
    fc.constant({}),
    fc.record({ card: fc.oneof(fc.integer({ min: 0, max: 2_000 }), fc.constantFrom(100, 101, 600, 601, 1_300, 1_301)) }),
  ),
});

/**
 * Independent oracle: recomputes each decision from the raw history instead of
 * from running accumulators, using the RTS numbers written out literally.
 */
function oracle(txns: readonly Transaction[], config: EngineConfig): string[] {
  const history: { txn: Transaction; kind: "exempt" | "sca-ok" | "sca-fail" }[] = [];
  const out: string[] = [];
  for (const txn of txns) {
    const mine = history.filter((h) => h.txn.instrument === txn.instrument);

    // Art. 4(3)(b) counts consecutive failed *authentication attempts*. An
    // exempt payment is not an attempt, so it does not break the run: only a
    // passed SCA does. Five in a row block the instrument, and nothing after
    // that is evaluated at all.
    const attempts = mine.filter((h) => h.kind !== "exempt");
    let consecutive = 0;
    for (let i = attempts.length - 1; i >= 0 && attempts[i]?.kind === "sca-fail"; i -= 1) consecutive += 1;
    if (consecutive >= 5) {
      out.push("blocked");
      continue;
    }

    const lastSca = mine.map((h) => h.kind).lastIndexOf("sca-ok");
    const since = mine.slice(lastSca + 1).filter((h) => h.kind === "exempt" && h.txn.channel === txn.channel);
    const sum = since.reduce((a, h) => a + h.txn.amountMinor, 0) + txn.amountMinor;
    const n = since.length + 1;
    const [single, cap] = txn.channel === "remote" ? [3_000, 10_000] : [5_000, 15_000];
    const amountOk = config.counterMode === "count" || sum <= cap;
    const countOk = config.counterMode === "amount" || n <= 5;

    let verdict = "sca";
    if (txn.amountMinor <= single && amountOk && countOk) {
      verdict = txn.channel === "remote" ? "exempt:low-value" : "exempt:contactless";
    } else if (txn.channel === "remote" && txn.traLowRisk && config.fraudRatePpm.card !== undefined) {
      const rate = config.fraudRatePpm.card;
      const etv = rate <= 100 ? 50_000 : rate <= 600 ? 25_000 : rate <= 1_300 ? 10_000 : 0;
      if (txn.amountMinor <= etv) verdict = "exempt:tra";
    }
    out.push(verdict);
    history.push({
      txn,
      kind: verdict !== "sca" ? "exempt" : txn.scaOutcome === "failure" ? "sca-fail" : "sca-ok",
    });
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe("stateful properties over random transaction sequences", () => {
  it("matches an oracle that recomputes every decision from raw history", () => {
    fc.assert(
      fc.property(fc.array(txnArb, { maxLength: 60, size: "max" }), configArb, (txns, config) => {
        // "blocked" is kept distinct from "sca": collapsing them would hide
        // the Art. 4(3)(b) limit from the one test that compares against an
        // independent recomputation.
        const got = replay(txns, config).steps.map((s) =>
          s.decision.outcome === "exempt"
            ? `exempt:${s.decision.exemption}`
            : s.decision.outcome === "blocked"
              ? "blocked"
              : "sca",
        );
        expect(got).toEqual(oracle(txns, config));
      }),
      FC_OPTIONS,
    );
  });

  it("counter-reset invariant: a successful SCA zeroes both accumulators of that instrument only", () => {
    fc.assert(
      fc.property(fc.array(txnArb, { maxLength: 60, size: "max" }), configArb, (txns, config) => {
        let state: EngineState = EMPTY_STATE;
        for (const txn of txns) {
          const result = evaluate(txn, state, config);
          if (result.decision.outcome === "sca-required" && result.executed) {
            const inst = result.state.instruments[txn.instrument];
            expect(inst?.remote).toEqual({ cumulativeMinor: 0, count: 0 });
            expect(inst?.contactless).toEqual({ cumulativeMinor: 0, count: 0 });
            for (const [other, before] of Object.entries(state.instruments)) {
              if (other !== txn.instrument) expect(result.state.instruments[other]).toBe(before);
            }
          }
          state = result.state;
        }
      }),
      FC_OPTIONS,
    );
  });

  it("a failed SCA leaves the accumulators alone but counts towards the attempt limit", () => {
    fc.assert(
      fc.property(fc.array(txnArb, { maxLength: 40, size: "max" }), configArb, (txns, config) => {
        let state: EngineState = EMPTY_STATE;
        for (const txn of txns) {
          const before = instrumentState(state, txn.instrument);
          const result = evaluate(txn, state, config);
          const after = instrumentState(result.state, txn.instrument);

          if (result.decision.outcome === "blocked") {
            expect(result.executed).toBe(false);
            expect(result.state).toBe(state);
          } else if (result.decision.outcome === "sca-required") {
            expect(result.executed).toBe(txn.scaOutcome !== "failure");
            if (txn.scaOutcome === "failure") {
              // Art. 4(3)(b) makes a failure count, so the state is not
              // untouched — but nothing an exemption reads may move.
              expect(after.failedAttempts).toBe(before.failedAttempts + 1);
              expect({ ...after, failedAttempts: 0 }).toEqual({ ...before, failedAttempts: 0 });
            } else {
              expect(after.failedAttempts).toBe(0);
            }
          } else {
            expect(result.executed).toBe(true);
            expect(after.failedAttempts).toBe(before.failedAttempts);
          }
          state = result.state;
        }
      }),
      FC_OPTIONS,
    );
  });

  it("an exempt payment adds exactly its amount and one count to its own channel", () => {
    fc.assert(
      fc.property(fc.array(txnArb, { maxLength: 40, size: "max" }), configArb, (txns, config) => {
        let state: EngineState = EMPTY_STATE;
        for (const txn of txns) {
          const result = evaluate(txn, state, config);
          if (result.decision.outcome === "exempt") {
            const before = state.instruments[txn.instrument];
            const after = result.state.instruments[txn.instrument];
            const other = txn.channel === "remote" ? "contactless" : "remote";
            expect(after?.[txn.channel]).toEqual({
              cumulativeMinor: (before?.[txn.channel].cumulativeMinor ?? 0) + txn.amountMinor,
              count: (before?.[txn.channel].count ?? 0) + 1,
            });
            expect(after?.[other]).toEqual(before?.[other] ?? { cumulativeMinor: 0, count: 0 });
          }
          state = result.state;
        }
      }),
      FC_OPTIONS,
    );
  });

  it("in both mode without TRA, accumulators never exceed the RTS limits", () => {
    const noTra = txnArb.map((t) => ({ ...t, traLowRisk: false }));
    fc.assert(
      fc.property(fc.array(noTra, { maxLength: 80, size: "max" }), (txns) => {
        const { steps } = replay(txns, { counterMode: "both", fraudRatePpm: {} });
        for (const { after } of steps) {
          expect(after.remote.cumulativeMinor).toBeLessThanOrEqual(LOW_VALUE.maxCumulativeMinor);
          expect(after.remote.count).toBeLessThanOrEqual(LOW_VALUE.maxConsecutiveCount);
          expect(after.contactless.cumulativeMinor).toBeLessThanOrEqual(CONTACTLESS.maxCumulativeMinor);
          expect(after.contactless.count).toBeLessThanOrEqual(CONTACTLESS.maxConsecutiveCount);
        }
      }),
      FC_OPTIONS,
    );
  });

  it("is pure: frozen inputs are never mutated and replays are deterministic", () => {
    fc.assert(
      fc.property(fc.array(txnArb, { maxLength: 40, size: "max" }), configArb, (txns, config) => {
        let state: EngineState = EMPTY_STATE;
        for (const txn of txns) {
          const snapshot = JSON.stringify(state);
          const result = evaluate(deepFreeze({ ...txn }), deepFreeze(state), deepFreeze({ ...config }));
          expect(JSON.stringify(state)).toBe(snapshot);
          state = result.state;
        }
        expect(replay(txns, config)).toEqual(replay(txns, config));
      }),
      FC_OPTIONS,
    );
  });
});

describe("ETV band monotonicity", () => {
  const etv = (type: "card" | "credit-transfer", rate: number) => etvBandFor(type, rate)?.etvMinor ?? 0;

  it("a higher fraud rate never yields a higher exemption threshold", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"card" | "credit-transfer">("card", "credit-transfer"),
        fc.integer({ min: 0, max: 5_000 }),
        fc.integer({ min: 0, max: 5_000 }),
        (type, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          expect(etv(type, hi)).toBeLessThanOrEqual(etv(type, lo));
        },
      ),
      FC_OPTIONS,
    );
  });

  it("if TRA exempts a payment at some fraud rate, it exempts it at every lower rate", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3_001, max: 60_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: 0, max: 2_000 }),
        (amountMinor, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const txn: Transaction = {
            id: "m",
            instrument: "c",
            amountMinor,
            currency: "EUR",
            channel: "remote",
            paymentType: "card",
            traLowRisk: true,
          };
          const at = (card: number) => evaluate(txn, EMPTY_STATE, { counterMode: "both", fraudRatePpm: { card } });
          if (at(hi).decision.outcome === "exempt") expect(at(lo).decision.outcome).toBe("exempt");
        },
      ),
      FC_OPTIONS,
    );
  });

  it("band edges sit exactly on the Annex reference rates", () => {
    expect([0, 100, 101, 600, 601, 1_300, 1_301].map((r) => etv("card", r))).toEqual([
      50_000, 50_000, 25_000, 25_000, 10_000, 10_000, 0,
    ]);
    expect([0, 50, 51, 100, 101, 150, 151].map((r) => etv("credit-transfer", r))).toEqual([
      50_000, 50_000, 25_000, 25_000, 10_000, 10_000, 0,
    ]);
    expect(() => etvBandFor("card", -1)).toThrow(RangeError);
    expect(() => etvBandFor("card", 0.5)).toThrow(RangeError);
  });
});

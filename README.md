# sca-exempt

A PSD2 Strong Customer Authentication exemption engine that says when SCA can be skipped, and why.

## The problem

Under PSD2, every electronic payment needs Strong Customer Authentication unless one of the exemptions in the Regulatory Technical Standards (Commission Delegated Regulation (EU) 2018/389) applies. Card issuers, acquirers and open-banking initiators each end up coding those rules themselves. The thresholds are easy to copy. The stateful part is where implementations quietly diverge: the cumulative-amount and consecutive-count accumulators, what resets them, whether €30.00 is inside the low-value limit, and which exemption to report when two fit. Getting this wrong in the permissive direction is a regulatory breach and a fraud liability, and most implementations cannot explain a decision after the fact.

`sca-exempt` is a small, dependency-free TypeScript library and CLI that makes this decision as a pure function. For every decision it returns the RTS article it relied on and the exact comparison behind it.

## How it works

The core is one deterministic function:

```
evaluate(transaction, state, config) -> { decision, executed, state' }
```

- **`transaction`**: amount in integer euro cents, instrument id, channel (`remote` or `contactless`), payment type (`card` or `credit-transfer`), and optional facts: payee, recurring series id, trusted-beneficiary change, unattended transport/parking terminal, own-account transfer, the PSP's low-risk classification, risk flags, and what happens if SCA is requested (`scaOutcome`, which defaults to `success`).
- **`state`**: an immutable map from instrument to `{ remote, contactless, trustedPayees, recurringSeries }`. `remote` and `contactless` are both accumulators of the form `{ cumulativeMinor, count }`.
- **`config`**: counter mode (`amount`, `count` or `both`), the PSP's rolling fraud rate per payment type in parts per million, and optionally which exemptions the PSP has enabled.

### The decision, in order

1. **Mandated SCA.** These are checked first and win over any exemption:
   - a transaction-monitoring risk flag (Art. 2, Art. 18(2)(c)(i)-(vi));
   - adding a payee to the trusted-beneficiary list (Art. 13);
   - the first payment of a recurring series, or a change to its amount or payee (Art. 14).
2. **Exemptions.** They are tried in this fixed order, and the first one that applies wins:

   | # | Exemption | Article | Condition |
   |---|---|---|---|
   | 1 | `unattended-terminal` | Art. 12 | point-of-sale transport-fare or parking terminal |
   | 2 | `own-account` | Art. 15 | credit transfer between the payer's own accounts |
   | 3 | `trusted-beneficiary` | Art. 13 | payee already added to the list under SCA |
   | 4 | `recurring` | Art. 14 | registered series, same amount, same payee |
   | 5 | `contactless` | Art. 11 | ≤ €50; cumulative ≤ €150 and/or ≤ 5 payments since last SCA |
   | 6 | `low-value` | Art. 16 | remote, ≤ €30; cumulative ≤ €100 and/or ≤ 5 payments since last SCA |
   | 7 | `tra` | Art. 18 | remote, classified low risk, amount ≤ ETV for the PSP's fraud rate |

3. If nothing applies, SCA is required (`no-exemption-applies`). The detail lists every exemption that was in scope and the comparison that ruled it out.

### The state machine

Each instrument has two accumulators, one per channel.

```
exempt payment on channel C   ->  C.cumulative += amount, C.count += 1
SCA requested and passed      ->  remote := 0/0, contactless := 0/0
                                  (register trusted payee / recurring series if requested)
SCA requested and failed      ->  state unchanged, payment not executed
```

A payment exempted under *any* exemption adds to its channel's accumulator. The RTS counts "previous remote transactions since the last application of SCA", not previous low-value ones. For example, a €900 payment to a trusted beneficiary uses up the €100 low-value allowance.

### ETV bands (Art. 18, Annex)

Rates are stored as integer ppm (0.13% = 1300). The engine picks the most permissive band whose reference rate is at or above the PSP's rate ("equivalent to or below"):

| ETV | Card reference rate | Credit-transfer reference rate |
|---|---|---|
| €500 | 0.01% | 0.005% |
| €250 | 0.06% | 0.01% |
| €100 | 0.13% | 0.015% |
| none | above 0.13% | above 0.015% |

All thresholds live in `src/rules.ts` with their article citations. No floating-point value ever reaches a money or rate comparison: amounts are integer cents, and percentages are parsed by shifting the decimal point in the string.

## Install and usage

Requires Node.js 20 or later.

```sh
git clone <this repository> sca-exempt && cd sca-exempt
npm ci
npm test
npm run build
```

### CLI

The CLI reads a JSONL file (or stdin with `-`), with one transaction per line. Lines starting with `#` are skipped.

```sh
node dist/cli.js replay examples/quickstart.jsonl --card-fraud-rate 0.05%
```

```
t1 card-9 €25.00 remote: EXEMPT low-value (RTS Art. 16) €25.00 <= €30.00, cumulative €25.00 <= €100.00, count 1 <= 5 | remote €25.00/1 contactless €0.00/0
t2 card-9 €30.00 remote: EXEMPT low-value (RTS Art. 16) €30.00 <= €30.00, cumulative €55.00 <= €100.00, count 2 <= 5 | remote €55.00/2 contactless €0.00/0
t3 card-9 €30.01 remote: SCA no-exemption-applies (PSD2 Art. 97(1), RTS Art. 4) €30.01 > low-value limit €30.00; risk analysis did not classify the payment as low risk | remote €0.00/0 contactless €0.00/0
t4 card-9 €180.00 remote: EXEMPT tra (RTS Art. 18) low risk, €180.00 <= ETV €250.00 at fraud rate 0.05% | remote €180.00/1 contactless €0.00/0
t5 card-9 €9.99 remote: SCA recurring-series-created (RTS Art. 14) first payment of recurring series sub-1 requires SCA | remote €0.00/0 contactless €0.00/0
t6 card-9 €9.99 remote: EXEMPT recurring (RTS Art. 14) recurring series sub-1: same amount, same payee | remote €9.99/1 contactless €0.00/0
-- 6 payments: 4 exempt, 2 authenticated with SCA, 0 failed SCA
```

Each line shows the decision, the article it relied on, the comparison behind it, and the instrument's accumulators afterwards (cumulative/count).

Options:

```
--card-fraud-rate <pct>   PSP's rolling card fraud rate, e.g. 0.05%   (enables TRA for cards)
--ct-fraud-rate <pct>     PSP's rolling credit-transfer fraud rate     (enables TRA for transfers)
--counter-mode <mode>     amount | count | both (default both)
--json                    emit one JSON object per decision instead of text
```

```sh
node dist/cli.js replay examples/quickstart.jsonl --json | head -1
```

```
{"id":"t1","instrument":"card-9","outcome":"exempt","exemption":"low-value","article":"RTS Art. 16","detail":"€25.00 <= €30.00, cumulative €25.00 <= €100.00, count 1 <= 5","executed":true,"state":{"remote":{"cumulativeMinor":2500,"count":1},"contactless":{"cumulativeMinor":0,"count":0}}}
```

`examples/golden.jsonl` contains 40 hand-built transactions that cross every boundary and every reset condition. Run it with `node dist/cli.js replay examples/golden.jsonl --card-fraud-rate 0.05%`. The last line is `-- 40 payments: 26 exempt, 13 authenticated with SCA, 1 failed SCA`.

Exit codes: `0` success, `1` bad input (the error names the line number), `2` bad usage. The parser rejects unknown fields instead of ignoring them. Otherwise a misspelt `"riskFlag"` would be silently dropped and turn a mandated SCA into an exemption.

Transaction fields:

| Field | Type | Required |
|---|---|---|
| `id`, `instrument` | string | yes |
| `amountMinor` | positive integer, euro cents | yes |
| `currency` | `"EUR"` | yes |
| `channel` | `"remote"` \| `"contactless"` | yes |
| `paymentType` | `"card"` \| `"credit-transfer"` | yes |
| `payee` | string | for series and trusted payees |
| `recurringSeriesId` | string | no |
| `addPayeeToTrusted`, `ownAccountTransfer`, `traLowRisk` | boolean | no |
| `unattendedTerminal` | `"transport-fare"` \| `"parking-fee"` | no |
| `riskFlags` | array of `abnormal-spending`, `unusual-device-or-software`, `malware`, `known-fraud-scenario`, `abnormal-payer-location`, `high-risk-payee-location` | no |
| `scaOutcome` | `"success"` \| `"failure"` | no (default `success`) |

### Library

```ts
import { evaluate, replay, EMPTY_STATE } from "sca-exempt";

const config = { counterMode: "both", fraudRatePpm: { card: 500 } } as const; // 0.05%
const txn = { id: "t1", instrument: "card-9", amountMinor: 2500, currency: "EUR", channel: "remote", paymentType: "card" } as const;

const { decision, executed, state } = evaluate(txn, EMPTY_STATE, config);
// decision.outcome === "exempt", decision.exemption === "low-value", decision.article === "RTS Art. 16"
// executed === true, state.instruments["card-9"].remote → { cumulativeMinor: 2500, count: 1 }

const { steps, state: finalState } = replay([txn /* , ... */], config);
```

Store `state` between calls; the engine keeps nothing internally.

## Results

The engine makes no performance claim, so there is no benchmark. Correctness is backed by 93 tests (`npm test`, about 1 second):

- **Counter-reset invariant (property, fast-check):** over random multi-instrument sequences, every successful SCA zeroes both accumulators of that instrument and leaves other instruments untouched. A failed SCA returns the identical state object.
- **Oracle model (property):** a second implementation recomputes every decision from the raw history instead of running counters, with the RTS numbers written out literally. It must agree with the engine on every step, in all three counter modes, with and without TRA.
- **Accumulator bounds, purity and determinism (property):** in `both` mode without TRA, the accumulators never exceed the RTS limits. Deep-frozen inputs are never mutated, and replaying the same sequence twice gives identical results.
- **Boundary tables:** €29.99/€30.00/€30.01, €90 + €9.99/€10.00/€10.01, 5th vs 6th payment for both channels, €49.99/€50.00/€50.01 single tap, €150 contactless cap, and every ETV band edge at the exact Annex rates for cards and credit transfers.
- **ETV monotonicity (property):** a higher fraud rate never yields a higher ETV. If TRA exempts a payment at some rate, it also exempts it at every lower rate.
- **Precedence:** mandated SCA beats low-value, TRA, trusted beneficiary, recurring and unattended terminal. Trusted beneficiary beats recurring, low-value and TRA. Low-value is used before TRA, and TRA takes over once low-value is exhausted.
- **Golden replay:** `examples/golden.jsonl` is checked line by line against a hand-worked table of the decision and all four accumulator values.

The suite has been checked against deliberate bugs. Off-by-one on the consecutive count is caught by the oracle, bounds and boundary tests. Resetting only the SCA'd channel is caught by the reset-invariant, oracle and golden tests.

## Design notes

**Resolving the ambiguous RTS readings in the strict direction.** Several clauses can be read two ways, and the engine picks the reading that requires SCA more often, because a wrong "exempt" costs far more than an unnecessary challenge:

- **Thresholds:** "does not exceed EUR 30" is read as inclusive, so €30.00 is exempt and €30.01 is not. That is what the article says, although many summaries write "< €30".
- **Cumulative amount:** it includes the new payment.
- **Count limit:** "does not exceed five consecutive transactions" means the 6th payment since the last SCA is challenged.
- **Accumulators:** every payment executed without SCA adds to them, whatever exemption was used.
- **Reset:** a successful SCA on either channel resets both, because the RTS resets on "the last application of strong customer authentication" without qualifying the channel.
- **Risk flags:** a flag from transaction monitoring overrides every exemption, not only TRA.

Each choice is one line in `src/engine.ts` and is pinned by a test, so a PSP whose legal reading differs changes it deliberately rather than by accident.

**Precedence is a policy, not a regulation.** The RTS ranks mandated SCA above exemptions but does not rank exemptions against each other. Because every exempt payment consumes the same accumulator, the choice does not change *whether* a payment is exempt, only *which* exemption is reported. That still matters for Art. 21 reporting and Art. 20 TRA monitoring. The engine reports exemptions with no amount ceiling first and TRA last, so TRA volume, which is audited against the reference fraud rate, only holds payments nothing else covered. The order is a single exported constant (`PRECEDENCE`), and a test pins it.

## Limitations

- **EUR only.** Payments in other currencies are rejected rather than converted, since the RTS limits are in euros and conversion is a policy decision.
- **Rates are inputs.** The engine does not compute the Art. 19 rolling fraud rate or do the real-time risk analysis. It takes the rate and a `traLowRisk` classification from the PSP.
- **No per-actor liability model.** It does not model who applies the exemption (issuer or acquirer), liability shift, merchant-initiated transactions, one-leg-out transactions, or corporate payments (Art. 17).
- **No blocking after failed attempts.** It does not track Art. 4(3)(d) failed-authentication blocking or Art. 4(3)(e) session timeouts. A failed SCA simply declines that payment.
- **Art. 10 not covered.** Account-information access is out of scope.
- **Trusted payees are never removed.** There is no event for removing a payee or cancelling a recurring series.
- **Time is not modelled.** Payments are processed in stream order, and there is no timestamp-based reset.
- **Not legal advice.** The interpretations in *Design notes* are defensible, strict readings, and national competent authorities or scheme rules may differ.

## License

MIT. See [LICENSE](LICENSE).

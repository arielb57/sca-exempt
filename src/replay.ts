import { DEFAULT_CONFIG, EMPTY_STATE, evaluate, instrumentState } from "./engine.js";
import type { Decision, EngineConfig, EngineState, InstrumentState, Transaction } from "./types.js";

export interface ReplayStep {
  readonly txn: Transaction;
  readonly decision: Decision;
  readonly executed: boolean;
  /** The transaction's instrument state after the step. */
  readonly after: InstrumentState;
}

export interface ReplayResult {
  readonly steps: readonly ReplayStep[];
  readonly state: EngineState;
}

/** Folds evaluate() over a transaction sequence in order. */
export function replay(
  txns: Iterable<Transaction>,
  config: EngineConfig = DEFAULT_CONFIG,
  initial: EngineState = EMPTY_STATE,
): ReplayResult {
  const steps: ReplayStep[] = [];
  let state = initial;
  for (const txn of txns) {
    const result = evaluate(txn, state, config);
    state = result.state;
    steps.push({
      txn,
      decision: result.decision,
      executed: result.executed,
      after: instrumentState(state, txn.instrument),
    });
  }
  return { steps, state };
}

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { EMPTY_STATE, evaluate } from "./engine.js";
import { formatEur, parsePercentToPpm } from "./money.js";
import { InputError, parseTransaction } from "./parse.js";
import type { PaymentType } from "./rules.js";
import type { CounterMode, EngineConfig, EngineState, InstrumentState } from "./types.js";

export interface CliIo {
  readonly stdin: Readable;
  readonly stdout: { write(chunk: string): unknown };
  readonly stderr: { write(chunk: string): unknown };
}

const USAGE = `Usage: sca-exempt replay [file.jsonl | -] [options]

Replays a JSONL stream of transactions (one JSON object per line) through the
PSD2 SCA exemption engine and prints one decision per line.

Options:
  --card-fraud-rate <pct>   PSP's rolling card fraud rate, e.g. 0.05%   (enables TRA for cards)
  --ct-fraud-rate <pct>     PSP's rolling credit-transfer fraud rate     (enables TRA for transfers)
  --counter-mode <mode>     amount | count | both (default both)
  --json                    emit one JSON object per decision instead of text
  -h, --help                show this help
`;

interface Options {
  readonly file: string;
  readonly json: boolean;
  readonly config: EngineConfig;
}

function parseArgs(argv: readonly string[]): Options | "help" {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") return "help";
  if (command !== "replay") throw new InputError(`unknown command "${command}"`);

  let file = "-";
  let json = false;
  let counterMode: CounterMode = "both";
  const fraudRatePpm: Partial<Record<PaymentType, number>> = {};
  let positional = 0;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    const value = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new InputError(`${arg} needs a value`);
      return v;
    };
    if (arg === "-h" || arg === "--help") return "help";
    else if (arg === "--json") json = true;
    else if (arg === "--card-fraud-rate") fraudRatePpm.card = parsePercentToPpm(value());
    else if (arg === "--ct-fraud-rate") fraudRatePpm["credit-transfer"] = parsePercentToPpm(value());
    else if (arg === "--counter-mode") {
      const v = value();
      if (v !== "amount" && v !== "count" && v !== "both") throw new InputError(`--counter-mode must be amount, count or both`);
      counterMode = v;
    } else if (arg.startsWith("-") && arg !== "-") throw new InputError(`unknown option ${arg}`);
    else {
      if (positional++ > 0) throw new InputError(`unexpected argument ${arg}`);
      file = arg;
    }
  }
  return { file, json, config: { counterMode, fraudRatePpm } };
}

function counters(inst: InstrumentState): string {
  return `remote ${formatEur(inst.remote.cumulativeMinor)}/${String(inst.remote.count)} contactless ${formatEur(inst.contactless.cumulativeMinor)}/${String(inst.contactless.count)}`;
}

/** Runs the CLI and resolves with the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let options: Options | "help";
  try {
    options = parseArgs(argv);
  } catch (e) {
    io.stderr.write(`error: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options === "help") {
    io.stdout.write(USAGE);
    return 0;
  }

  const input = options.file === "-" ? io.stdin : createReadStream(options.file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let state: EngineState = EMPTY_STATE;
  let lineNo = 0;
  const tally = { exempt: 0, sca: 0, failed: 0 };

  try {
    for await (const raw of lines) {
      lineNo++;
      const line = raw.trim();
      if (line === "" || line.startsWith("#")) continue;
      let decoded: unknown;
      try {
        decoded = JSON.parse(line);
      } catch {
        throw new InputError("invalid JSON");
      }
      const txn = parseTransaction(decoded);
      const result = evaluate(txn, state, options.config);
      state = result.state;
      const d = result.decision;
      const inst = state.instruments[txn.instrument];
      if (d.outcome === "exempt") tally.exempt++;
      else if (result.executed) tally.sca++;
      else tally.failed++;

      if (options.json) {
        io.stdout.write(
          `${JSON.stringify({
            id: txn.id,
            instrument: txn.instrument,
            outcome: d.outcome,
            ...(d.outcome === "exempt" ? { exemption: d.exemption } : { reason: d.reason }),
            article: d.article,
            detail: d.detail,
            executed: result.executed,
            state: inst ? { remote: inst.remote, contactless: inst.contactless } : undefined,
          })}\n`,
        );
      } else {
        const label =
          d.outcome === "exempt" ? `EXEMPT ${d.exemption}` : `${result.executed ? "SCA" : "SCA-FAILED"} ${d.reason}`;
        const tail = inst ? ` | ${counters(inst)}` : "";
        io.stdout.write(
          `${txn.id} ${txn.instrument} ${formatEur(txn.amountMinor)} ${txn.channel}: ${label} (${d.article}) ${d.detail}${tail}\n`,
        );
      }
    }
  } catch (e) {
    if (e instanceof InputError || e instanceof TypeError) {
      io.stderr.write(`error: line ${String(lineNo)}: ${e.message}\n`);
      return 1;
    }
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      io.stderr.write(`error: cannot read ${options.file}\n`);
      return 1;
    }
    throw e;
  }

  if (!options.json) {
    const total = tally.exempt + tally.sca + tally.failed;
    io.stdout.write(
      `-- ${String(total)} payments: ${String(tally.exempt)} exempt, ${String(tally.sca)} authenticated with SCA, ${String(tally.failed)} failed SCA\n`,
    );
  }
  return 0;
}

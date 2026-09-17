import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTransaction, replay } from "../src/index.js";
import { runCli } from "../src/run-cli.js";

const GOLDEN = fileURLToPath(new URL("../examples/golden.jsonl", import.meta.url));

/**
 * Expected result for every line of examples/golden.jsonl, worked out by hand
 * from the RTS with a card fraud rate of 0.05% (ETV band EUR 250):
 * [id, decision, remote cents, remote count, contactless cents, contactless count]
 */
const EXPECTED: [string, string, number, number, number, number][] = [
  ["g01", "exempt:low-value", 1000, 1, 0, 0],
  ["g02", "exempt:low-value", 3000, 2, 0, 0],
  ["g03", "exempt:low-value", 6000, 3, 0, 0], // EUR 30.00 does not exceed EUR 30
  ["g04", "sca:no-exemption-applies", 0, 0, 0, 0], // EUR 30.01; reset
  ["g05", "exempt:low-value", 2999, 1, 0, 0],
  ["g06", "exempt:low-value", 5998, 2, 0, 0],
  ["g07", "exempt:low-value", 8997, 3, 0, 0],
  ["g08", "exempt:low-value", 10000, 4, 0, 0], // cumulative exactly EUR 100
  ["g09", "sca-failed:no-exemption-applies", 10000, 4, 0, 0], // failed SCA: no reset
  ["g10", "sca:no-exemption-applies", 0, 0, 0, 0],
  ["g11", "exempt:low-value", 100, 1, 0, 0],
  ["g12", "exempt:low-value", 200, 2, 0, 0],
  ["g13", "exempt:low-value", 300, 3, 0, 0],
  ["g14", "exempt:low-value", 400, 4, 0, 0],
  ["g15", "exempt:low-value", 500, 5, 0, 0], // 5th consecutive
  ["g16", "sca:no-exemption-applies", 0, 0, 0, 0], // 6th consecutive
  ["g17", "exempt:contactless", 0, 0, 5000, 1], // EUR 50.00 does not exceed EUR 50
  ["g18", "sca:no-exemption-applies", 0, 0, 0, 0],
  ["g19", "exempt:contactless", 0, 0, 4500, 1],
  ["g20", "exempt:contactless", 0, 0, 9000, 2],
  ["g21", "exempt:contactless", 0, 0, 13500, 3],
  ["g22", "exempt:contactless", 0, 0, 15000, 4], // cumulative exactly EUR 150
  ["g23", "sca:no-exemption-applies", 0, 0, 0, 0], // EUR 150.01
  ["g24", "exempt:low-value", 2000, 1, 0, 0],
  ["g25", "exempt:contactless", 2000, 1, 2000, 1],
  ["g26", "exempt:tra", 22000, 2, 2000, 1], // EUR 200 <= ETV 250, counts towards Art. 16
  ["g27", "sca:no-exemption-applies", 0, 0, 0, 0], // remote SCA also clears contactless
  ["g28", "sca:no-exemption-applies", 0, 0, 0, 0], // EUR 260 > ETV 250
  ["g29", "sca:trusted-beneficiary-list-change", 0, 0, 0, 0],
  ["g30", "exempt:trusted-beneficiary", 90000, 1, 0, 0],
  ["g31", "sca:no-exemption-applies", 0, 0, 0, 0],
  ["g32", "sca:recurring-series-created", 0, 0, 0, 0],
  ["g33", "exempt:recurring", 999, 1, 0, 0],
  ["g34", "sca:recurring-series-amended", 0, 0, 0, 0],
  ["g35", "exempt:recurring", 1299, 1, 0, 0],
  ["g36", "sca:risk-signal", 0, 0, 0, 0],
  ["g37", "exempt:unattended-terminal", 0, 0, 8000, 1],
  ["g38", "exempt:own-account", 500000, 1, 0, 0],
  ["g39", "sca:no-exemption-applies", 0, 0, 0, 0],
  ["g40", "exempt:low-value", 2500, 1, 0, 0],
];

function goldenTransactions() {
  return readFileSync(GOLDEN, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => parseTransaction(JSON.parse(l)));
}

function sink() {
  let text = "";
  return { write: (s: string) => (text += s), get text() { return text; } };
}

describe("golden replay", () => {
  it("reproduces the hand-worked decision and accumulators for every line", () => {
    const { steps } = replay(goldenTransactions(), { counterMode: "both", fraudRatePpm: { card: 500 } });
    const actual = steps.map((s): [string, string, number, number, number, number] => [
      s.txn.id,
      s.decision.outcome === "exempt"
        ? `exempt:${s.decision.exemption}`
        : s.decision.outcome === "blocked"
          ? "blocked"
          : `${s.executed ? "sca" : "sca-failed"}:${s.decision.reason}`,
      s.after.remote.cumulativeMinor,
      s.after.remote.count,
      s.after.contactless.cumulativeMinor,
      s.after.contactless.count,
    ]);
    expect(actual).toEqual(EXPECTED);
  });

  it("the sequence crosses every reset condition the engine has", () => {
    const decisions = new Set(EXPECTED.map((e) => e[1]));
    for (const d of [
      "sca:no-exemption-applies",
      "sca-failed:no-exemption-applies",
      "sca:trusted-beneficiary-list-change",
      "sca:recurring-series-created",
      "sca:recurring-series-amended",
      "sca:risk-signal",
    ]) {
      expect(decisions).toContain(d);
    }
  });
});

describe("CLI", () => {
  it("prints one decision per transaction and a summary", async () => {
    const out = sink();
    const err = sink();
    const code = await runCli(["replay", GOLDEN, "--card-fraud-rate", "0.05%"], {
      stdin: Readable.from([]),
      stdout: out,
      stderr: err,
    });
    expect(code).toBe(0);
    expect(err.text).toBe("");
    const lines = out.text.trimEnd().split("\n");
    expect(lines).toHaveLength(41);
    expect(lines[2]).toBe(
      "g03 card-A €30.00 remote: EXEMPT low-value (RTS Art. 16) €30.00 <= €30.00, cumulative €60.00 <= €100.00, count 3 <= 5 | remote €60.00/3 contactless €0.00/0",
    );
    expect(lines[8]).toContain("g09 card-A €1.00 remote: SCA-FAILED no-exemption-applies");
    expect(lines[8]).toContain("low-value cumulative €101.00 since last SCA > €100.00");
    expect(lines[25]).toContain("EXEMPT tra (RTS Art. 18) low risk, €200.00 <= ETV €250.00 at fraud rate 0.05%");
    expect(lines[40]).toBe("-- 40 payments: 26 exempt, 13 authenticated with SCA, 1 failed SCA");
  });

  it("reads stdin and emits JSON with --json; the fraud-rate flag changes the ETV band", async () => {
    const txn = '{"id":"x","instrument":"c","amountMinor":40000,"currency":"EUR","channel":"remote","paymentType":"card","traLowRisk":true}\n';
    const run = async (rate: string) => {
      const out = sink();
      const code = await runCli(["replay", "--json", "--card-fraud-rate", rate], {
        stdin: Readable.from([txn]),
        stdout: out,
        stderr: sink(),
      });
      expect(code).toBe(0);
      return JSON.parse(out.text) as Record<string, unknown>;
    };
    expect(await run("0.01%")).toMatchObject({ outcome: "exempt", exemption: "tra", executed: true });
    expect(await run("0.02%")).toMatchObject({ outcome: "sca-required", reason: "no-exemption-applies" });
  });

  it.each([
    ['{"id":"a"', "line 1: invalid JSON"],
    ['{"id":"a","instrument":"c","amountMinor":1,"currency":"EUR","channel":"remote","paymentType":"card","riskFlag":["malware"]}', 'line 1: unknown field "riskFlag"'],
    ['{"id":"a","instrument":"c","amountMinor":"10.00","currency":"EUR","channel":"remote","paymentType":"card"}', "line 1: \"amountMinor\" must be a positive integer"],
    ['{"id":"a","instrument":"c","amountMinor":1,"currency":"GBP","channel":"remote","paymentType":"card"}', 'line 1: "currency" must be one of EUR'],
    ['{"id":"a","instrument":"c","amountMinor":1,"currency":"EUR","channel":"remote","paymentType":"card","riskFlags":["bad"]}', "line 1: unknown risk flag"],
    ['{"id":"a","instrument":"c","amountMinor":1,"currency":"EUR","channel":"contactless","paymentType":"credit-transfer"}', "line 1: transaction a: contactless payments must be card payments"],
  ])("rejects bad input %s with a line-numbered error", async (line, message) => {
    const err = sink();
    const code = await runCli(["replay"], { stdin: Readable.from([`${line}\n`]), stdout: sink(), stderr: err });
    expect(code).toBe(1);
    expect(err.text).toContain(`error: ${message}`);
  });

  it("reports the line number of a bad line after good ones, and skips comments", async () => {
    const good = '{"id":"a","instrument":"c","amountMinor":1,"currency":"EUR","channel":"remote","paymentType":"card"}';
    const out = sink();
    const err = sink();
    const code = await runCli(["replay"], { stdin: Readable.from([`# header\n${good}\n\n[1]\n`]), stdout: out, stderr: err });
    expect(code).toBe(1);
    expect(out.text).toContain("a c €0.01 remote: EXEMPT low-value");
    expect(err.text).toBe("error: line 4: expected a JSON object\n");
  });

  it("exits 2 on bad usage and 1 on a missing file", async () => {
    const err = sink();
    expect(await runCli(["replay", "--counter-mode", "sometimes"], { stdin: Readable.from([]), stdout: sink(), stderr: err })).toBe(2);
    expect(err.text).toContain("--counter-mode must be amount, count or both");
    expect(await runCli(["replay", "--card-fraud-rate", "0.00001%"], { stdin: Readable.from([]), stdout: sink(), stderr: sink() })).toBe(2);
    expect(await runCli(["frobnicate"], { stdin: Readable.from([]), stdout: sink(), stderr: sink() })).toBe(2);
    const missing = sink();
    expect(await runCli(["replay", "does-not-exist.jsonl"], { stdin: Readable.from([]), stdout: sink(), stderr: missing })).toBe(1);
    expect(missing.text).toBe("error: cannot read does-not-exist.jsonl\n");
    const help = sink();
    expect(await runCli(["--help"], { stdin: Readable.from([]), stdout: help, stderr: sink() })).toBe(0);
    expect(help.text).toContain("Usage: sca-exempt replay");
  });
});

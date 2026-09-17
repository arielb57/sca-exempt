import { describe, expect, it } from "vitest";
import { formatEur, formatPpm, parsePercentToPpm } from "../src/index.js";
import { FC_OPTIONS, fc } from "./helpers.js";

describe("percentages as integer ppm", () => {
  it.each([
    ["0.13%", 1300],
    ["0.06%", 600],
    ["0.01%", 100],
    ["0.015%", 150],
    ["0.005%", 50],
    ["1%", 10_000],
    ["0.0001", 1],
    [" 2.5 % ", 25_000],
  ])("%s -> %i ppm", (text, ppm) => {
    expect(parsePercentToPpm(text)).toBe(ppm);
  });

  it.each(["", "abc", "-0.1%", "0.00001%", "1e-3", "0,13%"])("rejects %j", (text) => {
    expect(() => parsePercentToPpm(text)).toThrow(RangeError);
  });

  it("round-trips through formatPpm", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (ppm) => {
        expect(parsePercentToPpm(formatPpm(ppm))).toBe(ppm);
      }),
      FC_OPTIONS,
    );
  });
});

describe("formatEur", () => {
  it.each([
    [0, "€0.00"],
    [1, "€0.01"],
    [2999, "€29.99"],
    [3000, "€30.00"],
    [123456789, "€1234567.89"],
    [-5, "-€0.05"],
  ])("%i -> %s", (minor, text) => {
    expect(formatEur(minor)).toBe(text);
  });

  it("rejects non-integers", () => {
    expect(() => formatEur(0.1)).toThrow(RangeError);
  });
});

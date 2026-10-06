import { describe, expect, it } from "vitest";
import { parseGuess, roundError, scoreRound, standings } from "../../src/modules/room/games/aproximado/aproximado.rules.js";

describe("parseGuess (the first guess is final, so ambiguity is refused, never guessed)", () => {
  it.each([
    ["74500", 0, 74500], ["74 500", 0, 74500], ["74.500", 0, 74500], ["74,500", 0, 74500], ["1,234,567", 0, 1234567], ["1.234.567", 1, 1234567],
    ["64,5", 1, 64.5], ["64.5", 1, 64.5], ["64,50", 1, 64.5], ["74.500", 1, 74.5], ["1.234,5", 1, 1234.5], ["1,234.5", 1, 1234.5], ["0,5", 1, 0.5],
    ["191", 0, 191], ["007", 0, 7],
  ])("%s at precision %i = %d", (raw, precision, value) => expect(parseGuess(raw, precision)).toBe(value));

  it.each([
    ["1.234,5", 0], ["1,234.5", 0], ["0,5", 0], ["12.5", 0], ["64,55", 1], ["1,,2", 0], ["1,,2", 1], ["1,23,456", 0], ["7 4500", 0],
    ["1e3", 0], ["-3", 0], ["+3", 0], ["abc", 0], ["", 0], ["12,", 1], [",5", 1], ["1.234.5", 1], ["99999999", 0],
    ["1234 567", 0], ["1.000 000", 0], ["64.5 000", 1], ["64,5 0", 1], ["12 34", 0],
  ])("%s at precision %i is refused", (raw, precision) => expect(parseGuess(raw, precision)).toBeNull());

  it("a broken precision is refused, never guessed", () => {
    expect(parseGuess("12", Number.NaN)).toBeNull();
    expect(parseGuess("1.234", Number.NaN)).toBeNull();
    expect(parseGuess("12", 400)).toBeNull();
  });

  it("space grouping with a decimal mark", () => {
    expect(parseGuess("1 234,5", 1)).toBe(1234.5);
    expect(parseGuess("74 500", 0)).toBe(74500);
  });
});

describe("scoreRound", () => {
  const pts = (r: ReturnType<typeof scoreRound>) => r.entries.map((e) => e.points);

  it("podium truth tables for 2, 3 and 6 seats (value 100, no exact)", () => {
    expect(pts(scoreRound([90, 120], 100, 0, "podium"))).toEqual([1, 0]);
    expect(pts(scoreRound([90, 80, 130], 100, 0, "podium"))).toEqual([2, 1, 0]);
    expect(pts(scoreRound([99, 98, 97, 96, 95, 94], 100, 0, "podium"))).toEqual([3, 2, 1, 0, 0, 0]);
  });

  it("equal distance shares the higher points; exact adds 1; no guess scores 0", () => {
    expect(pts(scoreRound([95, 105, 130], 100, 0, "podium"))).toEqual([2, 2, 0]);
    expect(pts(scoreRound([100, 101, null], 100, 0, "podium"))).toEqual([3, 1, 0]);
    expect(pts(scoreRound([100, 100], 100, 0, "closest"))).toEqual([2, 2]);
    expect(pts(scoreRound([null, null], 100, 0, "podium"))).toEqual([0, 0]);
  });

  it("decimals tie exactly (no float noise): 64.5 and 64.7 around 64.6, both inside a 0.1 exact window", () => {
    const r = scoreRound([64.5, 64.7], 64.6, 0.1, "podium", 1);
    expect(r.entries.map((e) => e.rank)).toEqual([1, 1]);
    expect(r.entries.map((e) => e.exact)).toEqual([true, true]);
    expect(pts(r)).toEqual([2, 2]);
    expect(r.entries[0].diff).toBe(0.1);
  });

  it("the exact window is rounded down to the question's precision (±0.5 on whole numbers = exact only)", () => {
    expect(scoreRound([101, 100], 100, 0.5, "podium").entries.map((e) => e.exact)).toEqual([false, true]);
    expect(scoreRound([64.7], 64.6, 0.05, "podium", 1).entries[0].exact).toBe(false);
    expect(scoreRound([64.6], 64.6, 0.05, "podium", 1).entries[0].exact).toBe(true);
  });
});

describe("standings", () => {
  it("skipping never beats answering: a wild guess and no answer cost the same error", () => {
    const r = scoreRound([101, 102, 103, 104, 1000, null], 100, 0, "podium");
    expect(roundError(r.entries[4].diff, 100)).toBe(1);
    expect(roundError(null, 100)).toBe(1);
    const table = standings(6, [r]);
    const place = (seat: number) => table.find((s) => s.seat === seat)!.place;
    expect(place(4)).toBe(place(5));
  });

  it("the error is unit-free: the same misses in €M and €k give the same order", () => {
    const m = [scoreRound([60, 70], 64.5, 0, "podium", 1), scoreRound([30, 45], 40, 0, "podium", 1)];
    const k = [scoreRound([60_000, 70_000], 64_500, 0, "podium"), scoreRound([30_000, 45_000], 40_000, 0, "podium")];
    expect(standings(2, m).map((s) => s.seat)).toEqual(standings(2, k).map((s) => s.seat));
  });

  it("withdrawn seats rank below every seat still in, and equal rows share a place", () => {
    const r = scoreRound([90, 90, 50], 100, 0, "podium");
    const table = standings(3, [r], new Set([0]));
    expect(table.map((s) => s.seat)).toEqual([1, 2, 0]);
    const tied = standings(2, [scoreRound([95, 105], 100, 0, "podium")]);
    expect(tied.map((s) => s.place)).toEqual([1, 1]);
  });
});

import { describe, expect, it } from "vitest";
import { guess, newState, open, orderOf, publicState, score, secs, type RunState } from "../../src/modules/conexiones/conexiones.rules.js";
import type { CxBoard } from "../../src/modules/room/games/conexiones/conexiones.rules.js";

// Invented players and links only (the repo is public).
const L = (s: string) => ({ en: s, es: s, ka: s, tr: s, ru: s });
const tid = (i: number) => `tile${String(i).padStart(2, "0")}ab`;
const board: CxBoard = {
  id: "test-day",
  difficulty: "medium",
  tiles: Array.from({ length: 16 }, (_, i) => ({ id: tid(i), player: `p-${i}`, name: { en: `Invented ${i}`, ka: `ka ${i}`, ru: `ru ${i}` }, portrait: null })),
  groups: [0, 1, 2, 3].map((g) => ({
    id: `g-${g}`, tier: (g + 1) as 1 | 2 | 3 | 4, key: `club:invented-${g}`,
    link: L(`Link ${g}`), decoys: [1, 2, 3].map((d) => L(`Decoy ${g}-${d}`)), members: [0, 1, 2, 3].map((m) => tid(g * 4 + m)),
  })),
};
const group = (g: number) => [0, 1, 2, 3].map((m) => tid(g * 4 + m));
/** Wrong fours that leave group 1 alone (at most two tiles of any group). */
const MISSES = [[0, 8, 12, 13], [0, 8, 12, 14], [0, 8, 12, 15], [0, 8, 13, 14]].map((xs) => xs.map(tid));
const miss = (k: number) => MISSES[k];
const T = 1_700_000_000_000;
const opened = (): RunState => open(newState(), T);
const show = (s: RunState, disclose = false) => publicState(s, "2026-11-01", { board }, T, { ranked: true, disclose });

describe("conexiones daily", () => {
  it("shows no tile before the board is opened, and refuses a guess", () => {
    const s = newState();
    expect(show(s).tiles).toEqual([]);
    expect(() => guess(s, board, group(0), T)).toThrow();
    expect(show(opened()).tiles).toHaveLength(16);
  });

  it("a run's order is its own and the same on every read", () => {
    const s = opened();
    expect(orderOf(board, s.seed)).toEqual(orderOf(board, s.seed));
    expect(show(s).tiles.map((t) => t.id)).toEqual(orderOf(board, s.seed));
    expect([...orderOf(board, s.seed)].sort()).toEqual(board.tiles.map((t) => t.id).sort());
  });

  it("a hit locks the group and takes its tiles off; a repeat is refused and costs nothing", () => {
    let s = guess(opened(), board, group(1), T + 1_000);
    expect(show(s).groups.map((g) => g.id)).toEqual(["g-1"]);
    expect(show(s).tiles).toHaveLength(16);
    s = guess(s, board, miss(1), T + 2_000);
    expect(s.mistakes).toBe(1);
    expect(() => guess(s, board, [...miss(1)].reverse(), T + 3_000)).toThrow(/repeat/);
    expect(() => guess(s, board, [tid(4), tid(0), tid(8), tid(12)], T + 3_000)).toThrow(/bad_tiles/);
    expect(() => guess(s, board, [tid(0), tid(0), tid(4), tid(12)], T + 3_000)).toThrow(/bad_tiles/);
  });

  it("never shows an unsolved group or the tiers of a try while the run is on", () => {
    const s = guess(guess(opened(), board, group(1), T + 1_000), board, miss(0), T + 2_000);
    const json = JSON.stringify(show(s, true));
    for (const g of [0, 2, 3]) {
      expect(json).not.toContain(`Link ${g}`);
      expect(json).not.toContain(`g-${g}`);
    }
    expect(show(s).tiers).toBeNull();
  });

  it("the fourth mistake ends the run; the missed groups and their tiles' tiers wait for the day to close", () => {
    let s = guess(opened(), board, group(1), T + 1_000);
    for (let k = 0; k < 4; k++) s = guess(s, board, miss(k), T + 2_000 + k);
    expect(s).toMatchObject({ done: true, mistakes: 4, t1: T + 2_003 });
    const today = show(s);
    expect(today.groups.map((g) => [g.id, g.missed])).toEqual([["g-1", false]]);
    expect(today.disclosed).toBe(false);
    // The found group's tiers show (the share grid); the rest would sort the remaining tiles into their groups.
    expect(today.tiers).toEqual([[2, 2, 2, 2], ...MISSES.map((xs) => xs.map(() => null))]);
    const json = JSON.stringify(today);
    for (const g of [0, 2, 3]) {
      expect(json).not.toContain(`Link ${g}`);
      expect(json).not.toContain(`g-${g}`);
    }
    const v = show(s, true);
    expect(v.groups.map((g) => [g.id, g.missed])).toEqual([["g-1", false], ["g-0", true], ["g-2", true], ["g-3", true]]);
    expect(v.tiers).toEqual([[2, 2, 2, 2], ...MISSES.map((xs) => xs.map((id) => Math.floor(Number(id.slice(4, 6)) / 4) + 1))]);
    expect(score(s)).toBe(1);
    expect(v.found).toBe(1);
    expect(publicState(s, "2026-11-01", null, T, { ranked: false, disclose: false })).toMatchObject({ found: 1, groups: [] });
    expect(() => guess(s, board, group(0), T + 9_000)).toThrow(/run_done/);
  });

  it("scores groups first, then mistakes left; seconds from opening to the last guess", () => {
    let s = guess(opened(), board, miss(0), T + 5_000);
    for (const g of [0, 1, 2, 3]) s = guess(s, board, group(g), T + 61_400);
    expect(s.done).toBe(true);
    expect(score(s)).toBe(4 + 3);
    expect(secs(s)).toBe(61);
    let perfect = opened();
    for (const g of [3, 2, 1, 0]) perfect = guess(perfect, board, group(g), T + 10_000);
    expect(score(perfect)).toBe(8);
  });
});

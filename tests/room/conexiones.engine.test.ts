import { describe, expect, it } from "vitest";
import {
  applyCommand, conexionesPackSchema, CX_BOARD_MISSES, INTRO_MS, NAME_MS, OUTAGE_MS, REVEAL_MS, seatsChanged, standings, startMatch, tick, TURN_MS, viewOf,
  type ConexionesCommand, type ConexionesContent, type ConexionesState,
} from "../../src/modules/room/games/conexiones/conexiones.engine.js";
import { conexionesRoomEngine } from "../../src/modules/room/games/conexiones/conexiones.room.js";
import { countPartitions, cxBoardSchema, judge, type CxBoard } from "../../src/modules/room/games/conexiones/conexiones.rules.js";

// Invented players and links only (the repo is public).
const L = (s: string) => ({ en: s, es: `${s} (es)`, ka: `${s} (ka)`, tr: `${s} (tr)`, ru: `${s} (ru)` });
const tid = (b: number, i: number) => `t${String(b).padStart(2, "0")}${String(i).padStart(2, "0")}xyz`.slice(0, 8);
const board = (b: number, difficulty: CxBoard["difficulty"] = "easy"): CxBoard => ({
  id: `test-${b}`,
  difficulty,
  tiles: Array.from({ length: 16 }, (_, i) => ({ id: tid(b, i), player: `p-${b}-${i}`, name: { en: `Invented ${b}-${i}`, ka: `ka ${b}-${i}`, ru: `ru ${b}-${i}` }, portrait: null })),
  groups: [0, 1, 2, 3].map((g) => ({
    id: `g${b}-${g}`, tier: (g + 1) as 1 | 2 | 3 | 4, key: `club:invented-${b}-${g}`,
    link: L(`Link ${b}-${g}`), decoys: [1, 2, 3].map((d) => L(`Decoy ${b}-${g}-${d}`)),
    members: [0, 1, 2, 3].map((m) => tid(b, g * 4 + m)),
  })),
});
const group = (b: number, g: number) => [0, 1, 2, 3].map((m) => tid(b, g * 4 + m));
/** Three of group g and one of the next group: one away. */
const near = (b: number, g: number) => [...group(b, g).slice(0, 3), tid(b, ((g + 1) % 4) * 4)];
/** Two of two groups: a plain miss. */
const wrong = (b: number, k = 0) => [tid(b, 0), tid(b, 1), tid(b, 4 + k), tid(b, 5 + k)];

const content: ConexionesContent = {
  first: 0,
  // Options order [2, 0, 3, 1]: the link is option 1.
  boards: [0, 1, 2, 3, 4].map((b) => ({ board: board(b, (["easy", "medium", "medium", "medium", "hard"] as const)[b]), order: Array.from({ length: 16 }, (_, i) => tid(b, 15 - i)), options: [2, 0, 3, 1] })),
};
const T = 1_000_000;
const live = (): ConexionesState => tick(startMatch(2, content, T), content, T + INTRO_MS);
const at = (s: ConexionesState) => s.deadline - TURN_MS + 1_000;
const send = (s: ConexionesState, seat: number, cmd: Partial<ConexionesCommand> & { type: ConexionesCommand["type"] }, now = at(s)) =>
  applyCommand(s, content, seat, { board: s.board, n: s.n, ...cmd } as ConexionesCommand, now);
const ok = (r: { state: ConexionesState; error?: string }) => {
  expect(r.error).toBeUndefined();
  return r.state;
};
const tryFour = (s: ConexionesState, seat: number, ids: string[]) => ok(send(s, seat, { type: "try", ids }));

describe("conexiones rules", () => {
  it("judges right, one away and wrong", () => {
    const b = board(0);
    expect(judge(b, group(0, 2)).verdict).toBe("right");
    expect(judge(b, near(0, 1)).verdict).toBe("oneAway");
    expect(judge(b, wrong(0)).verdict).toBe("wrong");
  });

  it("the board schema refuses a tile in two groups, twin names, two equal tiers and a repeated naming option", () => {
    expect(cxBoardSchema.safeParse(board(0)).success).toBe(true);
    const twoGroups = board(0);
    twoGroups.groups[1].members[0] = twoGroups.groups[0].members[0];
    expect(cxBoardSchema.safeParse(twoGroups).success).toBe(false);
    const twins = board(0);
    twins.tiles[1].name.en = twins.tiles[0].name.en.toUpperCase();
    expect(cxBoardSchema.safeParse(twins).success).toBe(false);
    const tiers = board(0);
    tiers.groups[1].tier = 1;
    expect(cxBoardSchema.safeParse(tiers).success).toBe(false);
    const decoy = board(0);
    decoy.groups[0].decoys[0] = decoy.groups[0].link;
    expect(cxBoardSchema.safeParse(decoy).success).toBe(false);
    const otherLink = board(0);
    otherLink.groups[3].decoys[2] = { ...otherLink.groups[1].link, ka: "something else" };
    expect(cxBoardSchema.safeParse(otherLink).success).toBe(false);
    const sameId = board(0);
    sameId.groups[2].id = sameId.groups[1].id;
    expect(cxBoardSchema.safeParse(sameId).success).toBe(false);
  });

  it("counts the ways a board splits: one with clean links, two with an unforced trap", () => {
    const tiles = Array.from({ length: 8 }, (_, i) => `x${i}`);
    const fits: Record<string, string[]> = Object.fromEntries(tiles.map((t, i) => [t, [i < 4 ? "a" : "b"]]));
    expect(countPartitions(tiles, ["a", "b"], fits)).toBe(1);
    // x0 also fits b, and x4 also fits a: swapping them is a second split.
    expect(countPartitions(tiles, ["a", "b"], { ...fits, x0: ["a", "b"], x4: ["a", "b"] })).toBe(2);
    // x0 also fits b but nothing of b fits a: elimination forces it, still one split.
    expect(countPartitions(tiles, ["a", "b"], { ...fits, x0: ["a", "b"] })).toBe(1);
  });
});

describe("conexiones room: turns", () => {
  it("exactly two seats; the intro opens board 1 for the first seat", () => {
    expect(() => startMatch(3, content, T)).toThrow();
    expect(tick(startMatch(2, content, T), content, T + INTRO_MS - 1).phase).toBe("intro");
    expect(live()).toMatchObject({ phase: "turn", board: 0, turn: 0, n: 0, deadline: T + INTRO_MS + TURN_MS });
  });

  it("one try per turn, hit or miss; a hit scores, a miss counts", () => {
    let s = tryFour(live(), 0, group(0, 0));
    expect(s).toMatchObject({ turn: 1, n: 1, misses: 0, points: [[1, 0]] });
    s = tryFour(s, 1, near(0, 1));
    expect(s).toMatchObject({ turn: 0, n: 2, misses: 1 });
    expect(s.tries.map((t) => t.verdict)).toEqual(["right", "oneAway"]);
  });

  it("refuses the wrong seat, a stale move number, solved or foreign tiles, and a four already tried without passing the turn", () => {
    let s = live();
    expect(send(s, 1, { type: "try", ids: group(0, 0) }).error).toBe("not_your_turn");
    expect(send(s, 0, { type: "try", ids: group(0, 0), n: 3 }).error).toBe("stale");
    expect(send(s, 0, { type: "try", ids: group(0, 0), board: 1 }).error).toBe("stale");
    expect(send(s, 0, { type: "try", ids: group(1, 0) }).error).toBe("bad_tiles");
    expect(send(s, 0, { type: "try", ids: [tid(0, 0), tid(0, 0), tid(0, 1), tid(0, 2)] }).error).toBe("bad_tiles");
    expect(send(s, 0, { type: "name", pick: 1 }).error).toBe("not_open");
    s = tryFour(s, 0, wrong(0));
    const again = send(s, 1, { type: "try", ids: [...wrong(0)].reverse() });
    expect(again.error).toBe("repeat");
    expect(again.state).toBe(s);
    s = tryFour(s, 1, group(0, 0));
    expect(send(s, 0, { type: "try", ids: [tid(0, 0), tid(0, 4), tid(0, 8), tid(0, 12)] }).error).toBe("bad_tiles");
    expect(send(s, 0, { type: "try", ids: group(0, 1) }, s.deadline).error).toBe("not_open");
  });

  it("three groups out: the seat on turn names the last link; right +1", () => {
    let s = tryFour(live(), 0, group(0, 0));
    s = tryFour(s, 1, group(0, 1));
    const now = at(s);
    s = ok(send(s, 0, { type: "try", ids: group(0, 2) }, now));
    expect(s).toMatchObject({ phase: "name", turn: 1, deadline: now + NAME_MS });
    expect(send(s, 1, { type: "try", ids: group(0, 3) }).error).toBe("not_open");
    expect(send(s, 0, { type: "name", pick: 1 }).error).toBe("not_your_turn");
    const v = viewOf(s, content, 0, "es");
    expect(v.options).toEqual(["Decoy 0-3-2 (es)", "Link 0-3 (es)", "Decoy 0-3-3 (es)", "Decoy 0-3-1 (es)"]);
    expect(v.named).toBeNull();
    s = ok(send(s, 1, { type: "name", pick: 1 }, s.deadline - 1));
    expect(s).toMatchObject({ phase: "reveal", points: [[2, 2]], named: { seat: 1, pick: 1, right: true }, found: [2, 1] });
    // A right naming is a point, not a group found.
    expect(standings(s).map((x) => x.roundWins)).toEqual([2, 1]);
    expect(viewOf(s, content, 0, "en").named).toMatchObject({ answer: 1, right: true });
  });

  it("a wrong naming scores nothing and the group goes to nobody", () => {
    let s = tryFour(live(), 0, group(0, 0));
    s = tryFour(s, 1, group(0, 1));
    s = tryFour(s, 0, group(0, 2));
    s = ok(send(s, 1, { type: "name", pick: 0 }));
    expect(s.points).toEqual([[2, 1]]);
    expect(s.out[3]).toEqual({ group: "g0-3", by: null });
  });

  it("six misses end the board and reveal the rest unscored", () => {
    let s = live();
    for (let i = 0; i < CX_BOARD_MISSES; i++) s = tryFour(s, s.turn, [tid(0, 0), tid(0, 4), tid(0, 8 + (i % 4)), tid(0, 12 + Math.floor(i / 4))]);
    expect(s.phase).toBe("reveal");
    expect(s.out.map((o) => o.by)).toEqual([null, null, null, null]);
    expect(s.points).toEqual([[0, 0]]);
  });

  it("boards alternate the opener; the match ends after five", () => {
    let s = live();
    for (let b = 0; b < 5; b++) {
      expect(s).toMatchObject({ phase: "turn", board: b, turn: b % 2 === 0 ? 0 : 1 });
      s = tryFour(s, s.turn, group(b, 0));
      s = tryFour(s, s.turn, group(b, 1));
      s = tryFour(s, s.turn, group(b, 2));
      s = ok(send(s, s.turn, { type: "name", pick: 1 }));
      s = tick(s, content, s.deadline);
    }
    expect(s.phase).toBe("over");
    expect(viewOf(s, content, 0, "en").result).toEqual({ winner: null, reason: "score" });
    expect(standings(s).map((x) => x.place)).toEqual([1, 1]);
  });
});

describe("conexiones room: clock, leaving, outage", () => {
  it("a run-out turn is a miss and passes; two in a row by one seat forfeit; a move clears the count", () => {
    let s = tick(live(), content, T + INTRO_MS + TURN_MS);
    expect(s).toMatchObject({ phase: "turn", turn: 1, misses: 1, timeouts: [1, 0] });
    s = tryFour(s, 1, wrong(0));
    s = tryFour(s, 0, wrong(0, 4));
    expect(s.timeouts).toEqual([0, 0]);
    s = tick(s, content, s.deadline);
    expect(s).toMatchObject({ turn: 0, timeouts: [0, 1] });
    s = tryFour(s, 0, group(0, 0));
    s = tick(s, content, s.deadline);
    expect(s).toMatchObject({ phase: "over", end: { reason: "forfeit", loser: 1 } });
    expect(standings(s).map((x) => x.place)).toEqual([1, 2]);
  });

  it("a second run-out never wins the match for a seat that is away: it is a miss, and presence settles the rest", () => {
    let s = tick(live(), content, T + INTRO_MS + TURN_MS);
    s = tryFour(s, 1, wrong(0));
    s = seatsChanged(s, [{ seat: 1, change: "away" }]);
    s = tick(s, content, s.deadline);
    expect(s).toMatchObject({ phase: "turn", turn: 1, timeouts: [2, 0], misses: 3 });
    s = seatsChanged(s, [{ seat: 1, change: "back" }]);
    s = tick(s, content, s.deadline);
    s = tick(s, content, s.deadline);
    expect(s).toMatchObject({ phase: "over", end: { reason: "forfeit", loser: 0 } });
  });

  it("a run-out naming scores nothing and reveals", () => {
    let s = tryFour(live(), 0, group(0, 0));
    s = tryFour(s, 1, group(0, 1));
    s = tryFour(s, 0, group(0, 2));
    const due = s.deadline;
    s = tick(s, content, due);
    expect(s).toMatchObject({ phase: "reveal", named: { seat: 1, pick: null, right: false }, timeouts: [0, 1], deadline: due + REVEAL_MS });
  });

  it("an overdue deadline is an outage: a fresh window, nobody charged", () => {
    const s = live();
    const after = tick(s, content, s.deadline + OUTAGE_MS + 1);
    expect(after).toMatchObject({ phase: "turn", turn: 0, misses: 0, timeouts: [0, 0], deadline: s.deadline + OUTAGE_MS + 1 + TURN_MS });
  });

  it("a seat that leaves loses; the other wins while it is here, and is waited for while it is away", () => {
    const s = tryFour(live(), 0, group(0, 0));
    const left = seatsChanged(s, [{ seat: 0, change: "leave" }]);
    expect(left).toMatchObject({ phase: "over", end: { reason: "left", loser: 0 } });
    expect(standings(left).map((x) => x.place)).toEqual([2, 1]);
    const waiting = seatsChanged(seatsChanged(s, [{ seat: 1, change: "away" }]), [{ seat: 0, change: "leave" }]);
    expect(waiting.phase).toBe("turn");
    expect(tick(waiting, content, waiting.deadline + 1).phase).toBe("turn");
    expect(seatsChanged(waiting, [{ seat: 1, change: "back" }])).toMatchObject({ phase: "over", end: { reason: "left", loser: 0 } });
    expect(seatsChanged(waiting, [{ seat: 1, change: "leave" }]).phase).toBe("cancelled");
    expect(seatsChanged(s, [{ seat: 0, change: "leave" }, { seat: 1, change: "leave" }]).phase).toBe("cancelled");
  });
});

describe("conexiones room: what a seat sees", () => {
  it("never a group still in play, never the right option before the naming", () => {
    let s = tryFour(live(), 0, group(0, 0));
    const json = JSON.stringify(viewOf(s, content, 1, "en"));
    for (const g of [1, 2, 3]) {
      expect(json).not.toContain(`Link 0-${g}`);
      expect(json).not.toContain(`Decoy 0-${g}`);
      expect(json).not.toContain(`g0-${g}`);
    }
    expect(json).toContain("Link 0-0");
    expect(JSON.stringify(viewOf(startMatch(2, content, T), content, 0, "en"))).not.toContain("Invented");
    s = tryFour(s, 1, group(0, 1));
    s = tryFour(s, 0, group(0, 2));
    const naming = JSON.stringify(viewOf(s, content, 0, "en"));
    expect(naming).not.toContain("g0-3");
    expect(naming).not.toContain('"answer"');
  });

  it("shows tiles in the match order, in the reader's script", () => {
    const v = viewOf(live(), content, 0, "ka");
    expect(v.tiles.map((t) => t.id)).toEqual(content.boards[0].order);
    expect(v.tiles[0].name).toBe("ka 0-15");
  });
});

describe("conexiones room engine: deal", () => {
  it("deals five boards on the curve with their own orders, none sharing a footballer", async () => {
    const pool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((b) => board(b, (["easy", "medium", "hard"] as const)[b % 3]));
    const dealt = await conexionesRoomEngine.deal(async (wanted) => pool.filter((p) => (wanted[p.difficulty] ?? 0) > 0).map((p) => ({ id: p.id, difficulty: p.difficulty, payload: p }) as never), null, 2);
    expect(dealt).not.toBeNull();
    const pack = conexionesPackSchema.parse(dealt!.content);
    expect(pack.boards.map((b) => b.board.difficulty)).toEqual(["easy", "medium", "medium", "medium", "hard"]);
    for (const b of pack.boards) expect([...b.order].sort()).toEqual(b.board.tiles.map((t) => t.id).sort());
    expect(dealt!.itemIds).toHaveLength(5);
  });

  it("no footballer on two boards of a match while the pool has boards without him; a small pool may repeat one", async () => {
    // Boards 0–4 share a footballer with the board after them; 10–14 share nobody.
    const shared = (b: number, d: CxBoard["difficulty"]) => {
      const x = board(b, d);
      x.tiles[0] = { ...x.tiles[0], player: `p-shared-${b % 5}` };
      x.tiles[1] = { ...x.tiles[1], player: `p-shared-${(b + 1) % 5}` };
      return x;
    };
    const order = ["easy", "medium", "medium", "medium", "hard"] as const;
    const pool = [...[0, 1, 2, 3, 4].map((b) => shared(b, order[b])), ...[10, 11, 12, 13, 14].map((b) => board(b, order[b - 10]))];
    const pick = (list: CxBoard[]) => async (wanted: Record<string, number>) => list.filter((p) => (wanted[p.difficulty] ?? 0) > 0).map((p) => ({ id: p.id, difficulty: p.difficulty, payload: p }) as never);
    const dealt = conexionesPackSchema.parse((await conexionesRoomEngine.deal(pick(pool), null, 2))!.content);
    const players = dealt.boards.flatMap((b) => b.board.tiles.map((t) => t.player));
    expect(new Set(players).size).toBe(players.length);
    // Only clashing boards left: the match still starts, with a repeat.
    const small = await conexionesRoomEngine.deal(pick(pool.slice(0, 5)), null, 2);
    expect(small).not.toBeNull();
  });

  it("QA 2026-10-25 N5: a footballer clash never pushes the deal onto a board met before when an unmet one fits", async () => {
    const order = ["easy", "easy", "medium", "medium", "medium", "medium", "medium", "medium", "hard", "hard"] as const;
    const pool = order.map((d, i) => board(20 + i, d));
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const deal = async (seen: Record<number, Date>) => {
      const pick = async (wanted: Record<string, number>) =>
        pool.map((p, i) => ({ item_id: p.id, difficulty: p.difficulty, payload: p, seen_at: seen[i] ?? null })).filter((p) => (wanted[p.difficulty] ?? 0) > 0) as never;
      return conexionesPackSchema.parse((await conexionesRoomEngine.deal(pick, null, 2))!.content).boards.map((b) => b.board.id);
    };
    // The unmet easy board clashes with the third medium; the other easy board is from the last match. Every medium is
    // unmet, so skipping that medium keeps the whole match unmet.
    pool[0].tiles[0] = { ...pool[0].tiles[0], player: "p-clash" };
    pool[4].tiles[0] = { ...pool[4].tiles[0], player: "p-clash" };
    expect(await deal({ 1: minutesAgo(5) })).toEqual([pool[0].id, pool[2].id, pool[3].id, pool[5].id, pool[8].id]);
    // Everything met before: the clash costs the easy board met a week ago, not a medium from the last match.
    pool[4].tiles[0] = { ...pool[4].tiles[0], player: pool[4].tiles[0].id };
    pool[2].tiles[0] = { ...pool[2].tiles[0], player: "p-clash" };
    const week = minutesAgo(7 * 24 * 60);
    expect(await deal({ 0: minutesAgo(9 * 24 * 60), 1: week, 2: minutesAgo(8 * 24 * 60), 3: minutesAgo(8 * 24 * 60), 4: minutesAgo(8 * 24 * 60), 5: minutesAgo(5), 6: minutesAgo(5), 7: minutesAgo(5), 8: week, 9: week }))
      .toEqual([pool[1].id, pool[2].id, pool[3].id, pool[4].id, pool[8].id]);
  });

  it("returns null when the pool cannot fill a match", async () => {
    expect(await conexionesRoomEngine.deal(async () => [], null, 2)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { CARD_MS, dayCardsSchema, joker, newState, next, pick, project, publicState, rights, score, settledAt, type RunState } from "../../src/modules/dato-falso/dato-falso.rules.js";
import { cutFor, type DfCard } from "../../src/modules/room/games/dato-falso/dato-falso.rules.js";
import { ANSWER_GRACE_MS } from "../../src/modules/wordgame-daily/wordgame-daily.shared.js";

// Invented players and clubs only (the repo is public).
const L = (s: string) => ({ en: s, es: s, ka: s, tr: s, ru: s });
const CURVE = ["easy", "medium", "easy", "medium", "hard", "medium", "easy", "hard", "medium", "hard"] as const;
const card = (i: number): DfCard => ({
  id: `test-${i}`, category: "clubs", difficulty: CURVE[i % 10],
  player: { id: `p-${i}`, name: L(`Invented Player ${i}`), portrait: null },
  options: [0, 1, 2, 3, 4].map((o) => ({ label: L(`Club ${i}-${o}`), art: { kind: "text" as const } })),
  fake: (i * 3) % 5,
  explain: L(`Secret reason ${i}.`),
});
const day = { cards: Array.from({ length: 10 }, (_, i) => card(i)) };
const T = 1_000_000;
const view = (s: RunState, now = T, disclose = false) => publicState(s, "2026-10-26", day, now, { ranked: true, disclose });
const opened = () => next(newState(), T);

describe("dato falso daily: cards and the clock", () => {
  it("next opens the first card for 30 s; a second next on an open card is refused", () => {
    const s = opened();
    expect(s).toMatchObject({ r: 0, open: true, dl: T + CARD_MS });
    expect(() => next(s, T)).toThrow();
  });

  it("a pick settles the card with its points; the next card opens fresh", () => {
    let s = pick(opened(), day.cards[0], day.cards[0].fake);
    expect(s).toMatchObject({ open: false, end: "pick", res: [{ right: true, pts: 1 }] });
    s = next(s, T + 5_000);
    expect(s).toMatchObject({ r: 1, open: true, cut: false, dbl: false });
    expect(() => pick(pick(s, day.cards[1], 0), day.cards[1], 1)).toThrow();
  });

  it("the clock: settled only past the deadline plus the grace, as a no-answer, at that instant", () => {
    const s = opened();
    expect(project(s, T + CARD_MS + ANSWER_GRACE_MS)).toBe(s);
    const late = project(s, T + CARD_MS + ANSWER_GRACE_MS + 1);
    expect(late).toMatchObject({ open: false, end: "time", res: [{ pick: null, pts: 0 }] });
    expect(settledAt(s, late)).toBe(T + CARD_MS + ANSWER_GRACE_MS);
    const doubled = project(joker(s, "double"), T + 60_000);
    expect(doubled.res[0].pts).toBe(-1);
  });

  it("jokers: once per run each, only on an open card; a cut option cannot be picked", () => {
    let s = joker(opened(), "cut");
    const removed = cutFor(day.cards[0], s.salt);
    expect(removed).not.toContain(day.cards[0].fake);
    expect(() => pick(s, day.cards[0], removed[0])).toThrow();
    expect(() => joker(s, "cut")).toThrow();
    s = joker(s, "double");
    s = pick(s, day.cards[0], day.cards[0].fake);
    expect(s.res[0]).toMatchObject({ cut: true, dbl: true, pts: 2 });
    expect(() => joker(s, "double")).toThrow();
    s = next(s, T);
    expect(() => joker(s, "cut")).toThrow();
  });

  it("ten cards finish the run; the last card running out finishes it too", () => {
    let s = opened();
    for (let i = 0; i < 10; i++) {
      s = i === 9 ? project(s, s.dl! + ANSWER_GRACE_MS + 1) : pick(s, day.cards[i], i % 2 === 0 ? day.cards[i].fake : (day.cards[i].fake + 1) % 5);
      if (i < 9) s = next(s, T);
    }
    expect(s.done).toBe(true);
    expect([score(s), rights(s)]).toEqual([5, 5]);
    expect(() => next(s, T)).toThrow();
  });

  it("a day refuses a repeated card or footballer, and cards off the difficulty curve", () => {
    expect(dayCardsSchema.safeParse(day).success).toBe(true);
    const twin = { cards: [...day.cards.slice(0, 9), { ...card(10), player: day.cards[0].player }] };
    expect(dayCardsSchema.safeParse(twin).success).toBe(false);
    const flat = { cards: day.cards.map((c) => ({ ...c, difficulty: "easy" as const })) };
    expect(dayCardsSchema.safeParse(flat).success).toBe(false);
  });
});

describe("dato falso daily: what the player sees", () => {
  it("an open card never carries its fake or explanation; later cards are not shown at all", () => {
    const s = joker(opened(), "cut");
    const v = view(s);
    const json = JSON.stringify(v);
    expect(json).not.toContain("Secret reason");
    expect(json).not.toMatch(/"fake"/);
    expect(json).not.toContain("Invented Player 1");
    expect(v.removed).toEqual(cutFor(day.cards[0], s.salt));
  });

  it("a settled card carries its fake and explanation; the whole day only when the run is over and the day closed", () => {
    const s = pick(opened(), day.cards[0], 1);
    expect(view(s).settled).toMatchObject({ fake: day.cards[0].fake, explain: day.cards[0].explain, reason: "pick" });
    expect(view(s).results).toHaveLength(1);
    let done = s;
    for (let i = 1; i < 10; i++) done = pick(next(done, T), day.cards[i], 0);
    expect(view(done).disclosed).toBe(false);
    expect(view(done, T, true)).toMatchObject({ disclosed: true });
    expect(view(done, T, true).results).toHaveLength(10);
  });
});

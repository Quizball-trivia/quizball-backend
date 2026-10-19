import { describe, expect, it } from "vitest";
import {
  applyCommand, CARD_MS, datoFalsoPackSchema, IDLE_AFTER, OUTAGE_MS, REVEAL_MS, seatsChanged, standings, startMatch, tick, viewOf,
  type DatoFalsoContent, type DatoFalsoState,
} from "../../src/modules/room/games/dato-falso/dato-falso.engine.js";
import { datoFalsoRoomEngine } from "../../src/modules/room/games/dato-falso/dato-falso.room.js";
import { cutFor, dfCardSchema, pointsFor, type DfCard } from "../../src/modules/room/games/dato-falso/dato-falso.rules.js";

// Invented players and clubs only (the repo is public).
const L = (s: string) => ({ en: s, es: s, ka: s, tr: s, ru: s });
const card = (i: number, fake = i % 5, difficulty: DfCard["difficulty"] = "easy"): DfCard => ({
  id: `test-${i}`,
  category: "clubs",
  difficulty,
  player: { id: `p-${i}`, name: L(`Invented Player ${i}`), portrait: null },
  options: [0, 1, 2, 3, 4].map((o) => ({ label: L(`Club ${i}-${o}`), art: { kind: "text" as const } })),
  fake,
  explain: L(`Never played for Club ${i}-${fake}.`),
});
const content: DatoFalsoContent = { salt: "0123456789abcdef0123", cards: Array.from({ length: 10 }, (_, i) => card(i)) };
const T = 1_000_000;
const live = (seats: number): DatoFalsoState => tick(startMatch(seats, T), content, T + 3_000);
const run = (s: DatoFalsoState, seat: number, cmd: Parameters<typeof applyCommand>[3], at = T + 4_000) => applyCommand(s, content, seat, cmd, at);
const pick = (s: DatoFalsoState, seat: number, option: number, at?: number) => run(s, seat, { type: "pick", card: s.card, option }, at);
const ok = (r: { state: DatoFalsoState; error?: string }) => {
  expect(r.error).toBeUndefined();
  return r.state;
};

describe("dato falso rules", () => {
  it("points: right +1, wrong 0, doubled +2 / −1", () => {
    expect([pointsFor(true, false), pointsFor(false, false), pointsFor(true, true), pointsFor(false, true)]).toEqual([1, 0, 2, -1]);
  });

  it("Descartar 2 removes two true options, the same two on every call, never the fake", () => {
    for (let i = 0; i < 10; i++) {
      const c = content.cards[i];
      const cut = cutFor(c, content.salt, 0);
      expect(cut).toHaveLength(2);
      expect(cut).not.toContain(c.fake);
      expect(cutFor(c, content.salt, 0)).toEqual(cut);
    }
  });

  it("the card schema refuses two options that read the same and a missing language", () => {
    const twin = card(1);
    twin.options[1] = { ...twin.options[1], label: twin.options[0].label };
    expect(dfCardSchema.safeParse(twin).success).toBe(false);
    const noKa = card(2) as unknown as { player: { name: Record<string, string> } };
    delete noKa.player.name.ka;
    expect(dfCardSchema.safeParse(noKa).success).toBe(false);
    expect(datoFalsoPackSchema.safeParse(content).success).toBe(true);
  });
});

describe("dato falso room: cards and the clock", () => {
  it("2–6 seats; the intro opens card 1 for 20 s", () => {
    expect(() => startMatch(1, T)).toThrow();
    expect(() => startMatch(7, T)).toThrow();
    expect(tick(startMatch(2, T), content, T + 2_999).phase).toBe("intro");
    expect(live(2)).toMatchObject({ phase: "card", card: 0, deadline: T + 3_000 + CARD_MS });
  });

  it("a pick is final; stale card, late and withdrawn picks are refused", () => {
    let s = ok(pick(live(3), 0, 1));
    expect(pick(s, 0, 2).error).toBe("already_picked");
    expect(run(s, 1, { type: "pick", card: 1, option: 0 }).error).toBe("stale_card");
    expect(pick(s, 1, 0, s.deadline).error).toBe("not_open");
    s = seatsChanged(s, [{ seat: 2, change: "leave" }]);
    expect(pick(s, 2, 0).error).toBe("withdrawn");
  });

  it("the card closes as soon as every eligible seat picked, else at the deadline", () => {
    let s = ok(pick(live(2), 0, 0));
    expect(tick(s, content, T + 5_000).phase).toBe("card");
    s = ok(pick(s, 1, 3));
    const revealed = tick(s, content, T + 5_000);
    expect(revealed).toMatchObject({ phase: "reveal", deadline: T + 5_000 + REVEAL_MS });
    expect(tick(live(2), content, T + 3_000 + CARD_MS).phase).toBe("reveal");
  });

  it("scores the reveal: right, wrong, doubled wrong, doubled unanswered", () => {
    let s = live(4);
    const fake = content.cards[0].fake;
    s = ok(pick(s, 0, fake));
    s = ok(pick(s, 1, (fake + 1) % 5));
    s = ok(run(s, 2, { type: "joker", card: 0, kind: "double" }));
    s = ok(pick(s, 2, (fake + 1) % 5));
    s = ok(run(s, 3, { type: "joker", card: 0, kind: "double" }));
    s = tick(s, content, s.deadline);
    expect(s.results[0].entries.map((e) => e.points)).toEqual([1, 0, -1, -1]);
  });

  it("jokers: once per match each, only before the pick; a cut option cannot be picked", () => {
    let s = live(2);
    s = ok(run(s, 0, { type: "joker", card: 0, kind: "cut" }));
    const removed = cutFor(content.cards[0], content.salt, 0);
    expect(pick(s, 0, removed[0]).error).toBe("option_removed");
    expect(run(s, 0, { type: "joker", card: 0, kind: "cut" }).error).toBe("joker_used");
    s = ok(pick(s, 0, content.cards[0].fake));
    expect(run(s, 0, { type: "joker", card: 0, kind: "double" }).error).toBe("already_picked");
    s = tick(ok(pick(s, 1, 0)), content, T + 5_000);
    s = tick(s, content, s.deadline);
    expect(s).toMatchObject({ phase: "card", card: 1 });
    expect(run(s, 0, { type: "joker", card: 1, kind: "cut" }).error).toBe("joker_used");
    expect(run(s, 0, { type: "joker", card: 1, kind: "double" }).error).toBeUndefined();
  });

  it("idle seats stop holding the early close after two silent cards; a pick brings them back", () => {
    let s = live(2);
    for (let c = 0; c < IDLE_AFTER; c++) {
      s = ok(pick(s, 0, 0, s.deadline - 1));
      s = tick(s, content, s.deadline);
      expect(s.phase).toBe("reveal");
      s = tick(s, content, s.deadline);
    }
    s = ok(pick(s, 0, 0, s.deadline - CARD_MS + 1));
    expect(tick(s, content, s.deadline - CARD_MS + 1).phase).toBe("reveal");
  });

  it("an outage gives the open card a fresh window and charges nobody", () => {
    const s = live(2);
    const after = tick(s, content, s.deadline + OUTAGE_MS + 1);
    expect(after).toMatchObject({ phase: "card", card: 0, deadline: s.deadline + OUTAGE_MS + 1 + CARD_MS });
  });

  it("ten cards then over; standings share a place on equal points and put leavers last", () => {
    let s = live(3);
    while (s.phase !== "over") {
      if (s.phase === "card") {
        s = ok(pick(s, 0, content.cards[s.card].fake, s.deadline - 1));
        s = ok(pick(s, 1, content.cards[s.card].fake, s.deadline - 1));
      }
      s = tick(s, content, s.deadline);
    }
    expect(s.results).toHaveLength(10);
    expect(standings(s)).toEqual([
      { seat: 0, points: 10, roundWins: 10, place: 1 },
      { seat: 1, points: 10, roundWins: 10, place: 1 },
      { seat: 2, points: 0, roundWins: 0, place: 3 },
    ]);
    const left = seatsChanged(live(3), [{ seat: 0, change: "leave" }]);
    expect(standings(left).find((x) => x.seat === 0)?.place).toBe(3);
  });

  it("the seat left alone wins, even before the first reveal; everyone leaving cancels", () => {
    const alone = seatsChanged(live(2), [{ seat: 0, change: "leave" }]);
    expect(alone.phase).toBe("over");
    expect(standings(alone).find((x) => x.seat === 1)?.place).toBe(1);
    expect(seatsChanged(live(2), [{ seat: 0, change: "leave" }, { seat: 1, change: "leave" }]).phase).toBe("cancelled");
    // Both closed every tab: their absence windows end one after the other; the match waits for the second, then cancels.
    const bothAway = seatsChanged(live(2), [{ seat: 0, change: "away" }, { seat: 1, change: "away" }]);
    const waiting = seatsChanged(bothAway, [{ seat: 0, change: "leave" }]);
    expect(waiting.phase).toBe("card");
    expect(seatsChanged(waiting, [{ seat: 1, change: "leave" }]).phase).toBe("cancelled");
    // The same after a card was revealed meanwhile: nobody there to win it.
    const revealed = tick(waiting, content, T + 3_000 + CARD_MS);
    expect(revealed.phase).toBe("reveal");
    expect(seatsChanged(revealed, [{ seat: 1, change: "leave" }]).phase).toBe("cancelled");
    // The last reveal ends while the one left is still away: no winner yet; their absence running out cancels.
    let last = live(2);
    while (!(last.phase === "reveal" && last.card === 9)) last = tick(last, content, last.deadline);
    last = seatsChanged(last, [{ seat: 0, change: "away" }, { seat: 1, change: "away" }]);
    last = seatsChanged(last, [{ seat: 0, change: "leave" }]);
    last = tick(last, content, last.deadline);
    expect(last.phase).toBe("reveal");
    expect(seatsChanged(last, [{ seat: 1, change: "leave" }]).phase).toBe("cancelled");
    expect(seatsChanged(last, [{ seat: 1, change: "back" }]).phase).toBe("over");
    // One leaves while the other is briefly away: coming back wins it.
    const back = seatsChanged(waiting, [{ seat: 1, change: "back" }]);
    expect(back.phase).toBe("over");
    expect(standings(back).find((x) => x.seat === 1)?.place).toBe(1);
    let s = tick(live(2), content, T + 3_000 + CARD_MS);
    expect(s.phase).toBe("reveal");
    s = seatsChanged(s, [{ seat: 1, change: "leave" }]);
    expect(s.phase).toBe("over");
  });
});

describe("dato falso room: review fixes", () => {
  it("a joker does not clear idle (it would tell the others a hidden joker was played)", () => {
    let s = live(2);
    for (let c = 0; c < IDLE_AFTER; c++) s = tick(tick(ok(pick(s, 0, 0)), content, s.deadline), content, s.deadline + REVEAL_MS);
    expect(viewOf(s, content, 0, "en").seats[1].idle).toBe(true);
    s = ok(run(s, 1, { type: "joker", card: s.card, kind: "double" }, s.deadline - CARD_MS + 1));
    expect(viewOf(s, content, 0, "en").seats[1]).toMatchObject({ idle: true, answered: false });
  });

  it("a seat that left scores nothing afterwards: no point for its pick, no −1 for its double", () => {
    let s = live(3);
    s = ok(run(s, 2, { type: "joker", card: 0, kind: "double" }));
    s = ok(pick(s, 2, (content.cards[0].fake + 1) % 5));
    s = seatsChanged(s, [{ seat: 2, change: "leave" }]);
    s = tick(s, content, s.deadline);
    expect(s.results[0].entries[2]).toMatchObject({ pick: null, points: 0, doubled: false });
    expect(standings(s).find((x) => x.seat === 2)?.points).toBe(0);
  });

  it("a seat that dropped out a moment ago is waited for until the deadline", () => {
    let s = ok(pick(live(2), 0, 0));
    s = seatsChanged(s, [{ seat: 1, change: "away" }]);
    expect(tick(s, content, T + 5_000).phase).toBe("card");
    expect(tick(s, content, s.deadline).phase).toBe("reveal");
  });
});

describe("dato falso room: code review fixes", () => {
  it("an idle seat that doubles and is not waited for gets its joker back and loses nothing", () => {
    let s = live(2);
    for (let c = 0; c < IDLE_AFTER; c++) s = tick(tick(ok(pick(s, 0, 0)), content, s.deadline), content, s.deadline + REVEAL_MS);
    const opened = s.deadline - CARD_MS;
    s = ok(run(s, 1, { type: "joker", card: s.card, kind: "double" }, opened + 1));
    s = ok(pick(s, 0, content.cards[s.card].fake, opened + 2));
    s = tick(s, content, opened + 2);
    expect(s.phase).toBe("reveal");
    expect(s.results.at(-1)!.entries[1]).toMatchObject({ points: 0, doubled: false });
    expect(s.spent[1].double).toBe(false);
  });
});

describe("dato falso room: what each seat sees", () => {
  it("an open card never carries the fake, the explanation, or another seat's pick or joker", () => {
    let s = live(2);
    s = ok(run(s, 1, { type: "joker", card: 0, kind: "double" }));
    s = ok(pick(s, 1, content.cards[0].fake));
    const view = viewOf(s, content, 0, "es");
    const json = JSON.stringify(view);
    expect(json).not.toContain("Never played");
    expect(json).not.toMatch(/"fake"/);
    expect(view.seats[1]).toMatchObject({ answered: true, jokers: { cut: false, double: false } });
    expect(view.mine).toMatchObject({ pick: null, doubled: false });
  });

  it("the reveal shows every pick, joker, the fake and the explanation", () => {
    let s = live(2);
    s = ok(run(s, 1, { type: "joker", card: 0, kind: "double" }));
    s = tick(ok(pick(ok(pick(s, 1, 2)), 0, 0)), content, T + 5_000);
    const view = viewOf(s, content, 0, "en");
    expect(view.reveal).toMatchObject({ fake: content.cards[0].fake, explain: content.cards[0].explain.en });
    expect(view.reveal?.entries[1]).toMatchObject({ pick: 2, doubled: true });
    expect(view.seats[1].jokers).toEqual({ cut: false, double: true });
  });

  it("my own cut options are listed only for me", () => {
    const s = ok(run(live(2), 0, { type: "joker", card: 0, kind: "cut" }));
    expect(viewOf(s, content, 0, "en").mine.removed).toEqual(cutFor(content.cards[0], content.salt, 0));
    expect(viewOf(s, content, 1, "en").mine.removed).toEqual([]);
  });
});

describe("dato falso room: deal", () => {
  const pool = (perDifficulty: number, samePlayer = false) => (["easy", "medium", "hard"] as const).flatMap((d, k) =>
    Array.from({ length: perDifficulty }, (_, i) => {
      const c = card(k * 100 + i, i % 5, d);
      return { item_id: c.id, difficulty: d, payload: samePlayer ? { ...c, player: { ...c.player, id: "p-same" } } : c };
    }));

  it("deals ten cards on the curve with distinct players and a fresh salt", async () => {
    const items = pool(8);
    const dealt = await datoFalsoRoomEngine.deal(async (wanted) => items.filter((it) => (wanted[it.difficulty] ?? 0) > 0).slice(0, 100), null, 2);
    const pack = datoFalsoRoomEngine.parseContent(dealt?.content);
    expect(pack?.cards.map((c) => c.difficulty)).toEqual(["easy", "medium", "easy", "medium", "hard", "medium", "easy", "hard", "medium", "hard"]);
    expect(new Set(pack?.cards.map((c) => c.player.id)).size).toBe(10);
    expect(dealt?.itemIds).toHaveLength(10);
  });

  it("a pool too small for a match deals nothing; one footballer may repeat rather than not start", async () => {
    expect(await datoFalsoRoomEngine.deal(async () => pool(2), null, 2)).toBeNull();
    expect(await datoFalsoRoomEngine.deal(async () => pool(4, true), null, 2)).not.toBeNull();
  });
});

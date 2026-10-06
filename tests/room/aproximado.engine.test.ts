import { describe, expect, it } from "vitest";
import { eligibleSeats, finalStandings, isIdle, OUTAGE_MS, seatChanged, seatsChanged, startMatch, submitGuess, tick, validGuess, type EngineConfig, type EngineState } from "../../src/modules/room/games/aproximado/aproximado.engine.js";
import type { AproximadoQuestion } from "../../src/modules/room/games/aproximado/aproximado.rules.js";

const q = (value: number, precision = 0, exactWithin = 0): AproximadoQuestion => ({ id: `q${value}`, kind: "goals", prompt: "?", unit: "", precision, exactWithin, value });
const cfg: EngineConfig = { questions: [q(100), q(50), q(64.5, 1, 0.5)], scoring: "podium", roundMs: 20_000, revealMs: 6_000, introMs: 3_000 };
const T = 1_000_000;

/** Intro over: question 1 open at T + 3 s. */
const live = (seats: number): EngineState => tick(startMatch(seats, cfg, T), cfg, T + 3_000);
const guess = (s: EngineState, seat: number, value: number, at = T + 4_000) => submitGuess(s, cfg, seat, value, at);

describe("aproximado engine: rounds", () => {
  it("2–6 admitted seats only; the intro opens question 1 on time", () => {
    expect(() => startMatch(1, cfg, T)).toThrow();
    expect(() => startMatch(7, cfg, T)).toThrow();
    const s = startMatch(3, cfg, T);
    expect(tick(s, cfg, T + 2_999).phase).toBe("intro");
    expect(live(3)).toMatchObject({ phase: "guess", round: 0, deadline: T + 23_000 });
  });

  it("the first guess is final; late, invalid and withdrawn guesses are refused", () => {
    let s = live(2);
    s = guess(s, 0, 90).state;
    expect(guess(s, 0, 95).error).toBe("already_answered");
    expect(submitGuess(s, cfg, 1, 90, s.deadline + 1).error).toBe("not_open");
    expect(guess(s, 1, 12.5).error).toBe("invalid"); // question 1 takes whole numbers
    expect(guess(s, 1, -3).error).toBe("invalid");
    const left = seatChanged(live(3), 2, "leave");
    expect(guess(left, 2, 90).error).toBe("withdrawn");
    expect(validGuess(64.5, 1)).toBe(true);
    expect(validGuess(64.55, 1)).toBe(false);
  });

  it("the deadline is one boundary: a guess exactly at it is refused, whether it or the expiry runs first", () => {
    const s = live(2);
    expect(submitGuess(s, cfg, 0, 90, s.deadline).error).toBe("not_open");
    expect(submitGuess(s, cfg, 0, 90, s.deadline - 1).error).toBeUndefined();
    expect(submitGuess(tick(s, cfg, s.deadline), cfg, 0, 90, s.deadline).error).toBe("not_open");
  });

  it("a guess may not carry more decimals than its question", () => {
    expect(validGuess(0.0000001, 0)).toBe(false);
    expect(validGuess(64.50000009, 1)).toBe(false);
    expect(validGuess(64.5, 1)).toBe(true);
    expect(validGuess(12, 7)).toBe(false);
    expect(guess(live(2), 0, 0.0000001).error).toBe("invalid");
  });

  it("a question closes early once every eligible seat answered, otherwise at its deadline", () => {
    let s = live(3);
    s = guess(guess(s, 0, 90).state, 1, 95).state;
    expect(tick(s, cfg, T + 5_000).phase).toBe("guess");
    s = guess(s, 2, 120).state;
    const r = tick(s, cfg, T + 5_000);
    expect(r.phase).toBe("reveal");
    expect(r.results[0].entries.map((e) => e.points)).toEqual([1, 2, 0]); // 3 seats: top = 2 (95), then 1 (90), 0 (120)
    expect(tick(live(3), cfg, T + 23_000).phase).toBe("reveal");
  });

  it("an away seat does not hold the early close; with nobody eligible the clock runs to the deadline", () => {
    let s = seatChanged(live(3), 2, "away");
    s = guess(guess(s, 0, 90).state, 1, 95).state;
    expect(tick(s, cfg, T + 5_000).phase).toBe("reveal");
    // Everyone left in is away: no early close at all.
    const allAway = seatChanged(seatChanged(live(2), 0, "away"), 1, "away");
    expect(eligibleSeats(allAway)).toEqual([]);
    expect(tick(allAway, cfg, T + 5_000).phase).toBe("guess");
    expect(tick(allAway, cfg, T + 23_000).phase).toBe("reveal");
  });

  it("two rounds without a guess make a seat idle (no longer waited for); one guess clears it", () => {
    let s = live(2);
    s = tick(guess(s, 0, 90).state, cfg, T + 23_000); // seat 1 missed question 1
    s = tick(s, cfg, T + 29_000); // question 2 opens
    s = tick(guess(s, 0, 40, T + 30_000).state, cfg, T + 49_000); // seat 1 missed question 2
    expect(isIdle(s, 1)).toBe(true);
    s = tick(s, cfg, T + 55_000); // question 3 opens: seat 0 alone is waited for
    expect(eligibleSeats(s)).toEqual([0]);
    const back = submitGuess(s, cfg, 1, 64.5, T + 56_000).state;
    expect(isIdle(back, 1)).toBe(false);
  });

  it("an overdue deadline is an outage: a fresh window, nobody charged", () => {
    const s = live(2);
    const after = tick(s, cfg, s.deadline + OUTAGE_MS + 1);
    expect(after.phase).toBe("guess");
    expect(after.deadline).toBe(s.deadline + OUTAGE_MS + 1 + 20_000);
    expect(after.missed).toEqual([0, 0]);
  });

  it("the last reveal ends in the result", () => {
    let s = live(2);
    for (let r = 0; r < 3; r += 1) {
      s = submitGuess(submitGuess(s, cfg, 0, cfg.questions[r].value, s.deadline - 1).state, cfg, 1, cfg.questions[r].value + 1, s.deadline - 1).state;
      s = tick(s, cfg, s.deadline);
      s = tick(s, cfg, s.deadline);
    }
    expect(s.phase).toBe("over");
    expect(finalStandings(s)[0].seat).toBe(0);
  });
});

describe("aproximado engine: seats leaving", () => {
  it("leaving is final; 'back' never undoes it", () => {
    const s = seatChanged(seatChanged(live(3), 1, "leave"), 1, "back");
    expect(s.status[1]).toBe("withdrawn");
  });

  it("before the first reveal, fewer than two seats left = cancelled", () => {
    expect(seatChanged(live(2), 1, "leave").phase).toBe("cancelled");
    const three = seatChanged(seatChanged(live(3), 1, "leave"), 2, "leave");
    expect(three.phase).toBe("cancelled");
  });

  it("after a reveal, the seat that stayed wins at once and the leaver ranks below even with more points", () => {
    let s = live(2);
    s = tick(guess(guess(s, 0, 50).state, 1, 100).state, cfg, T + 5_000); // seat 1 exact: 2 points, seat 0: 0
    s = seatChanged(s, 1, "leave");
    expect(s.phase).toBe("over");
    expect(finalStandings(s).map((r) => r.seat)).toEqual([0, 1]);
  });

  it("everyone leaving cancels the match even after rounds were played", () => {
    let s = live(2);
    s = tick(guess(guess(s, 0, 50).state, 1, 100).state, cfg, T + 5_000);
    const first = seatChanged(live(3), 0, "leave");
    expect(seatChanged(seatChanged(first, 1, "leave"), 2, "leave").phase).toBe("cancelled");
    expect(s.phase).toBe("reveal");
  });

  it("everyone leaving in one update cancels, in any order, even after a reveal", () => {
    let s = live(3);
    s = tick(guess(guess(guess(s, 0, 90).state, 1, 95).state, 2, 120).state, cfg, T + 5_000);
    expect(s.phase).toBe("reveal");
    const all = [0, 1, 2].map((seat) => ({ seat, change: "leave" as const }));
    expect(seatsChanged(s, all).phase).toBe("cancelled");
    expect(seatsChanged(s, [...all].reverse()).phase).toBe("cancelled");
    // Two of three leaving together: the one who stayed wins.
    const two = seatsChanged(s, [{ seat: 0, change: "leave" }, { seat: 1, change: "leave" }]);
    expect(two.phase).toBe("over");
    expect(finalStandings(two)[0].seat).toBe(2);
  });

  it("a guess already sent stands when its seat leaves (it is scored, the seat ranks below)", () => {
    let s = live(3);
    s = guess(s, 2, 100).state;
    s = seatChanged(s, 2, "leave");
    s = tick(guess(guess(s, 0, 90).state, 1, 80).state, cfg, T + 5_000);
    expect(s.results[0].entries[2]).toMatchObject({ guess: 100, exact: true, points: 3 });
    expect(finalStandings(s).map((r) => r.seat).at(-1)).toBe(2);
  });
});

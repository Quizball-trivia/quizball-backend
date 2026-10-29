import { describe, expect, it } from 'vitest';
import {
  afterOutage, applyCommand, IDLE_LIMIT, INTRO_MS, seatOrder, seatsChanged, standings, startMatch, tick, TURN_MS, viewOf,
  type Darts501Content, type Darts501State,
} from '../../src/modules/room/games/darts501/darts501.engine.js';
import { D501 } from '../../src/modules/darts501/darts501.rules.js';
import { boardFor, category, pad } from '../darts501/fixture.js';

const legs = [category('a', 'easy'), category('b', 'medium'), category('c', 'hard')];
const content = (seed = 0): Darts501Content => ({ pack: { legs, seed }, boards: legs.map(boardFor) });
const T0 = 1_000_000;

let clock = T0;
const begin = (seats = 2, seed = 0) => { clock = T0 + INTRO_MS; return tick(startMatch(seats, content(seed), T0), clock); };
const say = (s: Darts501State, text: string, seat = s.turn) => applyCommand(s, content(), seat, { type: 'throw', epoch: s.epoch, attempt: s.attempts, text }, clock);
const play = (s: Darts501State, ...texts: string[]) => texts.reduce((st, text) => { const r = say(st, text); expect(r.error).toBeUndefined(); return r.state; }, s);
const pass = (s: Darts501State) => { clock = s.deadline; return tick(s, clock); };
/** A state with the given scores and darts used, on the given seat's turn, new round. */
const at = (s: Darts501State, remaining: number[], turn: number, used = remaining.map(() => 0)): Darts501State => ({ ...s, remaining, used, turn, round: [], thrown: [], finishing: [] });

describe('turns and darts', () => {
  it('a dart takes the number off and passes the turn', () => {
    const s = begin();
    const me = s.turn;
    const r = play(s, 'Aro Bandel');
    expect(r.remaining[me]).toBe(321);
    expect(r.used[me]).toBe(1);
    expect(r.turn).toBe(1 - me);
    expect(r.last).toMatchObject({ v: 'score', e: 'p0', x: 180 });
  });

  it('a miss, over 180 and a bust use the dart and keep the score', () => {
    let s = begin();
    const me = s.turn;
    for (const text of ['Udo Varn', 'Kemi Lund']) {
      s = at(s, [501, 501], me);
      const r = play(s, text);
      expect(r.remaining[me]).toBe(501);
      expect(r.used[me]).toBe(1);
      expect(r.turn).toBe(1 - me);
    }
    const bust = play(at(s, [50, 50], me), 'Ceto Darrin');
    expect(bust.last?.v).toBe('bust');
    expect(bust.remaining[me]).toBe(50);
  });

  it('free answers keep the turn and its deadline; only the attempt moves', () => {
    const s = begin();
    const me = s.turn;
    for (const text of ['Nobody Atall', 'Zorr', 'Wim Xell']) {
      const r = say(s, text);
      expect(r.error).toBeUndefined();
      expect(r.state.turn).toBe(me);
      expect(r.state.deadline).toBe(s.deadline);
      expect(r.state.attempts).toBe(1);
      expect(r.state.used).toEqual(s.used);
    }
    const once = play(s, 'Aro Bandel');
    const again = say(once, 'Bandel');
    expect(again.state.last?.v).toBe('repeat');
    expect(again.state.turn).toBe(once.turn);
    expect(again.state.deadline).toBe(once.deadline);
  });

  it('refuses a stale epoch, a stale attempt, the wrong seat and a dart at the deadline', () => {
    const s = begin();
    const cmd = (over: object) => applyCommand(s, content(), s.turn, { type: 'throw', epoch: s.epoch, attempt: s.attempts, text: 'Aro Bandel', ...over }, clock);
    expect(cmd({ epoch: s.epoch - 1 }).error).toBe('stale_turn');
    expect(cmd({ attempt: 3 }).error).toBe('stale_attempt');
    expect(applyCommand(s, content(), 1 - s.turn, { type: 'throw', epoch: s.epoch, attempt: 0, text: 'Aro Bandel' }, clock).error).toBe('not_your_turn');
    expect(applyCommand(s, content(), s.turn, { type: 'throw', epoch: s.epoch, attempt: 0, text: 'Aro Bandel' }, s.deadline).error).toBe('not_open');
  });

  it('a turn that runs out is a dart that scores nothing', () => {
    const s = begin();
    const me = s.turn;
    const r = pass(s);
    expect(r.used[me]).toBe(1);
    expect(r.remaining[me]).toBe(501);
    expect(r.last?.v).toBe('time');
    expect(r.turn).toBe(1 - me);
    expect(r.deadline).toBe(clock + TURN_MS);
  });
});

describe('checkout and the rest of the round', () => {
  it('after a checkout the rest of the round throws; closest to 0 takes the leg', () => {
    const s0 = begin(3);
    const first = s0.turn;
    const second = (first + 1) % 3;
    let s = at(s0, [0, 0, 0].map(() => 60), first);
    s = play(s, 'Gian Holt'); // first: 60 → 0 (bullseye)
    expect(s.phase).toBe('turn');
    expect(s.turn).toBe(second);
    s = play(s, 'Yan Zorr'); // second: 60 → 10
    s = play(s, 'Sami Tull'); // third: 60 → 55
    expect(s.phase).toBe('legEnd');
    expect(s.legEnd).toEqual({ winner: first, reason: 'checkout' });
    expect(s.legsWon[first]).toBe(1);
  });

  it('a later checkout closer to 0 beats an earlier one in the same round; a tie goes to the first', () => {
    const s0 = begin(2);
    const a = s0.turn;
    const b = 1 - a;
    let s = at(s0, a === 0 ? [65, 60] : [60, 65], a);
    s = play(s, 'Gian Holt'); // a: 65 − 60 = 5 left
    expect(s.phase).toBe('turn');
    // Rebuild: a checks out at −5, b exactly 0.
    s = at(s0, a === 0 ? [55, 60] : [60, 55], a);
    s = play(s, 'Gian Holt'); // a: 55 − 60 = −5
    s = play(s, 'Gian Holt'); // repeat is free: b still on turn
    expect(s.turn).toBe(b);
    s = play(s, 'Emil Fosk'); // b: 60 − 100 bust
    expect(s.legEnd).toEqual({ winner: a, reason: 'checkout' });

    let t = at(s0, a === 0 ? [55, 50] : [50, 55], a);
    t = play(t, 'Gian Holt'); // a: −5
    t = play(t, 'Yan Zorr'); // b: 50 − 50 = 0, closer
    expect(t.legEnd).toEqual({ winner: b, reason: 'checkout' });

    let u = at(s0, a === 0 ? [60, 50] : [50, 60], a);
    u = play(u, 'Gian Holt'); // a: 0
    u = play(u, 'Yan Zorr'); // b: 0, a tie: the first wins
    expect(u.legEnd).toEqual({ winner: a, reason: 'checkout' });
  });

  it('a checkout by the last seat of the round ends the leg at once', () => {
    const s0 = begin(2);
    const a = s0.turn;
    let s = at(s0, [100, 100], a);
    s = play(s, 'Sami Tull'); // a: 95
    s = play(s, 'Emil Fosk'); // b: 0
    expect(s.phase).toBe('legEnd');
    expect(s.legEnd?.winner).toBe(1 - a);
  });

  it('when the darts run out the lowest score takes the leg, a tie takes nobody', () => {
    const s0 = begin(2);
    const a = s0.turn;
    const last = D501.darts - 1;
    let s = at(s0, [300, 300], a, [last, last]);
    s = play(s, 'Odo Prenn'); // a: 299
    s = play(s, 'Sami Tull'); // b: 295
    expect(s.legEnd).toEqual({ winner: 1 - a, reason: 'darts' });
    let t = at(s0, [300, 300], a, [last, last]);
    t = play(t, 'Sami Tull');
    t = play(t, 'Udo Varn'); // miss: 300 vs 295
    expect(t.legEnd?.winner).toBe(a);
    let u = at(s0, [300, 300], a, [last, last]);
    u = play(u, 'Odo Prenn');
    u = play(u, 'Udo Varn');
    expect(u.legEnd).toEqual({ winner: a, reason: 'darts' });
    let v = at(s0, [300, 300], a, [last, last]);
    v = play(v, 'Udo Varn');
    v = play(v, 'Kemi Lund');
    expect(v.legEnd).toEqual({ winner: null, reason: 'darts' });
  });
});

describe('legs and the match', () => {
  const winLeg = (s: Darts501State, seat: number): Darts501State => {
    let t = at(s, s.status.map(() => 60), seat);
    t = play(t, 'Gian Holt');
    for (let k = 0; t.phase === 'turn'; k += 1) t = play(t, pad(k));
    expect(t.legEnd?.winner).toBe(seat);
    return t;
  };

  it('a 1v1 is first to two legs; the opener of each leg comes from the seed order', () => {
    let s = begin(2, 7);
    const order = seatOrder(2, 7);
    expect(s.turn).toBe(order[0]);
    s = winLeg(s, 0);
    s = pass(s);
    expect(s.leg).toBe(1);
    expect(s.turn).toBe(order[1]);
    expect(s.remaining).toEqual([501, 501]);
    s = winLeg(s, 0);
    expect(viewOf(s, content(), 0, 'en').final).toBe(true);
    s = pass(s);
    expect(s.phase).toBe('over');
    expect(standings(s)).toEqual([{ seat: 0, points: 2, roundWins: 2, place: 1 }, { seat: 1, points: 0, roundWins: 0, place: 2 }]);
  });

  it('a party plays all three legs; the table is legs, then less left over the legs', () => {
    let s = begin(3);
    s = winLeg(s, 0); s = pass(s);
    s = winLeg(s, 0); s = pass(s);
    expect(s.phase).toBe('turn');
    s = winLeg(s, 1);
    s = pass(s);
    expect(s.phase).toBe('over');
    const table = standings(s);
    expect(table[0]).toMatchObject({ seat: 0, points: 2, place: 1 });
    expect(table[1]).toMatchObject({ seat: 1, points: 1, place: 2 });
  });
});

describe('idle, leaving and outages', () => {
  it(`${IDLE_LIMIT} turns in a row run out bench the seat; it keeps its seat but throws no more`, () => {
    let s = begin(3);
    const idler = s.turn;
    for (let n = 0; n < IDLE_LIMIT; n += 1) {
      expect(s.turn).toBe(idler);
      s = pass(s);
      for (let k = 0; s.turn !== idler && s.phase === 'turn'; k += 1) s = play(s, pad(n * 4 + k));
      if (n < IDLE_LIMIT - 1) expect(s.benched[idler]).toBe(false);
    }
    expect(s.benched[idler]).toBe(true);
    expect(s.status[idler]).not.toBe('withdrawn');
    expect(s.quit[idler]).toBe(true);
    expect(s.turn).not.toBe(idler);
    // The rest play on without the benched seat, through this leg and the next ones.
    // A footballer may be thrown again in a new leg: the one-pointers last a leg each.
    for (let guard = 0; s.phase !== 'over' && guard < 200; guard += 1) {
      if (s.phase === 'turn') {
        expect(s.turn).not.toBe(idler);
        s = play(s, pad(s.thrown.filter((d) => d.e !== null).length));
      } else s = pass(s);
    }
    expect(s.phase).toBe('over');
    expect(s.used[idler]).toBe(D501.darts);
  });

  it('a free answer is not a dart: it does not reset the idle count; a thrown dart does', () => {
    let t = begin(2);
    const me = t.turn;
    t = pass(t); t = play(t, pad(0));
    expect(t.idle[me]).toBe(1);
    t = say(t, 'Nobody Atall').state;
    expect(t.idle[me]).toBe(1);
    t = play(t, pad(1));
    expect(t.idle[me]).toBe(0);
  });

  it('a benched seat in a 1v1 ends the match like a leave', () => {
    let s = begin(2);
    const idler = s.turn;
    for (let n = 0; n < IDLE_LIMIT; n += 1) { s = pass(s); if (s.phase === 'turn' && s.turn !== idler) s = play(s, pad(n)); }
    expect(s.phase).toBe('cancelled');
  });

  it('a 1v1 seat that leaves before any leg ends cancels; after one, the other wins', () => {
    const s = begin(2);
    expect(seatsChanged(s, [{ seat: 0, change: 'leave' }], clock).phase).toBe('cancelled');
    let t = at(s, [60, 60], s.turn);
    t = play(t, 'Gian Holt');
    t = play(t, 'Udo Varn');
    t = pass(t);
    const left = seatsChanged(t, [{ seat: t.turn, change: 'leave' }], clock);
    expect(left.phase).toBe('over');
    expect(standings(left).find((r) => r.place === 1)?.seat).toBe(1 - t.turn);
  });

  it('leaving on your turn passes it at once; a seat that checked out and left is out of the finish', () => {
    const s0 = begin(3);
    const first = s0.turn;
    let s = at(s0, [60, 60, 60], first);
    s = play(s, 'Gian Holt'); // first checks out
    s = seatsChanged(s, [{ seat: first, change: 'leave' }], clock);
    expect(s.finishing).toEqual([]);
    expect(s.phase).toBe('turn');
    const onTurn = s.turn;
    const after = seatsChanged(s, [{ seat: onTurn, change: 'leave' }], clock);
    expect(after.phase).toBe('cancelled');
  });

  it('the only finisher leaving: the leg goes on; the last seat owed a dart leaving: the leg ends at once', () => {
    const s0 = begin(3);
    const first = s0.turn;
    let s = at(s0, [60, 60, 60], first);
    s = play(s, 'Gian Holt');
    const gone = seatsChanged(s, [{ seat: first, change: 'leave' }], clock);
    expect(gone.phase).toBe('turn');
    expect(gone.finishing).toEqual([]);
    let t = play(s, pad(0));
    const lastOwed = t.turn;
    t = seatsChanged(t, [{ seat: lastOwed, change: 'leave' }], clock);
    expect(t.phase).toBe('legEnd');
    expect(t.legEnd).toEqual({ winner: first, reason: 'checkout' });
  });

  it('a checkout adds 0 to the total left, never a negative number', () => {
    const s0 = begin(2);
    const a = s0.turn;
    let s = at(s0, a === 0 ? [55, 300] : [300, 55], a);
    s = play(s, 'Gian Holt'); // a: −5
    s = play(s, pad(0));
    expect(s.leftTotal[a]).toBe(0);
    expect(s.leftTotal[1 - a]).toBe(299);
  });

  it('a 1v1 whose legs are drawn plays all three; level legs go to less left, then a shared first place', () => {
    const last = D501.darts - 1;
    let s = begin(2);
    const draw = (st: Darts501State, left: number) => {
      let t = at(st, [left + 1, left + 1], st.turn, [last, last]);
      t = play(t, 'Odo Prenn');
      t = play(t, pad(5 + st.leg));
      return t;
    };
    s = draw(s, 300);
    expect(s.legEnd).toEqual({ winner: null, reason: 'darts' });
    expect(viewOf(s, content(), 0, 'en').final).toBe(false);
    s = pass(s); s = draw(s, 200); s = pass(s); s = draw(s, 100);
    expect(viewOf(s, content(), 0, 'en').final).toBe(true);
    s = pass(s);
    expect(s.phase).toBe('over');
    expect(standings(s).map((r) => r.place)).toEqual([1, 1]);
  });

  it('an away seat keeps its turn and its clock', () => {
    const s = begin(2);
    const r = seatsChanged(s, [{ seat: s.turn, change: 'away' }], clock);
    expect(r.turn).toBe(s.turn);
    expect(r.deadline).toBe(s.deadline);
    expect(r.status[s.turn]).toBe('away');
  });

  it('after an outage the open turn gets a fresh window', () => {
    const s = begin(2);
    expect(afterOutage(s, clock + 99_999).deadline).toBe(clock + 99_999 + TURN_MS);
  });
});

describe('what a seat sees', () => {
  it('never the category numbers, only the darts thrown and counts', () => {
    const s = begin(2);
    const v = viewOf(s, content(), 0, 'en');
    const json = JSON.stringify(v);
    expect(json).not.toContain('"entries"');
    expect(json).not.toContain('Ceto Darrin');
    expect(v.outs).toBeNull();
    const thrown = play(s, 'Aro Bandel');
    expect(JSON.stringify(viewOf(thrown, content(), 0, 'en'))).toContain('Aro Bandel');
  });

  it('shows the missed finishes from the viewer’s own score at the leg end only', () => {
    const s0 = begin(2);
    const a = s0.turn;
    let s = at(s0, a === 0 ? [60, 50] : [50, 60], a);
    s = play(s, 'Gian Holt');
    const viewer = 1 - a;
    expect(viewOf(s, content(), viewer, 'en').legEnd).toBeNull();
    s = play(s, 'Udo Varn');
    const v = viewOf(s, content(), viewer, 'en');
    expect(v.legEnd?.missed).toEqual([{ name: 'Yan Zorr', value: 50 }]);
    expect(viewOf(s, content(), a, 'en').legEnd?.missed).toEqual([]);
  });
});

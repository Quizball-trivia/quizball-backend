import { describe, expect, it } from 'vitest';
import {
  applyCommand, afterOutage, INTRO_MS, LIST_END_MS, LIVES, seatOrder, seatsChanged, standings, startMatch, tick, TURN_MS, viewOf,
  type TenableContent, type TenableState,
} from '../../src/modules/room/games/tenable/tenable.engine.js';
import type { TenableList } from '../../src/modules/tenable/tenable.content.js';
import { buildDirectory, TENABLE_MATCHER_VERSION, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';

// Invented footballers only: the repository is public.
const NAMES = ['Aro Bandel', 'Ceto Darrin', 'Emil Fosk', 'Gian Holt', 'Ivo Jarrel', 'Kemi Lund', 'Milo Narr', 'Odo Prenn', 'Quin Rask', 'Sami Tull'];
const OTHERS = ['Udo Varn', 'Wim Xell', 'Yan Zorr'];
const rows: TenableEntity[] = [...NAMES, ...OTHERS].map((name, i) => ({ eid: `p${i}`, name, known: name.split(' ')[1], fame: 90 - i, aliases: [], qualifier: null }));
const dir = buildDirectory('player', 'rel', rows);
const list = (id: string): TenableList => ({
  id, kind: 'player', release: 'rel', matcher: TENABLE_MATCHER_VERSION, tier: 'easy', topicKey: id,
  title: { en: `List ${id}`, es: `Lista ${id}`, ka: `სია ${id}`, tr: `Liste ${id}` }, note: null, asOf: null,
  slots: NAMES.map((_, i) => ({ eid: `p${i}`, figure: { value: 100 - i, unit: 'goals' as const } })),
});
const content = (seed = 0): TenableContent => ({ pack: { lists: [list('a'), list('b'), list('c')], seed }, directories: [dir, dir, dir] });
const T0 = 1_000_000;

const begin = (seats = 2, seed = 0) => tick(startMatch(seats, content(seed), T0), T0 + INTRO_MS);
const say = (s: TenableState, seat: number, text: string, at = T0 + INTRO_MS + 1, c = content()) =>
  applyCommand(s, c, seat, { type: 'answer', epoch: s.epoch, attempt: s.attempts, text }, at);

describe('turns', () => {
  it('a right answer takes its slot and passes the turn', () => {
    const s = begin();
    expect(s.phase).toBe('turn');
    const me = s.turn;
    const r = say(s, me, 'Darrin').state;
    expect(r.claimed[1]).toBe(me);
    expect(r.turn).toBe(1 - me);
    expect(r.last?.kind).toBe('right');
  });

  it('a wrong answer costs a life and passes the turn', () => {
    const s = begin();
    const me = s.turn;
    const r = say(s, me, 'Udo Varn').state;
    expect(r.lives[me]).toBe(LIVES - 1);
    expect(r.lives[1 - me]).toBe(LIVES);
    expect(r.turn).toBe(1 - me);
    expect(r.last).toMatchObject({ kind: 'wrong', eid: 'p10' });
  });

  it('free answers keep the turn and its deadline; only the attempt moves', () => {
    const s = begin();
    const me = s.turn;
    for (const text of ['Nobody Atall', 'Darrinn Darrinn Darrinn', 'de']) {
      const r = say(s, me, text, s.deadline - 5).state;
      expect(r.turn).toBe(me);
      expect(r.deadline).toBe(s.deadline);
      expect(r.attempts).toBe(1);
      expect(r.lives).toEqual(s.lives);
    }
    const once = say(s, me, 'Darrin').state;
    const again = say({ ...once, turn: me, epoch: once.epoch }, me, 'Ceto Darrin').state;
    expect(again.last?.kind).toBe('repeat');
    expect(again.deadline).toBe(once.deadline);
  });

  it('refuses stale turns and attempts, other seats, late answers', () => {
    const s = begin();
    const me = s.turn;
    expect(applyCommand(s, content(), me, { type: 'answer', epoch: s.epoch - 1, attempt: 0, text: 'Darrin' }, T0 + INTRO_MS + 1).error).toBe('stale_turn');
    expect(applyCommand(s, content(), me, { type: 'answer', epoch: s.epoch, attempt: 1, text: 'Darrin' }, T0 + INTRO_MS + 1).error).toBe('stale_attempt');
    expect(say(s, 1 - me, 'Darrin').error).toBe('not_your_turn');
    expect(say(s, me, 'Darrin', s.deadline).error).toBe('not_open');
  });

  it('a timeout costs a life; at 0 lives the seat sits out and a lone survivor keeps going', () => {
    let s = begin();
    const first = s.turn, second = 1 - first;
    s = tick(s, s.deadline); // first times out
    s = tick(s, s.deadline); // second times out
    s = tick(s, s.deadline); // first times out again: out of lives
    expect(s.lives[first]).toBe(0);
    expect(s.lives[second]).toBe(1);
    expect(s.turn).toBe(second);
    s = say(s, second, 'Bandel', s.deadline - 1).state;
    expect(s.turn).toBe(second); // alone, still on turn
    s = say(s, second, 'Wim Xell', s.deadline - 1).state;
    expect(s.phase).toBe('listEnd'); // nobody with lives left
    expect(s.listEnd).toBe('out');
  });
});

describe('lists and the match', () => {
  it('ten found ends the list; slots score their number; three lists end the match', () => {
    let s = begin();
    NAMES.forEach((name, i) => { s = say(s, s.turn, name, s.deadline - 1).state; expect(s.claimed[i]).not.toBeNull(); });
    expect(s.phase).toBe('listEnd');
    expect(s.listEnd).toBe('complete');
    // The opener took slots 1,3,5,7,9 (25), the other seat slots 2,4,6,8,10 (30).
    const opener = s.claimed[0]!;
    expect(s.listPoints![opener]).toBe(25);
    expect(s.listPoints![1 - opener]).toBe(30);
    s = tick(s, s.deadline);
    expect(s.phase).toBe('turn');
    expect(s.list).toBe(1);
    expect(s.turn).toBe(seatOrder(2, 0)[1]);
    expect(s.lives).toEqual([LIVES, LIVES]);
    s = tick({ ...s, phase: 'listEnd', list: 2, revealed: 3 }, s.deadline + LIST_END_MS);
    expect(s.phase).toBe('over');
  });

  it('openers follow a random seat order fixed by the seed, rotating, skipping seats that left', () => {
    for (const seats of [2, 3, 4, 5, 6]) {
      for (const seed of [0, 1, 7, 123456, 0xffffffff]) {
        const order = seatOrder(seats, seed);
        expect([...order].sort()).toEqual(Array.from({ length: seats }, (_, i) => i));
        let s = begin(seats, seed);
        expect(s.turn).toBe(order[0]);
        s = tick({ ...s, phase: 'listEnd', points: s.points.map((_, i) => 50 - i) }, s.deadline);
        expect(s.turn).toBe(order[1 % seats]); // the score plays no part
      }
    }
    const s = begin(3, 7);
    const order = seatOrder(3, 7);
    const after = tick({ ...seatsChanged(s, [{ seat: order[1], change: 'leave' }], s.deadline - 1), phase: 'listEnd' }, s.deadline);
    expect(after.turn).toBe(order[2]);
  });

  it('the first opener is uniform over the seats (no seat favoured)', () => {
    for (const seats of [2, 3, 4, 6]) {
      const counts = Array.from({ length: seats }, () => 0);
      const n = 6000;
      for (let seed = 0; seed < n; seed += 1) counts[seatOrder(seats, seed * 2654435761 >>> 0)[0]] += 1;
      for (const c of counts) expect(Math.abs(c / n - 1 / seats)).toBeLessThan(0.03);
    }
  });

  it('seed orders are spread: every seat opens list 1 for some seed', () => {
    for (const seats of [2, 4, 6]) {
      const firsts = new Set(Array.from({ length: 200 }, (_, seed) => seatOrder(seats, seed * 7919)[0]));
      expect(firsts.size).toBe(seats);
    }
  });

  it('places are shared on equal points; a seat that quit ranks last', () => {
    const s = { ...begin(3), points: [10, 10, 30], found: [3, 2, 4], quit: [false, false, true] };
    expect(standings(s).map((r) => [r.seat, r.place])).toEqual([[0, 1], [1, 1], [2, 3]]);
  });
});

describe('seats', () => {
  it('the seat on turn leaving passes the turn without charging anyone', () => {
    const start = begin(3);
    const onTurn = start.turn;
    const s = seatsChanged(start, [{ seat: onTurn, change: 'leave' }], T0 + INTRO_MS + 5);
    expect(s.turn).toBe((onTurn + 1) % 3);
    expect(s.lives).toEqual([0, 1, 2].map((seat) => (seat === onTurn ? 0 : LIVES)));
    expect(s.quit[onTurn]).toBe(true);
  });

  it('down to one seat: cancelled before any list ended, a result after', () => {
    expect(seatsChanged(begin(2), [{ seat: 1, change: 'leave' }], T0 + INTRO_MS + 5).phase).toBe('cancelled');
    expect(seatsChanged({ ...begin(2), revealed: 1 }, [{ seat: 1, change: 'leave' }], T0 + INTRO_MS + 5).phase).toBe('over');
  });

  it('an outage gives the open turn a fresh window', () => {
    const s = begin();
    expect(afterOutage(s, s.deadline + 60_000).deadline).toBe(s.deadline + 60_000 + TURN_MS);
  });
});

describe('view', () => {
  it('hidden slots carry only their rank until the list is revealed', () => {
    let s = begin();
    const me = s.turn;
    s = say(s, me, 'Darrin').state;
    const v = viewOf(s, content(), 1 - me, 'es');
    expect(v.slots[1]).toEqual({ rank: 2, name: 'Ceto Darrin', detail: '99 goles', by: me, missed: false });
    for (const slot of v.slots.filter((x) => x.rank !== 2)) expect(slot).toEqual({ rank: slot.rank, name: null, detail: null, by: null, missed: false });
    expect(JSON.stringify(v)).not.toContain('Aro Bandel');
    expect(JSON.stringify(v)).not.toContain('p0');
  });

  it('after the list ends every slot is shown, unfound ones marked missed', () => {
    let s = begin();
    const me = s.turn;
    s = say(s, me, 'Darrin').state;
    for (let i = 0; i < 4; i += 1) s = tick(s, s.deadline);
    expect(s.phase).toBe('listEnd');
    const v = viewOf(s, content(), 0, 'en');
    expect(v.slots[0]).toMatchObject({ name: 'Aro Bandel', detail: '100 goals', by: null, missed: true });
    expect(v.slots[1]).toMatchObject({ name: 'Ceto Darrin', by: me, missed: false });
  });
});

import { describe, expect, it } from 'vitest';
import { buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import { draw, judge, pickStart, startBucket } from '../../src/modules/room/games/name-chain/name-chain.core.js';
import {
  afterOutage, applyCommand, INTRO_MS, MAX_ROUNDS, matchOver, ROUND_END_MS, ROUNDS_TO_WIN, seatsChanged, standings, startMatch, tick, TURN_MS, viewOf,
  type NameChainContent, type NameChainState,
} from '../../src/modules/room/games/name-chain/name-chain.engine.js';
import { nameChainRoomEngine } from '../../src/modules/room/games/name-chain/name-chain.room.js';

// Invented footballers only: the repository is public. Names are built so every letter used below has several answers.
const P = (pid: string, name: string, fame: number): UniversePlayer => ({ pid, name, game: name.split(' ').pop()!, fame, aliases: [] });
const ROWS = [
  P('p-bako', 'Bako', 90), P('p-orlen', 'Tarin Orlen', 80), P('p-nurak', 'Nurak', 70), P('p-kosel', 'Emir Kosel', 60), P('p-lumar', 'Lumar', 50),
  P('p-ravin', 'Dago Ravin', 45), P('p-nesto', 'Nesto', 40), P('p-olbin', 'Olbin', 35), P('p-nesto2', 'Niko Nesto', 20), P('p-kato', 'Kato', 10),
  P('p-onur', 'Onur Vex', 5), P('p-nilo', 'Nilo', 4), P('p-oran', 'Oran', 3),
];
const universe = buildUniverse('rel-1', ROWS);
const content: NameChainContent = { pack: { release: 'rel-1', seed: 7 }, universe };
/** A match in its first turn, the chain standing at `start`, seat 0 on turn. */
const from = (start: string, seats = 2): NameChainState => ({
  ...startMatch(seats, 0), phase: 'turn', chain: [{ pid: start, by: null }], used: [start], letter: universe.last(start), turn: 0, epoch: 1, deadline: TURN_MS, draws: 1,
});
const say = (s: NameChainState, seat: number, text: string, now: number, attempt = s.attempts, epoch = s.epoch) => applyCommand(s, content, seat, { type: 'answer', epoch, attempt, text }, now);
const pass = (s: NameChainState, seat: number, now: number, epoch = s.epoch) => applyCommand(s, content, seat, { type: 'pass', epoch }, now);

describe('name chain: the chain', () => {
  it('draws the same value for the same seed and counter, and different ones otherwise', () => {
    expect(draw(7, 3)).toBe(draw(7, 3));
    expect(draw(7, 3)).not.toBe(draw(7, 4));
    expect(draw(8, 3)).not.toBe(draw(7, 3));
    for (let i = 0; i < 50; i += 1) { expect(draw(i, i)).toBeGreaterThanOrEqual(0); expect(draw(i, i)).toBeLessThan(1); }
  });
  it('splits start names into two stable halves', () => {
    expect(startBucket('p-bako')).toBe(startBucket('p-bako'));
    expect(new Set(ROWS.map((p) => startBucket(p.pid))).size).toBe(2);
  });
  it('picks a start nobody has used, the same one for the same draw', () => {
    const used = new Set(['p-bako']);
    const pick = pickStart(universe, used, 1, 0.3);
    expect(pick).not.toBeNull();
    expect(pick).not.toBe('p-bako');
    expect(pickStart(universe, used, 1, 0.3)).toBe(pick);
    expect(pickStart(universe, new Set(ROWS.map((p) => p.pid)), 1, 0.3)).toBeNull();
    // The caller's half is kept while it has anybody left, however obscure; only then the other half.
    for (const bucket of [0, 1] as const) {
      const mine = ROWS.filter((p) => startBucket(p.pid) === bucket).map((p) => p.pid);
      const taken = new Set<string>();
      for (let i = 0; i < mine.length; i += 1) {
        const next = pickStart(universe, taken, bucket, 0.5);
        if (next === null || startBucket(next) !== bucket) break;
        taken.add(next);
      }
      const leftover = pickStart(universe, taken, bucket, 0.5);
      if (leftover !== null && startBucket(leftover) === bucket) throw new Error('the loop above stops only when the half is spent');
      expect(mine.filter((pid) => !taken.has(pid)).every((pid) => universe.last(pid) === '' || [...universe.starting(universe.last(pid))].filter((other) => !taken.has(other) && other !== pid).length === 0)).toBe(true);
    }
  });
  it('judges a text on a letter: a free footballer, an unknown name, a wrong letter, a repeat', () => {
    expect(judge(universe, new Set(), 'O', 'Tarin Orlen')).toEqual({ verdict: 'ok', pid: 'p-orlen' });
    expect(judge(universe, new Set(), 'T', 'orlen')).toEqual({ verdict: 'ok', pid: 'p-orlen' });
    expect(judge(universe, new Set(), 'O', 'Nobody Atall')).toEqual({ verdict: 'unknown', pid: null });
    expect(judge(universe, new Set(), 'O', 'Kato')).toEqual({ verdict: 'letter', pid: 'p-kato' });
    expect(judge(universe, new Set(['p-orlen']), 'O', 'Orlen')).toEqual({ verdict: 'repeat', pid: 'p-orlen' });
    // A namesake still counts once the best known one is used.
    expect(judge(universe, new Set(['p-nesto']), 'N', 'Nesto')).toEqual({ verdict: 'ok', pid: 'p-nesto2' });
  });
});

describe('name chain: turns', () => {
  it('starts with an intro, then a start name of the room half and the first seat on turn', () => {
    const intro = startMatch(3, 0);
    expect(intro).toMatchObject({ phase: 'intro', deadline: INTRO_MS });
    expect(tick(intro, content, INTRO_MS - 1)).toBe(intro);
    const first = tick(intro, content, INTRO_MS);
    expect(first).toMatchObject({ phase: 'turn', round: 0, turn: 0, epoch: 1, draws: 1, deadline: INTRO_MS + TURN_MS });
    expect(first.chain).toHaveLength(1);
    expect(first.used).toEqual([first.chain[0].pid]);
    expect(first.letter).toBe(universe.last(first.chain[0].pid));
    // The same pack starts every replica on the same name.
    expect(tick(startMatch(3, 0), content, INTRO_MS).chain).toEqual(first.chain);
  });

  it('accepts a name on the letter, passes the turn and restarts the clock', () => {
    const s = say(from('p-bako'), 0, 'Orlen', 4_000).state; // Bako -> O
    expect(s).toMatchObject({ letter: 'N', turn: 1, epoch: 2, attempts: 0, deadline: 4_000 + TURN_MS, answers: [1, 0] });
    expect(s.chain.map((l) => l.pid)).toEqual(['p-bako', 'p-orlen']);
    expect(s.last).toMatchObject({ kind: 'ok', seat: 0, pid: 'p-orlen' });
  });

  it('a wrong answer costs nothing but time: the clock keeps running and the turn stays', () => {
    const s = from('p-bako');
    const wrong = say(s, 0, 'Kato', 3_000).state;
    expect(wrong).toMatchObject({ turn: 0, epoch: 1, attempts: 1, deadline: TURN_MS, last: { kind: 'letter', pid: 'p-kato' } });
    expect(say(wrong, 0, 'Whoever', 5_000).state).toMatchObject({ attempts: 2, last: { kind: 'unknown' } });
    expect(say(wrong, 0, 'Olbin', 9_999).state.turn).toBe(1);
  });

  it('judges each attempt once, and only the seat on turn, on the turn it was sent for', () => {
    const s = from('p-bako');
    const wrong = say(s, 0, 'Kato', 3_000).state;
    expect(say(wrong, 0, 'Kato', 3_100, 0).error).toBe('stale_attempt');
    expect(say(s, 1, 'Orlen', 3_000).error).toBe('not_your_turn');
    expect(say(s, 0, 'Orlen', 3_000, 0, 9).error).toBe('stale_turn');
    expect(say(s, 0, 'Orlen', TURN_MS).error).toBe('not_open');
    expect(say(s, 0, '   ', 3_000).error).toBe('invalid');
    expect(pass(s, 1, 3_000).error).toBe('not_your_turn');
    expect(say(startMatch(2, 0), 0, 'Orlen', 100).error).toBe('not_open');
  });

  it('never accepts the same footballer twice in a match, across rounds too', () => {
    let s = say(from('p-bako'), 0, 'Orlen', 1_000).state; // -> N, seat 1
    s = say(s, 1, 'Nurak', 2_000).state; // -> K, seat 0
    s = say(s, 0, 'Kosel', 3_000).state; // -> L, seat 1
    s = say(s, 1, 'Lumar', 4_000).state; // -> R, seat 0
    s = say(s, 0, 'Ravin', 5_000).state; // -> N, seat 1
    expect(say(s, 1, 'Nurak', 6_000).state.last).toMatchObject({ kind: 'repeat', pid: 'p-nurak' });
    expect(s.used).toHaveLength(6);
  });
});

describe('name chain: rounds', () => {
  it('the clock or giving up puts the seat out; with two seats that ends the round for the other', () => {
    const timed = tick(from('p-bako'), content, TURN_MS);
    expect(timed).toMatchObject({ phase: 'roundEnd', ended: { seat: 0, reason: 'time' }, roundWinner: 1, points: [0, 1], roundsWon: 1, deadline: TURN_MS + ROUND_END_MS });
    const gaveUp = pass(from('p-bako'), 0, 2_000).state;
    expect(gaveUp).toMatchObject({ phase: 'roundEnd', ended: { seat: 0, reason: 'pass' }, roundWinner: 1 });
  });

  it('three or more: the seat is out and the chain goes on from the same letter with a fresh clock', () => {
    const s = tick(from('p-bako', 3), content, TURN_MS);
    expect(s).toMatchObject({ phase: 'turn', alive: [false, true, true], turn: 1, letter: 'O', epoch: 2, deadline: 2 * TURN_MS, ended: { seat: 0, reason: 'time' } });
    const last = pass(s, 1, 12_000).state;
    expect(last).toMatchObject({ phase: 'roundEnd', roundWinner: 2, points: [0, 0, 1] });
  });

  it('everyone is back in for the next round, the opener rotates, and used names stay used', () => {
    let s = tick(from('p-bako'), content, TURN_MS);
    s = tick(s, content, s.deadline);
    expect(s).toMatchObject({ phase: 'turn', round: 1, turn: 1, alive: [true, true], draws: 2 });
    expect(s.used).toContain('p-bako');
    expect(s.chain[0].pid).not.toBe('p-bako');
  });

  it('first to three points wins; at the round cap the table decides and level is a shared first place', () => {
    const at = (points: number[], round: number): NameChainState => ({ ...from('p-bako', points.length), phase: 'roundEnd', points, round, deadline: 0 });
    expect(matchOver(at([ROUNDS_TO_WIN, 1], 3))).toBe(true);
    expect(tick(at([ROUNDS_TO_WIN, 1], 3), content, 1).phase).toBe('over');
    expect(tick(at([2, 2], 3), content, 1)).toMatchObject({ phase: 'turn', round: 4 });
    const capped = tick(at([2, 2, 1], MAX_ROUNDS - 1), content, 1);
    expect(capped.phase).toBe('over');
    expect(standings(capped).map((r) => [r.seat, r.place])).toEqual([[0, 1], [1, 1], [2, 3]]);
  });
});

describe('name chain: seats leaving', () => {
  it('the seat on turn leaves: its turn passes on at once, at the time it left', () => {
    const s = seatsChanged(from('p-bako', 3), [{ seat: 0, change: 'leave' }], 4_000);
    expect(s).toMatchObject({ phase: 'turn', turn: 1, alive: [false, true, true], status: ['withdrawn', 'in', 'in'], ended: { seat: 0, reason: 'left' }, deadline: 4_000 + TURN_MS, epoch: 2 });
  });

  it('a seat that is not on turn leaves: the turn and its clock are untouched', () => {
    const s = seatsChanged(from('p-bako', 3), [{ seat: 2, change: 'leave' }], 4_000);
    expect(s).toMatchObject({ turn: 0, epoch: 1, deadline: TURN_MS, alive: [true, true, false] });
  });

  it('leaving a two-seat match: cancelled before any round was won, a loss after', () => {
    expect(seatsChanged(from('p-bako'), [{ seat: 1, change: 'leave' }], 4_000).phase).toBe('cancelled');
    const later: NameChainState = { ...from('p-bako'), points: [1, 0], roundsWon: 1, round: 1 };
    const left = seatsChanged(later, [{ seat: 0, change: 'leave' }], 4_000);
    expect(left.phase).toBe('over');
    expect(standings(left).map((r) => [r.seat, r.place])).toEqual([[1, 1], [0, 2]]);
  });

  it('once the deciding round is over, leaving changes nothing', () => {
    const won: NameChainState = { ...from('p-bako'), phase: 'roundEnd', points: [ROUNDS_TO_WIN, 0], roundsWon: 3, round: 2, deadline: 9_000 };
    const left = seatsChanged(won, [{ seat: 0, change: 'leave' }], 5_000);
    expect(left.phase).toBe('roundEnd');
    expect(standings(tick(left, content, 9_000)).map((r) => [r.seat, r.place])).toEqual([[0, 1], [1, 2]]);
  });

  it('an away seat keeps its turn and its clock; an outage gives the turn its window again', () => {
    const away = seatsChanged(from('p-bako', 3), [{ seat: 0, change: 'away' }], 4_000);
    expect(away).toMatchObject({ turn: 0, deadline: TURN_MS, status: ['away', 'in', 'in'] });
    expect(tick(away, content, TURN_MS)).toMatchObject({ turn: 1, alive: [false, true, true] });
    expect(afterOutage(away, 60_000).deadline).toBe(60_000 + TURN_MS);
  });
});

describe('name chain: what a seat is shown, and the pack', () => {
  it('shows the chain, whose turn it is, the tokens to answer with, and examples only once a turn was lost', () => {
    const s = say(from('p-bako', 3), 0, 'Kato', 2_000).state;
    const v = viewOf(s, content, 1);
    expect(v).toMatchObject({ phase: 'turn', format: 'party', letter: 'O', turn: 0, epoch: 1, attempt: 1, mySeat: 1, could: [], standings: null, final: false });
    expect(v.chain).toEqual([{ name: 'Bako', game: 'Bako', by: null }]);
    expect(v.last).toMatchObject({ kind: 'letter', name: 'Kato', starts: ['K'], seat: 0 });
    const ended = viewOf(tick(from('p-bako'), content, TURN_MS), content, 0);
    expect(ended.could.length).toBeGreaterThan(0);
    expect(ended.could).not.toContain('Bako');
    expect(ended.roundWinner).toBe(1);
  });

  it('a pack is a release and a seed; anything else is refused', async () => {
    expect(nameChainRoomEngine.parseContent({ release: 'rel-1', seed: 7 })).toMatchObject({ pack: { release: 'rel-1', seed: 7 } });
    expect(nameChainRoomEngine.parseContent({ release: 'rel-1' })).toBeNull();
    expect(nameChainRoomEngine.parseContent({ release: 'rel-1', seed: 7, extra: 1 })).toBeNull();
    const dealt = await nameChainRoomEngine.deal(async () => [{ item_id: 'nc-rel-1', difficulty: 'easy', payload: { id: 'nc-rel-1', release: 'rel-1' } }], null);
    expect(dealt).toMatchObject({ itemIds: ['nc-rel-1'], content: { release: 'rel-1' } });
    expect(await nameChainRoomEngine.deal(async () => [], null)).toBeNull();
  });
});

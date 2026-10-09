import { describe, expect, it } from 'vitest';
import { buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import * as chain from '../../src/modules/name-chain-daily/name-chain-daily.rules.js';
import type { SharedPlayerItem } from '../../src/modules/room/games/shared-player/shared-player.engine.js';
import * as shared from '../../src/modules/shared-player-daily/shared-player-daily.rules.js';
import { ANSWER_GRACE_MS } from '../../src/modules/wordgame-daily/wordgame-daily.shared.js';
import { contentHash, parseDaysFile } from '../../src/modules/wordgame-daily/wordgame-daily.seed.js';
import { CONTENT_START } from '../../src/modules/shared-player-daily/shared-player-daily.days.js';
import { addDays } from '../../src/modules/daily/daily.calendar.js';

// Invented footballers and clubs only: the repository is public.
const P = (pid: string, name: string, fame: number): UniversePlayer => ({ pid, name, game: name.split(' ').pop()!, fame, aliases: [] });
const universe = buildUniverse('rel-1', [
  P('p-bako', 'Bako', 90), P('p-orlen', 'Tarin Orlen', 80), P('p-nurak', 'Nurak', 70), P('p-kosel', 'Emir Kosel', 60), P('p-lumar', 'Lumar', 50),
  P('p-ravin', 'Dago Ravin', 45), P('p-nesto', 'Nesto', 40), P('p-olbin', 'Olbin', 35), P('p-nesto2', 'Niko Nesto', 20), P('p-kato', 'Kato', 10),
  P('p-onur', 'Onur Vex', 5), P('p-nilo', 'Nilo', 4), P('p-oran', 'Oran', 3),
]);
const label = (name: string) => ({ es: name, en: name, ka: name, tr: name });
const pair = (n: number): SharedPlayerItem => ({
  id: `pair-${n}`, release: 'rel-1', a: { key: `north-${n}`, label: label(`North ${n}`), crest: '/clubs/n.webp' }, b: { key: `south-${n}`, label: label(`South ${n}`), crest: '/clubs/s.webp' },
  accepted: ['p-orlen', 'p-kosel', 'p-ravin'], examples: 2,
});
const pairs = Array.from({ length: 10 }, (_, n) => pair(n));

describe('played for both, solo', () => {
  const open = () => shared.next(shared.newState(), 1_000);
  const view = (s: shared.RunState, disclose = false) => shared.publicState(s, '2026-10-08', pairs, universe, 5_000, { ranked: true, disclose });

  it('shows no clubs until the first pair is opened, then starts its clock', () => {
    expect(view(shared.newState()).clubs).toBeNull();
    const s = open();
    expect(s).toMatchObject({ r: 0, open: true, dl: 1_000 + shared.RACE_MS });
    expect(view(s).clubs?.map((c) => c.key)).toEqual(['north-0', 'south-0']);
    expect(() => shared.next(s, 2_000)).toThrow(/pair_open/);
  });

  it('a right answer settles the pair with the time left; a wrong one blocks for a moment', () => {
    const wrong = shared.answer(open(), pairs[0], universe, 'Kato', 3_000);
    expect(wrong.result).toBe('wrong');
    expect(wrong.state).toMatchObject({ open: true, att: 1, lock: 3_000 + shared.WRONG_LOCK_MS, last: { kind: 'wrong', text: 'Kato' } });
    expect(shared.answer(wrong.state, pairs[0], universe, 'Orlen', 3_500).result).toBe('locked');
    const right = shared.answer(wrong.state, pairs[0], universe, 'orlen', 4_000);
    expect(right.result).toBe('ok');
    expect(right.state).toMatchObject({ open: false, end: 'found', res: [{ pid: 'p-orlen', left: (shared.RACE_MS - 3_000) / 100 }], done: false });
    expect(shared.score(right.state)).toBe(1);
    expect(shared.speed(right.state)).toBe((shared.RACE_MS - 3_000) / 100);
    expect(shared.RACE_MS).toBe(20_000);
    expect(() => shared.answer(right.state, pairs[0], universe, 'Kosel', 4_100)).toThrow(/pair_closed/);
  });

  it('the clock (with the network grace) loses the pair, and says when', () => {
    const s = open();
    const at = s.dl! + ANSWER_GRACE_MS;
    expect(shared.project(s, at)).toBe(s);
    const lost = shared.project(s, at + 1);
    expect(lost).toMatchObject({ open: false, end: 'time', res: [{ pid: null, left: 0 }] });
    expect(shared.settledAt(s, lost)).toBe(at);
    expect(shared.project(lost, at + 60_000)).toBe(lost);
  });

  it('a day keeps the clock it was played with: ten seconds before 2026-10-10, twenty from then on', () => {
    expect([shared.raceMsFor('2026-10-06'), shared.raceMsFor('2026-10-09'), shared.raceMsFor('2026-10-10'), shared.raceMsFor('2026-12-19')]).toEqual([10_000, 10_000, 20_000, 20_000]);
    const early = shared.next(shared.newState(), 1_000, shared.raceMsFor('2026-10-09'));
    expect(early.dl).toBe(11_000);
    // Never more time left than the day's clock gives, whatever the stored deadline says.
    expect(shared.answer(early, pairs[0], universe, 'orlen', 1_000, shared.raceMsFor('2026-10-09')).state.res[0].left).toBe(100);
    const late = shared.next(shared.newState(), 1_000, shared.raceMsFor('2026-10-10'));
    expect(late.dl).toBe(21_000);
    expect(shared.answer(late, pairs[0], universe, 'orlen', 1_000, shared.raceMsFor('2026-10-10')).state.res[0].left).toBe(200);
    // Ten pairs found at once: the largest tie-break a run can reach, which the runs table must accept.
    expect(shared.PAIRS_PER_DAY * (shared.RACE_MS / 100)).toBe(2000);
  });

  it('ten pairs finish the run; score is the pairs found', () => {
    let s = shared.newState();
    for (let i = 0; i < 10; i += 1) {
      s = shared.next(s, i * 60_000);
      s = i % 2 === 0 ? shared.answer(s, pairs[i], universe, 'Kosel', i * 60_000 + 2_000).state : shared.project(s, i * 60_000 + shared.RACE_MS + 5_000);
    }
    expect(s.done).toBe(true);
    expect(shared.score(s)).toBe(5);
    expect(() => shared.next(s, 999_999)).toThrow(/run_done/);
  });

  it('never hands out today\'s answers: examples only once the day is closed', () => {
    const lost = shared.project(open(), 60_000);
    const live = view(lost);
    expect(live.settled).toMatchObject({ reason: 'time', found: null, total: 3, examples: null });
    expect(JSON.stringify(live)).not.toMatch(/Orlen|Kosel|Ravin|p-orlen/);
    expect(view(lost, true).settled?.examples).toEqual(['Tarin Orlen', 'Emir Kosel']);
    const found = shared.answer(open(), pairs[0], universe, 'Ravin', 2_000).state;
    expect(view(found).settled).toMatchObject({ reason: 'found', found: 'Dago Ravin', examples: null });
  });

  it('a run on other content shows nothing of it', () => {
    const s = shared.answer(open(), pairs[0], universe, 'Ravin', 2_000).state;
    expect(shared.publicState(s, '2026-10-08', null, null, 5_000, { ranked: false, disclose: true })).toMatchObject({ clubs: null, settled: { clubs: null, found: null, total: null, examples: null } });
  });
});

describe('name chain, solo', () => {
  const SEED = 7;
  const start = () => chain.next(chain.newState(), universe, SEED, 1_000);
  const say = (s: chain.RunState, text: string, now: number) => chain.answer(s, universe, SEED, text, now);

  it('starts a chain from a name of the daily half, the same one for the same seed', () => {
    const s = start();
    expect(s).toMatchObject({ c: 0, open: true, dl: 1_000 + chain.TURN_START_MS, d: 1 });
    expect(s.ch).toHaveLength(1);
    expect(s.ch[0].g).toBe(true);
    expect(start().ch).toEqual(s.ch);
    expect(() => chain.next(s, universe, SEED, 2_000)).toThrow(/chain_open/);
  });

  it('accepts a name on the letter and restarts the clock; a wrong one costs only time', () => {
    const s: chain.RunState = { ...start(), ch: [{ p: 'p-bako', g: true }], used: ['p-bako'], letter: 'O' };
    const wrong = say(s, 'Kato', 2_000);
    expect(wrong.result).toBe('letter');
    expect(wrong.state).toMatchObject({ att: 1, dl: s.dl, last: { kind: 'letter', p: 'p-kato' } });
    const ok = say(wrong.state, 'Orlen', 3_000);
    expect(ok.result).toBe('ok');
    expect(ok.state).toMatchObject({ letter: 'N', att: 0, at: 3_000, dl: 3_000 + chain.TURN_START_MS });
    expect(say({ ...s, used: ['p-bako', 'p-olbin'] }, 'Olbin', 5_000).result).toBe('repeat');
  });

  it('takes no answer sooner than a person can type one', () => {
    const s: chain.RunState = { ...start(), ch: [{ p: 'p-bako', g: true }], used: ['p-bako'], letter: 'O' };
    const first = say(s, 'Orlen', 3_000).state;
    expect(say(first, 'Nurak', 3_000 + chain.MIN_ANSWER_GAP_MS - 1)).toMatchObject({ result: 'too_fast', state: first });
    expect(say(first, 'Nurak', 3_000 + chain.MIN_ANSWER_GAP_MS).result).toBe('ok');
  });

  it('the turn gets shorter as the chain grows, down to a floor', () => {
    expect(chain.turnMsFor(0)).toBe(10_000);
    expect(chain.turnMsFor(5)).toBe(9_000);
    expect(chain.turnMsFor(19)).toBe(7_000);
    expect(chain.turnMsFor(400)).toBe(chain.TURN_MIN_MS);
  });

  it('the clock or giving up ends the chain; three chains finish the run and the score is every name said', () => {
    let s: chain.RunState = { ...start(), ch: [{ p: 'p-bako', g: true }], used: ['p-bako'], letter: 'O' };
    s = say(s, 'Orlen', 3_000).state;
    s = say(s, 'Nurak', 5_000).state;
    const timed = chain.project(s, s.dl! + ANSWER_GRACE_MS + 1);
    expect(timed).toMatchObject({ open: false, end: 'time', n: [2], done: false });
    expect(chain.settledAt(s, timed)).toBe(s.dl! + ANSWER_GRACE_MS);
    let next = chain.next(timed, universe, SEED, 50_000);
    expect(next).toMatchObject({ c: 1, open: true, d: 2 });
    expect(next.used).toEqual(expect.arrayContaining(['p-bako', 'p-orlen', 'p-nurak']));
    next = chain.pass(next);
    expect(next).toMatchObject({ end: 'pass', n: [2, 0] });
    const last = chain.pass(chain.next(next, universe, SEED, 90_000));
    expect(last).toMatchObject({ done: true, n: [2, 0, 0] });
    expect(chain.score(last)).toBe(2);
    expect(chain.longest(last)).toBe(2);
    expect(() => chain.next(last, universe, SEED, 99_000)).toThrow(/run_done/);
  });

  it('a chain is complete at the cap', () => {
    const many = Array.from({ length: chain.CHAIN_CAP - 1 }, (_, i) => ({ p: `x-${i}`, g: false }));
    const s: chain.RunState = { ...start(), ch: [{ p: 'p-bako', g: true }, ...many], used: ['p-bako'], letter: 'O' };
    expect(say(s, 'Orlen', 9_000).state).toMatchObject({ end: 'cap', open: false, n: [chain.CHAIN_CAP] });
  });

  it('shows the chain, the letter, and what could have been said once a chain ended', () => {
    const s: chain.RunState = { ...start(), ch: [{ p: 'p-bako', g: true }], used: ['p-bako'], letter: 'O' };
    const live = chain.publicState(say(s, 'Kato', 2_000).state, '2026-10-08', universe, 2_500, { ranked: true });
    expect(live).toMatchObject({ letter: 'O', open: true, attempt: 1, settled: null, last: { kind: 'letter', name: 'Kato', starts: ['K'] } });
    expect(live.links).toEqual([{ name: 'Bako', game: 'Bako', given: true }]);
    const over = chain.publicState(chain.pass(s), '2026-10-08', universe, 3_000, { ranked: true });
    expect(over.settled).toMatchObject({ reason: 'pass', named: 0 });
    expect(over.settled!.could.length).toBeGreaterThan(0);
  });
});

describe('name chain, solo: a release with nobody left to start from', () => {
  it('ends the run with what was named instead of leaving it unfinished', () => {
    const tiny = buildUniverse('rel-tiny', [P('t-bako', 'Bako', 90), P('t-orlen', 'Olen', 80)]);
    let s = chain.next(chain.newState(), tiny, 7, 1_000);
    const other = s.ch[0].p === 't-bako' ? 'Olen' : 'Bako';
    const said = chain.answer(s, tiny, 7, other, 2_000);
    s = said.state;
    // Both names are used: the chain is over, and no other chain can start.
    expect(s.open).toBe(false);
    expect(s.done).toBe(false);
    const ended = chain.next(s, tiny, 7, 3_000);
    expect(ended).toMatchObject({ done: true, open: false });
    expect(chain.score(ended)).toBe(said.result === 'ok' ? 1 : 0);
    expect(() => chain.next(ended, tiny, 7, 4_000)).toThrow(/run_done/);
  });
});

describe('days file', () => {
  const days = (n: number, content: (i: number) => unknown, game = 'shared_player') => ({ game, days: Array.from({ length: n }, (_, i) => ({ day: addDays(CONTENT_START, i), number: i + 1, content: content(i) })) });
  const pack = (i: number) => ({ release: 'rel-1', pairs: Array.from({ length: 10 }, (_, n) => pair(i * 10 + n)) });

  it('accepts contiguous days of one release and versions each by its content', () => {
    const parsed = parseDaysFile(days(3, pack));
    expect(parsed).toMatchObject({ game: 'shared_player', release: 'rel-1' });
    expect(parsed.days.map((d) => d.contentVersion)).toEqual(parsed.days.map((d) => contentHash(d.content)));
    expect(new Set(parsed.days.map((d) => d.contentVersion)).size).toBe(3);
    expect(parseDaysFile(days(2, (i) => ({ release: 'rel-1', seed: i + 1 }), 'name_chain')).days).toHaveLength(2);
  });

  it('refuses a gap, a wrong number, a pair on two days, a club three times a day, two releases, and never quotes content', () => {
    const gap = days(2, pack); gap.days[1].day = addDays(CONTENT_START, 2);
    expect(() => parseDaysFile(gap)).toThrow(/contiguous/);
    const number = days(2, pack); number.days[1].number = 9;
    expect(() => parseDaysFile(number)).toThrow(/number must be/);
    expect(() => parseDaysFile(days(2, () => pack(0)))).toThrow(/more than one day/);
    // The same two clubs under another id (and the other way round) are the same pair.
    const renamed = days(2, pack);
    const first = (renamed.days[0].content as ReturnType<typeof pack>).pairs[0];
    (renamed.days[1].content as ReturnType<typeof pack>).pairs[0] = { ...first, id: 'another-id', a: first.b, b: first.a };
    expect(() => parseDaysFile(renamed)).toThrow(/more than one day/);
    const crowded = pack(0); crowded.pairs[1] = { ...crowded.pairs[1], a: crowded.pairs[0].a }; crowded.pairs[2] = { ...crowded.pairs[2], a: crowded.pairs[0].a };
    expect(() => parseDaysFile(days(1, () => crowded))).toThrow(/more than 2 times/);
    expect(() => parseDaysFile(days(2, (i) => ({ release: `rel-${i}`, seed: 1 }), 'name_chain'))).toThrow(/one footballer release/);
    let message = '';
    try { parseDaysFile(days(1, () => ({ release: 'rel-1', pairs: [{ ...pair(0), accepted: ['Tarin Orlen'] }] }))); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/invalid content/);
    expect(message).not.toContain('Orlen');
  });
});

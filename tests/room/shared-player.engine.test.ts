import { describe, expect, it } from 'vitest';
import { buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import {
  afterOutage, COUNTDOWN_MS, DUEL_ROUNDS, matchOver, PARTY_ROUNDS, POINTS_TO_WIN, RACE_MS, REVEAL_MS, seatsChanged, standings, startMatch, submitAnswer, tick, TIE_MS, viewOf, WRONG_LOCK_MS,
  type SharedPlayerContent, type SharedPlayerItem, type SharedPlayerState,
} from '../../src/modules/room/games/shared-player/shared-player.engine.js';
import { dealSharedPlayer, sharedPlayerRoomEngine } from '../../src/modules/room/games/shared-player/shared-player.room.js';

// Invented footballers and clubs only: the repository is public.
const P = (pid: string, name: string, fame: number): UniversePlayer => ({ pid, name, game: name.split(' ').pop()!, fame, aliases: [] });
const universe = buildUniverse('rel-1', [
  P('p-orlen', 'Tarin Orlen', 80), P('p-kosel', 'Emir Kosel', 60), P('p-ravin', 'Dago Ravin', 45), P('p-brando', 'Stefano Brandolini', 15),
  P('p-marnel', 'Zeki Marnel', 12), P('p-outsider', 'Joan Marvelo', 30),
]);
const label = (name: string) => ({ es: name, en: name, ka: name, tr: `${name} TR` });
const club = (key: string) => ({ key, label: label(key), crest: `/clubs/${key}.webp` });
const pair = (n: number, release = 'rel-1'): SharedPlayerItem => ({
  id: `pair-${n}`, release, a: club(`north-${n}`), b: club(`south-${n}`), accepted: ['p-orlen', 'p-kosel', 'p-ravin', 'p-brando'], examples: 2,
});
const content: SharedPlayerContent = { pack: { release: 'rel-1', pairs: Array.from({ length: 10 }, (_, n) => pair(n)) }, universe };
const answer = (s: SharedPlayerState, seat: number, text: string, now: number, attempt = s.attempts[seat], round = s.round) =>
  submitAnswer(s, content, seat, { type: 'answer', round, attempt, text }, now);
/** A match in its first race. */
const racing = (seats: number): SharedPlayerState => tick(startMatch(seats, 0), COUNTDOWN_MS);
const view = (s: SharedPlayerState, seat: number) => viewOf(s, content, seat, 'en');

describe('played for both: the round', () => {
  it('hides the clubs through the countdown, then opens the race', () => {
    const s = startMatch(2, 0);
    expect(s).toMatchObject({ phase: 'countdown', deadline: COUNTDOWN_MS });
    expect(view(s, 0).clubs).toBeNull();
    expect(answer(s, 0, 'Orlen', 100).error).toBe('not_open');
    const open = tick(s, COUNTDOWN_MS);
    expect(open).toMatchObject({ phase: 'race', deadline: COUNTDOWN_MS + RACE_MS });
    expect(view(open, 0).clubs).toEqual([{ key: 'north-0', name: 'north-0', crest: '/clubs/north-0.webp' }, { key: 'south-0', name: 'south-0', crest: '/clubs/south-0.webp' }]);
    expect(viewOf(open, content, 0, 'tr').clubs?.[0].name).toBe('north-0 TR');
  });

  it('a wrong answer blocks that seat for a moment and nothing else', () => {
    const s = racing(2);
    const wrong = answer(s, 0, 'Nobody', 4_000);
    expect(wrong.error).toBeUndefined();
    expect(wrong.state).toMatchObject({ phase: 'race', attempts: [1, 0], lockedUntil: [4_000 + WRONG_LOCK_MS, 0], last: [{ attempt: 0, kind: 'wrong', text: 'Nobody' }, null] });
    expect(answer(wrong.state, 0, 'Orlen', 4_500).error).toBe('locked');
    expect(answer(wrong.state, 1, 'Orlen', 4_500).state.hits).toEqual([null, 'p-orlen']);
    expect(answer(wrong.state, 0, 'Orlen', 4_000 + WRONG_LOCK_MS).state.hits[0]).toBe('p-orlen');
  });

  it('judges each attempt once: a repeated or late send changes nothing', () => {
    const s = racing(2);
    const wrong = answer(s, 0, 'Nobody', 4_000).state;
    expect(answer(wrong, 0, 'Nobody', 6_000, 0).error).toBe('stale_attempt');
    expect(answer(wrong, 0, 'Orlen', 6_000, 1, 3).error).toBe('stale_round');
    const hit = answer(wrong, 0, 'Orlen', 6_000).state;
    expect(answer(hit, 0, 'Kosel', 6_100).error).toBe('already_answered');
    expect(answer(s, 0, 'Orlen', COUNTDOWN_MS + RACE_MS).error).toBe('not_open');
    expect(answer(s, 0, '   ', 4_000).error).toBe('invalid');
  });

  it('accepts a generous spelling and refuses a footballer who did not play for both', () => {
    const s = racing(3);
    expect(answer(s, 0, 'stefano brandolni', 4_000).state.hits[0]).toBe('p-brando');
    expect(answer(s, 1, 'Joan Marvelo', 4_000).state.last[1]).toMatchObject({ kind: 'wrong' });
    expect(answer(s, 2, 'Marnel', 4_000).state.last[2]).toMatchObject({ kind: 'wrong' });
  });
});

describe('played for both: two seats', () => {
  it('the first right answer takes the point once the tie window has passed', () => {
    const first = answer(racing(2), 1, 'Kosel', 5_000).state;
    expect(first).toMatchObject({ phase: 'settle', deadline: 5_000 + TIE_MS, order: [1] });
    expect(tick(first, 5_000 + TIE_MS - 1)).toBe(first);
    const shown = tick(first, 5_000 + TIE_MS);
    expect(shown).toMatchObject({ phase: 'reveal', scores: [0, 1], deadline: 5_000 + TIE_MS + REVEAL_MS });
    expect(shown.results[0]).toEqual({ winners: [1], answers: [null, 'p-kosel'], gains: [0, 1] });
  });

  it('two right answers inside the tie window share the point; one after it is too late', () => {
    const first = answer(racing(2), 0, 'Orlen', 5_000).state;
    const both = answer(first, 1, 'Kosel', 5_000 + TIE_MS - 1).state;
    expect(both).toMatchObject({ phase: 'reveal', scores: [1, 1] });
    expect(answer(first, 1, 'Kosel', 5_000 + TIE_MS).error).toBe('not_open');
  });

  it('keeps the whole tie window when the first answer comes at the buzzer', () => {
    const last = COUNTDOWN_MS + RACE_MS - 1;
    const first = answer(racing(2), 0, 'Orlen', last).state;
    expect(first.deadline).toBe(last + TIE_MS);
    expect(answer(first, 1, 'Kosel', last + TIE_MS - 1).state.scores).toEqual([1, 1]);
  });

  it('nobody finds one: the answers are shown and the next round starts', () => {
    const shown = tick(racing(2), COUNTDOWN_MS + RACE_MS);
    expect(shown).toMatchObject({ phase: 'reveal', scores: [0, 0] });
    expect(view(shown, 0).reveal).toMatchObject({ winners: [], answers: [null, null], examples: ['Tarin Orlen', 'Emir Kosel'], total: 4 });
    expect(tick(shown, shown.deadline)).toMatchObject({ phase: 'countdown', round: 1, hits: [null, null], attempts: [0, 0] });
  });

  it('first to three with a different score wins; level plays on until the round cap, then it is a draw', () => {
    const at = (scores: [number, number], round: number): SharedPlayerState => ({ ...racing(2), phase: 'reveal', scores, round, deadline: 0 });
    expect(matchOver(at([POINTS_TO_WIN, 1], 4))).toBe(true);
    expect(tick(at([POINTS_TO_WIN, 1], 4), 1).phase).toBe('over');
    expect(tick(at([3, 3], 5), 1)).toMatchObject({ phase: 'countdown', round: 6 });
    const level = tick(at([2, 2], DUEL_ROUNDS - 1), 1);
    expect(level.phase).toBe('over');
    expect(standings(level).map((r) => r.place)).toEqual([1, 1]);
  });
});

describe('played for both: three to six seats', () => {
  it('keeps the round open for everyone and pays by the order of the right answers', () => {
    let s = racing(5);
    for (const [seat, text] of [[2, 'Orlen'], [0, 'Kosel'], [4, 'Ravin'], [1, 'Brandolini']] as const) s = answer(s, seat, text, 5_000 + seat).state;
    expect(s).toMatchObject({ phase: 'race', order: [2, 0, 4, 1] });
    const shown = tick(s, s.deadline);
    expect(shown.results[0].gains).toEqual([2, 1, 3, 0, 1]);
    expect(shown.scores).toEqual([2, 1, 3, 0, 1]);
  });

  it('closes the round as soon as every connected seat has answered', () => {
    let s = seatsChanged(racing(3), [{ seat: 2, change: 'away' }]);
    s = answer(s, 0, 'Orlen', 5_000).state;
    expect(tick(s, 5_001)).toBe(s);
    s = answer(s, 1, 'Kosel', 5_100).state;
    expect(tick(s, 5_101).phase).toBe('reveal');
  });

  it('plays the set number of rounds and shares places on ties', () => {
    let s: SharedPlayerState = { ...racing(3), phase: 'reveal', round: PARTY_ROUNDS - 1, scores: [5, 9, 5], deadline: 0 };
    s = tick(s, 1);
    expect(s.phase).toBe('over');
    expect(standings(s).map((r) => [r.seat, r.place])).toEqual([[1, 1], [0, 2], [2, 2]]);
  });
});

describe('played for both: seats leaving', () => {
  const revealed = (seats: number, scores: number[]): SharedPlayerState => ({ ...racing(seats), phase: 'reveal', scores, deadline: 20_000, results: [{ winners: [0], answers: Array(seats).fill(null), gains: Array(seats).fill(0) }] });

  it('before any round is revealed, a room left with one seat is cancelled', () => {
    expect(seatsChanged(racing(2), [{ seat: 0, change: 'leave' }]).phase).toBe('cancelled');
    expect(seatsChanged(racing(3), [{ seat: 0, change: 'leave' }]).phase).toBe('race');
  });

  it('after a revealed round, whoever is left wins and the seat that quit ranks last, whatever the score', () => {
    const s = seatsChanged(revealed(2, [2, 0]), [{ seat: 0, change: 'leave' }]);
    expect(s.phase).toBe('over');
    expect(standings(s).map((r) => [r.seat, r.place])).toEqual([[1, 1], [0, 2]]);
  });

  it('everyone leaving together cancels instead of crowning whoever was processed last', () => {
    expect(seatsChanged(revealed(3, [1, 1, 1]), [{ seat: 0, change: 'leave' }, { seat: 1, change: 'leave' }, { seat: 2, change: 'leave' }]).phase).toBe('cancelled');
  });

  it('once the last round is revealed, leaving changes nothing', () => {
    const won: SharedPlayerState = { ...revealed(2, [POINTS_TO_WIN, 0]), round: 2 };
    const left = seatsChanged(won, [{ seat: 0, change: 'leave' }]);
    expect(left.phase).toBe('reveal');
    const over = tick(left, left.deadline);
    expect(over.phase).toBe('over');
    expect(standings(over).map((r) => [r.seat, r.place])).toEqual([[0, 1], [1, 2]]);
  });

  it('a seat that is away keeps its place and can come back', () => {
    const away = seatsChanged(racing(3), [{ seat: 1, change: 'away' }]);
    expect(away.status).toEqual(['in', 'away', 'in']);
    expect(seatsChanged(away, [{ seat: 1, change: 'back' }]).status).toEqual(['in', 'in', 'in']);
    expect(answer(seatsChanged(racing(3), [{ seat: 1, change: 'leave' }]), 1, 'Orlen', 5_000).error).toBe('withdrawn');
  });
});

describe('played for both: what a seat is shown', () => {
  it('never an accepted name or another seat\'s answer before the reveal', () => {
    let s = racing(3);
    s = answer(s, 0, 'Orlen', 5_000).state;
    s = answer(s, 1, 'Nobody', 5_000).state;
    const mine = view(s, 0);
    const theirs = view(s, 1);
    expect(mine).toMatchObject({ myHit: 'Tarin Orlen', myAttempt: 1, myLast: { kind: 'ok', text: 'Tarin Orlen' }, reveal: null, results: [] });
    expect(theirs).toMatchObject({ myHit: null, myAttempt: 1, myLast: { kind: 'wrong', text: 'Nobody' } });
    expect(theirs.seats.map((seat) => seat.answered)).toEqual([true, false, false]);
    const leaked = JSON.stringify(theirs);
    for (const name of ['Orlen', 'Kosel', 'Ravin', 'Brandolini', 'p-orlen', 'p-kosel']) expect(leaked).not.toContain(name);
    expect(JSON.stringify(view(startMatch(3, 0), 0))).not.toContain('north-0"');
  });

  it('lists every crest of the match up front without saying which clubs meet', () => {
    const crests = view(startMatch(2, 0), 0).crests;
    expect(crests).toHaveLength(20);
    expect(crests).toEqual([...crests].sort());
  });

  it('the reveal shows who answered what, the examples and any accepted answer outside them', () => {
    let s = racing(3);
    s = answer(s, 0, 'Brandolini', 5_000).state;
    const shown = view(tick(s, s.deadline), 2);
    expect(shown.reveal).toMatchObject({ winners: [0], answers: ['Stefano Brandolini', null, null], gains: [3, 0, 0], examples: ['Tarin Orlen', 'Emir Kosel', 'Stefano Brandolini'], total: 4 });
    expect(shown.results).toHaveLength(1);
  });
});

describe('played for both: outages and the pool', () => {
  it('an outage gives the open countdown or race its window again and keeps the answers', () => {
    const s = answer(racing(3), 0, 'Orlen', 5_000).state;
    expect(afterOutage(s, 60_000)).toMatchObject({ phase: 'race', deadline: 60_000 + RACE_MS, hits: ['p-orlen', null, null] });
    const settled = answer(racing(2), 0, 'Orlen', 5_000).state;
    expect(afterOutage(settled, 60_000)).toBe(settled);
  });

  const item = (n: number, difficulty: string, a = `a-${n}`, b = `b-${n}`, release = 'rel-1') => ({
    item_id: `pair-${n}`, difficulty, payload: { ...pair(n, release), a: club(a), b: club(b) },
  });

  it('deals four easy pairs, then six harder ones, of one release', async () => {
    const pool = [...Array.from({ length: 12 }, (_, n) => item(n, 'easy')), ...Array.from({ length: 18 }, (_, n) => item(100 + n, 'medium'))];
    const dealt = await dealSharedPlayer(async () => pool);
    expect(dealt?.itemIds).toHaveLength(10);
    const pack = sharedPlayerRoomEngine.parseContent(dealt!.content)!.pack;
    expect(pack.pairs.slice(0, 4).every((p) => Number(p.id.split('-')[1]) < 100)).toBe(true);
    expect(pack.pairs.slice(4).every((p) => Number(p.id.split('-')[1]) >= 100)).toBe(true);
  });

  it('keeps one club from meeting everyone when the pool allows it', async () => {
    const pool = [...Array.from({ length: 12 }, (_, n) => item(n, 'easy', 'same', `b-${n}`)), ...Array.from({ length: 4 }, (_, n) => item(50 + n, 'easy')), ...Array.from({ length: 18 }, (_, n) => item(100 + n, 'medium'))];
    const dealt = await dealSharedPlayer(async () => pool);
    const pack = sharedPlayerRoomEngine.parseContent(dealt!.content)!.pack;
    expect(pack.pairs.filter((p) => p.a.key === 'same').length).toBeLessThanOrEqual(2);
  });

  it('refuses a pool that cannot fill a pack, and never mixes releases', async () => {
    expect(await dealSharedPlayer(async () => [item(1, 'easy'), item(2, 'medium')])).toBeNull();
    const mixed = [...Array.from({ length: 4 }, (_, n) => item(n, 'easy')), ...Array.from({ length: 6 }, (_, n) => item(100 + n, 'medium', `a-${100 + n}`, `b-${100 + n}`, 'rel-2'))];
    expect(await dealSharedPlayer(async () => mixed)).toBeNull();
  });

  it('deals one difficulty when the host chose it, and asks the pool for the chosen scope', async () => {
    const pool = [...Array.from({ length: 30 }, (_, n) => item(n, 'easy')), ...Array.from({ length: 30 }, (_, n) => item(100 + n, 'medium'))];
    const asked: Array<[Record<string, number>, string | undefined]> = [];
    const pick = async (wanted: Record<string, number>, tag?: string) => { asked.push([wanted, tag]); return pool.filter((i) => wanted[i.difficulty]); };
    const easy = await dealSharedPlayer(pick, { scope: 'ESP', difficulty: 'easy' });
    expect(easy!.itemIds.every((id) => Number(id.split('-')[1]) < 100)).toBe(true);
    expect(asked[0]).toEqual([{ easy: 30 }, 'ESP']);
    const turkish = await dealSharedPlayer(pick, { scope: 'TR', difficulty: 'medium' });
    expect(turkish!.itemIds.every((id) => Number(id.split('-')[1]) >= 100)).toBe(true);
    expect(asked[1]).toEqual([{ medium: 30 }, 'TR']);
    await dealSharedPlayer(pick, { scope: 'tr-eu' });
    expect(asked[2]).toEqual([{ easy: 12, medium: 18 }, 'tr-eu']);
  });

  it('accepts no options as the default scope, every difficulty in every scope, and refuses anything else', () => {
    expect(sharedPlayerRoomEngine.parseOptions(null)).toEqual({ scope: 'mixed' });
    expect(sharedPlayerRoomEngine.parseOptions({ scope: 'ITA', difficulty: 'medium' })).toEqual({ scope: 'ITA', difficulty: 'medium' });
    expect(sharedPlayerRoomEngine.parseOptions({ scope: 'TR', difficulty: 'easy' })).toEqual({ scope: 'TR', difficulty: 'easy' });
    expect(sharedPlayerRoomEngine.parseOptions({ scope: 'GER', difficulty: 'hard' })).toBeUndefined();
    expect(sharedPlayerRoomEngine.parseOptions({ scope: 'MARS' })).toBeUndefined();
    expect(sharedPlayerRoomEngine.parseOptions({ scope: 'ESP', extra: 1 })).toBeUndefined();
  });

  it('refuses stored content that is not a ten-pair pack of one release', () => {
    expect(sharedPlayerRoomEngine.parseContent({ release: 'rel-1', pairs: [pair(1)] })).toBeNull();
    expect(sharedPlayerRoomEngine.parseContent({ release: 'rel-1', pairs: Array.from({ length: 10 }, (_, n) => pair(n, n === 3 ? 'rel-2' : 'rel-1')) })).toBeNull();
    expect(sharedPlayerRoomEngine.parseContent(content.pack)).not.toBeNull();
  });
});

describe('played for both: "that was right" reports', () => {
  it('says nothing about a round whose answers are not out yet', () => {
    const s = racing(2);
    expect(sharedPlayerRoomEngine.refusal!(s, content, 0, 'Joan Marvelo')).toBeNull();
    expect(sharedPlayerRoomEngine.refusal!(s, content, 1, 'Joan Marvelo')).toBeNull();
  });

  it('describes a refused text of a revealed round and drops one the pair accepts', () => {
    const revealed = tick(racing(2), COUNTDOWN_MS + RACE_MS);
    expect(revealed.results).toHaveLength(1);
    expect(sharedPlayerRoomEngine.refusal!(revealed, content, 0, 'Joan Marvelo')).toEqual({ release: 'rel-1', subject: 'north-0|south-0', resolvedPid: 'p-outsider' });
    expect(sharedPlayerRoomEngine.refusal!(revealed, content, 0, 'Milo Vantar')).toEqual({ release: 'rel-1', subject: 'north-0|south-0', resolvedPid: null });
    expect(sharedPlayerRoomEngine.refusal!(revealed, content, 0, 'Tarin Orlen')).toBeNull();
    expect(sharedPlayerRoomEngine.refusal!(revealed, content, 1, 'Joan Marvelo')).toBeNull();
    expect(sharedPlayerRoomEngine.refusal!(revealed, { ...content, universe: null }, 0, 'Joan Marvelo')).toBeNull();
  });
});

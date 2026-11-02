import { describe, expect, it, vi } from 'vitest';
import '../setup.js';
import { buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import { startBucket } from '../../src/modules/room/games/name-chain/name-chain.core.js';
import { createNameChainDailyService } from '../../src/modules/name-chain-daily/name-chain-daily.service.js';
import { practiceSchema, practiceStep, PRACTICE_USED_MAX, type PracticeRequest } from '../../src/modules/name-chain-daily/name-chain-daily.practice.js';

vi.mock('../../src/modules/footballers/footballers.russian.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/footballers/footballers.russian.js')>()),
  activeRussianVersion: vi.fn(async () => null),
}));

// Invented footballers only: the repository is public.
const P = (pid: string, name: string, fame: number): UniversePlayer => ({ pid, name, game: name.split(' ').pop()!, fame, aliases: [] });
const universe = buildUniverse('rel-1', [
  P('p-bako', 'Bako', 90), P('p-orlen', 'Tarin Orlen', 80), P('p-nurak', 'Nurak', 70), P('p-kosel', 'Emir Kosel', 60), P('p-lumar', 'Lumar', 50),
  P('p-ravin', 'Dago Ravin', 45), P('p-nesto', 'Nesto', 40), P('p-olbin', 'Olbin', 35), P('p-nesto2', 'Niko Nesto', 20), P('p-kato', 'Kato', 10),
  P('p-onur', 'Onur Vex', 5), P('p-nilo', 'Nilo', 4), P('p-oran', 'Oran', 3),
]);
const step = (input: unknown, random = 0) => practiceStep(universe, 'latin', practiceSchema.parse(input) as PracticeRequest, random);

describe('name chain, relaxed practice', () => {
  it('starts from a name of the rooms\' half, never one the daily keeps for itself', () => {
    for (const random of [0, 0.3, 0.6, 0.99]) {
      const out = step({ op: 'start' }, random);
      expect(out.links).toHaveLength(1);
      expect(out.links[0].given).toBe(true);
      expect(startBucket(out.links[0].pid)).toBe(1);
      expect(out.letter).toBe(universe.last(out.links[0].pid));
      expect(out).toMatchObject({ result: null, exhausted: false, alphabet: 'latin' });
    }
  });

  it('judges an answer on the letter the tail passes on, with no clock and no score', () => {
    const wrong = step({ op: 'answer', used: ['p-bako'], tail: 'p-bako', answer: 'Kato' });
    expect(wrong).toMatchObject({ result: 'letter', letter: 'O', links: [], last: { kind: 'letter', name: 'Kato', starts: ['K'] } });
    expect(step({ op: 'answer', used: ['p-bako'], tail: 'p-bako', answer: 'Zzzzq' })).toMatchObject({ result: 'unknown', letter: 'O', last: { name: null } });
    expect(step({ op: 'answer', used: ['p-bako', 'p-olbin'], tail: 'p-bako', answer: 'Olbin' }).result).toBe('repeat');
    const ok = step({ op: 'answer', used: ['p-bako'], tail: 'p-bako', answer: 'orlen' });
    expect(ok).toMatchObject({ result: 'ok', letter: 'N', links: [{ pid: 'p-orlen', name: 'Tarin Orlen', game: 'Orlen', given: false }] });
    expect(ok).not.toHaveProperty('score');
  });

  it('the tail counts as used even when the client left it out', () => {
    // A tail missing from `used` is still the chain's: it is added before judging.
    expect(step({ op: 'answer', used: [], tail: 'p-orlen', answer: 'Nurak' }).result).toBe('ok');
    expect(step({ op: 'answer', used: ['p-orlen', 'p-nurak'], tail: 'p-nurak', answer: 'Kato' }).result).toBe('ok');
  });

  it('supplies a fresh name when the new letter has nobody left', () => {
    // After Kato the chain needs an O; with every O name used, the game supplies a fresh start.
    const used = ['p-nurak', 'p-orlen', 'p-olbin', 'p-onur', 'p-oran'];
    const out = step({ op: 'answer', used, tail: 'p-nurak', answer: 'Kato' });
    expect(out.result).toBe('ok');
    expect(out.links[0]).toMatchObject({ pid: 'p-kato', given: false });
    expect(out.links).toHaveLength(2);
    expect(out.links[1].given).toBe(true);
    expect(out.letter).toBe(universe.last(out.links[1].pid));
  });

  it('giving up shows the unused names that would have answered the letter', () => {
    const out = step({ op: 'pass', used: ['p-bako', 'p-orlen'], tail: 'p-bako' });
    expect(out.could).toEqual(['Olbin', 'Onur Vex', 'Oran']);
    expect(out).toMatchObject({ result: null, letter: '', links: [] });
  });

  it('ignores ids the release does not know and refuses an unknown tail', () => {
    expect(step({ op: 'answer', used: ['ghost', 'p-bako'], tail: 'p-bako', answer: 'Olbin' }).result).toBe('ok');
    expect(() => step({ op: 'pass', used: [], tail: 'ghost' })).toThrow(/practice_unknown_tail/);
  });

  it('keeps requests bounded', () => {
    expect(practiceSchema.safeParse({ op: 'start', used: Array.from({ length: PRACTICE_USED_MAX + 1 }, (_, i) => `p-${i}`) }).success).toBe(false);
    expect(practiceSchema.safeParse({ op: 'answer', used: [], tail: 'p-bako', answer: '!!!' }).success).toBe(false);
    expect(practiceSchema.safeParse({ op: 'answer', used: [], answer: 'Olbin' }).success).toBe(false);
    expect(practiceSchema.safeParse({ op: 'start', locale: 'fr' }).success).toBe(false);
  });
});

describe('name chain practice, through the service', () => {
  const served = (ids: string[]) => new Map(ids.map((day) => [day, { day, number: 1, contentVersion: 1, release: 'rel-1', seed: 1, universe }]));
  const make = (ids: string[], repo: Record<string, unknown> = {}) => createNameChainDailyService({
    repo: repo as never, content: async () => served(ids), contentStale: () => undefined,
    now: () => new Date('2026-10-20T15:00:00Z'), reports: { file: vi.fn() } as never, random: () => 0,
  });

  it('plays on the newest day already out, and touches no run, row or leaderboard', async () => {
    const repo = new Proxy({}, { get: (_t, key) => { throw new Error(`repo.${String(key)} must not be used by practice`); } });
    const out = await make(['2026-10-19', '2026-10-20', '2026-10-21'], repo as never).practice({ op: 'answer', used: ['p-bako'], tail: 'p-bako', answer: 'Orlen' });
    expect(out).toMatchObject({ result: 'ok', letter: 'N', alphabet: 'latin' });
  });

  it('is a 404 before any day is out', async () => {
    await expect(make(['2026-10-21']).practice({ op: 'start', used: [] })).rejects.toMatchObject({ statusCode: 404 });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const db = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('../../src/db/index.js', () => ({ sql: db.sql }));
const active = vi.hoisted(() => ({ greek: null as string | null }));
vi.mock('../../src/modules/footballers/footballers.russian.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/footballers/footballers.russian.js')>()),
  activeRussianVersion: vi.fn(async () => null),
}));
vi.mock('../../src/modules/footballers/footballers.greek.js', async (original) => ({
  ...(await original<typeof import('../../src/modules/footballers/footballers.greek.js')>()),
  activeGreekVersion: vi.fn(async () => active.greek),
}));

import { forgetGreek } from '../../src/modules/footballers/footballers.greek.js';
import { buildUniverse, type UniversePlayer } from '../../src/modules/footballers/footballers.universe.js';
import { createNameChainDailyService } from '../../src/modules/name-chain-daily/name-chain-daily.service.js';
import { practiceSchema, type PracticeRequest } from '../../src/modules/name-chain-daily/name-chain-daily.practice.js';

// Invented footballers and invented Greek spellings only: the repository is public.
const P = (pid: string, name: string, game: string, fame: number): UniversePlayer => ({ pid, name, game, fame, aliases: [] });
const universe = buildUniverse('rel-1', [P('p-orlen', 'Tarin Orlen', 'Orlen', 80), P('p-nesto', 'Nesto Valdi', 'Nesto', 60), P('p-sarko', 'Sarko', 'Sarko', 40)]);
// Version b spells Orlen with a final σ: the letter after him changes from Ν to Σ.
const VERSIONS: Record<string, Array<{ pid: string; name_el: string; game_name_el: string; aliases_el: string[]; fame: number }>> = {
  'el-a': [
    { pid: 'p-orlen', name_el: 'Ταρίν Όρλεν', game_name_el: 'Όρλεν', aliases_el: [], fame: 80 },
    { pid: 'p-nesto', name_el: 'Νέστο Βάλντι', game_name_el: 'Νέστος', aliases_el: ['Νέστωρ'], fame: 60 },
    { pid: 'p-sarko', name_el: 'Σάρκο', game_name_el: 'Σάρκο', aliases_el: [], fame: 40 },
  ],
  'el-b': [
    { pid: 'p-orlen', name_el: 'Ταρίν Όρλενος', game_name_el: 'Όρλενος', aliases_el: [], fame: 80 },
    { pid: 'p-nesto', name_el: 'Νέστο Βάλντι', game_name_el: 'Νέστος', aliases_el: ['Νέστωρ'], fame: 60 },
    { pid: 'p-sarko', name_el: 'Σάρκο', game_name_el: 'Σάρκο', aliases_el: [], fame: 40 },
  ],
};
db.sql.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const rows = VERSIONS[String(values[0])] ?? [];
  return strings.join('?').includes('FROM wordgame_el_versions') ? (rows.length ? [{ players: rows.length }] : []) : rows;
});

const service = createNameChainDailyService({
  repo: {} as never, content: async () => new Map([['2026-10-20', { day: '2026-10-20', number: 1, contentVersion: 1, release: 'rel-1', seed: 1, universe }]]),
  contentStale: () => undefined, now: () => new Date('2026-10-20T15:00:00Z'), reports: { file: vi.fn() } as never, random: () => 0,
});
const practice = (input: unknown) => service.practice(practiceSchema.parse(input) as PracticeRequest);

describe('a practice chain keeps the names and letters it started with', () => {
  beforeEach(() => {
    forgetGreek();
    active.greek = 'el-a';
  });

  it('a Greek version switched on mid-chain changes neither the letter nor the verdict', async () => {
    const start = await practice({ op: 'start', locale: 'el' });
    expect(start.frozen).toEqual({ oe: 'el-a', al: 'gr' });
    const step = { op: 'answer', locale: 'el', used: ['p-orlen'], tail: 'p-orlen', answer: 'Νέστωρ', frozen: start.frozen };
    const before = await practice(step);
    expect(before).toMatchObject({ result: 'ok', alphabet: 'greek' });
    active.greek = 'el-b';
    // An older client (no `frozen`) is judged with today's names: the letter moved.
    expect((await practice({ ...step, frozen: undefined })).result).toBe('letter');
    const after = await practice(step);
    expect(after).toMatchObject({ result: before.result, letter: before.letter, frozen: { oe: 'el-a', al: 'gr' } });
    expect((await practice({ op: 'pass', locale: 'el', used: ['p-orlen'], tail: 'p-orlen', frozen: start.frozen })).frozen).toEqual(start.frozen);
  });

  it('a chain started while the names could not load stays Latin', async () => {
    active.greek = null;
    const start = await practice({ op: 'start', locale: 'el' });
    expect(start).toMatchObject({ alphabet: 'latin', frozen: {} });
    active.greek = 'el-a';
    expect(await practice({ op: 'answer', locale: 'el', used: ['p-orlen'], tail: 'p-orlen', answer: 'Nesto', frozen: start.frozen })).toMatchObject({ result: 'ok', alphabet: 'latin' });
  });

  it('a frozen version this process neither holds nor has active asks for a new chain; nothing arbitrary is loaded', async () => {
    active.greek = 'el-b';
    db.sql.mockClear();
    await expect(practice({ op: 'pass', locale: 'el', used: [], tail: 'p-orlen', frozen: { oe: 'el-a', al: 'gr' } })).rejects.toMatchObject({ statusCode: 400 });
    expect(db.sql.mock.calls.some((c) => c[1] === 'el-a')).toBe(false);
    expect(practiceSchema.safeParse({ op: 'pass', used: [], tail: 'p-orlen', frozen: { al: 'gr' } }).success).toBe(false);
  });
});

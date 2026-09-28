import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  answerHash, assertCalendar, parseDayFile, planSeed, PROJECT_REFS, resolveSeedTarget, toDayRow, type SeedDay,
} from '../../src/modules/buscaminas/buscaminas.seed.js';
import type { BuscaminasDayRow } from '../../src/modules/buscaminas/buscaminas.types.js';
import { calendar, makeDay } from './fixtures.js';

const DAY = '2026-09-27';
const edit = (patch: (d: SeedDay) => void): SeedDay => {
  const d = structuredClone(makeDay(DAY));
  patch(d);
  return d;
};
const rehash = (d: SeedDay): SeedDay => ({ ...d, contentVersion: answerHash(d.rounds) });

describe('buscaminas seed: day file validation', () => {
  it('contentVersion is the content pipeline\'s answer hash (values computed by its Python code)', () => {
    expect(answerHash(makeDay(DAY).rounds)).toBe(16773820);
    // ensure_ascii escaping of non-ASCII ids.
    expect(answerHash([{ id: 'ronda-ñ-☃', difficulty: 'easy', prompt: { es: 'a', en: 'a', ka: 'a', tr: 'a' }, cards: [
      { id: 'c1', name: 'A', img: '/buscaminas/v1/p/1.webp', ok: true }, { id: 'c2', name: 'B', img: '/buscaminas/v1/p/2.webp', ok: false },
    ] }])).toBe(5326315);
  });

  it('accepts a full day and drops unknown fields', () => {
    const raw = { ...makeDay(DAY), notes: 'x', rounds: makeDay(DAY).rounds.map((r) => ({ ...r, key: 'k', cards: r.cards.map((c) => ({ ...c, evidence: 'e' })) })) };
    expect(parseDayFile('f', raw)).toEqual(makeDay(DAY));
  });

  it.each([
    ['a wrong number', (d: SeedDay) => { d.number = 7; }, /number must be 2/],
    ['an impossible date', (d: SeedDay) => { d.day = '2026-02-30'; }, /valid YYYY-MM-DD/],
    ['19 rounds', (d: SeedDay) => { d.rounds.pop(); }, /expected 20 rounds/],
    ['a duplicate round id', (d: SeedDay) => { d.rounds[1].id = 'r0'; }, /duplicate id r0/],
    ['an unknown difficulty', (d: SeedDay) => { (d.rounds[0] as { difficulty: string }).difficulty = 'insane'; }, /difficulty/],
    ['a missing locale', (d: SeedDay) => { d.rounds[2].prompt.ka = ' '; }, /round 2: prompt.ka missing/],
    ['15 cards', (d: SeedDay) => { d.rounds[0].cards.pop(); }, /expected 16 cards/],
    ['a duplicate card', (d: SeedDay) => { d.rounds[0].cards[1].id = 'r0c0'; }, /duplicate card r0c0/],
    ['an image outside the card art directory', (d: SeedDay) => { d.rounds[0].cards[0].img = 'https://x.example/a.webp'; }, /img must be a file under/],
    ['a stripped ok flag', (d: SeedDay) => { delete (d.rounds[0].cards[0] as { ok?: boolean }).ok; }, /missing ok/],
    ['11 correct cards', (d: SeedDay) => { d.rounds[0].cards[0].ok = false; }, /expected 12 correct cards/],
    ['a contentVersion that is not the answer hash', (d: SeedDay) => { d.contentVersion += 1; }, /is not the answer hash/],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => parseDayFile('2026-09-27.json', edit(patch))).toThrow(message);
  });

  it('a changed answer changes the hash', () => {
    const swapped = rehash(edit((d) => { d.rounds[0].cards[0].ok = false; d.rounds[0].cards[15].ok = true; }));
    expect(swapped.contentVersion).not.toBe(makeDay(DAY).contentVersion);
    expect(() => parseDayFile('f', swapped)).not.toThrow();
  });

  it('requires the whole calendar: 90 contiguous days from the launch day', () => {
    expect(() => assertCalendar(calendar())).not.toThrow();
    expect(() => assertCalendar(calendar().slice(0, 89))).toThrow(/expected 90 days/);
    const gap = calendar();
    gap[10] = makeDay('2026-12-25');
    expect(() => assertCalendar(gap)).toThrow(/contiguous/);
  });

  it('splits a day into its public board and its server-only answers', () => {
    const row = toDayRow(makeDay(DAY));
    expect(JSON.stringify(row.board)).not.toContain('"ok"');
    expect(row.board.rounds[0].cards[0]).toEqual({ id: 'r0c0', name: 'Player 0-0', img: '/buscaminas/v1/p/r0c0.webp' });
    expect(row.answers.r0).toEqual(Array.from({ length: 12 }, (_, c) => `r0c${c}`));
    expect(Object.keys(row.answers)).toHaveLength(20);
  });
});

describe('buscaminas seed: plan', () => {
  const stored = (...rows: BuscaminasDayRow[]) => new Map(rows.map((r) => [r.day, r]));
  const a = toDayRow(makeDay('2026-09-26'));
  const b = toDayRow(makeDay('2026-09-27'));
  const bCorrected = toDayRow(makeDay('2026-09-27', 1));
  const bRetitled = toDayRow(edit((d) => { d.rounds[0].prompt.en = 'new clue'; }));

  it('classifies days as new, changed or unchanged, key order aside, and reports stored extras without deleting them', () => {
    const reordered = { ...a, answers: Object.fromEntries(Object.entries(a.answers).reverse()) };
    const extra = toDayRow(makeDay('2026-09-28'));
    const plan = planSeed(stored(reordered, b, extra), new Map(), [a, bRetitled, toDayRow(makeDay('2026-09-29'))], { allowCorrection: false });
    expect(plan.entries.map((e) => [e.day, e.status, e.answersChanged])).toEqual([
      ['2026-09-26', 'unchanged', false], ['2026-09-27', 'changed', false], ['2026-09-29', 'new', false],
    ]);
    expect(plan.extraDays).toEqual(['2026-09-28']);
  });

  it('a text-only change to a played day is allowed; new answers for a played day need --allow-correction', () => {
    const runs = new Map([['2026-09-27', 3]]);
    expect(planSeed(stored(b), runs, [bRetitled], { allowCorrection: false }).entries[0]).toMatchObject({ status: 'changed', answersChanged: false, runs: 3 });
    expect(() => planSeed(stored(b), runs, [bCorrected], { allowCorrection: false })).toThrow(/2026-09-27 \(3 runs\): answers changed; pass --allow-correction/);
    expect(planSeed(stored(b), runs, [bCorrected], { allowCorrection: true }).entries[0]).toMatchObject({
      status: 'changed', answersChanged: true, previousVersion: b.contentVersion, contentVersion: bCorrected.contentVersion,
    });
    // Unplayed days take new answers freely.
    expect(planSeed(stored(b), new Map(), [bCorrected], { allowCorrection: false }).entries[0]).toMatchObject({ answersChanged: true });
  });

  it('a correction must change contentVersion so unfinished runs restart', () => {
    const sameVersion = { ...bCorrected, contentVersion: b.contentVersion };
    expect(() => planSeed(stored(b), new Map([['2026-09-27', 1]]), [sameVersion], { allowCorrection: true })).toThrow(/must change contentVersion/);
  });
});

describe('buscaminas seed: host guard', () => {
  const pooler = (ref: string) => `postgresql://postgres.${ref}:s3cret-pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`;

  it('a local database needs no flag, and refuses one', () => {
    expect(resolveSeedTarget('postgresql://postgres:pw@127.0.0.1:5432/quizball_local', undefined)).toEqual({ kind: 'local', label: 'local 127.0.0.1:5432/quizball_local' });
    expect(resolveSeedTarget('postgres://u@localhost/db', undefined).kind).toBe('local');
    expect(() => resolveSeedTarget('postgresql://postgres:pw@127.0.0.1:5432/x', 'staging')).toThrow(/local database/);
  });

  it('a remote database needs --target naming its exact project; errors name the project, never the password', () => {
    const errorOf = (url: string, target?: 'staging' | 'production') => { try { resolveSeedTarget(url, target); return ''; } catch (e) { return (e as Error).message; } };
    expect(errorOf(pooler(PROJECT_REFS.staging))).toMatch(/Refusing to seed a non-local database \(Supabase project nsdfiprfmhdqhbfxfwpv\)/);
    expect(errorOf(pooler(PROJECT_REFS.staging), 'production')).toMatch(/expects Supabase project lfbwhxvwubzeqkztghok/);
    expect(errorOf(`postgresql://postgres:s3cret-pw@db.${PROJECT_REFS.production}.supabase.co:5432/postgres`, 'staging')).toMatch(/points at Supabase project lfbwhx/);
    expect(errorOf('postgresql://admin:s3cret-pw@db.example.com/postgres', 'staging')).toMatch(/host db.example.com/);
    for (const message of [errorOf(pooler(PROJECT_REFS.staging)), errorOf('not a url'), errorOf('mysql://u:s3cret-pw@h/db')]) expect(message).not.toContain('s3cret');
    expect(resolveSeedTarget(pooler(PROJECT_REFS.staging), 'staging')).toEqual({ kind: 'staging', label: 'staging (Supabase project nsdfiprfmhdqhbfxfwpv)' });
    expect(resolveSeedTarget(`postgresql://postgres:pw@db.${PROJECT_REFS.production}.supabase.co:5432/postgres`, 'production').kind).toBe('production');
  });

  it('trusts a postgres.<ref> user only on a Supabase pooler host; a direct host must agree with it', () => {
    const staging = PROJECT_REFS.staging;
    const errorOf = (url: string, target?: 'staging' | 'production') => { try { resolveSeedTarget(url, target); return ''; } catch (e) { return (e as Error).message; } };
    // Supabase-shaped user on some other host: says nothing about where the connection goes.
    for (const host of ['wrong.example.com', 'aws-1-eu-central-1.pooler.supabase.com.evil.example', 'pooler.supabase.com', 'x.pooler.supabase.co']) {
      const url = `postgresql://postgres.${staging}:s3cret-pw@${host}:6543/postgres`;
      expect(errorOf(url, 'staging')).toMatch(new RegExp(`expects Supabase project ${staging}, but DATABASE_URL points at host `));
      expect(errorOf(url)).toMatch(/Refusing to seed a non-local database \(host /);
    }
    // Pooler host with the matching --target: accepted.
    expect(resolveSeedTarget(pooler(staging), 'staging')).toEqual({ kind: 'staging', label: `staging (Supabase project ${staging})` });
    expect(resolveSeedTarget(`postgresql://postgres.${staging}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, 'staging').kind).toBe('staging');
    // Direct host: its own ref; a postgres.<ref> user naming another project is refused.
    expect(resolveSeedTarget(`postgresql://postgres:pw@db.${staging}.supabase.co:5432/postgres`, 'staging').kind).toBe('staging');
    expect(resolveSeedTarget(`postgresql://postgres.${staging}:pw@db.${staging}.supabase.co:5432/postgres`, 'staging').kind).toBe('staging');
    expect(errorOf(`postgresql://postgres.${staging}:pw@db.${PROJECT_REFS.production}.supabase.co:5432/postgres`, 'staging')).toMatch(/points at host db\.lfbwhx/);
    // Local: no flag needed, even with a Supabase-shaped user.
    expect(resolveSeedTarget(`postgresql://postgres.${staging}:pw@localhost:5432/quizball_local`, undefined).kind).toBe('local');
  });

  it('the CLI refuses a remote database before reading files or connecting', () => {
    const root = resolve(__dirname, '../..');
    const empty = mkdtempSync(join(tmpdir(), 'buscaminas-days-'));
    writeFileSync(join(empty, 'README.txt'), 'no day files');
    let stderr = '';
    try {
      execFileSync(join(root, 'node_modules/.bin/tsx'), ['scripts/buscaminas-seed-days.ts', empty, '--dry-run'], {
        cwd: root, stdio: 'pipe', env: { ...process.env, DATABASE_URL: pooler(PROJECT_REFS.production) },
      });
    } catch (error) {
      stderr = String((error as { stderr?: Buffer }).stderr);
    }
    expect(stderr).toMatch(/Refusing to seed a non-local database \(Supabase project lfbwhxvwubzeqkztghok\) without --target/);
    expect(stderr).not.toContain('s3cret');
  });
});

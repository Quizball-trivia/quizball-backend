import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../src/modules/pistas/pistas.days.js';
import { PROJECT_REFS } from '../../src/modules/buscaminas/buscaminas.seed.js';
import {
  assertCalendar, canonical, contentHash, parseDayFile, planSeed, repeatedPlayers, resolvePistasSeedTarget, toDayRow,
} from '../../src/modules/pistas/pistas.seed.js';
import type { PistasDayRow } from '../../src/modules/pistas/pistas.types.js';
import { calendar, makeDay, rawDay } from './fixtures.js';

const DAY = '2026-09-27';
type Raw = ReturnType<typeof rawDay>;
const edit = (patch: (d: Raw) => void): Raw => {
  const d = structuredClone(rawDay(DAY));
  patch(d);
  return d;
};
const errorOf = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };

describe('pistas seed: day file validation', () => {
  it('keeps exactly the stored fields: `source` and unknown fields never reach the database or the version', () => {
    const day = makeDay(DAY);
    expect(JSON.stringify(day)).not.toMatch(/source|questionIds|playerId/);
    const noisy = edit((d) => {
      (d as Record<string, unknown>).notes = 'x';
      (d.rounds[0].clues[0] as Record<string, unknown>).origin = 'q-1';
      d.rounds[0].source = { questionIds: ['other'], playerId: 'other' };
    });
    expect(parseDayFile('f', noisy)).toEqual(day);
    expect(day.rounds[0]).toEqual({
      id: 'r0', difficulty: 'easy',
      clues: expect.arrayContaining([{ kind: 'confed', icon: 'confed:uefa', text: { es: 'pista 0.0', en: 'clue 0.0', ka: 'მინიშნება 0.0', tr: 'ipucu 0.0' } }]),
      answer: { display: { es: 'Número 0', en: 'Numero 0', ka: 'ნომერი 0', tr: 'Numara 0' }, accepted: ['Numero 0', 'ნომერი 0', 'Numara 0', 'N 0'] },
    });
  });

  it('the content version hashes the full canonical rounds: any clue, icon, text, answer or order change is a new version', () => {
    const base = makeDay(DAY).contentVersion;
    expect(base).toBe(contentHash(makeDay(DAY).rounds));
    expect(Number.isInteger(base) && base >= 1 && base <= 2 ** 32).toBe(true);
    const variants = [
      edit((d) => { d.rounds[3].clues[9].text.ka = 'სხვა'; }),
      edit((d) => { d.rounds[3].clues[0].icon = 'confed:conmebol'; }),
      edit((d) => { d.rounds[3].answer.accepted.push('Otro'); }),
      edit((d) => { d.rounds[3].answer.display.tr = 'Numero 3'; }),
      edit((d) => { d.rounds.reverse(); }),
      edit((d) => { d.rounds[0].clues.reverse(); }),
    ];
    const versions = variants.map((d) => parseDayFile('f', d).contentVersion);
    for (const v of versions) expect(v).not.toBe(base);
    expect(new Set(versions).size).toBe(versions.length);
    // Key order does not matter.
    const reordered = makeDay(DAY).rounds.map((r) => ({ answer: r.answer, clues: r.clues, difficulty: r.difficulty, id: r.id }));
    expect(canonical(reordered)).toBe(canonical(makeDay(DAY).rounds));
    expect(contentHash(reordered)).toBe(base);
  });

  it.each([
    ['a wrong number', (d: Raw) => { d.number = 7; }, /number must be 1/],
    ['an impossible date', (d: Raw) => { d.day = '2026-02-30'; }, /valid YYYY-MM-DD/],
    ['a day before the first content day', (d: Raw) => { d.day = '2026-09-20'; }, /before the first content day/],
    ['9 rounds', (d: Raw) => { d.rounds.pop(); }, /expected 10 rounds/],
    ['a duplicate round id', (d: Raw) => { d.rounds[1].id = 'r0'; }, /round 2: duplicate round id/],
    ['an unknown difficulty', (d: Raw) => { d.rounds[0].difficulty = 'insane'; }, /round 1: difficulty/],
    ['9 clues', (d: Raw) => { d.rounds[2].clues.pop(); }, /round 3: expected 10 clues/],
    ['an unknown clue kind', (d: Raw) => { d.rounds[0].clues[4].kind = 'club' as never; }, /round 1 clue 5: kind must be one of/],
    ['an icon that is markup or a URL', (d: Raw) => { d.rounds[0].clues[0].icon = '<img src=x>'; }, /round 1 clue 1: icon must be null or an icon id/],
    ['a remote icon', (d: Raw) => { d.rounds[0].clues[0].icon = 'https://x.example/a.png'; }, /icon must be null or an icon id/],
    ['a missing clue locale', (d: Raw) => { d.rounds[1].clues[3].text.ka = ' '; }, /round 2 clue 4: text.ka missing/],
    ['a missing display locale', (d: Raw) => { d.rounds[1].answer.display.tr = ''; }, /round 2: answer.display.tr missing/],
    ['no accepted answers', (d: Raw) => { d.rounds[1].answer.accepted = []; }, /round 2: answer.accepted must be a non-empty list/],
    ['an accepted answer without letters', (d: Raw) => { d.rounds[1].answer.accepted.push('--'); }, /round 2: answer.accepted\[4\] has no letter or digit/],
    ['a display name that is not accepted', (d: Raw) => { d.rounds[4].answer.accepted = ['Numero 4', 'Numara 4']; }, /round 5: answer.display.ka does not normalise into answer.accepted/],
    ['the same answer twice in a day', (d: Raw) => { d.rounds[6].answer = structuredClone(d.rounds[2].answer); }, /round 7: same answer as round 3/],
  ])('rejects %s', (_name, patch, message) => {
    expect(() => parseDayFile('2026-09-27.json', edit(patch))).toThrow(message);
  });

  it('refuses a clue that names an accepted answer as whole words (any locale, accents and case aside), and never prints it', () => {
    const named = edit((d) => { d.rounds[2].clues[6].text.es = 'Le decían NÚMERO-2 en el barrio'; });
    const message = errorOf(() => parseDayFile('2026-09-27.json', named));
    expect(message).toBe('2026-09-27.json: round 3 clue 7: text.es names an accepted answer');
    const alias = edit((d) => { d.rounds[2].clues[1].text.tr = 'Takma adı n 2'; });
    expect(errorOf(() => parseDayFile('f', alias))).toMatch(/round 3 clue 2: text.tr names an accepted answer/);
    // A longer word that merely contains the answer is not a whole-word match.
    expect(() => parseDayFile('f', edit((d) => { d.rounds[2].clues[1].text.en = 'numero 20 shirt'; }))).not.toThrow();
  });

  it('no validation message contains an answer or a clue text', () => {
    const cases = [
      edit((d) => { d.rounds[4].answer.accepted = ['Numero 4']; }),
      edit((d) => { d.rounds[6].answer = structuredClone(d.rounds[2].answer); }),
      edit((d) => { d.rounds[2].clues[6].text.es = 'es Numero 2'; }),
      edit((d) => { d.rounds[1].id = 'r0'; }),
    ];
    for (const d of cases) expect(errorOf(() => parseDayFile('f', d))).not.toMatch(/umero|ნომერი|Numara|pista|"r0"/);
  });

  it('takes the whole calendar or a batch that appends to it, as long as the files are contiguous', () => {
    expect(() => assertCalendar(calendar())).not.toThrow();
    expect(() => assertCalendar(calendar().slice(0, 4))).not.toThrow();
    expect(() => assertCalendar([...calendar(), makeDay('2026-10-27')])).not.toThrow();
    expect(() => assertCalendar([makeDay('2026-10-27'), makeDay('2026-10-28')])).not.toThrow();
    expect(() => assertCalendar([])).toThrow(/no days/);
    const gap = calendar();
    gap[2] = makeDay('2026-10-03');
    expect(() => assertCalendar(gap)).toThrow(/contiguous/);
  });

  it('finds a player who is the answer on two days, naming positions only', () => {
    const day = (id: string, names: string[]) => ({
      day: id,
      rounds: names.map((name, r) => ({ ...makeDay(id).rounds[r], answer: { display: { es: name, en: name, ka: name, tr: name }, accepted: [name] } })),
    });
    const stored = [day('2026-09-27', ['Alfa Uno', 'Beta Dos']), day('2026-09-28', ['Gama Tres', 'Delta Cuatro'])];
    expect(repeatedPlayers([day('2026-09-29', ['Epsilon Cinco', 'Zeta Seis'])], stored)).toEqual([]);
    expect(repeatedPlayers([day('2026-09-29', ['Epsilon Cinco', 'Beta Dos'])], stored)).toEqual(['2026-09-29 round 2 = 2026-09-27 round 2']);
    // Within one set each pair is reported once, and a day never matches itself.
    expect(repeatedPlayers(stored, stored)).toEqual([]);
    const twice = [...stored, day('2026-09-29', ['Alfa Uno', 'Otro Mas'])];
    expect(repeatedPlayers(twice, twice)).toEqual(['2026-09-29 round 1 = 2026-09-27 round 1']);
    expect(JSON.stringify(repeatedPlayers(twice, twice))).not.toMatch(/Alfa|Uno/);
    // A nickname shown on one day and accepted on the other is the same player; a shared accepted surname is not.
    const nick = (id: string, display: string, accepted: string[]) => ({
      day: id, rounds: [{ ...makeDay(id).rounds[0], answer: { display: { es: display, en: display, ka: display, tr: display }, accepted } }],
    });
    expect(repeatedPlayers([nick('2026-09-30', 'El Mago', ['El Mago'])], [nick('2026-09-27', 'Pablo Ficticio', ['Pablo Ficticio', 'El Mago'])])).toHaveLength(1);
    expect(repeatedPlayers([nick('2026-09-30', 'Hugo Ficticio', ['Hugo Ficticio', 'Ficticio'])], [nick('2026-09-27', 'Pablo Ficticio', ['Pablo Ficticio', 'Ficticio'])])).toEqual([]);
  });

  it('scans a year of days for repeats in well under the seed transaction budget', () => {
    const year = Array.from({ length: 365 }, (_, d) => ({
      day: addDays('2026-09-27', d),
      rounds: Array.from({ length: 10 }, (_, r) => ({
        ...makeDay('2026-09-27').rounds[r],
        answer: { display: { es: `Jugador ${d} ${r}`, en: `Player ${d} ${r}`, ka: `მოთამაშე ${d} ${r}`, tr: `Oyuncu ${d} ${r}` }, accepted: [`Player ${d} ${r}`, `P ${d} ${r}`] },
      })),
    }));
    const started = Date.now();
    expect(repeatedPlayers(year, year)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('pistas seed: plan', () => {
  const stored = (...rows: PistasDayRow[]) => new Map(rows.map((r) => [r.day, r]));
  const a = toDayRow(makeDay('2026-09-27'));
  const b = toDayRow(makeDay('2026-09-28'));
  const bCorrected = toDayRow(makeDay('2026-09-28', 1));

  it('classifies days as new, changed or unchanged (key order aside) and reports stored extras without deleting them', () => {
    const reordered = { ...a, rounds: a.rounds.map((r) => ({ answer: r.answer, clues: r.clues, id: r.id, difficulty: r.difficulty })) };
    const extra = toDayRow(makeDay('2026-09-29'));
    const plan = planSeed(stored(reordered, b, extra), new Map(), [a, bCorrected, toDayRow(makeDay('2026-09-30'))], { allowCorrection: false });
    expect(plan.entries.map((e) => [e.day, e.status, e.contentChanged])).toEqual([
      ['2026-09-27', 'unchanged', false], ['2026-09-28', 'changed', true], ['2026-09-30', 'new', false],
    ]);
    expect(plan.extraDays).toEqual(['2026-09-29']);
  });

  it('any content change to a played day needs --allow-correction, which unranks its ranked runs', () => {
    const runs = new Map([['2026-09-28', { runs: 3, ranked: 2 }]]);
    expect(errorOf(() => planSeed(stored(b), runs, [bCorrected], { allowCorrection: false })))
      .toMatch(/2026-09-28 \(3 runs\): content changed; pass --allow-correction/);
    expect(planSeed(stored(b), runs, [bCorrected], { allowCorrection: true }).entries[0]).toMatchObject({
      status: 'changed', contentChanged: true, runs: 3, voids: 2, previousVersion: b.contentVersion, contentVersion: bCorrected.contentVersion,
    });
    // Unchanged played days and unplayed days need no flag.
    expect(planSeed(stored(b), runs, [b], { allowCorrection: false }).entries[0]).toMatchObject({ status: 'unchanged', voids: 0 });
    expect(planSeed(stored(b), new Map(), [bCorrected], { allowCorrection: false }).entries[0]).toMatchObject({ contentChanged: true, voids: 0 });
  });
});

describe('pistas seed: host guard', () => {
  const pooler = (ref: string) => `postgresql://postgres.${ref}:s3cret-pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`;
  const local = 'postgresql://postgres:pw@127.0.0.1:5432/quizball_pistas_local';

  it('the target is always explicit and must match DATABASE_URL', () => {
    expect(errorOf(() => resolvePistasSeedTarget(local, undefined))).toMatch(/--target local\|staging\|production is required/);
    expect(resolvePistasSeedTarget(local, 'local')).toEqual({ kind: 'local', label: 'local 127.0.0.1:5432/quizball_pistas_local' });
    expect(errorOf(() => resolvePistasSeedTarget(local, 'staging'))).toMatch(/local database/);
    expect(errorOf(() => resolvePistasSeedTarget(pooler(PROJECT_REFS.production), 'local'))).toMatch(/^--target local: Refusing to seed a non-local database \(Supabase project lfbwhx/);
    expect(errorOf(() => resolvePistasSeedTarget(pooler(PROJECT_REFS.staging), 'production'))).toMatch(/expects Supabase project lfbwhxvwubzeqkztghok/);
    expect(resolvePistasSeedTarget(pooler(PROJECT_REFS.staging), 'staging')).toEqual({ kind: 'staging', label: 'staging (Supabase project nsdfiprfmhdqhbfxfwpv)' });
    for (const message of [errorOf(() => resolvePistasSeedTarget(pooler(PROJECT_REFS.staging), 'local')), errorOf(() => resolvePistasSeedTarget('not a url', 'local'))]) {
      expect(message).not.toContain('s3cret');
    }
  });

  it('the CLI refuses a remote database before reading files or connecting', () => {
    const root = resolve(__dirname, '../..');
    const empty = mkdtempSync(join(tmpdir(), 'pistas-days-'));
    writeFileSync(join(empty, 'README.txt'), 'no day files');
    const run = (args: string[]) => {
      try {
        execFileSync(join(root, 'node_modules/.bin/tsx'), ['scripts/pistas-seed-days.ts', ...args], {
          cwd: root, stdio: 'pipe', env: { ...process.env, DATABASE_URL: pooler(PROJECT_REFS.production) },
        });
        return '';
      } catch (error) {
        return String((error as { stderr?: Buffer }).stderr);
      }
    };
    const refused = run(['--file', empty, '--target', 'local']);
    expect(refused).toMatch(/--target local: Refusing to seed a non-local database \(Supabase project lfbwhxvwubzeqkztghok\)/);
    expect(refused).not.toContain('s3cret');
    expect(run(['--file', empty])).toMatch(/--target local\|staging\|production is required/);
    expect(run(['--file', empty, '--target', 'prod'])).toMatch(/--target must be local, staging or production/);
  });
});

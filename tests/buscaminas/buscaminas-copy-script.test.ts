import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addDays, LAUNCH_DAY, PUBLISHED_DAYS } from '../../src/modules/buscaminas/buscaminas.days.js';
import { openContent, type SealedContent } from '../../src/modules/buscaminas/buscaminas.sealed.js';
import type { BuscaminasDayContent } from '../../src/modules/buscaminas/buscaminas.types.js';
import { makeDay, testKey } from './fixtures.js';

const root = resolve(__dirname, '../..');
const tsx = join(root, 'node_modules/.bin/tsx');
const KEY = testKey();

const calendar = (): BuscaminasDayContent[] => Array.from({ length: PUBLISHED_DAYS }, (_, i) => makeDay(addDays(LAUNCH_DAY, i), 100 + i));

function writeSource(days: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'buscaminas-src-'));
  for (const day of days) writeFileSync(join(dir, `${(day as { day: string }).day}.json`), JSON.stringify(day));
  return dir;
}

function runCopy(src: string, opts: { key?: string; out?: string } = {}): { out: string; error: string | null } {
  const out = opts.out ?? mkdtempSync(join(tmpdir(), 'buscaminas-out-'));
  try {
    execFileSync(tsx, ['scripts/buscaminas-copy-content.ts', src], {
      cwd: root, stdio: 'pipe', env: { ...process.env, BUSCAMINAS_CONTENT_OUT_DIR: out, BUSCAMINAS_CONTENT_KEY: opts.key ?? KEY },
    });
    return { out, error: null };
  } catch (error) {
    return { out, error: String((error as { stderr?: Buffer }).stderr ?? error) };
  }
}

const readSealed = (out: string): SealedContent => {
  const text = readFileSync(join(out, 'content.enc.ts'), 'utf8');
  return JSON.parse(text.slice(text.indexOf('= ') + 2, text.lastIndexOf(';'))) as SealedContent;
};

const withDay = (i: number, patch: (d: BuscaminasDayContent) => unknown): unknown[] =>
  calendar().map((d, j) => (j === i ? patch(d) : d));

describe('buscaminas content copy script', () => {
  it('encrypts the full boards (dropping unknown fields), removes stale plaintext and is idempotent', () => {
    const days = calendar();
    const src = writeSource(days.map((d) => ({ ...d, rounds: d.rounds.map((r) => ({ ...r, notes: 'n', cards: r.cards.map((c) => ({ ...c, evidence: 'e' })) })) })));
    const out = mkdtempSync(join(tmpdir(), 'buscaminas-out-'));
    mkdirSync(join(out, 'days'));
    writeFileSync(join(out, 'days', `${LAUNCH_DAY}.json`), '{}');
    writeFileSync(join(out, 'content.generated.ts'), 'export {};');

    expect(runCopy(src, { out }).error).toBeNull();
    expect(existsSync(join(out, 'days'))).toBe(false);
    expect(existsSync(join(out, 'content.generated.ts'))).toBe(false);
    const text = readFileSync(join(out, 'content.enc.ts'), 'utf8');
    expect(text).not.toMatch(/"ok"|r0c0|Player|clue|pista|buscaminas\/v1\/p/);
    const opened = openContent(readSealed(out), KEY);
    expect(opened).toEqual(days);
    expect(opened[0].rounds[0].prompt).toEqual({ es: 'pista 0', en: 'clue 0', ka: 'მინიშნება 0', tr: 'ipucu 0' });
    expect(opened[0].rounds[0].cards[0]).toEqual({ id: 'r0c0', name: 'Player 0-0', img: '/buscaminas/v1/p/r0c0.webp', ok: true });

    expect(runCopy(src, { out }).error).toBeNull();
    expect(readFileSync(join(out, 'content.enc.ts'), 'utf8')).toBe(text);
  }, 30_000);

  it('rejects day files without a valid contentVersion instead of defaulting it', () => {
    const cases = [
      withDay(3, ({ contentVersion: _omit, ...rest }) => rest),
      withDay(3, (d) => ({ ...d, contentVersion: 2 ** 32 + 1 })),
      withDay(3, (d) => ({ ...d, contentVersion: '3' })),
    ];
    for (const days of cases) expect(runCopy(writeSource(days)).error).toMatch(/contentVersion must be present/);
  }, 30_000);

  it('rejects stripped answers and a gap or short calendar', () => {
    expect(runCopy(writeSource(withDay(0, (d) => ({ ...d, rounds: d.rounds.map((r) => ({ ...r, cards: r.cards.map(({ ok: _ok, ...card }) => card) })) })))).error)
      .toMatch(/missing ok/);
    const gap = calendar().filter((_, i) => i !== 5).concat(makeDay(addDays(LAUNCH_DAY, PUBLISHED_DAYS)));
    expect(runCopy(writeSource(gap)).error).toMatch(/contiguous/);
    expect(runCopy(writeSource(calendar().slice(1))).error).toMatch(new RegExp(`expected ${PUBLISHED_DAYS} day files`));
  }, 30_000);

  it('rejects a board missing a locale, a card name or image, an image outside the card directory, or an unknown difficulty', () => {
    type Round = BuscaminasDayContent['rounds'][number];
    type Card = Round['cards'][number];
    const withRound = (patch: (r: Round) => unknown) => withDay(7, (d) => ({ ...d, rounds: d.rounds.map((r, i) => (i === 4 ? patch(r) : r)) }));
    const withCard = (patch: (c: Card) => unknown) => withRound((r) => ({ ...r, cards: r.cards.map((c, j) => (j === 9 ? patch(c) : c)) }));
    const cases: Array<[unknown[], RegExp]> = [
      [withRound(({ prompt: { ka: _ka, ...prompt }, ...r }) => ({ ...r, prompt })), /2026-10-03\.json: round 4: prompt\.ka missing/],
      [withRound((r) => ({ ...r, prompt: { ...r.prompt, tr: ' ' } })), /round 4: prompt\.tr missing/],
      [withRound(({ prompt: _prompt, ...r }) => r), /round 4: prompt\.es missing/],
      [withRound((r) => ({ ...r, difficulty: 'expert' })), /round 4: difficulty must be one of easy\/medium\/hard/],
      [withRound((r) => ({ ...r, cards: r.cards.slice(0, 15) })), /round 4: expected 16 cards/],
      [withCard((c) => ({ ...c, name: '' })), /round 4 card 9: missing name/],
      [withCard(({ img: _img, ...c }) => c), /round 4 card 9: img must be a file under \/buscaminas\/v1\/p\//],
      [withCard((c) => ({ ...c, img: 'https://example.com/p/1.webp' })), /card 9: img must be a file under/],
      [withCard((c) => ({ ...c, img: '/buscaminas/v1/p/../../secret.json' })), /card 9: img must be a file under/],
    ];
    for (const [days, reason] of cases) expect(runCopy(writeSource(days)).error).toMatch(reason);
  }, 60_000);

  it('refuses to run without a valid key', () => {
    const src = writeSource(calendar());
    expect(runCopy(src, { key: '' }).error).toMatch(/BUSCAMINAS_CONTENT_KEY is not set/);
    expect(runCopy(src, { key: 'abc' }).error).toMatch(/64 hex/);
  }, 30_000);
});

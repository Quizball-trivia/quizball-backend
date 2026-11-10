import { describe, expect, it } from 'vitest';
import { chunkRows, GapBuffer, normalizeGapText, safeGap, storable, type GapObservation } from '../../src/modules/content-gaps/content-gaps.buffer.js';

// Invented names only: the repository is public.
const seen = (over: Partial<GapObservation> = {}): GapObservation => ({
  game: 'darts501', mode: 'daily', boardKey: 'cat-1', context: 'rel|cov|m1|abc', verdict: 'unknown', text: 'Aro Bandel', ...over,
});

describe('normalizeGapText', () => {
  it('folds case, accents, Turkish dotless i and punctuation, keeps Georgian and Cyrillic', () => {
    expect(normalizeGapText('  Árö  BÁNDEL!! ')).toBe('aro bandel');
    expect(normalizeGapText('KIRIŞ Iı')).toBe('kiris ii');
    expect(normalizeGapText('ვოტკინსი')).toBe('ვოტკინსი');
    expect(normalizeGapText('Бандель-Аро')).toBe('бандель аро');
    expect(normalizeGapText('?!')).toBe('');
  });
});

describe('GapBuffer', () => {
  it('aggregates one key per board, context, verdict and text, keeping a few raw samples per locale', () => {
    const b = new GapBuffer();
    b.add(seen({ text: 'Aro Bandel', locale: 'en' }));
    b.add(seen({ text: 'aro  bandel', locale: 'en' }));
    b.add(seen({ text: 'ARO BANDEL', locale: 'es' }));
    b.add(seen({ text: 'Aro Bandel', verdict: 'miss', resolvedId: 'p0' }));
    const rows = b.drain();
    expect(rows).toHaveLength(2);
    const unknown = rows.find((r) => r.verdict === 'unknown')!;
    expect(unknown).toMatchObject({ n: 3, norm: 'aro bandel', samples: { en: ['Aro Bandel', 'aro  bandel'], es: ['ARO BANDEL'] } });
    expect(rows.find((r) => r.verdict === 'miss')).toMatchObject({ n: 1, resolved_id: 'p0' });
    expect(b.drain()).toEqual([]);
  });

  it('a new judging context is a new key (a fix starts fresh)', () => {
    const b = new GapBuffer();
    b.add(seen());
    b.add(seen({ context: 'rel|cov2|m1|def' }));
    expect(b.drain()).toHaveLength(2);
  });

  it('guesses the locale from the script when the game does not know it', () => {
    const b = new GapBuffer();
    b.add(seen({ text: 'ბანდელი' }));
    b.add(seen({ text: 'Бандель' }));
    b.add(seen({ text: 'Bandel' }));
    b.add(seen({ text: 'Bandelo', locale: 'pt' }));
    expect(b.drain().map((r) => Object.keys(r.samples)[0]).sort()).toEqual(['ka', 'pt', 'ru', 'xx']);
  });

  it('never keeps contact details or empty text', () => {
    const b = new GapBuffer();
    expect(b.add(seen({ text: 'someone@example.org' }))).toBe(false);
    expect(b.add(seen({ text: '+1 (555) 010-9999' }))).toBe(false);
    expect(b.add(seen({ text: 'https://example.org' }))).toBe(false);
    expect(b.add(seen({ text: ' !! ' }))).toBe(false);
    expect(b.add(seen({ text: '180' }))).toBe(true);
    expect(b.takeStats()).toMatchObject({ refused: 4, recorded: 1 });
  });

  it('caps keys: a full buffer drops new keys but keeps counting existing ones', () => {
    const b = new GapBuffer(2);
    b.add(seen({ text: 'Aro' }));
    b.add(seen({ text: 'Ceto' }));
    expect(b.add(seen({ text: 'Emil' }))).toBe(false);
    expect(b.add(seen({ text: 'Aro' }))).toBe(true);
    expect(b.takeStats()).toMatchObject({ dropped: 1, keys: 2 });
    expect(b.drain().find((r) => r.norm === 'aro')!.n).toBe(2);
  });

  it('caps samples per locale and the lengths of everything stored', () => {
    const b = new GapBuffer();
    for (let i = 0; i < 9; i += 1) b.add(seen({ text: `Aro Bandel${'!'.repeat(i)}`, locale: 'en' }));
    b.add(seen({ text: 'x'.repeat(500), candidateIds: Array.from({ length: 30 }, (_, i) => `p${i}`) }));
    const rows = b.drain();
    expect(rows.find((r) => r.norm === 'aro bandel')!.samples.en).toHaveLength(5);
    const long = rows.find((r) => r.norm.startsWith('x'))!;
    expect(long.norm.length).toBeLessThanOrEqual(80);
    expect(long.samples.xx[0].length).toBeLessThanOrEqual(160);
    expect(long.candidate_ids).toHaveLength(10);
  });

  it('drains sorted by key (the flush lock order)', () => {
    const b = new GapBuffer();
    for (const t of ['Zed', 'Aro', 'Mo']) b.add(seen({ text: t }));
    expect(b.drain().map((r) => r.norm)).toEqual(['aro', 'mo', 'zed']);
  });
});

describe('chunkRows', () => {
  it('bounds chunks by rows and by bytes', () => {
    const b = new GapBuffer();
    for (let i = 0; i < 12; i += 1) b.add(seen({ text: `Name ${String.fromCharCode(97 + i)}` }));
    const rows = b.drain();
    expect(chunkRows(rows, 5).map((c) => c.length)).toEqual([5, 5, 2]);
    expect(chunkRows(rows, 500, 600).every((c) => c.length >= 1 && c.length <= 3)).toBe(true);
  });
});

describe('safety of what is kept', () => {
  it('screens full-width contact details on the whole text, before clipping', () => {
    const b = new GapBuffer();
    expect(b.add(seen({ text: 'someone＠example.org' }))).toBe(false);
    expect(b.add(seen({ text: '＋１（５５５）０１０－９９９９' }))).toBe(false);
    expect(b.add(seen({ text: `${'a'.repeat(170)} someone@example.org` }))).toBe(false);
    expect(b.add(seen({ text: 'www.example.org' }))).toBe(false);
    expect(b.add(seen({ text: '1234\u000056789' }))).toBe(false);
  });

  it('stores only text PostgreSQL accepts: no NUL, no lone surrogate, never a split pair', () => {
    expect(storable('ab\u0000c', 10)).toBe('abc');
    expect(storable('a\uD800b', 10)).toBe('a�b');
    expect(storable('😀😀😀', 2)).toBe('😀😀');
    const b = new GapBuffer();
    b.add(seen({ text: 'Aro\u0000 Ban\uDC00del' }));
    const [row] = b.drain();
    expect(row.samples.xx[0]).toBe('Aro Ban�del');
    expect(JSON.stringify(row)).not.toContain('\\u0000');
  });

  it('past the byte budget existing keys keep counting but take no more samples or metadata', () => {
    const probe = new GapBuffer();
    probe.add(seen({ text: 'Aro Bandel', locale: 'en' }));
    // Room for exactly one row with its first sample, nothing more.
    const budget = Buffer.byteLength(JSON.stringify(['darts501', 'cat-1', 'rel|cov|m1|abc', 'unknown', 'aro bandel'])) * 2 + 200 + Buffer.byteLength('Aro Bandel') + 8 + 16;
    const b = new GapBuffer(100, budget);
    b.add(seen({ text: 'Aro Bandel', locale: 'en' }));
    expect(b.add(seen({ text: 'Ceto Darrin' }))).toBe(false);
    b.add(seen({ text: 'aro bandel', locale: 'es', candidateIds: ['p1', 'p2'] }));
    const aro = b.drain().find((r) => r.norm === 'aro bandel')!;
    expect(aro.n).toBe(2);
    expect(aro.samples.es).toBeUndefined();
    expect(aro.candidate_ids).toBeNull();
  });

  it('safeGap turns a throwing diagnostic into no gap', () => {
    expect(safeGap(() => { throw new Error('boom'); })).toBeNull();
    expect(safeGap(() => 7)).toBe(7);
  });
});

describe('byte budget', () => {
  it('holds the serialised size under the configured ceiling, Georgian text included', () => {
    const max = 20_000;
    const b = new GapBuffer(100_000, max);
    for (let i = 0; i < 2_000; i += 1) b.add(seen({ text: `ბანდელი ${i} ${'ქ'.repeat(40)}`, candidateIds: ['p1', 'p2'], resolvedId: 'p9' }));
    const size = Buffer.byteLength(JSON.stringify(b.drain()));
    expect(size).toBeLessThanOrEqual(max);
  });
});

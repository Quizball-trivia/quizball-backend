import { describe, expect, it } from 'vitest';
import { dartsGap } from '../../src/modules/darts501/darts501.gaps.js';
import { readDart } from '../../src/modules/darts501/darts501.rules.js';
import { category, directory, boardFor } from '../darts501/fixture.js';

// Invented content only (tests/darts501/fixture.ts).
describe('Darts 501 → content gaps', () => {
  const cat = category('cat-x');
  const judged = (text: string) => {
    const read = readDart(boardFor(cat), new Set(), 501, text, null);
    return dartsGap(read.verdict, text, read.eid, cat, directory);
  };

  it('logs unknown, ambiguous (with candidates), uncovered and miss; never a score or a repeat', () => {
    expect(judged('Nobody Atall')).toMatchObject({ game: 'darts501', boardKey: 'cat-x', verdict: 'unknown', resolvedId: null });
    expect(judged('Zorr')).toMatchObject({ verdict: 'ambiguous', candidateIds: expect.arrayContaining(['p12', 'p13']) });
    expect(judged('Wim Xell')).toMatchObject({ verdict: 'uncovered', resolvedId: 'p11' });
    expect(judged('Udo Varn')).toMatchObject({ verdict: 'miss', resolvedId: 'p10' });
    expect(judged('Emil Fosk')).toBeNull();
    expect(dartsGap('repeat', 'Emil Fosk', 'p2', cat, directory)).toBeNull();
  });

  it('the context names release, coverage, matcher and content revision; a corrected category is a new context', () => {
    const a = judged('Udo Varn')!;
    const fixed = { ...cat, entries: [...cat.entries, { eid: 'p10', value: 7 }] };
    const b = dartsGap('miss', 'Udo Varn', 'p10', fixed, directory)!;
    expect(a.context.startsWith('rel|cov|m')).toBe(true);
    expect(b.context).not.toBe(a.context);
  });

  it('candidates() is diagnostics only: identify still says ambiguous', () => {
    expect(directory.identify('Zorr')).toEqual({ kind: 'ambiguous' });
    expect(directory.candidates?.('Zorr')).toEqual(['p12', 'p13']);
    expect(directory.candidates?.('Emil Fosk')).toEqual(['p2']);
  });
});

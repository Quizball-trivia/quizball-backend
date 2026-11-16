import { describe, expect, it } from 'vitest';
import { buildDirectory, footballerTypoVeto, judge, type TenableEntity } from '../../src/modules/tenable/tenable.identify.js';
import { NAMES } from '../footballers/names-fixture.js';

// Invented people only (tests/footballers/names-fixture.ts): the manager Ezio Galtero played as a footballer, and a
// different footballer is called Ezio Gautero.
const E = (eid: string, name: string, known: string, fame: number): TenableEntity => ({ eid, name, known, fame, aliases: [], qualifier: null });
const ROWS = [E('m-gal', 'Ezio Galtero', 'Galtero', 60), E('m-orv', 'Paolo Orvani', 'Orvani', 40)];

describe('Tenable managers: a footballer\'s own name is never a typo of another manager', () => {
  const vetoed = buildDirectory('manager', 'rel', ROWS, 'latin', () => footballerTypoVeto(NAMES));
  const plain = buildDirectory('manager', 'rel', ROWS);

  it('refuses the typo reading when the text is, as typed, another footballer', () => {
    expect(plain.identify('Ezio Gautero')).toEqual({ kind: 'entity', eid: 'm-gal' });
    expect(vetoed.identify('Ezio Gautero')).toEqual({ kind: 'unknown' });
    expect(judge(vetoed, ['m-gal'], new Set(), 'Ezio Gautero')).toEqual({ kind: 'unknown' });
  });

  it('keeps plain typos and names of managers who are not footballers', () => {
    expect(vetoed.identify('Ezio Galtro')).toEqual({ kind: 'entity', eid: 'm-gal' });
    expect(vetoed.identify('Paolo Orvany')).toEqual({ kind: 'entity', eid: 'm-orv' });
  });

  it('without the names (not loaded) it judges as before, and a reading made before they load is read again after', () => {
    expect(footballerTypoVeto(null)).toBeUndefined();
    let names: typeof NAMES | null = null;
    const later = buildDirectory('manager', 'rel', ROWS, 'latin', () => footballerTypoVeto(names));
    expect(later.identify('Ezio Gautero')).toEqual({ kind: 'entity', eid: 'm-gal' });
    names = NAMES;
    expect(later.identify('Ezio Gautero')).toEqual({ kind: 'unknown' });
  });
});

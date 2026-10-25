import { describe, expect, it } from 'vitest';
import { assertAppend, keysOf, repeatedLists, sameCategory } from '../../src/modules/ultimo/ultimo.seed.js';
import { makeDay, plainCategory } from './fixtures.js';

const retitled = (id: string) => ({ es: `Otra ${id}`, en: `Other ${id}`, ka: `Otra ${id}`, tr: `Otra ${id}` });

describe('Último content overlap', () => {
  const base = plainCategory('overlap-base', 8);

  it('the same names under new answer ids and a new title are the same list', () => {
    const rekeyed = { ...base, id: 'rekeyed', title: retitled('a'), answers: base.answers.map((a, i) => ({ ...a, id: `new-${i}` })) };
    expect(sameCategory(base, rekeyed)).toBe(true);
  });

  it('the same answer ids with every display renamed are the same list', () => {
    const renamed = {
      ...base, id: 'renamed', title: retitled('b'),
      answers: base.answers.map((a, i) => ({ ...a, display: { es: `Otro ${i}`, en: `Other ${i}`, ka: `Otro ${i}`, tr: `Otro ${i}` } })),
    };
    expect(sameCategory(base, renamed)).toBe(true);
  });

  it('a different list is not', () => {
    expect(sameCategory(base, plainCategory('overlap-other', 8))).toBe(false);
  });
});

describe('Último seed: append', () => {
  const stored = Array.from({ length: 30 }, (_, i) => makeDay(i));
  const next = (from: number, n: number) => Array.from({ length: n }, (_, i) => makeDay(from + i));
  const errorOf = (fn: () => unknown): string => { try { fn(); return ''; } catch (e) { return (e as Error).message; } };

  it('adds only days after the stored ones, and stored + appended must cover the calendar without a gap', () => {
    expect(() => assertAppend(stored, next(30, 30))).not.toThrow();
    expect(errorOf(() => assertAppend(stored, next(29, 31)))).toMatch(/already stored: 2026-10-27$/);
    expect(errorOf(() => assertAppend(stored, next(31, 30)))).toMatch(/contiguous.*position 31 is 2026-10-29, expected 2026-10-28/);
    expect(errorOf(() => assertAppend(stored, next(30, 5)))).toMatch(/expected at least 60 days/);
  });

  it('refuses a category id that a stored day already uses', () => {
    const appended = next(30, 30);
    appended[4] = makeDay(34, [stored[2].categories[1], ...appended[4].categories.slice(1)]);
    expect(errorOf(() => assertAppend(stored, appended))).toMatch(/a category id is used on two days/);
  });
});

describe('Último seed: repeated lists on append', () => {
  const old = plainCategory('old-list', 9);
  const published = [keysOf(old)];
  const day = (cats: ReturnType<typeof plainCategory>[]) => ({ day: '2026-10-28', categories: cats });

  it('refuses the same list under a new id and title, by answer ids or by names, and a reused title', () => {
    const rekeyed = { ...old, id: 'new-id', title: { es: 'Otro', en: 'Other', ka: 'სხვა', tr: 'Başka' } };
    expect(repeatedLists(published, [day([plainCategory('fresh', 8), rekeyed])])).toEqual(['2026-10-28 c2']);
    const renamedIds = { ...rekeyed, answers: old.answers.map((a, i) => ({ ...a, id: `x-${i}` })) };
    expect(repeatedLists(published, [day([renamedIds])])).toEqual(['2026-10-28 c1']);
    const sameTitle = { ...plainCategory('other-list', 8), title: old.title };
    expect(repeatedLists(published, [day([sameTitle])])).toEqual(['2026-10-28 c1']);
  });

  it('allows a look-alike list that shares most but not all answers', () => {
    const lookAlike = { ...old, id: 'look-alike', title: { es: 'Parecida', en: 'Similar', ka: 'მსგავსი', tr: 'Benzer' }, answers: old.answers.slice(1) };
    expect(repeatedLists(published, [day([lookAlike])])).toEqual([]);
  });
});

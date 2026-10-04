import { describe, expect, it } from 'vitest';
import { contentHash, keysOf, repeatedCategories, sameCategory, sameDailyList } from '../../src/modules/ultimo/ultimo.seed.js';
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

describe('último seed: a list is a daily category once', () => {
  const day = (offset: number, categories?: Parameters<typeof makeDay>[1]) => { const d = makeDay(offset, categories); return { ...d, contentVersion: contentHash(d.categories) }; };
  const base = plainCategory('lista-a', 10);

  it('the same id, the same title or exactly the same answers is the same daily list; sharing most answers is not', () => {
    expect(sameDailyList(keysOf(base), keysOf({ ...base }))).toBe(true);
    expect(sameDailyList(keysOf(base), keysOf({ ...plainCategory('otra', 9), title: base.title }))).toBe(true);
    const renamed = { ...base, id: 'renamed', title: { es: 'Otro nombre', en: 'Another name', ka: 'სხვა', tr: 'Başka' } };
    expect(sameDailyList(keysOf(base), keysOf(renamed))).toBe(true);
    // Nine of ten answers shared (two squads of one country): a different list for the daily calendar…
    const lookalike = { ...renamed, answers: [...base.answers.slice(0, 9), plainCategory('x', 1).answers[0]] };
    expect(sameDailyList(keysOf(base), keysOf(lookalike))).toBe(false);
    // …though the daily-versus-pool rule still calls it the same content.
    expect(sameCategory(base, lookalike)).toBe(true);
  });

  it('finds a repeat in the other supplied days, in what is stored and in the ledger, by position only', () => {
    const renamed = { ...base, id: 'renamed', title: { es: 'Otro nombre', en: 'Another name', ka: 'სხვა', tr: 'Başka' } };
    const first = day(0, [base, ...makeDay(0).categories.slice(1)]);
    const second = day(1, [renamed, ...makeDay(1).categories.slice(1)]);
    // Two supplied days: reported once, on the later day, whatever is stored.
    expect(repeatedCategories([first, second])).toEqual([`${second.day} #1`]);
    expect(repeatedCategories([first])).toEqual([]);
    // Appending the second day alone: found against what is stored elsewhere, or in the ledger.
    expect(repeatedCategories([second], { elsewhere: [keysOf(base)] })).toEqual([`${second.day} #1`]);
    expect(repeatedCategories([second], { ledger: [keysOf(base)] })).toEqual([`${second.day} #1`]);
    expect(JSON.stringify(repeatedCategories([second], { ledger: [keysOf(base)] }))).not.toMatch(/Jugador|Apellido|lista-a/);
    // The same list twice on one new day.
    const twice = day(2, [base, renamed, ...makeDay(2).categories.slice(2)]);
    expect(repeatedCategories([twice])).toEqual([`${twice.day} #2`]);
  });

  it('a day keeps, corrects or re-keys its own lists; it cannot take another day\'s list under an id it already has', () => {
    const other = plainCategory('lista-b', 9);
    const stored = day(0, [base, ...makeDay(0).categories.slice(1)]);
    const ledger = [keysOf(base), keysOf(other), ...stored.categories.slice(1).map(keysOf)];
    const own = (d: string) => (d === stored.day ? stored.categories.map(keysOf) : []);
    // Re-supplied as it is: its own ledger entries are not a repeat.
    expect(repeatedCategories([stored], { ledger, own })).toEqual([]);
    // Re-keyed (only the id changes) or corrected (an answer changes): still its own list.
    const rekeyed = day(0, [{ ...base, id: 'lista-a-v2' }, ...stored.categories.slice(1)]);
    expect(repeatedCategories([rekeyed], { ledger, own })).toEqual([]);
    const corrected = day(0, [{ ...base, answers: [...base.answers.slice(0, 9), plainCategory('z', 1).answers[0]] }, ...stored.categories.slice(1)]);
    expect(repeatedCategories([corrected], { ledger, own })).toEqual([]);
    // Another day's list slipped in under an id this day already has: a repeat.
    const hijacked = day(0, [{ ...other, id: base.id }, ...stored.categories.slice(1)]);
    expect(repeatedCategories([hijacked], { ledger, elsewhere: [keysOf(other)], own })).toEqual([`${stored.day} #1`]);
    expect(repeatedCategories([hijacked], { ledger, own })).toEqual([`${stored.day} #1`]);
  });

  it('the same answers under new ids or with one display name edited are still the same list', () => {
    const renamed = { ...base, id: 'renamed', title: { es: 'Otro nombre', en: 'Another name', ka: 'სხვა', tr: 'Başka' } };
    const edited = { ...renamed, answers: renamed.answers.map((a, i) => (i === 0 ? { ...a, display: { ...a.display, en: `${a.display.en} Jr` } } : a)) };
    expect(sameDailyList(keysOf(base), keysOf(edited))).toBe(true);
    const rekeyedAnswers = { ...renamed, answers: renamed.answers.map((a, i) => ({ ...a, id: `other-${i}` })) };
    expect(sameDailyList(keysOf(base), keysOf(rekeyedAnswers))).toBe(true);
  });
});

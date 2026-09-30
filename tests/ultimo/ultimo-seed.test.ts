import { describe, expect, it } from 'vitest';
import { sameCategory } from '../../src/modules/ultimo/ultimo.seed.js';
import { plainCategory } from './fixtures.js';

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

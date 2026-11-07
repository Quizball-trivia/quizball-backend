import { describe, expect, it } from 'vitest';
import { EMAIL_COPY, EMAIL_LANGUAGES, fillCopy, singleLanguageEmail } from '../../src/modules/retention-email/email-copy.js';

const leaves = (value: unknown, path = ''): Array<[string, string]> =>
  typeof value === 'string'
    ? [[path, value]]
    : Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => leaves(inner, `${path}.${key}`));
const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

describe('email copy', () => {
  const english = new Map(leaves(EMAIL_COPY.en));

  it.each(EMAIL_LANGUAGES)('%s has every string, with the same placeholders as English', (lang) => {
    const own = new Map(leaves(EMAIL_COPY[lang]));
    expect([...own.keys()].sort()).toEqual([...english.keys()].sort());
    for (const [path, text] of own) {
      expect(text.trim().length, path).toBeGreaterThan(0);
      expect(placeholders(text), path).toEqual(placeholders(english.get(path)!));
    }
  });

  it('keeps Georgian, English and unknown readers on the two-language email', () => {
    for (const preferred of ['en', 'ka', 'EN-us', 'xx', '', null, undefined]) expect(singleLanguageEmail(preferred)).toBeNull();
  });

  it('reads a regional tag as its language', () => {
    expect(singleLanguageEmail('pt-BR')).toBe('pt');
    expect(singleLanguageEmail('fr-CA')).toBe('fr');
    expect(singleLanguageEmail(' ES ')).toBe('es');
  });

  it('fills known placeholders and leaves others', () => {
    expect(fillCopy('{qp} of {x}', { qp: 5 })).toBe('5 of {x}');
  });
});

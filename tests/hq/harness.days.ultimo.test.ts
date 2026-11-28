import { describe, expect, it } from 'vitest';
import '../setup.js';

const { ultimoCategory, slug, ULTIMO_PATTERN, ULTIMO_PER_DAY } = await import('../../src/modules/harness/harness.days.ultimo.js');
const { roundsToOrder } = await import('../../src/modules/harness/harness.days.js');
const { parseDayFile } = await import('../../src/modules/ultimo/ultimo.seed.js');
const { dayNumber } = await import('../../src/modules/ultimo/ultimo.days.js');

const LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'el'] as const;
const every = (text: string) => Object.fromEntries(LOCALES.map((l) => [l, text])) as Record<(typeof LOCALES)[number], string>;
const CLUBS = ['Arlan Rovers', 'Teo United', 'Bruck City', 'Selik Athletic', 'Dantas FC', 'Kless Town', 'Farn Wanderers', 'Tomin Albion', 'Onder County', 'Massen Vale'];
const checked = (names = CLUBS, over: Record<string, unknown> = {}) => ({ title: 'Clubs Arlan Moss played for (to November 2026)', hint: 'Loans count; national teams do not.', answers: names.map((name) => ({ name, aliases: [name.split(' ')[0]!] })), ...over });
const localized = (names = CLUBS, over: Record<string, unknown> = {}) => ({
  title: every('Clubs Arlan Moss played for (to November 2026)'),
  hint: every('Loans count; national teams do not.'),
  answers: names.map((name) => ({ display: { ...every(name), ka: `${name} ქართ` }, aliases: [`${name} FC`] })),
  ...over,
});

describe('day builder: Último', () => {
  it('makes ids a list can be stored under', () => {
    expect(slug("Atlético de Madrid")).toBe('atletico-de-madrid');
    expect(slug('  Vélez   Sarsfield ')).toBe('velez-sarsfield');
    expect(slug('!!!')).toBe('x');
    expect(slug('a'.repeat(90)).length).toBe(60);
  });

  it('builds a list the way the game stores one', () => {
    const made = ultimoCategory(12, 'medium', checked(), localized());
    if (!made.ok) throw new Error(made.why);
    expect(made.category.id).toBe('hq12-clubs-arlan-moss-played-for-to-november-2026');
    expect(made.category.difficulty).toBe('medium');
    expect(made.category.answers).toHaveLength(10);
    expect(made.category.answers[0]).toEqual({ id: 'arlan-rovers', display: { ...every('Arlan Rovers'), ka: 'Arlan Rovers ქართ' }, aliases: ['Arlan', 'Arlan Rovers FC'] });
  });

  it('leaves out a spelling that would name two answers, and keeps answer ids apart', () => {
    const names = ['Dinamo Tbilisi', 'Dinamo Kyiv', ...CLUBS.slice(0, 8)];
    const made = ultimoCategory(3, 'easy', checked(names), localized(names));
    if (!made.ok) throw new Error(made.why);
    // "Dinamo" is the first answer's alias; the second answer may not have it too.
    expect(made.category.answers[0]!.aliases).toContain('Dinamo');
    expect(made.category.answers[1]!.aliases).not.toContain('Dinamo');
    const twins = ['Real Madrid', 'Real  Madrid!', ...CLUBS.slice(0, 8)];
    const same = ultimoCategory(4, 'easy', checked(twins), localized(twins, { answers: twins.map((name, i) => ({ display: every(i === 1 ? 'Real Madrid B' : name), aliases: [] })) }));
    if (!same.ok) throw new Error(same.why);
    expect(same.category.answers.slice(0, 2).map((a) => a.id)).toEqual(['real-madrid', 'real-madrid-b-2']);
  });

  it('says why a list cannot be stored, without building half of one', () => {
    expect(ultimoCategory(1, 'easy', null as never, localized())).toEqual({ ok: false, why: 'its checked list is not in the shape expected' });
    expect(ultimoCategory(1, 'easy', checked(), { title: 'x' } as never)).toEqual({ ok: false, why: 'its translations are not in the shape expected' });
    expect(ultimoCategory(1, 'easy', checked(), localized(CLUBS.slice(0, 9)))).toEqual({ ok: false, why: 'the translations do not match the list answer for answer' });
    const noGreek = localized();
    delete (noGreek.title as Record<string, string>).el;
    expect(ultimoCategory(1, 'easy', checked(), noGreek)).toEqual({ ok: false, why: 'the title is missing in a language, or too long' });
    const longName = localized();
    (longName.answers[2]!.display as Record<string, string>).de = 'x'.repeat(61);
    expect(ultimoCategory(1, 'easy', checked(), longName)).toEqual({ ok: false, why: 'answer 3 has no name in a language, or one too long to type' });
    const clash = localized();
    (clash.answers[5]!.display as Record<string, string>).tr = 'Arlan Rovers';
    expect(ultimoCategory(1, 'easy', checked(), clash)).toEqual({ ok: false, why: 'answers 1 and 6 have the same name in a language' });
    // Fewer than the game takes: the game's own shape refuses it, by field only.
    expect(ultimoCategory(1, 'easy', checked(CLUBS.slice(0, 5)), localized(CLUBS.slice(0, 5)))).toEqual({ ok: false, why: "the game's own shape refused it (answers)" });
  });

  it("makes a day the game's own checks accept", () => {
    const day = '2026-12-11';
    const lists = ULTIMO_PATTERN.map((difficulty, i) => {
      const names = CLUBS.map((c) => `${c} ${String.fromCharCode(65 + i)}`);
      const made = ultimoCategory(i + 1, difficulty, checked(names, { title: `List number ${i + 1} of clubs` }), localized(names, { title: every(`List number ${i + 1} of clubs`) }));
      if (!made.ok) throw new Error(made.why);
      return made.category;
    });
    const parsed = parseDayFile(day, { day, number: dayNumber(day), categories: lists });
    expect(parsed.categories.map((c) => c.difficulty)).toEqual(['easy', 'easy', 'medium', 'medium', 'hard']);
  });

  it('orders lists by the mix of a day of Último', () => {
    // Ten days short would be 26/26/13 (2/2/1 a day, a third more for the ones that are dropped): one order names
    // at most 30, in the same mix.
    expect(roundsToOrder(10, { easy: 0, medium: 0, hard: 0 }, 200, ULTIMO_PER_DAY)).toEqual({ easy: 12, medium: 12, hard: 6 });
    expect(roundsToOrder(2, { easy: 0, medium: 0, hard: 0 }, 200, ULTIMO_PER_DAY)).toEqual({ easy: 6, medium: 6, hard: 3 });
    expect(roundsToOrder(1, { easy: 1, medium: 0, hard: 0 }, 200, ULTIMO_PER_DAY)).toEqual({ easy: 2, medium: 3, hard: 2 });
    const cut = roundsToOrder(10, { easy: 0, medium: 0, hard: 0 }, 30, ULTIMO_PER_DAY);
    expect(cut.easy + cut.medium + cut.hard).toBe(30);
  });
});

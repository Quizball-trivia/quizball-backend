import { describe, expect, it } from 'vitest';
import '../setup.js';

const { roundsToOrder, storedRound, PISTAS_PATTERN } = await import('../../src/modules/harness/harness.days.js');
const { parseDayFile } = await import('../../src/modules/pistas/pistas.seed.js');
const { dayNumber } = await import('../../src/modules/pistas/pistas.days.js');

const LOCALES = ['es', 'en', 'ka', 'tr', 'ru', 'pt', 'de', 'fr', 'el'] as const;
const every = (text: string) => Object.fromEntries(LOCALES.map((l) => [l, `${text} (${l})`])) as Record<(typeof LOCALES)[number], string>;
const chips = new Map([
  ['confed:UEFA', every("I'm European.")],
  ['position:FW', every("I'm a forward.")],
  ['foot:left', every("I'm left-footed.")],
  ['decade:1970', every('I was born in the 1970s.')],
  ['decade:2000', every('I was born in the 2000s.')],
]);
const checked = (over: Record<string, unknown> = {}) => ({ name: 'Arlan Moss', accepted: ['Moss', 'Arlan Moss'], confed: 'UEFA', position: 'FW', foot: 'left', born: 1976, facts: Array.from({ length: 7 }, (_, i) => `Fact ${i + 1}`), ...over });
const localized = (name = 'Arlan Moss', over: Record<string, unknown> = {}) => ({
  display: Object.fromEntries(LOCALES.map((l) => [l, l === 'ka' ? 'არლან მოსი' : name])),
  accepted: ['არლან მოსი'],
  facts: Array.from({ length: 7 }, (_, i) => every(`Fact ${i + 1}`)),
  ...over,
});

describe('day builder', () => {
  it('orders what the missing days need plus spares, less what is already on its way', () => {
    // Ten days short: 3/4/3 a day, a third more for the ones the checker drops.
    expect(roundsToOrder(10, { easy: 0, medium: 0, hard: 0 }, 200)).toEqual({ easy: 9, medium: 12, hard: 9 });
    expect(roundsToOrder(1, { easy: 0, medium: 0, hard: 0 }, 200)).toEqual({ easy: 4, medium: 6, hard: 4 });
    expect(roundsToOrder(1, { easy: 4, medium: 2, hard: 9 }, 200)).toEqual({ easy: 0, medium: 4, hard: 0 });
    expect(roundsToOrder(0, { easy: 0, medium: 0, hard: 0 }, 200)).toEqual({ easy: 0, medium: 0, hard: 0 });
  });

  it('never orders more than there is room for, and keeps the mix when it has to cut', () => {
    const cut = roundsToOrder(10, { easy: 0, medium: 0, hard: 0 }, 10);
    expect(cut.easy + cut.medium + cut.hard).toBeLessThanOrEqual(10);
    expect(cut.medium).toBeGreaterThanOrEqual(cut.easy);
    expect(cut.easy).toBeGreaterThan(0);
    expect(cut.hard).toBeGreaterThan(0);
    expect(roundsToOrder(10, { easy: 0, medium: 0, hard: 0 }, 0)).toEqual({ easy: 0, medium: 0, hard: 0 });
    expect(roundsToOrder(10, { easy: 0, medium: 0, hard: 0 }, -5)).toEqual({ easy: 0, medium: 0, hard: 0 });
  });

  it('builds a round the way the stored days are written: three profile chips, then seven facts', () => {
    const made = storedRound(checked() as never, localized() as never, chips as never, 'easy');
    if (!made.ok) throw new Error(made.why);
    // An older player is told by the decade, after the confederation and the position.
    expect(made.round.clues.map((c) => c.kind)).toEqual(['confed', 'position', 'decade', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact', 'fact']);
    expect(made.round.clues[2]!.icon).toBe('1970');
    expect(made.round.clues[3]).toEqual({ kind: 'fact', icon: null, text: every('Fact 1') });
    // Every name shown is also an accepted answer.
    expect(made.round.answer.accepted).toEqual(['Moss', 'Arlan Moss', 'არლან მოსი']);
    // A recent player is told by their foot, first.
    const recent = storedRound(checked({ born: 2002 }) as never, localized() as never, chips as never, 'hard');
    if (!recent.ok) throw new Error(recent.why);
    expect(recent.round.clues.slice(0, 3).map((c) => `${c.kind}:${c.icon}`)).toEqual(['foot:left', 'confed:UEFA', 'position:FW']);
    // No known foot: the decade, whatever the age.
    const noFoot = storedRound(checked({ born: 2002, foot: null }) as never, localized() as never, chips as never, 'hard');
    expect(noFoot.ok && noFoot.round.clues[2]!.icon).toBe('2000');
  });

  it('says why a round cannot be stored, without building half of one', () => {
    expect(storedRound(checked({ confed: 'OFC' }) as never, localized() as never, chips as never, 'easy')).toEqual({ ok: false, why: 'no wording for that confederation' });
    expect(storedRound(checked({ position: 'XX' }) as never, localized() as never, chips as never, 'easy')).toEqual({ ok: false, why: 'no wording for that position' });
    expect(storedRound(checked({ born: 1890, foot: null }) as never, localized() as never, chips as never, 'easy')).toEqual({ ok: false, why: 'no wording for the foot or the decade' });
    expect(storedRound(checked() as never, localized('Arlan Moss', { facts: [every('one')] }) as never, chips as never, 'easy')).toEqual({ ok: false, why: 'a round needs 7 facts' });
    const noGreek = localized();
    delete (noGreek.display as Record<string, string>).el;
    expect(storedRound(checked() as never, noGreek as never, chips as never, 'easy')).toEqual({ ok: false, why: 'the name is missing in a language' });
    const thinFact = localized();
    (thinFact.facts[3] as Record<string, string>).ka = '  ';
    expect(storedRound(checked() as never, thinFact as never, chips as never, 'easy')).toEqual({ ok: false, why: 'fact 4 is missing in a language' });
  });

  it('makes a day the game\'s own checks accept', () => {
    const day = '2026-12-10';
    const names = ['Arlan Moss', 'Teo Varga', 'Ilan Bruck', 'Mato Selik', 'Pio Dantas', 'Uri Kless', 'Odo Farn', 'Lev Tomin', 'Raf Onder', 'Kio Massen'];
    const rounds = PISTAS_PATTERN.map((difficulty, i) => {
      const made = storedRound(checked({ name: names[i], accepted: [names[i]!] }) as never, localized(names[i], { accepted: [], display: Object.fromEntries(LOCALES.map((l) => [l, names[i]])) }) as never, chips as never, difficulty);
      if (!made.ok) throw new Error(made.why);
      return { id: `${day}-r${i + 1}`, ...made.round };
    });
    const parsed = parseDayFile(day, { day, number: dayNumber(day), rounds });
    expect(parsed.rounds).toHaveLength(10);
    expect(parsed.rounds.map((r) => r.difficulty)).toEqual([...PISTAS_PATTERN]);
    // And the checks still bite: a clue that names the answer is refused, by position only.
    (rounds[4]!.clues[5]!.text as Record<string, string>).tr = 'Pio Dantas scored here';
    expect(() => parseDayFile(day, { day, number: dayNumber(day), rounds })).toThrow(/round 5 clue 6: text\.tr names an accepted answer/);
  });
});

import { describe, expect, it } from 'vitest';
import { matchAnswer, turnMsFor, ultimoCategorySchema } from '../../src/modules/ultimo/ultimo.match.js';
import { category } from './fixtures.js';

const c = category();
const idx = (id: string) => c.answers.findIndex((a) => a.id === id);
const answerOf = (text: string) => matchAnswer(c, text);

describe('Último en pie answer matching', () => {
  it('a full name, an alias, a unique surname and the name without its first word all name their answer', () => {
    expect(answerOf('Emilio Varga')).toEqual({ kind: 'answer', index: idx('emilio') });
    expect(answerOf('emi')).toEqual({ kind: 'answer', index: idx('emilio') });
    expect(answerOf('VARGA')).toEqual({ kind: 'answer', index: idx('emilio') });
    expect(answerOf('de lucca')).toEqual({ kind: 'answer', index: idx('diego') });
    expect(answerOf('DeLucca')).toEqual({ kind: 'answer', index: idx('diego') });
  });

  it('a surname several answers share is ambiguous — never the first one listed', () => {
    expect(answerOf('Martel')).toEqual({ kind: 'ambiguous' });
    expect(answerOf('Bruno Martel')).toEqual({ kind: 'answer', index: idx('bruno') });
  });

  it('an explicit alias wins over another answer\'s generated surname', () => {
    // "Rojo" is Fabián Sosa's alias and Gastón Rojo's surname: the alias names Fabián.
    expect(answerOf('rojo')).toEqual({ kind: 'answer', index: idx('fabian') });
    expect(answerOf('Gastón Rojo')).toEqual({ kind: 'answer', index: idx('gaston') });
  });

  it('Turkish dotted/dotless i and Georgian script match however they are typed', () => {
    for (const typed of ['Işık Yılmaz', 'ISIK YILMAZ', 'ışık yılmaz', 'isik yilmaz', 'İşık Yılmaz']) expect(answerOf(typed)).toEqual({ kind: 'answer', index: idx('isik') });
    expect(answerOf('ახალი არკადია')).toEqual({ kind: 'answer', index: idx('arcadia') });
    expect(answerOf('Yeni Arkadya')).toEqual({ kind: 'answer', index: idx('arcadia') });
  });

  it('one typo is forgiven when it points to exactly one answer; close to two it is ambiguous; short keys are exact only', () => {
    expect(answerOf('Vargo')).toEqual({ kind: 'answer', index: idx('emilio') });
    expect(answerOf('Petrow')).toEqual({ kind: 'answer', index: idx('petrov') });
    expect(answerOf('Rossa')).toEqual({ kind: 'ambiguous' });
    expect(answerOf('Emu')).toEqual({ kind: 'none' });
    expect(answerOf('Zzzzzzz')).toEqual({ kind: 'none' });
    expect(answerOf('x')).toEqual({ kind: 'none' });
  });

  it('the schema refuses a name on two answers and names longer than the answer box', () => {
    const clash = { ...c, answers: [...c.answers.slice(0, 8), { ...c.answers[8], aliases: ['Emi'] }] };
    expect(ultimoCategorySchema.safeParse(clash).success).toBe(false);
    const long = { ...c, answers: [...c.answers.slice(0, 11), { ...c.answers[11], aliases: ['x'.repeat(61)] }] };
    expect(ultimoCategorySchema.safeParse(long).success).toBe(false);
    expect(ultimoCategorySchema.safeParse(c).success).toBe(true);
  });

  it('the answer clock starts at 20 s and loses 2 s every two answers, never under 6 s', () => {
    expect([0, 1, 2, 3, 4, 13, 14, 40].map(turnMsFor)).toEqual([20_000, 20_000, 18_000, 18_000, 16_000, 8_000, 6_000, 6_000]);
  });
});

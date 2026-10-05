import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { calendarFingerprint } from '../../src/modules/day-batches/day-batches.games.js';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

describe('calendarFingerprint', () => {
  it('is the formula the pipeline records (pinned on both sides: src/day-batches.test.ts in the agents repo)', async () => {
    const board = { rounds: [{ prompt: { es: 'Jugaron en Boca', en: 'Played for Boca' }, difficulty: 'easy' }] };
    const tx = ((first: unknown) => (typeof first === 'string' ? first : Promise.resolve([{ day: '2026-09-26', v: '7', board }]))) as never;
    expect(await calendarFingerprint(tx, 'buscaminas_days', true))
      .toBe(sha(`2026-09-26:7:${sha('{"rounds":[{"difficulty":"easy","prompt":{"en":"Played for Boca","es":"Jugaron en Boca"}}]}')}`));
  });
});

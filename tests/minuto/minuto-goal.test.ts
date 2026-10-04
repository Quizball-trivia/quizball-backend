import { describe, expect, it } from 'vitest';
import { duelPoints, goalSchema, publicGoal, soloPoints } from '../../src/modules/minuto/minuto.goal.js';
import { rawGoal } from './fixtures.js';

describe('minuto goal', () => {
  it('duel points follow the video: exact 3 (and it replaces the closest point), else closer 1, a tie 1 each', () => {
    const table: Array<[[number | null, number | null], number, [number, number]]> = [
      [[50, 50], 50, [3, 3]],
      [[50, 52], 50, [3, 0]],
      [[49, 50], 50, [0, 3]],
      [[48, 53], 50, [1, 0]],
      [[56, 47], 50, [0, 1]],
      [[47, 53], 50, [1, 1]],
      [[50, null], 50, [3, 0]],
      [[80, null], 50, [1, 0]],
      [[null, 80], 50, [0, 1]],
      [[null, null], 50, [0, 0]],
    ];
    for (const [guesses, answer, points] of table) expect(duelPoints(guesses, answer)).toEqual(points);
  });

  it('solo points: exact 3, within 2 → 2, within 5 → 1, else 0', () => {
    expect([0, 1, 2, 3, 5, 6, 40].map(soloPoints)).toEqual([3, 2, 2, 1, 1, 0, 0]);
  });

  it('refuses added time after a minute that is not 45/90/105/120, a minute past 130 and a score that never counted the goal', () => {
    expect(goalSchema.safeParse(rawGoal('2026-10-01', 9)).success).toBe(true);
    expect(goalSchema.safeParse({ ...rawGoal('2026-10-01', 1), minute: { base: 60, added: 2 } }).success).toBe(false);
    expect(goalSchema.safeParse({ ...rawGoal('2026-10-01', 1), minute: { base: 120, added: 11 } }).success).toBe(false);
    expect(goalSchema.safeParse({ ...rawGoal('2026-10-01', 1), scoreAfter: [0, 1] }).success).toBe(false);
    expect(goalSchema.safeParse({ ...rawGoal('2026-10-01', 1), source: 'x' }).success).toBe(false);
  });

  it('the public card never carries the minute, the fingerprint or a stray field', () => {
    const goal = goalSchema.parse(rawGoal('2026-10-01', 4));
    const card = publicGoal(goal);
    expect(card).not.toHaveProperty('minute');
    expect(card).not.toHaveProperty('fingerprint');
    expect(JSON.stringify(card)).not.toContain(goal.fingerprint);
    expect(card.scorer.name.es).toBe('Goleador 4');
  });

  it('preserves rights-managed photo credits while requiring an opaque first-party path', () => {
    const image = {
      src: 'minuto/photos/0123456789abcdef0123456789abcdef.webp',
      credit: 'Photographer / Getty Images',
      license: 'Rights-managed',
    };
    const raw = { ...rawGoal('2026-10-01', 4), image };
    const card = publicGoal(goalSchema.parse(raw));
    expect(card.image).toEqual(image);
    expect(card).not.toHaveProperty('minute');
    expect(goalSchema.safeParse({ ...raw, image: { ...image, src: 'https://example.com/photo.webp' } }).success).toBe(false);
    expect(goalSchema.safeParse({ ...raw, image: { ...image, src: 'minuto/photos/goal-minute-42.webp' } }).success).toBe(false);
    expect(goalSchema.safeParse({ ...raw, image: { ...image, license: 'Unknown' } }).success).toBe(false);
  });
});

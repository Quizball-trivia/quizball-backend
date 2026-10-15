import { describe, expect, it } from 'vitest';
import { checkRelease } from '../../src/modules/footballers/footballers.seed.js';
import { MATCHER_VERSION } from '../../src/modules/footballers/footballers.universe.js';

// Invented footballers only: the repository is public.
const player = (pid: string, name = 'Tarin Orlen') => ({ pid, name, game: 'Orlen', fame: 50, aliases: [] });
const file = (players: unknown[], release: Record<string, unknown> = {}) => ({ release: { id: 'test-release-1', matcherVersion: MATCHER_VERSION, ...release }, players });

describe('word game release file', () => {
  it('accepts a well-formed release and fingerprints its content, whatever the row order', () => {
    const a = checkRelease(file([player('p1'), player('p2', 'Emir Kosel')]));
    const b = checkRelease(file([player('p2', 'Emir Kosel'), player('p1')]));
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(checkRelease(file([player('p1'), player('p2', 'Emir Kosal')])).fingerprint).not.toBe(a.fingerprint);
  });
  it('refuses a duplicate id, another matcher, a bad release id and a name without a Latin letter', () => {
    expect(() => checkRelease(file([player('p1'), player('p1')]))).toThrow(/Duplicate/);
    expect(() => checkRelease(file([player('p1')], { matcherVersion: MATCHER_VERSION + 1 }))).toThrow(/matcher/);
    expect(() => checkRelease(file([player('p1')], { id: 'Bad Id' }))).toThrow(/Invalid release/);
    expect(() => checkRelease(file([player('p1', '!!!')]))).toThrow(/Latin letter/);
  });
  it('mirrors the table limits and never quotes a name in its error', () => {
    const long = 'Tarin '.repeat(20);
    let message = '';
    try { checkRelease(file([player('p1', long)])); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/Invalid release/);
    expect(message).not.toContain('Tarin');
    expect(() => checkRelease(file([{ ...player('p1'), fame: 101 }]))).toThrow();
    expect(() => checkRelease(file([{ ...player('p1'), aliases: Array(17).fill('x') }]))).toThrow();
    expect(() => checkRelease(file([{ ...player('p1'), extra: 1 }]))).toThrow();
  });
});

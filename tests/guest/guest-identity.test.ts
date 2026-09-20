import { describe, expect, it } from 'vitest';
import { guestKitFor, guestNameCandidates } from '../../src/modules/guest/guest-identity.js';

describe('guest identity', () => {
  it('derives deterministic, distinct name candidates with a numeric suffix', () => {
    const a = guestNameCandidates('11111111-1111-1111-1111-111111111111');
    expect(a).toEqual(guestNameCandidates('11111111-1111-1111-1111-111111111111'));
    expect(a).toHaveLength(6);
    expect(new Set(a).size).toBe(6);
    for (const name of a) expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/);
    expect(guestNameCandidates('22222222-2222-2222-2222-222222222222')[0]).not.toBe(a[0]);
  });

  it('assigns one of the three default kits', () => {
    const kits = new Set<string>();
    for (let i = 0; i < 40; i += 1) kits.add(guestKitFor(`guest-${i}`).jersey ?? '');
    expect([...kits].sort()).toEqual(['jersey_blue', 'jersey_green', 'jersey_yellow']);
    expect(guestKitFor('x')).toEqual(guestKitFor('x'));
  });
});

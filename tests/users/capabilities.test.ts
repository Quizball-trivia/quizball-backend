import { describe, expect, it } from 'vitest';
import { assertCapability, capabilitiesFor, hasCapability, isGuestUser, isProgressionEligible } from '../../src/modules/users/capabilities.js';
import { CapabilityRequiredError, ErrorCode } from '../../src/core/errors.js';

describe('capabilities', () => {
  const member = { is_guest: false, is_ai: false, ai_kind: null };
  const guest = { is_guest: true, is_ai: false, ai_kind: null };
  const persistentBot = { is_guest: false, is_ai: true, ai_kind: 'persistent' };
  const ephemeralBot = { is_guest: false, is_ai: true, ai_kind: 'ephemeral' };

  it('gives members everything and guests only the friendly-room pair', () => {
    expect(capabilitiesFor(member).size).toBe(10);
    expect([...capabilitiesFor(guest)].sort()).toEqual(['createFriendlyRoom', 'joinFriendlyRoom']);
    for (const cap of ['rankedEntry', 'queueEntry', 'weekendLeague', 'social', 'progression', 'wallet', 'profileEdit', 'discoverable'] as const) {
      expect(hasCapability(guest, cap), cap).toBe(false);
    }
    expect(isGuestUser({})).toBe(false);
  });

  it('throws the typed 403 the web maps to the sign-up dialog', () => {
    expect(() => assertCapability(member, 'rankedEntry')).not.toThrow();
    try {
      assertCapability(guest, 'rankedEntry');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityRequiredError);
      const typed = error as CapabilityRequiredError;
      expect(typed.statusCode).toBe(403);
      expect(typed.code).toBe(ErrorCode.CAPABILITY_REQUIRED);
      expect(typed.details).toEqual({ capability: 'rankedEntry' });
    }
  });

  it('keeps the existing bot policy and adds the guest exclusion for progression', () => {
    expect(isProgressionEligible(member)).toBe(true);
    expect(isProgressionEligible(persistentBot)).toBe(true);
    expect(isProgressionEligible(ephemeralBot)).toBe(false);
    expect(isProgressionEligible(guest)).toBe(false);
  });
});

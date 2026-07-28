import { describe, expect, it } from 'vitest';
import { isPersistentBot, isRankedSettleEligible } from '../../src/modules/users/ai-classification.js';

/**
 * Ephemeral-unchanged regression: the calibrated model applies ONLY to
 * ai_kind='persistent'. This asserts the branch predicate that gates the whole
 * possession-ai persistent path — an ephemeral or auction AI must NEVER be
 * classified as persistent, so possession-ai's resolvePersistentModelForMatch
 * returns null for them and the existing bridge path runs byte-identically.
 */
describe('persistent-bot branch gating (ephemeral unchanged)', () => {
  it('only ai_kind=persistent counts as a persistent bot', () => {
    expect(isPersistentBot({ is_ai: true, ai_kind: 'persistent' })).toBe(true);
    expect(isPersistentBot({ is_ai: true, ai_kind: 'ephemeral' })).toBe(false);
    expect(isPersistentBot({ is_ai: true, ai_kind: 'auction' })).toBe(false);
    expect(isPersistentBot({ is_ai: true, ai_kind: null })).toBe(false);
    expect(isPersistentBot({ is_ai: false, ai_kind: null })).toBe(false);
  });

  it('a real human is never a persistent bot but is settle-eligible', () => {
    const human = { is_ai: false, ai_kind: null };
    expect(isPersistentBot(human)).toBe(false);
    expect(isRankedSettleEligible(human)).toBe(true);
  });
});

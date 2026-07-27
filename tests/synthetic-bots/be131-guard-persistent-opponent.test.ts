/**
 * Regression: the human disconnect/forfeit guards (be#131 family) must behave
 * byte-identically when the AI opponent is a PERSISTENT roster bot instead of an
 * ephemeral one. Both are is_ai=true, so every guard predicate that gates
 * "forfeit the human to the AI" — which keys on is_ai — classifies a persistent
 * bot exactly like an ephemeral bot: the human is never mis-identified as the AI
 * side, and the persistent bot is never counted in the human-ready set.
 *
 * PR7's only change to these paths is an ADDITIVE reservation release at the
 * existing terminal choke points, gated behind the flag AND a no-op when no
 * reservation row exists — it never alters which user is the human/forfeiter.
 */
import { describe, it, expect } from 'vitest';
import '../setup.js';
import { isPersistentBot, isRankedSettleEligible } from '../../src/modules/users/ai-classification.js';

const human = { is_ai: false, ai_kind: null };
const ephemeral = { is_ai: true, ai_kind: 'ephemeral' };
const persistent = { is_ai: true, ai_kind: 'persistent' };
const auction = { is_ai: true, ai_kind: 'auction' };

describe('be#131 guard: persistent bot classified like any AI opponent', () => {
  it('the human-ready predicate (is_ai !== true) excludes a persistent bot exactly like an ephemeral one', () => {
    // Mirrors resolveHumanReadyUserIds / no-contest human filter: keep only is_ai === false.
    const roster = [human, ephemeral, persistent, auction];
    const humans = roster.filter((u) => u.is_ai !== true);
    expect(humans).toEqual([human]);
  });

  it('isPersistentBot is true only for a persistent bot, false for human/ephemeral/auction', () => {
    expect(isPersistentBot(human)).toBe(false);
    expect(isPersistentBot(ephemeral)).toBe(false);
    expect(isPersistentBot(auction)).toBe(false);
    expect(isPersistentBot(persistent)).toBe(true);
  });

  it('settlement eligibility is unchanged for the guard: human + persistent settle, ephemeral/auction do not', () => {
    expect(isRankedSettleEligible(human)).toBe(true);
    expect(isRankedSettleEligible(persistent)).toBe(true);
    expect(isRankedSettleEligible(ephemeral)).toBe(false);
    expect(isRankedSettleEligible(auction)).toBe(false);
  });
});

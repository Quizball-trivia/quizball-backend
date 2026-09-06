import { describe, expect, it } from 'vitest';
import {
  DAILY_CHALLENGE_TAGS,
  rankDailyChallenges,
} from '../../src/modules/daily-challenges/daily-challenges.recommendations.js';
import type { DailyChallengeType } from '../../src/modules/daily-challenges/daily-challenges.schemas.js';

const candidates: DailyChallengeType[] = [
  'moneyDrop', 'trueFalse', 'clues', 'countdown', 'careerPath', 'highLow',
];

describe('daily challenge recommendations', () => {
  it('prefers what other players are finishing today when history is even', () => {
    const ranked = rankDailyChallenges({
      candidates,
      playersToday: new Map([['clues', 500], ['moneyDrop', 5]]),
      playsByUser: new Map(),
    }, 1);
    expect(ranked[0].challengeType).toBe('clues');
    expect(ranked[0].reason).toBe('trending');
  });

  it('surfaces a challenge the player rarely touches over one they grind', () => {
    const ranked = rankDailyChallenges({
      candidates: ['moneyDrop', 'countdown'],
      playersToday: new Map([['moneyDrop', 10], ['countdown', 10]]),
      playsByUser: new Map([['moneyDrop', 12], ['countdown', 0]]),
    }, 1);
    expect(ranked[0].challengeType).toBe('countdown');
  });

  it('rewards sharing a tag with the challenge just played', () => {
    // highLow and careerPath are both "guessing"; trueFalse is not.
    const ranked = rankDailyChallenges({
      candidates: ['trueFalse', 'careerPath'],
      playersToday: new Map([['trueFalse', 10], ['careerPath', 10]]),
      playsByUser: new Map(),
      justPlayed: 'clues',
    }, 1);
    expect(DAILY_CHALLENGE_TAGS.clues).toContain('guessing');
    expect(ranked[0].challengeType).toBe('careerPath');
    expect(ranked[0].reason).toBe('similar');
  });

  it('keeps the row diverse instead of two of the same kind', () => {
    const ranked = rankDailyChallenges({
      candidates: ['careerPath', 'clues', 'footballLogic'],
      playersToday: new Map([['careerPath', 100], ['clues', 99], ['footballLogic', 20]]),
      playsByUser: new Map(),
    }, 2);
    const tags = ranked.flatMap((item) => DAILY_CHALLENGE_TAGS[item.challengeType]);
    // Both top scorers are pure "guessing"; the diversity penalty must break it.
    expect(new Set(tags).size).toBeGreaterThan(1);
  });

  it('never returns more than the candidates allow, and nothing when none remain', () => {
    expect(rankDailyChallenges({ candidates: [], playersToday: new Map(), playsByUser: new Map() })).toEqual([]);
    expect(rankDailyChallenges({
      candidates: ['moneyDrop'], playersToday: new Map(), playsByUser: new Map(),
    }, 4)).toHaveLength(1);
  });
});

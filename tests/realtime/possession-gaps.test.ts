import { describe, expect, it } from 'vitest';
import { rankedGap } from '../../src/realtime/possession-gaps.js';

const base = { game: 'clue_chain' as const, questionId: 'q-1', accepted: ['Aro Bandel'], guess: 'Arro Bandle', isAi: false, partnerPool: null };

describe('rankedGap', () => {
  it('a refused guess on our own question is a miss keyed by question, judged against its accepted set', () => {
    const gap = rankedGap(base);
    expect(gap).toMatchObject({ game: 'clue_chain', mode: 'realtime', boardKey: 'q-1', verdict: 'miss', text: 'Arro Bandle', locale: null });
    expect(gap!.context).toMatch(/^[0-9a-f]{12}$/);
    // An edited question is a new judging context.
    expect(rankedGap({ ...base, accepted: ['Aro Bandel', 'Arro Bandel'] })!.context).not.toBe(gap!.context);
  });

  it('AI opponents, partner pools, unknown questions and blank guesses are not gaps', () => {
    expect(rankedGap({ ...base, isAi: true })).toBeNull();
    expect(rankedGap({ ...base, partnerPool: 'partner-x' })).toBeNull();
    expect(rankedGap({ ...base, questionId: null })).toBeNull();
    expect(rankedGap({ ...base, guess: '   ' })).toBeNull();
  });
});

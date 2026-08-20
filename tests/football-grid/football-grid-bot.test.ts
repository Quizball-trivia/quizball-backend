import { describe, expect, it } from 'vitest';
import {
  chooseFootballGridBotCell,
  footballGridBotAccuracy,
  footballGridBotDelayMs,
  footballGridBotTierPolicy,
  footballGridBotTierPolicyForVersion,
} from '../../src/modules/football-grid/football-grid-bot.service.js';
import type { FootballGridState } from '../../src/modules/football-grid/football-grid.types.js';

describe('Football Grid bot tier model', () => {
  it('makes higher Ranked tiers more knowledgeable and tactically consistent', () => {
    const academy = footballGridBotTierPolicy('Academy');
    const goat = footballGridBotTierPolicy('GOAT');
    expect(goat.accuracy).toBeGreaterThan(academy.accuracy);
    expect(goat.tacticalOptimality).toBeGreaterThan(academy.tacticalOptimality);
    expect(goat.passOnMiss).toBeLessThan(academy.passOnMiss);
    expect(footballGridBotAccuracy('GOAT')).toBe(goat.accuracy);
  });

  it('uses deterministic human-like delays that shorten with tier', () => {
    expect(footballGridBotDelayMs('Captain', 12345, 7)).toBe(
      footballGridBotDelayMs('Captain', 12345, 7),
    );
    expect(footballGridBotDelayMs('GOAT', 12345, 7)).toBeLessThan(
      footballGridBotDelayMs('Academy', 12345, 7),
    );
  });

  it('dispatches live matches only through their pinned policy version', () => {
    expect(footballGridBotTierPolicyForVersion(1, 1, 'Captain')).toEqual(
      footballGridBotTierPolicy('Captain'),
    );
    expect(() => footballGridBotTierPolicyForVersion(2, 1, 'Captain')).toThrow(
      'Unsupported Football Grid bot policy 2/1',
    );
  });

  it('takes a winning cell before considering a block', () => {
    const state = {
      turnNumber: 0,
      players: [{ userId: 'bot' }, { userId: 'human' }],
      claims: [
        { cellIndex: 0, claimantUserId: 'bot' },
        { cellIndex: 1, claimantUserId: 'bot' },
        { cellIndex: 3, claimantUserId: 'human' },
        { cellIndex: 4, claimantUserId: 'human' },
      ],
    } as FootballGridState;
    expect(chooseFootballGridBotCell(state, 'bot', 1, 'GOAT')).toBe(2);
  });

  it('blocks an immediate opponent win when it has no winning move', () => {
    const state = {
      turnNumber: 0,
      players: [{ userId: 'bot' }, { userId: 'human' }],
      claims: [
        { cellIndex: 3, claimantUserId: 'human' },
        { cellIndex: 4, claimantUserId: 'human' },
      ],
    } as FootballGridState;
    expect(chooseFootballGridBotCell(state, 'bot', 1, 'GOAT')).toBe(5);
  });
});

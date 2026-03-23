import type { ProgressionResponse } from './progression.schemas.js';

const BASE_LEVEL_XP = 100;
const LEVEL_GROWTH_FACTOR = 1.12;

const MATCH_XP_REWARDS = {
  ranked: {
    win: 120,
    draw: 100,
    loss: 85,
    forfeitLoss: 40,
  },
  friendly: {
    win: 70,
    draw: 60,
    loss: 50,
    forfeitLoss: 20,
  },
} as const;

export type MatchXpMode = keyof typeof MATCH_XP_REWARDS;

export function xpRequiredForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 1) {
    throw new RangeError('Level must be a positive integer');
  }

  return Math.max(
    1,
    Math.round(BASE_LEVEL_XP * Math.pow(LEVEL_GROWTH_FACTOR, level - 1))
  );
}

export function getProgressionFromTotalXp(totalXp: number): ProgressionResponse {
  const normalizedTotalXp = Math.max(0, Math.floor(totalXp));

  let level = 1;
  let remainingXp = normalizedTotalXp;
  let xpForNextLevel = xpRequiredForLevel(level);

  while (remainingXp >= xpForNextLevel) {
    remainingXp -= xpForNextLevel;
    level += 1;
    xpForNextLevel = xpRequiredForLevel(level);
  }

  return {
    level,
    totalXp: normalizedTotalXp,
    currentLevelXp: remainingXp,
    xpForNextLevel,
    progressPct: Math.floor((remainingXp / xpForNextLevel) * 100),
  };
}

export function getMatchXpReward(input: {
  mode: MatchXpMode;
  result: 'win' | 'loss' | 'draw';
  isForfeitLoss?: boolean;
}): number {
  if (input.result === 'draw') {
    return MATCH_XP_REWARDS[input.mode].draw;
  }

  if (input.result === 'loss' && input.isForfeitLoss) {
    return MATCH_XP_REWARDS[input.mode].forfeitLoss;
  }

  return MATCH_XP_REWARDS[input.mode][input.result];
}

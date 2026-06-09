import type {
  DailyChallengeSessionResponse,
  DailyChallengeSettings,
  DailyChallengeType,
} from './daily-challenges.schemas.js';

const MONEY_DROP_COIN_CAP = 1000;

export function computeMaxScoreForSession(session: DailyChallengeSessionResponse): number {
  switch (session.challengeType) {
    case 'moneyDrop':
      return Math.min(session.startingMoney, MONEY_DROP_COIN_CAP);
    case 'trueFalse':
    case 'imposter':
    case 'careerPath':
    case 'footballLogic':
    case 'clues':
      return session.questionCount;
    case 'putInOrder':
      return session.roundCount;
    case 'countdown':
      return session.rounds.reduce((total, round) => total + round.answerGroups.length, 0);
    case 'highLow':
      return session.rounds.reduce((total, round) => total + round.matchups.length, 0);
  }
}

export function getMaxScoreFromSettings(
  challengeType: DailyChallengeType,
  settings: DailyChallengeSettings
): number {
  switch (challengeType) {
    case 'moneyDrop':
      return Math.min(settings.startingMoney, MONEY_DROP_COIN_CAP);
    case 'trueFalse':
    case 'imposter':
    case 'careerPath':
    case 'footballLogic':
    case 'clues':
      return settings.questionCount;
    case 'putInOrder':
    case 'countdown':
    case 'highLow':
      return settings.roundCount;
  }
}

export function clampDailyChallengeScore(score: number, maxScore: number): number {
  const normalizedMax = Math.max(0, Math.floor(maxScore));
  return Math.min(Math.max(0, Math.floor(score)), normalizedMax);
}

export function getCoinsAwardedForCompletion(challengeType: DailyChallengeType, score: number): number {
  const normalizedScore = clampDailyChallengeScore(score, Number.MAX_SAFE_INTEGER);

  if (challengeType === 'moneyDrop') {
    return Math.min(normalizedScore, MONEY_DROP_COIN_CAP);
  }

  return normalizedScore * 20;
}

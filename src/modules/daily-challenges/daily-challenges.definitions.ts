import type { DailyChallengeDefinition, DailyChallengeType } from './daily-challenges.types.js';

export const DAILY_CHALLENGE_DEFINITIONS: Record<DailyChallengeType, DailyChallengeDefinition> = {
  moneyDrop: {
    challengeType: 'moneyDrop',
    title: 'Money Drop',
    description: 'Answer real football trivia and keep as much cash on the right answer as you can.',
    iconToken: 'dollarSign',
  },
  footballJeopardy: {
    challengeType: 'footballJeopardy',
    title: 'Football Jeopardy',
    description: 'Pick categories and values, then clear the board for the biggest score.',
    iconToken: 'brain',
  },
  clues: {
    challengeType: 'clues',
    title: 'Clues Challenge',
    description: 'Solve each football clue chain before the later hints give it away.',
    iconToken: 'lightbulb',
  },
  countdown: {
    challengeType: 'countdown',
    title: 'Countdown Challenge',
    description: 'Beat the clock and type as many valid answers as you can each round.',
    iconToken: 'timer',
  },
  putInOrder: {
    challengeType: 'putInOrder',
    title: 'Put in Order',
    description: 'Drag football events into the correct order.',
    iconToken: 'list',
  },
};

import type { AchievementDefinition } from './achievements.types.js';

export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  {
    id: 'debut_match',
    title: 'Debut Match',
    description: 'Complete your first match.',
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'hat_trick_hero',
    title: 'Hat-Trick Hero',
    description: 'Finish a match with every answer correct.',
    icon: 'Star',
    target: 1,
  },
  {
    id: 'lightning_counter',
    title: 'Lightning Counter',
    description: 'Answer a question correctly in under 2 seconds.',
    icon: 'Zap',
    target: 1,
  },
  {
    id: 'clean_sheet',
    title: 'Clean Sheet',
    description: 'Win a possession match without conceding a goal.',
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'winning_streak',
    title: 'Winning Streak',
    description: 'Reach a 5-match win streak.',
    icon: 'Flame',
    target: 5,
  },
  {
    id: 'multiplayer_master',
    title: 'Multiplayer Master',
    description: 'Win 10 matches in QuizBall.',
    icon: 'Users',
    target: 10,
  },
  {
    id: 'trophy_collector',
    title: 'Trophy Collector',
    description: 'Win your first party quiz.',
    icon: 'Award',
    target: 1,
  },
] as const;

export const ACHIEVEMENT_IDS = new Set(
  ACHIEVEMENT_DEFINITIONS.map((definition) => definition.id)
);

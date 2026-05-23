import type { AchievementDefinition } from './achievements.types.js';

export const ACHIEVEMENT_DEFINITIONS: readonly AchievementDefinition[] = [
  {
    id: 'debut_match',
    title: { en: 'Debut Match', ka: 'სადებიუტო მატჩი' },
    description: { en: 'Complete your first match.', ka: 'დაასრულე შენი პირველი მატჩი.' },
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'hat_trick_hero',
    title: { en: 'Hat-Trick Hero', ka: 'ჰეთ-ტრიკის გმირი' },
    description: { en: 'Finish a match with every answer correct.', ka: 'დაასრულე მატჩი ყველა სწორი პასუხით.' },
    icon: 'Star',
    target: 1,
  },
  {
    id: 'lightning_counter',
    title: { en: 'Lightning Counter', ka: 'ელვის სისწრაფე' },
    description: { en: 'Answer a question correctly in under 2 seconds.', ka: 'უპასუხე კითხვას სწორად 2 წამზე ნაკლებში.' },
    icon: 'Zap',
    target: 1,
  },
  {
    id: 'clean_sheet',
    title: { en: 'Clean Sheet', ka: 'სუფთა ფურცელი' },
    description: { en: 'Win a possession match without conceding a goal.', ka: 'მოიგე ფლობის მატჩი გოლის გატანის გარეშე.' },
    icon: 'Trophy',
    target: 1,
  },
  {
    id: 'winning_streak',
    title: { en: 'Winning Streak', ka: 'მოგების სერია' },
    description: { en: 'Reach a 5-match win streak.', ka: 'მიაღწიე 5-მატჩიან მოგების სერიას.' },
    icon: 'Flame',
    target: 5,
  },
  {
    id: 'multiplayer_master',
    title: { en: 'Multiplayer Master', ka: 'მრავალმოთამაშის ოსტატი' },
    description: { en: 'Win 10 matches in QuizBall.', ka: 'მოიგე 10 მატჩი QuizBall-ში.' },
    icon: 'Users',
    target: 10,
  },
  {
    id: 'trophy_collector',
    title: { en: 'Trophy Collector', ka: 'თასების კოლექციონერი' },
    description: { en: 'Win your first party quiz.', ka: 'მოიგე შენი პირველი ფარტი ქვიზი.' },
    icon: 'Award',
    target: 1,
  },
] as const;

export const ACHIEVEMENT_IDS = new Set(
  ACHIEVEMENT_DEFINITIONS.map((definition) => definition.id)
);

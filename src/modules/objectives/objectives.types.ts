import type { Json } from '../../db/types.js';
import type { I18nField } from '../../http/schemas/shared.js';

export type ObjectivePeriodType = 'daily' | 'weekly';

export type ObjectiveRuleType =
  | 'online_matches_completed'
  | 'correct_answers'
  | 'second_half_goal'
  | 'clean_sheet'
  | 'complete_all_daily'
  | 'ranked_wins'
  | 'ranked_win_streak'
  | 'correct_answers_single_category'
  | 'friend_custom_match'
  | 'complete_daily_sets';

export interface ObjectiveDefinition {
  id: string;
  periodType: ObjectivePeriodType;
  title: I18nField;
  description: I18nField;
  icon: string;
  target: number;
  rewardCoins: number;
  rewardXp: number;
  active: boolean;
  primaryDaily?: boolean;
  rule: {
    type: ObjectiveRuleType;
  };
}

export interface ObjectiveProgressRow {
  id: string;
  user_id: string;
  objective_id: string;
  period_type: ObjectivePeriodType;
  period_start: string;
  period_end: string;
  progress: number;
  target: number;
  completed_at: string | null;
  rewarded_at: string | null;
  reward_coins: number;
  reward_xp: number;
  metadata: Json;
  created_at: string;
  updated_at: string;
}

export interface ObjectivePeriod {
  type: ObjectivePeriodType;
  start: Date;
  end: Date;
}

export interface ObjectiveMatchFact {
  matchId: string;
  userId: string;
  opponentUserId: string | null;
  mode: 'friendly' | 'ranked';
  variant: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
  isWinner: boolean;
  correctAnswers: number;
  goalsFor: number;
  goalsAgainst: number;
  penaltyGoalsAgainst: number;
  isDev: boolean;
  isAi: boolean;
  secondHalfGoals: number;
  correctByCategory: Record<string, { name: string; count: number }>;
  playedWithFriend: boolean;
}

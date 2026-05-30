import type { I18nField } from '../../http/schemas/shared.js';

export interface AchievementDefinition {
  id: string;
  title: I18nField;
  description: I18nField;
  icon: string;
  target: number;
}

export interface UserAchievementRow {
  user_id: string;
  achievement_id: string;
  progress: number;
  unlocked_at: string | null;
  source_match_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AchievementProgress {
  id: string;
  title: I18nField;
  description: I18nField;
  icon: string;
  unlocked: boolean;
  progress: number;
  target: number;
  unlockedAt: string | null;
}

export interface AchievementUnlockPayload extends AchievementProgress {}

export type AchievementMatchVariant =
  | 'ranked_sim'
  | 'friendly_possession'
  | 'friendly_party_quiz';

export interface UserAchievementMetrics {
  completedMatches: number;
  totalWins: number;
  partyQuizWins: number;
  hasPerfectMatch: boolean;
  hasLightningCounter: boolean;
  hasCleanSheet: boolean;
  currentWinStreak: number;
  bestWinStreak: number;
}

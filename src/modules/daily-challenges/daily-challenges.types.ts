import type { Json } from '../../db/types.js';

export type DailyChallengeType =
  | 'moneyDrop'
  | 'trueFalse'
  | 'clues'
  | 'countdown'
  | 'putInOrder'
  | 'imposter'
  | 'careerPath'
  | 'highLow'
  | 'footballLogic';

export type DailyChallengeIconToken =
  | 'dollarSign'
  | 'checkCircle'
  | 'lightbulb'
  | 'timer'
  | 'list'
  | 'users'
  | 'route'
  | 'trendingUp'
  | 'image';

export interface DailyChallengeLocalizedText {
  en: string;
  ka: string;
}

export interface DailyChallengeDefinition {
  challengeType: DailyChallengeType;
  title: DailyChallengeLocalizedText;
  description: DailyChallengeLocalizedText;
  iconToken: DailyChallengeIconToken;
}

export interface DailyChallengeConfigRow {
  challenge_type: DailyChallengeType;
  is_active: boolean;
  sort_order: number;
  show_on_home: boolean;
  coin_reward: number;
  xp_reward: number;
  settings: unknown;
  created_at: string;
  updated_at: string;
}

export interface DailyChallengeCompletionRow {
  id: string;
  user_id: string;
  challenge_type: DailyChallengeType;
  challenge_day: string;
  score: number;
  coins_awarded: number;
  xp_awarded: number;
  completed_at: string;
}

export interface QuestionContentRow {
  id: string;
  category_id: string;
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: Json;
  explanation: Json | null;
  payload: Json;
  category_name: Json;
}

export interface DailyChallengeAvailableCategoryRow {
  id: string;
  slug: string;
  name: Json;
  question_count: number;
  easy_count: number;
  medium_count: number;
  hard_count: number;
}

export interface ResetDailyChallengeResult {
  challengeType: DailyChallengeType;
  reset: true;
}

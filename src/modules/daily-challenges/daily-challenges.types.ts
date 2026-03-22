import type { Json } from '../../db/types.js';

export type DailyChallengeType =
  | 'moneyDrop'
  | 'footballJeopardy'
  | 'clues'
  | 'countdown'
  | 'putInOrder';

export type DailyChallengeIconToken =
  | 'dollarSign'
  | 'brain'
  | 'lightbulb'
  | 'timer'
  | 'list';

export interface DailyChallengeDefinition {
  challengeType: DailyChallengeType;
  title: string;
  description: string;
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

export interface ResetDailyChallengeResult {
  challengeType: DailyChallengeType;
  reset: true;
}

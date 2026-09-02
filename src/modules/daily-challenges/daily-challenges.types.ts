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
  | 'footballLogic'
  | 'fifaCards';

export type DailyChallengeIconToken =
  | 'dollarSign'
  | 'checkCircle'
  | 'lightbulb'
  | 'timer'
  | 'list'
  | 'users'
  | 'route'
  | 'trendingUp'
  | 'image'
  | 'cards';

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

export interface FifaCardRow {
  id: string;
  source_key: string;
  edition: string;
  edition_label: string;
  name: string;
  name_ka: string | null;
  accepted: string[];
  overall: number;
  position: string;
  nation: string;
  nation_code: string;
  league: string;
  club: string;
  pac: number;
  sho: number;
  pas: number;
  dri: number;
  def: number;
  phy: number;
  photo_id: number | null;
  photo_ver: string | null;
  face_source: 'own' | 'name-match' | 'none';
  difficulty: 'easy' | 'medium' | 'hard';
  is_active: boolean;
}

export interface DailyFifaCardSetRow {
  challenge_day: string;
  card_ids: string[];
}

export interface DailyChallengeCardOutcomeInput {
  cardId: string;
  solved: boolean;
  cluesRevealed: number;
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

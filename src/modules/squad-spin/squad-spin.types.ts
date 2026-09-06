import type { Json } from '../../db/types.js';
import type { SquadSpinTier } from './squad-spin.constants.js';

export type SquadSpinStatus = 'active' | 'cashed' | 'lost' | 'expired';
export type SquadSpinPhase = 'question' | 'decision' | 'settled';
export type SquadSpinFamily = 'club' | 'country' | 'league' | 'manager' | 'trophy_award';
export type SquadSpinPosition = 'GK' | 'DEF' | 'MID' | 'FWD';

/** Frozen per round: fair step per tier and the margin applied at cash-out. */
export interface StepsSnapshot {
  t3e: number;
  t3m: number;
  t4: number;
  t5: number;
  margin: number;
}

export interface SquadSpinRoundRow {
  id: string;
  user_id: string;
  status: SquadSpinStatus;
  phase: SquadSpinPhase;
  state_version: number;
  stake_coins: number;
  reels: number;
  /** FAIR pot in milli-coins (×1000). */
  pot_milli: number;
  spins_cleared: number;
  combo_id: string | null;
  combo_ids: string[];
  question_dealt_at: string | null;
  question_deadline_at: string | null;
  decision_deadline_at: string | null;
  steps_bp: Json;
  calibration_day: string;
  server_seed: string;
  commit_hash: string;
  client_nonce: string | null;
  payout_coins: number | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

export interface SquadSpinCriterionRow {
  id: string;
  family: SquadSpinFamily;
  criterion_key: string;
  label_en: string;
  label_ka: string;
  asset_key: string | null;
}

export interface SquadSpinPlayerRow {
  id: string;
  name_en: string;
  name_ka: string | null;
  image_url: string | null;
  position_group: SquadSpinPosition;
  nationality_code: string | null;
}

export interface SquadSpinAliasRow {
  player_id: string;
  normalized_alias: string;
  locale: 'en' | 'ka' | 'translit';
  acceptance_policy: 'exact' | 'unique_only' | 'safe_typo';
}

export interface SquadSpinComboRow {
  id: string;
  reels: number;
  club_id: string;
  nation_id: string;
  position_group: SquadSpinPosition;
  extra_ids: string[];
  answer_ids: string[];
  n_answers: number;
  tier: SquadSpinTier;
}

export interface SquadSpinCalibrationRow {
  publication_day: string;
  accuracy_bp: Record<SquadSpinTier, number>;
  steps_bp: StepsSnapshot;
  samples: Record<SquadSpinTier, number>;
  rules_version: number;
  created_at: string;
}

export type SquadSpinEventType = 'start' | 'spin_dealt' | 'answer' | 'continue' | 'cashout' | 'auto_cashout' | 'expired';

export interface SquadSpinEventInput {
  roundId: string;
  userId: string;
  stateVersion: number;
  eventType: SquadSpinEventType;
  spinIndex?: number | null;
  comboId?: string | null;
  tier?: string | null;
  submittedText?: string | null;
  resolvedPlayerId?: string | null;
  answerCorrect?: boolean | null;
  answerLate?: boolean | null;
  answerMs?: number | null;
  commitHash?: string | null;
  serverSeed?: string | null;
  clientNonce?: string | null;
  hmacInput?: string | null;
  potBefore?: number | null;
  potAfter?: number | null;
}

import type { I18nField, Json } from '../../db/types.js';

export type TriviaMinesStatus = 'active' | 'cashed' | 'lost' | 'expired';
export type TriviaMinesPhase = 'picking' | 'question' | 'settled';

export interface TriviaMinesRoundRow {
  id: string;
  user_id: string;
  status: TriviaMinesStatus;
  phase: TriviaMinesPhase;
  state_version: number;
  stake_coins: number;
  /** FAIR pot in milli-coins (×1000); the margin and the coin rounding apply once at cash-out. */
  pot_milli: number;
  opened: number[];
  flagged: number[];
  bust_tile: number | null;
  scouts_left: number;
  question_id: string | null;
  question_payload: Json | null;
  question_correct_option: string | null;
  question_deadline_at: string | null;
  server_seed: string;
  commit_hash: string;
  client_nonce: string | null;
  payout_coins: number | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
}

export interface DealtQuestionSnapshot {
  question_id: string;
  prompt: I18nField;
  options: Array<{ id: string; text: I18nField }>;
  dealt_at: string;
}

export type TriviaMinesEventType =
  | 'start' | 'pick' | 'bust' | 'question_dealt' | 'answer' | 'question_expired'
  | 'cashout' | 'auto_cashout' | 'expired' | 'refunded';

export interface TriviaMinesEventInput {
  roundId: string;
  userId: string;
  stateVersion: number;
  eventType: TriviaMinesEventType;
  tile?: number | null;
  questionId?: string | null;
  answerOption?: string | null;
  answerCorrect?: boolean | null;
  answerMs?: number | null;
  flaggedTile?: number | null;
  commitHash?: string | null;
  serverSeed?: string | null;
  clientNonce?: string | null;
  hmacInput?: string | null;
  potBefore?: number | null;
  potAfter?: number | null;
}

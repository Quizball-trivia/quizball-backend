import type { I18nField, Json } from '../../db/types.js';

export type FreeKicksStatus = 'active' | 'cashed' | 'lost' | 'expired';
export type FreeKicksPhase = 'deciding' | 'question' | 'post_goal' | 'settled';

export interface FreeKicksRoundRow {
  id: string;
  user_id: string;
  status: FreeKicksStatus;
  phase: FreeKicksPhase;
  state_version: number;
  stake_coins: number;
  pot_coins: number;
  attack: number;
  open_count: number;
  answer_locked: boolean;
  goals: number;
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

/** Bilingual snapshot of a dealt question — exactly what the player saw. */
export interface DealtQuestionSnapshot {
  question_id: string;
  prompt: I18nField;
  options: Array<{ id: string; text: I18nField }>;
  dealt_at: string;
}

export type FreeKicksEventType =
  | 'start'
  | 'question_dealt'
  | 'answer'
  | 'question_expired'
  | 'shot'
  | 'next_attack'
  | 'cashout'
  | 'auto_cashout'
  | 'expired';

export interface FreeKicksEventInput {
  roundId: string;
  userId: string;
  attack: number;
  stateVersion: number;
  eventType: FreeKicksEventType;
  questionId?: string | null;
  answerOption?: string | null;
  answerCorrect?: boolean | null;
  answerMs?: number | null;
  openCount?: number | null;
  pickedZone?: string | null;
  keeperZone?: string | null;
  scored?: boolean | null;
  commitHash?: string | null;
  serverSeed?: string | null;
  clientNonce?: string | null;
  hmacInput?: string | null;
  potBefore?: number | null;
  potAfter?: number | null;
}

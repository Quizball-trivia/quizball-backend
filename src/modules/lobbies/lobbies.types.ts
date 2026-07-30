import type { Json } from '../../db/types.js';

export interface RankedLobbyContext {
  isPlacement?: boolean;
  placementGameNo?: number;
  aiAnchorRp?: number;
  aiCorrectness?: number;
  aiDelayProfile?: {
    minMs: number;
    maxMs: number;
  };
  /**
   * Persistent-bot calibrated-model pin (PR8). Present ONLY for a persistent
   * roster bot opponent; absent for ephemeral / placement / human matches. The
   * gameplay model reads THIS at question-show so a params refresh mid-match
   * cannot change a live bot (§1.7). PR7 owns the surrounding persistent branch
   * in matches.service; PR8 adds this field + its population.
   */
  persistentBotModel?: PersistentBotModelPin;
}

/**
 * Everything the calibrated gameplay model needs to reproduce a persistent bot's
 * decisions, snapshotted at match creation. The model PARAMS are pinned by
 * version + a full copy (question_stats stays unversioned, so the params — which
 * carry the difficulty link + clamps — are the immutability anchor). Per-question
 * stats are read live at show time (questions are drafted per-round in ranked
 * possession, not at creation), keyed by this pinned params version.
 */
export interface PersistentBotModelPin {
  /** bot_model_params.version that was active at match creation (audit + pin). */
  paramsVersion: number | null;
  /** Full frozen params copy (immutable for the life of the match). */
  params: unknown;
  /** The bot's user id (redundant with match_players but explicit for the model). */
  botUserId: string;
  /** Skill inputs, frozen at creation. */
  currentRp: number;
  personalOffset: number;
  governorAdjustment: number;
  categoryAffinities: Record<string, number>;
  /** Georgia-day string used to seed the bounded daily-form swing. */
  dailyFormSeed: string;
  /**
   * Ceiling-derived theta bound, solved at creation over the frozen difficulty
   * distribution so a bot's expected aggregate accuracy cannot exceed the frozen
   * ceiling. Effective theta is capped pointwise at this. Frozen per match.
   */
  thetaCeilingBound: number;
}

export interface LobbyRow {
  id: string;
  invite_code: string | null;
  mode: 'friendly' | 'ranked';
  game_mode: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
  friendly_random: boolean;
  friendly_category_a_id: string | null;
  friendly_category_b_id: string | null;
  is_public: boolean;
  display_name: string;
  ranked_context: RankedLobbyContext | null;
  host_user_id: string;
  status: 'waiting' | 'active' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface LobbyWithJoinedAt extends LobbyRow {
  joined_at: string;
}

export interface LobbyMemberRow {
  lobby_id: string;
  user_id: string;
  is_ready: boolean;
  joined_at: string;
}

export interface LobbyCategoryRow {
  lobby_id: string;
  slot: number;
  category_id: string;
}

export interface LobbyCategoryBanRow {
  lobby_id: string;
  user_id: string;
  category_id: string;
  banned_at: string;
}

export interface LobbyMemberWithUser {
  lobby_id: string;
  user_id: string;
  is_ready: boolean;
  joined_at: string;
  nickname: string | null;
  avatar_url: string | null;
  avatar_customization: Json | null;
  favorite_club: string | null;
  is_ai: boolean;
  ai_kind: string | null;
}

export interface LobbyCategoryWithDetails {
  category_id: string;
  slot: number;
  name: Record<string, string>;
  icon: string | null;
  image_url: string | null;
}

import type { AvatarCustomization } from '../users/avatar-customization.js';

export const BUSCAMINAS_LOCALES = ['es', 'en', 'ka', 'tr'] as const;
export type BuscaminasLocale = (typeof BUSCAMINAS_LOCALES)[number];

export const BUSCAMINAS_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type BuscaminasDifficulty = (typeof BUSCAMINAS_DIFFICULTIES)[number];

export interface PublicCard {
  id: string;
  name: string;
  img: string;
}

export interface PublicRound {
  id: string;
  difficulty: BuscaminasDifficulty;
  prompt: Record<BuscaminasLocale, string>;
  cards: PublicCard[];
}

/** A board as any caller may see it: never an `ok` flag. */
export interface PublicBoard {
  day: string;
  number: number;
  contentVersion: number;
  rounds: PublicRound[];
}

/** The sealed day: the public board plus which cards fit the clue. */
export interface BuscaminasDayContent {
  day: string;
  number: number;
  contentVersion: number;
  rounds: ReadonlyArray<Omit<PublicRound, 'cards'> & { cards: ReadonlyArray<PublicCard & { ok: boolean }> }>;
}

export type RoundOutcome = 'perfect' | 'banked' | 'mine';

export interface RoundResult {
  outcome: RoundOutcome;
  found: number;
  points: number;
}

/** Signed run state; also persisted verbatim in buscaminas_runs.state for ranked runs. */
export interface RunPayload {
  v: 1;
  rid: string;
  d: string;
  cv: number;
  u: string | null;
  r: number;
  p: string[];
  m: string | null;
  s: RoundResult | null;
  res: RoundResult[];
  done: boolean;
  sv: number;
}

export interface PublicRunState {
  day: string;
  round: number;
  picked: string[];
  found: number;
  mine: string | null;
  settled: null | (RoundResult & { reveal: { ok: string[]; mines: string[] } | null });
  results: RoundResult[];
  done: boolean;
  score: number;
  ranked: boolean;
  rank?: number;
}

export interface BuscaminasRunRow {
  id: string;
  user_id: string;
  day: string;
  content_version: number;
  state: RunPayload;
  state_version: number;
  done: boolean;
  score: number | null;
  perfects: number | null;
  completed_at: Date | null;
}

/** Same row shape as the Ranked / Tic Tac Toe / auction boards so the web's LeaderboardTable renders it. */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  country: string | null;
  tier: string | null;
  score: number;
  perfects: number;
}

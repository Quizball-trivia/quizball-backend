import type { AvatarCustomization } from '../users/avatar-customization.js';

export const PISTAS_LOCALES = ['es', 'en', 'ka', 'tr'] as const;
export type PistasLocale = (typeof PISTAS_LOCALES)[number];
export type LocalizedText = Record<PistasLocale, string>;

export const CLUE_KINDS = ['confed', 'position', 'foot', 'decade', 'fact'] as const;
export type ClueKind = (typeof CLUE_KINDS)[number];

export const PISTAS_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type PistasDifficulty = (typeof PISTAS_DIFFICULTIES)[number];

export interface Clue {
  kind: ClueKind;
  icon: string | null;
  text: LocalizedText;
}

/** One stored round (pistas_days.rounds[i]); server-only: the answer never leaves it except as allowed below. */
export interface StoredRound {
  id: string;
  difficulty: PistasDifficulty;
  clues: Clue[];
  answer: { display: LocalizedText; accepted: string[] };
}

/** One pistas_days row. */
export interface PistasDayRow {
  day: string;
  number: number;
  contentVersion: number;
  rounds: StoredRound[];
}

/** Who is playing: a signed-in member or a guest session. */
export type Player = { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string };

export type RoundOutcome = 'solved' | 'missed';

export interface RoundResult {
  outcome: RoundOutcome;
  /** Clues revealed when the round settled. */
  clues: number;
  points: number;
}

/**
 * pistas_runs.state: r = round index, n = clues revealed (1..10), g = wrong guesses this round,
 * c = the last-chance ceiling on n after a wrong guess, s = the current round's result once settled,
 * res = every settled round's result (the current one included).
 */
export interface RunState {
  v: 1;
  r: number;
  n: number;
  g: number;
  c: number | null;
  s: RoundResult | null;
  res: RoundResult[];
  done: boolean;
}

export interface PublicRunState {
  day: string;
  round: number;
  totalRounds: number;
  /** Only the revealed clues of the current round. */
  clues: Clue[];
  revealed: number;
  pointsInPlay: number;
  wrongGuesses: 0 | 1;
  ceiling: number | null;
  canReveal: boolean;
  settled: null | (RoundResult & { answer: { display: LocalizedText } | null });
  results: RoundResult[];
  done: boolean;
  score: number;
  solved: number;
  ranked: boolean;
  rank?: number;
}

export interface PistasRunRow {
  id: string;
  user_id: string | null;
  guest_id: string | null;
  day: string;
  ranked: boolean;
  content_version: number;
  state: RunState;
  state_version: number;
  done: boolean;
  score: number | null;
  solved: number | null;
  completed_at: Date | null;
  closes_at: Date;
  /** The database clock has passed closes_at (evaluated when the row was read or written). */
  closed: boolean;
}

/** Same row shape as the Buscaminas / Ranked boards, with `solved` in place of `perfects`. */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  country: string | null;
  tier: string | null;
  score: number;
  solved: number;
}

export interface ReviewRound {
  number: number;
  answer: { display: LocalizedText };
  clues: Clue[];
}

export interface ReviewResponse {
  day: string;
  rounds: ReviewRound[];
}

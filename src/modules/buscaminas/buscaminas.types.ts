import type { AvatarCustomization } from '../users/avatar-customization.js';

export interface BuscaminasDayContent {
  day: string;
  number: number;
  contentVersion: number;
  rounds: ReadonlyArray<{ id: string; cards: ReadonlyArray<{ id: string; ok: boolean }> }>;
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

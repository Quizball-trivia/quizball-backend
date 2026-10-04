import type { AvatarCustomization } from '../users/avatar-customization.js';
import type { MinutoGoal, PublicGoal } from './minuto.goal.js';

export type { MinutoGoal, PublicGoal } from './minuto.goal.js';

/** One minuto_days row: ten goals, server-only. */
export interface MinutoDayRow {
  day: string;
  number: number;
  contentVersion: number;
  goals: MinutoGoal[];
}

/** Who is playing: a signed-in member or a guest session. */
export type Player = { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string };

/**
 * One settled goal, kept whole: the guess and the minute it was judged against. A finished run (or a corrected
 * day) still shows exactly what the player saw, without reading the day's current content.
 */
export interface GoalResult {
  goal: string;
  guess: number;
  answer: { base: number; added: number };
  diff: number;
  points: number;
}

/** minuto_runs.state: r = current goal index; res = every settled goal (res.length > r ⇔ the current goal is settled). */
export interface RunState {
  v: 1;
  r: number;
  res: GoalResult[];
  done: boolean;
}

export interface PublicRunState {
  day: string;
  round: number;
  totalRounds: number;
  /** The current goal's card (never its minute; that is in `settled` once guessed). Null for another content version. */
  goal: PublicGoal | null;
  /** The current goal once guessed: the guess, the real minute and the points. */
  settled: GoalResult | null;
  results: GoalResult[];
  done: boolean;
  score: number;
  exact: number;
  ranked: boolean;
  rank?: number;
}

export interface MinutoRunRow {
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
  exact: number | null;
  completed_at: Date | null;
  closes_at: Date;
  closed: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  country: string | null;
  tier: string | null;
  score: number;
  exact: number;
}

export interface ReviewGoal {
  number: number;
  goal: PublicGoal;
  minute: { base: number; added: number };
}

export interface ReviewResponse {
  day: string;
  goals: ReviewGoal[];
}

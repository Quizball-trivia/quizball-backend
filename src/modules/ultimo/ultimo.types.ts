import type { AvatarCustomization } from '../users/avatar-customization.js';
import type { LocalizedText, UltimoCategory } from './ultimo.match.js';

export type { LocalizedText, UltimoCategory };

/** One ultimo_days row. */
export interface UltimoDayRow {
  day: string;
  number: number;
  contentVersion: number;
  categories: unknown;
}

export type { DailyPlayer as Player } from '../daily/daily.repo.js';

export type EndReason = 'time' | 'misses' | 'complete';

export interface CategoryResult {
  named: number;
  complete: boolean;
  reason: EndReason;
}

/**
 * ultimo_runs.state: c = category index; open = its answer clock is running; said = answer indices named in it;
 * m = misses in a row; dl = the answer deadline (epoch ms) while open; end = why the current category settled;
 * res = every settled category's result (the current one included).
 */
export interface RunState {
  v: 1;
  c: number;
  open: boolean;
  said: number[];
  m: number;
  dl: number | null;
  end: EndReason | null;
  res: CategoryResult[];
  done: boolean;
}

export interface PublicCategoryResult extends CategoryResult {
  points: number;
  /** The category the player already played: its title and size (never its names). Null on other content. */
  title: LocalizedText | null;
  total: number | null;
}

export interface PublicRunState {
  day: string;
  category: number;
  totalCategories: number;
  /** Null until the category is started: its title is part of what the clock is for. */
  title: LocalizedText | null;
  hint: LocalizedText | null;
  total: number | null;
  open: boolean;
  /** ISO; the web counts down against `serverNow`. */
  deadline: string | null;
  serverNow: string;
  turnMs: number;
  said: LocalizedText[];
  misses: number;
  settled: null | (PublicCategoryResult & { missing: LocalizedText[] | null; missingCount: number });
  results: PublicCategoryResult[];
  done: boolean;
  score: number;
  answers: number;
  ranked: boolean;
  rank?: number;
}

export interface UltimoRunRow {
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
  answers: number | null;
  completed_at: Date | null;
  closes_at: Date;
  /** The database clock has passed closes_at (evaluated when the row was read or written). */
  closed: boolean;
}

/** Same row shape as the other daily boards, with `answers` in place of `solved`. */
export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  avatarUrl: string | null;
  avatarCustomization: AvatarCustomization | null;
  country: string | null;
  tier: string | null;
  score: number;
  answers: number;
}

export interface ReviewCategory {
  number: number;
  title: LocalizedText;
  hint: LocalizedText;
  answers: LocalizedText[];
}

export interface ReviewResponse {
  day: string;
  categories: ReviewCategory[];
}

import type { AvatarCustomization } from '../users/avatar-customization.js';
import type { FootballGridBoardView } from '../football-grid/football-grid.types.js';

export interface GridDailyDayRow {
  day: string;
  number: number;
  contentVersion: number;
  board: unknown;
}

export type Player = { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string };

/** A filled cell: the footballer as the player was shown them. */
export interface GridDailyCell {
  playerId: string;
  name: string;
  nameKa: string | null;
  /** Absent on cells stored before Russian names existed. */
  nameRu?: string | null;
  imageUrl: string | null;
}

/** grid_daily_runs.state: t0/t1 are the instants of the first guess and of the finish (ms). */
export interface RunState {
  v: 1;
  cells: Array<GridDailyCell | null>;
  left: number;
  t0: number | null;
  t1: number | null;
  done: boolean;
}

export interface PublicRunState {
  day: string;
  number: number | null;
  /** The day's board; null when the stored content is another version than the run's. */
  boardId: string | null;
  cells: Array<GridDailyCell | null>;
  guessesLeft: number;
  totalGuesses: number;
  startedAt: number | null;
  finishedAt: number | null;
  done: boolean;
  score: number;
  speed: number;
  ranked: boolean;
  rank?: number;
  /** The clock `startedAt` and `finishedAt` are stamped with, at the moment of this answer. */
  serverNow: number;
}

export interface GridDailyRunRow {
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
  speed: number | null;
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
  speed: number;
}

export interface ReviewResponse {
  day: string;
  board: FootballGridBoardView;
  samples: Array<{ cellIndex: number; players: GridDailyCell[] }>;
}

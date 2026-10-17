import { z } from 'zod';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { compare, raceTournamentDataSchema, type L10n, type RaceTournamentData } from '../room/games/football-race/football-race.rules.js';

/**
 * One day's race, self-contained: the tournament data cut to the day's four nations (yours first) and its stats.
 * Server-only: a player sees a stat's values only in the result of the pick that played it.
 */
export const dayRaceSchema = z.object({
  racers: z.array(z.string().min(1).max(60)).length(4),
  data: raceTournamentDataSchema,
}).strict().superRefine((d, ctx) => {
  const ids = new Set(d.data.nations.map((n) => n.id));
  if (new Set(d.racers).size !== 4 || d.racers.some((r) => !ids.has(r))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'racers must be four nations of the data' });
  const metricOf = new Map(d.data.metrics.map((m) => [m.id, m]));
  for (const s of d.data.stats) {
    if (d.racers.some((r) => typeof s.values[r] !== 'number')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `stat ${s.id} lacks a racer's value` });
    // Every stat of a day is playable: one that splits nobody (all level, or level once rounded) could never be picked.
    // An unknown metric is the inner schema's error; it must not throw here.
    else if (metricOf.has(s.metric) && !compare(s, metricOf.get(s.metric)!, d.racers)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `stat ${s.id} does not split the day's nations` });
  }
});
export type DayRace = z.infer<typeof dayRaceSchema>;

/** One football_race_days row. */
export interface FootballRaceDayRow { day: string; number: number; contentVersion: number; race: unknown }

export type Player = { kind: 'member'; userId: string } | { kind: 'guest'; guestId: string };

/** One pick, kept whole: what the player saw is never re-read from the day's current content. */
export interface PickResult { stat: string; values: number[]; leaders: number[] }

/**
 * football_race_runs.state. Positions follow from the results (rivals start ahead). `nation`: the racer the player
 * races as (seat 0 of every result); absent until chosen or the first pick.
 */
export interface RunState { v: 1; res: PickResult[]; done: boolean; nation?: string }

export interface PublicRunState {
  day: string;
  release: string;
  cutoff: string;
  source: L10n;
  tournament: { id: string; label: L10n };
  /** By seat: index 0 is the player's nation, then the day's other three. */
  racers: Array<{ id: string; code: string; flag: string; name: L10n }>;
  /** The nation chosen (or fixed by the first pick); null while the player can still choose. */
  nation: string | null;
  target: number;
  /** Spaces a rival must still cover from its head start. */
  rivalTarget: number;
  positions: number[];
  eras: Array<{ id: string; label: L10n }>;
  families: Array<{ id: string; label: L10n }>;
  metrics: Array<{ id: string; family: string; unwanted: boolean; dir: 'high' | 'low'; decimals: number; kind: string; label: L10n; keywords: string }>;
  /** Every stat of the day, wording only. */
  stats: Array<{ id: string; scope: string; metric: string; family: string; unwanted: boolean }>;
  /** The picks played, with the values and the line behind each racer's number. */
  results: Array<PickResult & { details: Array<L10n | null> }>;
  done: boolean;
  result: 'won' | 'lost' | null;
  picks: number;
  score: number;
  ranked: boolean;
  rank?: number;
}

export interface FootballRaceRunRow {
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
  picks: number | null;
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
  picks: number;
}

/** A closed day: who led each stat (public facts; the values stay in the picks that played them). */
export interface ReviewResponse { day: string; tournament: { id: string; label: L10n }; racers: string[]; leaders: Record<string, number[]> }

export type { RaceTournamentData };

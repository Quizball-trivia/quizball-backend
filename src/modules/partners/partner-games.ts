/** Partner game ids (external contract §6) and the partner day (Asia/Tbilisi). */

import { DEFAULT_RANKED_POINTS, rankedMaxScore } from './games/ranked/ranked-points.js';

export const PARTNER_GAME_IDS = [
  'ranked',
  'countdown',
  'true-false',
  'pick-em',
  'career-path',
  'higher-lower',
  'card-detective',
  'guess-the-goal',
  'road-to-goal',
  'trivia-mines',
  'quiz-board',
] as const;
export type PartnerGameId = (typeof PARTNER_GAME_IDS)[number];

export function isPartnerGameId(value: string): value is PartnerGameId {
  return (PARTNER_GAME_IDS as readonly string[]).includes(value);
}

/** Cap per play and its display ("up to 500"), external contract v1.1 §7. Ranked here is only the contract table's
 *  maximum: the live cap follows the editable table (ranked-points-store, and the version a match started on). */
export const PARTNER_GAME_MAX_SCORE: Record<PartnerGameId, number> = {
  ranked: rankedMaxScore(DEFAULT_RANKED_POINTS),
  countdown: 2500,
  'true-false': 200,
  'pick-em': 500,
  'career-path': 300,
  'higher-lower': 400,
  'card-detective': 1000,
  'guess-the-goal': 140,
  'road-to-goal': 400,
  'trivia-mines': 1000,
  'quiz-board': 1800,
};

/** Plays per day a rule may set (internal API §2); the migration's checks enforce the same bounds. */
export function maxPlaysLimit(gameId: PartnerGameId): number {
  return gameId === 'ranked' ? 30 : 10;
}

export const PARTNER_DAY_TIMEZONE = 'Asia/Tbilisi';
/** Rules may be set from today to this many days ahead (internal API §2). */
export const CALENDAR_HORIZON_DAYS = 90;

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: PARTNER_DAY_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: PARTNER_DAY_TIMEZONE, timeZoneName: 'longOffset' });

/** 'YYYY-MM-DD' of `at` in Asia/Tbilisi. */
export function partnerDayOf(at: Date): string {
  return dayFormat.format(at);
}

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function offsetMinutes(at: Date): number {
  const name = offsetFormat.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}

/** The next 00:00 Asia/Tbilisi after `at`. */
export function nextPartnerMidnight(at: Date): Date {
  const [y, m, d] = addDays(partnerDayOf(at), 1).split('-').map(Number);
  const localMidnightAsUtc = Date.UTC(y, m - 1, d);
  return new Date(localMidnightAsUtc - offsetMinutes(new Date(localMidnightAsUtc)) * 60_000);
}

import type { Request } from 'express';
import { z } from 'zod';
import { guestSessionRequired } from '../daily/daily.errors.js';
import type { DailyPlayer } from '../daily/daily.repo.js';
import { footballersService } from '../footballers/footballers.service.js';
import type { Universe } from '../footballers/footballers.universe.js';

/** What the two word-game dailies share: request shapes, who is playing, and the footballers a day is played on. */

/** A real calendar date: a malformed one is a 422, never a database error. */
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD').refine((day) => {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day;
}, 'Expected a valid date');

export const ANSWER_MAX_LENGTH = 60;
// Content versions are content hashes: positive integers up to 2^32.
export const startSchema = z.object({ day: daySchema, contentVersion: z.number().int().min(1).max(2 ** 32).optional() });
export type StartRequest = z.infer<typeof startSchema>;
/** Every move names the run and the version the client last saw; the server row decides. */
export const moveSchema = z.object({ runId: z.string().uuid(), version: z.number().int().min(0).max(2 ** 31 - 1) });
export type MoveRequest = z.infer<typeof moveSchema>;
export const answerSchema = moveSchema.extend({ answer: z.string().max(ANSWER_MAX_LENGTH).regex(/[\p{L}\p{N}]/u, 'An answer needs a letter or a digit') });
export type AnswerRequest = z.infer<typeof answerSchema>;
const reportText = z.string().max(ANSWER_MAX_LENGTH).regex(/[\p{L}\p{N}]/u, 'A report needs a letter or a digit');
/** A refused answer of the player's own run of `day` (and, where the day has pairs, of which pair). */
export const pairReportSchema = z.object({ day: daySchema, pair: z.number().int().min(0).max(63), text: reportText });
export type PairReportRequest = z.infer<typeof pairReportSchema>;
export const nameReportSchema = z.object({ day: daySchema, text: reportText });
export type NameReportRequest = z.infer<typeof nameReportSchema>;
export const dayQuerySchema = z.object({ day: daySchema.optional() });
export type DayQuery = z.infer<typeof dayQuerySchema>;
export const reviewQuerySchema = z.object({ day: daySchema });
export type ReviewQuery = z.infer<typeof reviewQuerySchema>;

/** Set by the routes' identity middleware: a member session, else a guest session. */
export function playerOf(req: Request): DailyPlayer {
  if (req.user) return { kind: 'member', userId: req.user.id };
  if (req.guest) return { kind: 'guest', guestId: req.guest.id };
  throw guestSessionRequired();
}

/** Network slack on every deadline: an answer sent in time is not refused for its trip. */
export const ANSWER_GRACE_MS = 1_500;
export const LEADERBOARD_TOP = 20;
export const LEADERBOARD_CACHE_MS = 15_000;
/** How often a replica checks the days table for a newer seed (a cheap fingerprint query). */
export const CONTENT_REFRESH_MS = 30_000;

/**
 * The served days with the footballers of their release attached. A day names its release, and the rules are
 * synchronous, so the release is loaded (once per process) before the days are handed out; a day whose release cannot
 * be loaded is left out rather than judged against the wrong names.
 */
export function withUniverses<Day extends { release: string }>(days: () => Promise<ReadonlyMap<string, Day>>): () => Promise<ReadonlyMap<string, Day & { universe: Universe }>> {
  let hydrated: { from: ReadonlyMap<string, Day>; index: ReadonlyMap<string, Day & { universe: Universe }> } | null = null;
  return async () => {
    const index = await days();
    if (hydrated?.from === index) return hydrated.index;
    const universes = new Map<string, Universe | null>();
    for (const release of new Set([...index.values()].map((day) => day.release))) {
      universes.set(release, await footballersService.universe(release).catch(() => null));
    }
    const out = new Map<string, Day & { universe: Universe }>();
    for (const [id, day] of index) {
      const universe = universes.get(day.release);
      if (universe) out.set(id, { ...day, universe });
    }
    // Only a complete hydration is kept: a release that failed to load is tried again on the next read.
    if (out.size === index.size) hydrated = { from: index, index: out };
    return out;
  };
}

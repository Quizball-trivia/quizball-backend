import type { Request } from 'express';
import { z } from 'zod';

import { normalizeSupportedCountryCode } from '../../core/country.js';
import { AuthenticationError, NotFoundError } from '../../core/errors.js';
import { sql } from '../../db/index.js';
import { usersRepo } from '../users/users.repo.js';
import { leaderboardClubs } from './leaderboard-clubs.js';

/** Which players a board ranks: everyone, one country, or the fans of one club. */
export type BoardFilter =
  | { kind: 'global' }
  | { kind: 'country'; country: string }
  | { kind: 'club'; club: string };

export const GLOBAL_BOARD: BoardFilter = { kind: 'global' };

const CLUB_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * Query fields shared by every board endpoint. `scope=country|club` without a
 * `country`/`club` keeps the original meaning (the caller's own country/club,
 * sign-in required); with one, any visitor may browse that board.
 */
export const boardQueryFields = {
  scope: z.enum(['global', 'country', 'club']).optional().default('global'),
  country: z.string().regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).optional(),
  club: z.string().regex(CLUB_ID).optional(),
};

export interface BoardQuery {
  scope: 'global' | 'country' | 'club';
  country?: string;
  club?: string;
}

/** WHERE fragment for a query that aliases users as `u`. */
export function boardFilterSql(filter: BoardFilter) {
  if (filter.kind === 'country') return sql`AND u.country = ${filter.country}`;
  if (filter.kind === 'club') {
    return sql`AND lower(btrim(u.favorite_club)) IN (
      SELECT alias FROM leaderboard_club_aliases WHERE club_id = ${filter.club}
    )`;
  }
  return sql``;
}

/** Cache-key segment; one per distinct board. */
export function boardCacheScope(filter: BoardFilter): string {
  if (filter.kind === 'country') return `country:${filter.country}`;
  if (filter.kind === 'club') return `club:${filter.club}`;
  return 'global';
}

/**
 * Turns the query into a board. Returns null for "my country/club" when the
 * caller has none, so the endpoint can answer with an empty board.
 */
export async function resolveBoardFilter(req: Request, query: BoardQuery): Promise<BoardFilter | null> {
  if (query.scope === 'global') return GLOBAL_BOARD;

  if (query.scope === 'country') {
    if (query.country) {
      const country = normalizeSupportedCountryCode(query.country);
      if (!country) throw new NotFoundError('Unknown country board');
      return { kind: 'country', country };
    }
    if (!req.user) throw new AuthenticationError('Sign in to see your country board');
    const user = await usersRepo.getById(req.user.id);
    const country = normalizeSupportedCountryCode(user?.country);
    return country ? { kind: 'country', country } : null;
  }

  if (query.club) {
    if (!(await leaderboardClubs.exists(query.club))) throw new NotFoundError('Unknown club board');
    return { kind: 'club', club: query.club };
  }
  if (!req.user) throw new AuthenticationError('Sign in to see your club board');
  const user = await usersRepo.getById(req.user.id);
  const club = await leaderboardClubs.resolve(user?.favorite_club);
  return club ? { kind: 'club', club } : null;
}

/** Whether a user belongs to a board, given their stored country/club. */
export async function isOnBoard(
  filter: BoardFilter,
  user: { country: string | null; favorite_club: string | null } | null,
): Promise<boolean> {
  if (!user) return false;
  if (filter.kind === 'global') return true;
  if (filter.kind === 'country') return normalizeSupportedCountryCode(user.country) === filter.country;
  return (await leaderboardClubs.resolve(user.favorite_club)) === filter.club;
}

/** The partner's rules in the CMS (internal API §2): games (on/off, order, default limit), the calendar of per-date
 *  limits and the ranked points table. Saves are compare-and-set on a version counter, bounded server-side and
 *  audited. */

import { z } from 'zod';
import { sql } from '../../db/index.js';
import { asSql, type Db } from './partner-db.js';
import type { PartnerConfig } from './partner-config.js';
import { PartnerError } from './partner-errors.js';
import {
  addDays,
  CALENDAR_HORIZON_DAYS,
  maxPlaysLimit,
  PARTNER_GAME_IDS,
  type PartnerGameId,
} from './partner-games.js';
import { dayRulesForPlayer, partnerDayNow } from './partner-quota.service.js';
import { PARTNER_IDENTIFIER } from './partner-sessions.service.js';
import {
  RANKED_MARGIN_ROWS,
  RANKED_POINTS_MAX_VALUE,
  rankedMaxScore,
  rankedPointsProblems,
  type RankedPointsTable,
} from './games/ranked/ranked-points.js';
import { forgetCurrentRankedPoints, tableFromRow, type RankedPointsRow } from './games/ranked/ranked-points-store.js';

const gameIdSchema = z.enum(PARTNER_GAME_IDS);

function isRealDay(value: string): boolean {
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay, 'not a real date');

export const gamesConfigBodySchema = z.object({
  version: z.number().int().min(1),
  games: z
    .array(
      z.object({
        gameId: gameIdSchema,
        enabled: z.boolean(),
        order: z.number().int().min(1),
        defaultLimit: z.number().int().min(0),
        ready: z.boolean().optional(),
      }),
    )
    .length(PARTNER_GAME_IDS.length),
});
export type GamesConfigBody = z.infer<typeof gamesConfigBodySchema>;

export const calendarQuerySchema = z.object({ from: daySchema.optional(), to: daySchema.optional() });

export const calendarBodySchema = z.object({
  version: z.number().int().min(1),
  changes: z
    .array(z.object({ date: daySchema, gameId: gameIdSchema, limit: z.number().int().min(0).nullable() }))
    .max(100),
});
export type CalendarBody = z.infer<typeof calendarBodySchema>;

const pointsSchema = z.number().int().min(0).max(RANKED_POINTS_MAX_VALUE);
const pointsPairSchema = z.object({ winner: pointsSchema, loser: pointsSchema });

export const rankedPointsBodySchema = z.object({
  version: z.number().int().min(1),
  points: z.object({
    margins: z.array(pointsPairSchema).length(RANKED_MARGIN_ROWS),
    penaltyWin: pointsPairSchema,
    drawAfterPenalties: pointsSchema,
    leftNotAhead: pointsSchema,
  }),
});
export type RankedPointsBody = z.infer<typeof rankedPointsBodySchema>;

export const playerParamSchema = z.object({ playerId: z.string().regex(PARTNER_IDENTIFIER) });

/** The longest span one calendar read may cover. */
const MAX_CALENDAR_SPAN_DAYS = 366;

export interface PartnerGamesConfig {
  version: number;
  games: Array<{ gameId: PartnerGameId; enabled: boolean; order: number; defaultLimit: number; ready: boolean }>;
}

export interface CalendarResponse {
  version: number;
  overrides: Array<{ date: string; gameId: PartnerGameId; limit: number }>;
}

export interface RankedPointsConfig {
  version: number;
  points: RankedPointsTable;
  /** The most one ranked play can score under this table. */
  maxScore: number;
}

async function readGames(db: Db, config: PartnerConfig): Promise<PartnerGamesConfig> {
  // One statement, one snapshot: the version always matches the rows returned with it.
  const rows = await db<{ games_version: number; game_id: PartnerGameId | null; enabled: boolean; sort_order: number; default_limit: number; ready: boolean }[]>`
    SELECT v.games_version, g.game_id, g.enabled, g.sort_order, g.default_limit, g.ready
    FROM partner_config_versions v
    LEFT JOIN partner_games g ON g.partner_slug = v.partner_slug AND g.environment = v.environment
    WHERE v.partner_slug = ${config.slug} AND v.environment = ${config.environment}
    ORDER BY g.sort_order`;
  if (rows.length === 0) throw new PartnerError('not_found', 'Partner rules are not set up for this environment');
  return {
    version: rows[0].games_version,
    games: rows
      .filter((r) => r.game_id !== null)
      .map((r) => ({
        gameId: r.game_id as PartnerGameId,
        enabled: r.enabled,
        order: r.sort_order,
        defaultLimit: r.default_limit,
        ready: r.ready,
      })),
  };
}

export function getGamesConfig(config: PartnerConfig): Promise<PartnerGamesConfig> {
  return readGames(sql, config);
}

function validateGames(body: GamesConfigBody): void {
  const ids = new Set(body.games.map((g) => g.gameId));
  if (ids.size !== PARTNER_GAME_IDS.length) throw new PartnerError('invalid_request', 'Every game must appear exactly once');
  const orders = body.games.map((g) => g.order).sort((a, b) => a - b);
  if (orders.some((order, i) => order !== i + 1)) throw new PartnerError('invalid_request', 'order must be 1..n, each once');
  for (const g of body.games) {
    if (g.defaultLimit > maxPlaysLimit(g.gameId)) {
      throw new PartnerError('invalid_request', `defaultLimit for ${g.gameId} must be 0–${maxPlaysLimit(g.gameId)}`);
    }
  }
}

type VersionColumn = 'games_version' | 'calendar_version' | 'ranked_points_version';

/** Locks the version row and checks the caller saw the latest save; bumpVersion moves it on after the write. */
async function claimVersion(
  tx: Db,
  config: PartnerConfig,
  column: VersionColumn,
  expected: number,
): Promise<void> {
  const [row] = await tx<{ version: number }[]>`
    SELECT ${tx(column)} AS version FROM partner_config_versions
    WHERE partner_slug = ${config.slug} AND environment = ${config.environment}
    FOR UPDATE`;
  if (!row) throw new PartnerError('not_found', 'Partner rules are not set up for this environment');
  if (row.version !== expected) throw new PartnerError('stale_version');
}

async function bumpVersion(tx: Db, config: PartnerConfig, column: VersionColumn): Promise<void> {
  await tx`
    UPDATE partner_config_versions SET ${tx(column)} = ${tx(column)} + 1, updated_at = now()
    WHERE partner_slug = ${config.slug} AND environment = ${config.environment}`;
}

async function audit(
  tx: Db,
  config: PartnerConfig,
  actorUserId: string,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx`
    INSERT INTO partner_audit (partner_slug, environment, actor, action, target, before, after)
    VALUES (${config.slug}, ${config.environment}, ${`user:${actorUserId}`}, ${action}, NULL,
            ${tx.json(before as never)}, ${tx.json(after as never)})`;
}

export async function putGamesConfig(
  config: PartnerConfig,
  actorUserId: string,
  body: GamesConfigBody,
): Promise<PartnerGamesConfig> {
  validateGames(body);
  return sql.begin(async (t) => {
    const tx = asSql(t);
    await claimVersion(tx, config, 'games_version', body.version);
    const before = await readGames(tx, config);
    // `ready` is Quizball ops' flag and is never written from here.
    for (const g of body.games) {
      await tx`
        UPDATE partner_games
        SET enabled = ${g.enabled}, sort_order = ${g.order}, default_limit = ${g.defaultLimit}, updated_at = now()
        WHERE partner_slug = ${config.slug} AND environment = ${config.environment} AND game_id = ${g.gameId}`;
    }
    await bumpVersion(tx, config, 'games_version');
    const after = await readGames(tx, config);
    await audit(tx, config, actorUserId, 'games.update', before, after);
    return after;
  });
}

async function readCalendar(db: Db, config: PartnerConfig, from: string, to: string): Promise<CalendarResponse> {
  const rows = await db<{ calendar_version: number; date: string | null; game_id: PartnerGameId | null; plays_limit: number }[]>`
    SELECT v.calendar_version, to_char(o.date, 'YYYY-MM-DD') AS date, o.game_id, o.plays_limit
    FROM partner_config_versions v
    LEFT JOIN partner_limit_overrides o
      ON o.partner_slug = v.partner_slug AND o.environment = v.environment
     AND o.date BETWEEN ${from}::date AND ${to}::date
    WHERE v.partner_slug = ${config.slug} AND v.environment = ${config.environment}
    ORDER BY o.date, o.game_id`;
  if (rows.length === 0) throw new PartnerError('not_found', 'Partner rules are not set up for this environment');
  return {
    version: rows[0].calendar_version,
    overrides: rows
      .filter((r) => r.game_id !== null)
      .map((r) => ({ date: r.date as string, gameId: r.game_id as PartnerGameId, limit: r.plays_limit })),
  };
}

export async function getCalendar(
  config: PartnerConfig,
  query: { from?: string; to?: string },
): Promise<CalendarResponse> {
  const { day: today } = await partnerDayNow();
  const from = query.from ?? today;
  const to = query.to ?? addDays(from, CALENDAR_HORIZON_DAYS);
  if (from > to || to > addDays(from, MAX_CALENDAR_SPAN_DAYS)) {
    throw new PartnerError('invalid_request', `from must be on or before to, at most ${MAX_CALENDAR_SPAN_DAYS} days apart`);
  }
  return readCalendar(sql, config, from, to);
}

/** Saves per-date limits (null removes one) from today (Tbilisi) to +90 days; returns the editable window. */
export async function putCalendar(
  config: PartnerConfig,
  actorUserId: string,
  body: CalendarBody,
  at?: Date,
): Promise<CalendarResponse> {
  const { day: today } = await partnerDayNow(at);
  const last = addDays(today, CALENDAR_HORIZON_DAYS);
  const seen = new Set<string>();
  for (const change of body.changes) {
    if (change.date < today) throw new PartnerError('invalid_request', `${change.date} is in the past and read-only`);
    if (change.date > last) throw new PartnerError('invalid_request', `${change.date} is more than ${CALENDAR_HORIZON_DAYS} days ahead`);
    if (change.limit !== null && change.limit > maxPlaysLimit(change.gameId)) {
      throw new PartnerError('invalid_request', `limit for ${change.gameId} must be 0–${maxPlaysLimit(change.gameId)}`);
    }
    const key = `${change.date}|${change.gameId}`;
    if (seen.has(key)) throw new PartnerError('invalid_request', `${change.date} ${change.gameId} appears twice`);
    seen.add(key);
  }
  return sql.begin(async (t) => {
    const tx = asSql(t);
    await claimVersion(tx, config, 'calendar_version', body.version);
    const changes = body.changes.map((c, ord) => ({ ord, date: c.date, game_id: c.gameId, plays_limit: c.limit }));
    // One statement however many changes: every game start waits on the version row locked above.
    const [{ before }] = await tx<{ before: CalendarResponse['overrides'] }[]>`
      WITH changes AS (
        SELECT c.ord, c.date::date AS date, c.game_id, c.plays_limit
        FROM jsonb_to_recordset(${tx.json(changes)}) AS c(ord int, date text, game_id text, plays_limit int)
      ),
      previous AS (
        SELECT c.ord, o.date, o.game_id, o.plays_limit
        FROM changes c
        JOIN partner_limit_overrides o
          ON o.partner_slug = ${config.slug} AND o.environment = ${config.environment}
         AND o.date = c.date AND o.game_id = c.game_id
      ),
      removed AS (
        DELETE FROM partner_limit_overrides o
        USING changes c
        WHERE o.partner_slug = ${config.slug} AND o.environment = ${config.environment}
          AND o.date = c.date AND o.game_id = c.game_id AND c.plays_limit IS NULL
      ),
      saved AS (
        INSERT INTO partner_limit_overrides (partner_slug, environment, date, game_id, plays_limit, updated_by)
        SELECT ${config.slug}, ${config.environment}, c.date, c.game_id, c.plays_limit, ${actorUserId}::uuid
        FROM changes c
        WHERE c.plays_limit IS NOT NULL
        ON CONFLICT (partner_slug, environment, date, game_id)
        DO UPDATE SET plays_limit = EXCLUDED.plays_limit, updated_by = EXCLUDED.updated_by, updated_at = now()
      )
      SELECT COALESCE(
        jsonb_agg(jsonb_build_object('date', to_char(date, 'YYYY-MM-DD'), 'gameId', game_id, 'limit', plays_limit) ORDER BY ord),
        '[]'::jsonb
      ) AS before
      FROM previous`;
    await bumpVersion(tx, config, 'calendar_version');
    await audit(tx, config, actorUserId, 'calendar.update', before, body.changes);
    return readCalendar(tx, config, today, last);
  });
}

async function readRankedPoints(db: Db, config: PartnerConfig): Promise<RankedPointsConfig> {
  const [row] = await db<RankedPointsRow[]>`
    SELECT p.version, p.margin_winner, p.margin_loser, p.penalty_winner, p.penalty_loser, p.draw_after_penalties,
           p.left_not_ahead
    FROM partner_config_versions v
    JOIN partner_ranked_points p
      ON p.partner_slug = v.partner_slug AND p.environment = v.environment AND p.version = v.ranked_points_version
    WHERE v.partner_slug = ${config.slug} AND v.environment = ${config.environment}`;
  if (!row) throw new PartnerError('not_found', 'Partner rules are not set up for this environment');
  const points = tableFromRow(row);
  return { version: row.version, points, maxScore: rankedMaxScore(points) };
}

export function getRankedPoints(config: PartnerConfig): Promise<RankedPointsConfig> {
  return readRankedPoints(sql, config);
}

/** Saves a new version of the table; matches already started keep the version they started on. */
export async function putRankedPoints(
  config: PartnerConfig,
  actorUserId: string,
  body: RankedPointsBody,
): Promise<RankedPointsConfig> {
  const problems = rankedPointsProblems(body.points);
  if (problems.length > 0) throw new PartnerError('invalid_request', problems[0]);
  const saved = await sql.begin(async (t) => {
    const tx = asSql(t);
    await claimVersion(tx, config, 'ranked_points_version', body.version);
    const before = await readRankedPoints(tx, config);
    const { margins, penaltyWin, drawAfterPenalties, leftNotAhead } = body.points;
    await tx`
      INSERT INTO partner_ranked_points
        (partner_slug, environment, version, margin_winner, margin_loser, penalty_winner, penalty_loser,
         draw_after_penalties, left_not_ahead, created_by)
      VALUES (${config.slug}, ${config.environment}, ${body.version + 1},
              ${margins.map((m) => m.winner)}::int[], ${margins.map((m) => m.loser)}::int[],
              ${penaltyWin.winner}, ${penaltyWin.loser}, ${drawAfterPenalties}, ${leftNotAhead}, ${actorUserId})`;
    await bumpVersion(tx, config, 'ranked_points_version');
    const after = await readRankedPoints(tx, config);
    await audit(tx, config, actorUserId, 'ranked_points.update', before, after);
    return after;
  });
  forgetCurrentRankedPoints(config);
  return saved as RankedPointsConfig;
}

export interface PartnerPlayerView {
  playerId: string;
  displayName: string;
  status: 'active' | 'blocked';
  firstSeenAt: string;
  lastSeenAt: string | null;
  today: Array<{ gameId: PartnerGameId; playsUsed: number; playsLimit: number }>;
}

export async function getPlayerView(config: PartnerConfig, externalPlayerId: string): Promise<PartnerPlayerView> {
  const [player] = await sql<{ id: string; display_name: string | null; status: 'active' | 'blocked'; created_at: Date; last_seen_at: Date | null }[]>`
    SELECT id, display_name, status, created_at, last_seen_at FROM partner_players
    WHERE partner_slug = ${config.slug} AND environment = ${config.environment} AND external_player_id = ${externalPlayerId}`;
  if (!player) throw new PartnerError('unknown_player');
  const { day } = await partnerDayNow();
  const rules = await dayRulesForPlayer(config, player.id, day);
  return {
    playerId: externalPlayerId,
    displayName: player.display_name ?? '',
    status: player.status,
    firstSeenAt: player.created_at.toISOString(),
    lastSeenAt: player.last_seen_at?.toISOString() ?? null,
    today: rules
      .filter((r) => r.enabled)
      .map((r) => ({ gameId: r.gameId, playsUsed: r.playsUsed, playsLimit: r.playsLimit })),
  };
}

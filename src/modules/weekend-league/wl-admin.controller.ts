/**
 * WL admin surface for the CMS — bearer-auth admin role (requireRole('admin')
 * in the route), NOT the ops token. Reads give the team live visibility into
 * events (registrations, field, standings, awards, stream health); actions
 * reuse the exact same service functions as the ops-token surface.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { wlLiveEngineInternals } from './wl-live-engine.js';
import { WL_FINALISTS } from './wl-rules.js';
import {
  wlCancelTournament,
  wlCreateTestSchema,
  wlCreateTestTournament,
  wlForceTick,
  wlPauseTournament,
  wlResumeTournament,
} from './wl-ops.service.js';
import { wlFillBotsToTarget } from './wl-bots.js';

const idParamSchema = z.object({ id: z.string().uuid() });
const actionBodySchema = z.object({ reason: z.string().max(400).optional() });
const fillBotsSchema = z.object({ min_field: z.number().int().min(1).max(2_000) });

function actorOf(req: Request): string {
  const user = (req as Request & { user?: { id?: string; email?: string } }).user;
  return `admin:${user?.email ?? user?.id ?? 'unknown'}`;
}

export const wlAdminController = {
  /** Recent tournaments with live counts — the CMS list view. */
  async listTournaments(_req: Request, res: Response): Promise<void> {
    const rows = await sql<Array<Record<string, unknown>>>`
      SELECT t.id, t.week_key::text, t.status, t.is_test,
             (t.config->>'launch_edition')::boolean AS launch_edition,
             t.entry_opens_at, t.entry_closes_at, t.qualifier_starts_at, t.final_starts_at,
             t.champion_user_id, t.cancelled_reason, t.created_at,
             (SELECT COUNT(*)::int FROM wl_entries e WHERE e.tournament_id = t.id) AS registered,
             (SELECT COUNT(*)::int FROM wl_entries e
               WHERE e.tournament_id = t.id AND e.checked_in_at IS NOT NULL) AS checked_in,
             (SELECT COUNT(*)::int FROM wl_entries e
               JOIN users u ON u.id = e.user_id
               WHERE e.tournament_id = t.id AND u.is_ai = true) AS bots
      FROM wl_tournaments t
      ORDER BY t.created_at DESC
      LIMIT 25
    `;
    res.json({ tournaments: rows });
  },

  /** Everything the team needs about one event on one screen. */
  async tournamentDetail(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const [t] = await sql<Array<Record<string, unknown>>>`
      SELECT t.*, t.week_key::text AS week_key FROM wl_tournaments t WHERE t.id = ${id}
    `;
    if (!t) throw new NotFoundError('Tournament not found');

    // Full registrant roster for the CMS table — humans first, oldest entry
    // first, capped to keep the payload sane at bot-filled fields.
    const registrants = await sql<Array<Record<string, unknown>>>`
      SELECT u.nickname, u.email, u.is_ai, e.state, e.qp_at_entry,
             e.entered_at, e.checked_in_at, e.final_checked_in_at, e.final_rank,
             -- How far each entrant got in SATURDAY's qualifier (games 0-2):
             -- the final (game 3) is excluded so a finalist's Sunday rank can
             -- never masquerade as their qualifier result (review catch).
             q.game_index AS qualifier_game_index,
             q.rank        AS qualifier_rank,
             q.score       AS qualifier_score
      FROM wl_entries e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN LATERAL (
        SELECT r.game_index, r.rank, r.score
        FROM wl_game_results r
        WHERE r.tournament_id = e.tournament_id AND r.user_id = e.user_id
          AND r.game_index < 3
        ORDER BY r.game_index DESC
        LIMIT 1
      ) q ON true
      WHERE e.tournament_id = ${id}
      ORDER BY u.is_ai ASC, e.entered_at ASC
      LIMIT 1500
    `;

    const entryStates = await sql<Array<{ state: string; n: number; bots: number }>>`
      SELECT e.state, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE u.is_ai)::int AS bots
      FROM wl_entries e JOIN users u ON u.id = e.user_id
      WHERE e.tournament_id = ${id}
      GROUP BY e.state ORDER BY n DESC
    `;

    const gameIndex = Number(((t['stage'] as Record<string, unknown> | null) ?? {})['current_game'] ?? 0);
    const board = await wlLiveEngineInternals.topBoard(id, gameIndex, WL_FINALISTS);
    const boardUsers = board.length > 0
      ? await sql<Array<{ id: string; nickname: string; is_ai: boolean }>>`
          SELECT id, nickname, is_ai FROM users
          WHERE id = ANY(${sql.array(board.map((b) => b.user_id))}::uuid[])
        `
      : [];
    const nameById = new Map(boardUsers.map((u) => [u.id, u]));

    const gameResults = await sql<Array<Record<string, unknown>>>`
      SELECT game_index, user_id, score, time_ms_total, rank, advanced
      FROM wl_game_results WHERE tournament_id = ${id}
      ORDER BY game_index ASC, rank ASC
    `;

    const awards = await sql<Array<Record<string, unknown>>>`
      SELECT a.user_id, u.nickname, u.email, a.final_rank, a.band, a.prize_type, a.status
      FROM wl_awards a JOIN users u ON u.id = a.user_id
      WHERE a.tournament_id = ${id}
      ORDER BY a.final_rank ASC
    `;

    const [stream] = await sql<Array<Record<string, unknown>>>`
      SELECT MAX(seq)::int AS head,
             COUNT(*) FILTER (WHERE delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL)::int AS pending,
             COUNT(*) FILTER (WHERE attempts >= 3 AND delivered_at IS NULL)::int AS poisonish
      FROM wl_events WHERE tournament_id = ${id}
    `;

    // Bulk PII (emails) — never cached by a proxy or the browser.
    res.set('Cache-Control', 'private, no-store');
    res.json({
      tournament: t,
      registrants,
      entry_states: entryStates,
      current_game_index: gameIndex,
      board: board.map((b) => ({
        ...b,
        nickname: nameById.get(b.user_id)?.nickname ?? null,
        is_ai: nameById.get(b.user_id)?.is_ai ?? null,
      })),
      game_results: gameResults,
      awards,
      stream,
    });
  },

  async createTest(req: Request, res: Response): Promise<void> {
    const input = wlCreateTestSchema.parse({ actor: actorOf(req), ...req.body });
    const { tournamentId } = await wlCreateTestTournament({ ...input, actor: actorOf(req) });
    res.json({ tournament_id: tournamentId });
  },

  async pause(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const { reason } = actionBodySchema.parse(req.body ?? {});
    res.json({ paused: await wlPauseTournament(id, actorOf(req), reason) });
  },

  async resume(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    res.json({ resumed: await wlResumeTournament(id, actorOf(req)) });
  },

  async cancel(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const { reason } = actionBodySchema.parse(req.body ?? {});
    res.json({ cancelled: await wlCancelTournament(id, actorOf(req), reason) });
  },

  /** WL question-stock levels per kind — the CMS agent panel's fuel gauge. */
  async stock(_req: Request, res: Response): Promise<void> {
    const rows = await sql<Array<{ type: string; visibility: string; n: number }>>`
      SELECT q.type, q.visibility, COUNT(*)::int AS n
      FROM questions q
      WHERE q.status = 'published'
        AND q.type IN ('true_false', 'high_low', 'mcq_single', 'career_path', 'clue_chain')
        AND q.visibility IN ('public', 'wl_private')
      GROUP BY 1, 2
      ORDER BY 1, 2
    `;
    res.json({ stock: rows });
  },

  async deleteTest(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const deleted = await sql<{ id: string }[]>`
      DELETE FROM wl_tournaments
      WHERE id = ${id} AND is_test = true
      RETURNING id
    `;
    if (deleted.length === 0) {
      throw new BadRequestError('Only TEST events can be deleted (cancel real events instead — deleting the row would make the weekly calendar recreate it)');
    }
    res.json({ deleted: true });
  },

  async forceTick(req: Request, res: Response): Promise<void> {
    res.json({ ticked: await wlForceTick(actorOf(req)) });
  },

  async fillBots(req: Request, res: Response): Promise<void> {
    const { id } = idParamSchema.parse(req.params);
    const { min_field: minField } = fillBotsSchema.parse(req.body ?? {});
    const filled = await wlFillBotsToTarget(id, minField);
    res.json({ filled });
  },
};

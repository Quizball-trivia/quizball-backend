/**
 * WL ops controls — token-authed tournament operations.
 *
 * Auth: x-wl-ops-token must equal config.WL_OPS_TOKEN; when the env is
 * unset the whole surface 404s (no probeable existence). Every action logs
 * an audit line with the caller-supplied actor tag.
 *
 * create-test builds a tournament on ARBITRARY timestamps (or a compressed
 * preset), which is how staging exercises the full event end-to-end on any
 * date without waiting for a real Saturday. Non-prod only; the live ops
 * actions (pause/resume/cancel/force-tick) work everywhere.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { NotFoundError, AuthenticationError, BadRequestError } from '../../core/errors.js';
import { wlOrchestratorRepo } from './wl-orchestrator.repo.js';
import { wlEventsRepo } from './wl-events.repo.js';
import {
  wlCancelTournament,
  wlCreateTestSchema,
  wlCreateTestTournament,
  wlForceTick,
  wlPauseTournament,
  wlResumeTournament,
} from './wl-ops.service.js';

const actionSchema = z.object({
  actor: z.string().min(1).max(80),
  tournament_id: z.string().uuid(),
  reason: z.string().max(400).optional(),
});

// Mirrors the governor controller's shared-secret comparison: unequal
// lengths are a mismatch, never a thrown length error (no timing leak).
function secretsMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function requireOpsToken(req: Request): void {
  if (!config.WL_OPS_TOKEN) throw new NotFoundError('Not found');
  if (!secretsMatch(config.WL_OPS_TOKEN, req.header('x-wl-ops-token'))) {
    throw new AuthenticationError('Invalid ops token');
  }
}

export const wlOpsController = {
  async createTest(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = wlCreateTestSchema.parse(req.body ?? {});
    const { tournamentId } = await wlCreateTestTournament(input);
    res.json({ tournament_id: tournamentId });
  },

  async pause(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.parse(req.body ?? {});
    const paused = await wlPauseTournament(input.tournament_id, input.actor, input.reason);
    res.json({ paused });
  },

  async resume(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.parse(req.body ?? {});
    const resumed = await wlResumeTournament(input.tournament_id, input.actor);
    res.json({ resumed });
  },

  async cancel(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.parse(req.body ?? {});
    const cancelled = await wlCancelTournament(input.tournament_id, input.actor, input.reason);
    res.json({ cancelled });
  },

  async forceTick(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const actor = z.object({ actor: z.string().min(1).max(80) })
      .parse(req.body ?? {}).actor;
    const ticked = await wlForceTick(actor);
    res.json({ ticked });
  },

  /**
   * One-time Season-2 QP bootstrap (idempotent): every human player gets a
   * single ledger row under the reserved bootstrap match id with
   * 25*S2_wins + 10*S2_losses from ranked_rp_changes since the S2 reset.
   * Run BEFORE the first event's entry opens so active players arrive with
   * a qualifying balance. The (match_id, user_id) PK makes reruns no-ops.
   */
  async bootstrapSeason2Qp(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = z.object({
      actor: z.string().min(1).max(80),
      since: z.string().datetime(),
      week_key: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body ?? {});
    const { sql } = await import('../../db/index.js');
    // Absolute, convergent recompute: only S2 matches NOT already in the
    // ordinary ledger count (no double pay with PR1-era accrual), and the
    // grant row UPSERTS so reruns after more settlements stay correct.
    const rows = await sql<{ user_id: string }[]>`
      INSERT INTO wl_qp_awards (match_id, user_id, week_key, points, result)
      SELECT '00000000-0000-4000-8000-00000000019b'::uuid, s.user_id, ${input.week_key}::date,
             s.wins * 25 + s.losses * 10, 'grant'
      FROM (
        SELECT rc.user_id,
               COUNT(*) FILTER (WHERE rc.result = 'win')::int AS wins,
               COUNT(*) FILTER (WHERE rc.result = 'loss')::int AS losses
        FROM ranked_rp_changes rc
        JOIN users u ON u.id = rc.user_id AND u.is_ai = false AND u.is_seed = false
          AND u.is_deleted = false AND u.deleted_at IS NULL
        LEFT JOIN wl_qp_awards existing
          ON existing.match_id = rc.match_id AND existing.user_id = rc.user_id
        WHERE rc.created_at >= ${new Date(input.since)}
          AND existing.match_id IS NULL
        GROUP BY rc.user_id
      ) s
      WHERE s.wins * 25 + s.losses * 10 > 0
      ON CONFLICT (match_id, user_id) DO UPDATE SET
        points = EXCLUDED.points, week_key = EXCLUDED.week_key, result = 'grant'
      RETURNING user_id
    `;
    // Convergence for users whose previously-unmatched matches have since
    // gained ordinary ledger rows: their recomputed total is zero and the
    // stale grant must go (points CHECK > 0 forbids a zero upsert).
    await sql`
      DELETE FROM wl_qp_awards g
      WHERE g.match_id = '00000000-0000-4000-8000-00000000019b'::uuid
        AND NOT EXISTS (
          SELECT 1 FROM ranked_rp_changes rc
          LEFT JOIN wl_qp_awards existing
            ON existing.match_id = rc.match_id AND existing.user_id = rc.user_id
          WHERE rc.user_id = g.user_id AND rc.created_at >= ${new Date(input.since)}
            AND existing.match_id IS NULL AND rc.result IN ('win', 'loss')
        )
    `;
    logger.warn({ actor: input.actor, inserted: rows.length }, 'WL ops: S2 QP bootstrap');
    res.json({ inserted: rows.length });
  },

  /**
   * Recovery for a poison outbox head: verifies the tournament is paused and
   * the given seq IS the current poison head, terminally skips it (audited
   * via last_error + logs), then lets the queue drain on the next tick.
   */
  async skipPoisonEvent(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.extend({ seq: z.number().int().min(1) }).parse(req.body ?? {});
    const t = await wlOrchestratorRepo.getById(input.tournament_id);
    if (!t) throw new NotFoundError('Tournament not found');
    if (t.status !== 'paused') {
      throw new BadRequestError('Tournament must be paused before skipping events');
    }
    const skipped = await wlEventsRepo.skipPoisonHead(input.tournament_id, input.seq, input.actor);
    logger.warn(
      { actor: input.actor, tournamentId: input.tournament_id, seq: input.seq, skipped },
      'WL ops: skip poison event'
    );
    res.json({ skipped });
  },
};

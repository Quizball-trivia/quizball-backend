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
import { buildWlConfig, wlTournamentConfigSchema } from './wl-config.js';
import { wlOrchestratorRepo } from './wl-orchestrator.repo.js';
import { getWlOrchestratorIo, wlRunLockedTick } from './wl-orchestrator.js';
import { wlEventsRepo } from './wl-events.repo.js';
import { wlRedisNowMs } from './wl-redis.js';

const createTestSchema = z.object({
  actor: z.string().min(1).max(80),
  // Either explicit timestamps…
  entry_opens_at: z.string().datetime().optional(),
  entry_closes_at: z.string().datetime().optional(),
  qualifier_starts_at: z.string().datetime().optional(),
  final_starts_at: z.string().datetime().optional(),
  // …or a compressed schedule starting now (seconds per window).
  compressed: z.object({
    entry_seconds: z.number().int().min(10).max(3600),
    checkin_seconds: z.number().int().min(10).max(3600),
    to_final_seconds: z.number().int().min(10).max(7200),
  }).optional(),
  config: wlTournamentConfigSchema.partial().optional(),
});

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

// The repo rejects phase-machine-illegal moves with a plain Error; ops
// callers deserve a 400 with the reason, not a 500.
async function transitionOr400(
  input: Parameters<typeof wlOrchestratorRepo.transition>[0]
): Promise<boolean> {
  try {
    return await wlOrchestratorRepo.transition(input);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('WL transition not allowed')) {
      throw new BadRequestError(error.message);
    }
    throw error;
  }
}

export const wlOpsController = {
  async createTest(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    if (config.NODE_ENV === 'prod') {
      throw new BadRequestError('Test tournaments cannot be created in prod');
    }
    const input = createTestSchema.parse(req.body ?? {});
    const now = await wlRedisNowMs();

    let entryOpensAt: Date;
    let entryClosesAt: Date;
    let qualifierStartsAt: Date;
    let finalStartsAt: Date;
    if (input.compressed) {
      // The check-in window IS the entry_closed→qualifier gap, exactly.
      const checkinWindowMs = input.compressed.checkin_seconds * 1000;
      entryOpensAt = new Date(now - 1000);
      entryClosesAt = new Date(now + input.compressed.entry_seconds * 1000);
      qualifierStartsAt = new Date(entryClosesAt.getTime() + checkinWindowMs);
      finalStartsAt = new Date(
        qualifierStartsAt.getTime() + input.compressed.to_final_seconds * 1000
      );
      // Computed window wins over caller config — the schedule and the
      // config MUST agree or check-in opens at the wrong moment.
      input.config = {
        ...input.config,
        checkin_window_ms: checkinWindowMs,
      };
    } else {
      if (
        !input.entry_opens_at || !input.entry_closes_at
        || !input.qualifier_starts_at || !input.final_starts_at
      ) {
        throw new BadRequestError('Provide either compressed or all four timestamps');
      }
      entryOpensAt = new Date(input.entry_opens_at);
      entryClosesAt = new Date(input.entry_closes_at);
      qualifierStartsAt = new Date(input.qualifier_starts_at);
      finalStartsAt = new Date(input.final_starts_at);
    }
    if (!(entryOpensAt < entryClosesAt && entryClosesAt <= qualifierStartsAt
      && qualifierStartsAt < finalStartsAt)) {
      throw new BadRequestError('Timestamps must be ordered: entry open < close <= qualifier < final');
    }

    const created = await wlOrchestratorRepo.createWithInitialEvent({
      weekKey: null,
      isTest: true,
      config: buildWlConfig({ launch_edition: true, ...input.config }),
      entryOpensAt,
      entryClosesAt,
      qualifierStartsAt,
      finalStartsAt,
      redisTimeMs: now,
      status: 'scheduled',
    });
    if (!created) {
      throw new BadRequestError('Tournament creation returned no row (conflict?)');
    }
    logger.info({ actor: input.actor, tournamentId: created.id }, 'WL ops: test tournament created');
    res.json({ tournament_id: created.id });
  },

  async pause(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.parse(req.body ?? {});
    const t = await wlOrchestratorRepo.getById(input.tournament_id);
    if (!t) throw new NotFoundError('Tournament not found');
    const redisNow = await wlRedisNowMs();
    const moved = await transitionOr400({
      tournamentId: t.id, from: t.status, to: 'paused',
      setPausedFrom: t.status, redisTimeMs: redisNow,
      eventPayload: { reason: input.reason ?? 'ops', actor: input.actor },
    });
    logger.warn({ actor: input.actor, tournamentId: t.id, moved }, 'WL ops: pause');
    res.json({ paused: moved });
  },

  async resume(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.parse(req.body ?? {});
    const t = await wlOrchestratorRepo.getById(input.tournament_id);
    if (!t) throw new NotFoundError('Tournament not found');
    const redisNow = await wlRedisNowMs();
    const moved = await wlOrchestratorRepo.resume(input.tournament_id, redisNow);
    logger.warn({ actor: input.actor, tournamentId: input.tournament_id, moved }, 'WL ops: resume');
    res.json({ resumed: moved });
  },

  async cancel(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const input = actionSchema.parse(req.body ?? {});
    const t = await wlOrchestratorRepo.getById(input.tournament_id);
    if (!t) throw new NotFoundError('Tournament not found');
    const redisNow = await wlRedisNowMs();
    const moved = await transitionOr400({
      tournamentId: t.id, from: t.status, to: 'cancelled', redisTimeMs: redisNow,
      cancelledReason: input.reason ?? `ops:${input.actor}`,
      eventPayload: { actor: input.actor },
    });
    logger.warn({ actor: input.actor, tournamentId: t.id, moved }, 'WL ops: cancel');
    res.json({ cancelled: moved });
  },

  async forceTick(req: Request, res: Response): Promise<void> {
    requireOpsToken(req);
    const actor = z.object({ actor: z.string().min(1).max(80) })
      .parse(req.body ?? {}).actor;
    const io = getWlOrchestratorIo();
    if (!io) throw new BadRequestError('WL orchestrator not started');
    // Same strict lock as the loop — never an unlocked side-channel.
    const ran = await wlRunLockedTick(io, { createWeekly: false });
    logger.warn({ actor, ran }, 'WL ops: force-tick');
    res.json({ ticked: ran });
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

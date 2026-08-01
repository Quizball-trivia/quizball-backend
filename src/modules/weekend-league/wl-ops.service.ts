/**
 * Shared ops/admin actions for WL tournaments — the ops-token surface and the
 * CMS admin surface both call these, so behavior can never drift between the
 * two auth paths.
 */

import { z } from 'zod';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import { BadRequestError, NotFoundError } from '../../core/errors.js';
import { buildWlConfig, wlTournamentConfigSchema } from './wl-config.js';
import { wlOrchestratorRepo } from './wl-orchestrator.repo.js';
import { getWlOrchestratorIo, wlRunLockedTick } from './wl-orchestrator.js';
import { wlRedisNowMs } from './wl-redis.js';

export const wlCreateTestSchema = z.object({
  actor: z.string().min(1).max(80),
  entry_opens_at: z.string().datetime().optional(),
  entry_closes_at: z.string().datetime().optional(),
  qualifier_starts_at: z.string().datetime().optional(),
  final_starts_at: z.string().datetime().optional(),
  compressed: z.object({
    entry_seconds: z.number().int().min(10).max(3600),
    checkin_seconds: z.number().int().min(10).max(3600),
    to_final_seconds: z.number().int().min(10).max(7200),
  }).optional(),
  config: wlTournamentConfigSchema.partial().optional(),
});
export type WlCreateTestInput = z.infer<typeof wlCreateTestSchema>;

export async function wlCreateTestTournament(input: WlCreateTestInput): Promise<{ tournamentId: string }> {
  if (config.NODE_ENV === 'prod') {
    throw new BadRequestError('Test tournaments cannot be created in prod');
  }
  const now = await wlRedisNowMs();

  let entryOpensAt: Date;
  let entryClosesAt: Date;
  let qualifierStartsAt: Date;
  let finalStartsAt: Date;
  let cfg = input.config;
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
    cfg = { ...cfg, checkin_window_ms: checkinWindowMs };
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
    config: buildWlConfig({ launch_edition: true, ...cfg }),
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
  return { tournamentId: created.id };
}

// The repo rejects phase-machine-illegal moves with a plain Error; callers
// deserve a 400 with the reason, not a 500.
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

export async function wlPauseTournament(tournamentId: string, actor: string, reason?: string): Promise<boolean> {
  const t = await wlOrchestratorRepo.getById(tournamentId);
  if (!t) throw new NotFoundError('Tournament not found');
  const redisNow = await wlRedisNowMs();
  const moved = await transitionOr400({
    tournamentId: t.id, from: t.status, to: 'paused',
    setPausedFrom: t.status, redisTimeMs: redisNow,
    eventPayload: { reason: reason ?? 'ops', actor },
  });
  logger.warn({ actor, tournamentId: t.id, moved }, 'WL ops: pause');
  return moved;
}

export async function wlResumeTournament(tournamentId: string, actor: string): Promise<boolean> {
  const t = await wlOrchestratorRepo.getById(tournamentId);
  if (!t) throw new NotFoundError('Tournament not found');
  const redisNow = await wlRedisNowMs();
  const moved = await wlOrchestratorRepo.resume(tournamentId, redisNow);
  logger.warn({ actor, tournamentId, moved }, 'WL ops: resume');
  return moved;
}

export async function wlCancelTournament(tournamentId: string, actor: string, reason?: string): Promise<boolean> {
  const t = await wlOrchestratorRepo.getById(tournamentId);
  if (!t) throw new NotFoundError('Tournament not found');
  const redisNow = await wlRedisNowMs();
  const moved = await transitionOr400({
    tournamentId: t.id, from: t.status, to: 'cancelled', redisTimeMs: redisNow,
    cancelledReason: reason ?? `ops:${actor}`,
    eventPayload: { actor },
  });
  logger.warn({ actor, tournamentId: t.id, moved }, 'WL ops: cancel');
  return moved;
}

export async function wlForceTick(actor: string): Promise<boolean> {
  const io = getWlOrchestratorIo();
  if (!io) throw new BadRequestError('WL orchestrator not started');
  // Same strict lock as the loop — never an unlocked side-channel.
  const ran = await wlRunLockedTick(io, { createWeekly: false });
  logger.warn({ actor, ran }, 'WL ops: force-tick');
  return ran;
}

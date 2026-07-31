/**
 * Outbox deliverer — the ONLY place WL events become socket emissions.
 *
 * Strictly in-order per tournament: claims the lowest pending seq under a
 * fenced lease and performs its effect. Public room broadcasts go through
 * io.to(room) once (the redis adapter fans out to peer replicas); the
 * claimant is the single emitter. A poison head (attempts ≥ 5) pauses the
 * tournament — every WL event type is critical, so nothing is skipped
 * silently.
 *
 * Spectator delivery is a second, independent cursor over the SAME events:
 * an event becomes spectator-visible only after its live delivery is
 * terminal AND 30s past its first live emission attempt — the delay can
 * stretch (crash/retry) but never shrink.
 */

import { logger } from '../../core/logger.js';
import type { QuizballServer } from '../../realtime/socket-server.js';
import {
  WL_EVENT_POISON_ATTEMPTS,
  wlEventsRepo,
  type WlEventRow,
} from './wl-events.repo.js';
import { wlOrchestratorRepo } from './wl-orchestrator.repo.js';
import { wlRedisNowMs } from './wl-redis.js';

export const WL_SPECTATOR_DELAY_MS = 30_000;

async function spectatorDelayMs(tournamentId: string): Promise<number> {
  const t = await wlOrchestratorRepo.getById(tournamentId);
  const { wlConfigFrom } = await import('./wl-config.js');
  return t ? wlConfigFrom(t.config).spectator_delay_ms : WL_SPECTATOR_DELAY_MS;
}

export function wlPlayersRoom(tournamentId: string): string {
  return `wl:${tournamentId}`;
}

export function wlSpectatorsRoom(tournamentId: string): string {
  return `wl:${tournamentId}:spec`;
}

type WlEventName = `wl:${WlEventRow['type']}`;

function publicEventName(event: WlEventRow): WlEventName {
  return `wl:${event.type}`;
}

const MAX_EVENTS_PER_DRAIN = 200;

/** Thrown when the strict orchestrator lock is lost mid-work: the caller
 * MUST stop all further side effects — another process owns the work now. */
export class WlLockLostError extends Error {
  constructor() {
    super('WL orchestrator lock lost');
    this.name = 'WlLockLostError';
  }
}

/**
 * Drain the pending outbox head-first for one tournament (bounded per call
 * so a single tournament can never hold the orchestrator lock past its
 * TTL). `heartbeat` is invoked per event; a false return raises
 * WlLockLostError so no later step (spectator delivery, next tournament)
 * can run under a lost lock. Safe to call from any replica at any time.
 */
export async function wlDeliverPending(
  io: QuizballServer,
  tournamentId: string,
  heartbeat?: () => Promise<boolean>
): Promise<number> {
  let delivered = 0;
  while (delivered < MAX_EVENTS_PER_DRAIN) {
    if (heartbeat && !(await heartbeat())) throw new WlLockLostError();
    const head = await wlEventsRepo.pendingHead(tournamentId);
    if (!head) break;
    // Poison classification only for an UNCLAIMED head: attempts counts
    // claims, so a live claimant's own in-flight attempt must not be
    // mistaken for a stuck row by a concurrent deliverer.
    if (head.attempts >= WL_EVENT_POISON_ATTEMPTS && !head.claimLive) {
      await pauseForPoison(tournamentId, head.seq, head.attempts);
      break;
    }
    if (head.claimLive && head.attempts >= WL_EVENT_POISON_ATTEMPTS) break;

    const event = await wlEventsRepo.claimNext(tournamentId);
    if (!event) break; // another replica holds the lease

    try {
      // Renew the lease immediately before the visible side effect: a lost
      // fence here means another claimant owns the seq — do NOT emit.
      const renewed = await wlEventsRepo.renewLease(tournamentId, event.seq, event.claim_token);
      if (!renewed) break;
      const redisNow = await wlRedisNowMs();

      // Question dispatches get their one-shot playable/deadline stamps at
      // first emission; a too-late crash-retry voids to a reserve instead
      // (the dispatch event is terminally aborted — never emitted).
      let outPayload: Record<string, unknown> = event.payload;
      if (event.type === 'dispatch') {
        const { wlLiveEngineInternals } = await import('./wl-live-engine.js');
        const enriched = await wlLiveEngineInternals.stampForEmission(
          tournamentId, event.payload, redisNow
        );
        if (!enriched) {
          const attemptId = String(event.payload['attempt_id'] ?? '');
          if (attemptId) {
            // One fenced transaction: event abort + run void + void event +
            // replacement dispatch — or nothing (fence lost / already moved).
            await wlLiveEngineInternals.voidAttempt(
              tournamentId, attemptId, redisNow, 'stale_dispatch_retry',
              { seq: event.seq, claimToken: event.claim_token }
            );
          } else {
            await wlEventsRepo.markAborted(
              tournamentId, event.seq, event.claim_token, 'dispatch_stale_or_voided'
            );
          }
          continue;
        }
        outPayload = enriched;
        await wlEventsRepo.persistDispatchStamps(
          tournamentId, event.seq, event.claim_token,
          Number(enriched['playableAt']), Number(enriched['deadlineAt'])
        );
      }

      // Fresh clock IMMEDIATELY before the visible emission: DB latency in
      // the enrichment above must neither skew client offsets nor shorten
      // the spectator delay (visibility = emitNow + 30s).
      const emitNow = await wlRedisNowMs();
      // Staleness re-validated on THIS clock: the awaited stamp-persistence
      // above may have pushed a dispatch below its minimum lead (or past
      // its deadline) — such a dispatch is voided, never emitted.
      if (event.type === 'dispatch') {
        const deadlineAt = Number(outPayload['deadlineAt']);
        const { WL_MIN_REMAINING_LEAD_MS, wlLiveEngineInternals } = await import('./wl-live-engine.js');
        if (!Number.isFinite(deadlineAt) || emitNow > deadlineAt - WL_MIN_REMAINING_LEAD_MS) {
          const attemptId = String(event.payload['attempt_id'] ?? '');
          if (attemptId) {
            await wlLiveEngineInternals.voidAttempt(
              tournamentId, attemptId, emitNow, 'stale_before_emit',
              { seq: event.seq, claimToken: event.claim_token }
            );
          }
          continue;
        }
      }
      const stamped = await wlEventsRepo.markLiveEmission(
        tournamentId, event.seq, event.claim_token, emitNow, await spectatorDelayMs(tournamentId)
      );
      if (!stamped) break; // fence lost

      io.to(wlPlayersRoom(tournamentId)).emit(publicEventName(event), {
        ...outPayload,
        tournamentId,
        seq: event.seq,
        type: event.type,
        serverNowAtEmit: emitNow,
      } as never);

      if (event.type === 'dispatch' && typeof outPayload['deadlineAt'] === 'number') {
        // Wake-up hint at the deadline; the 5s live reconciler is the
        // durable backstop (timers are never the source of truth).
        const { scheduleWlTick } = await import('./wl-timer.js');
        await scheduleWlTick(tournamentId, Number(outPayload['deadlineAt'])).catch(() => {});
      }

      {
        // Generic live-room eviction: cut players (result events), final
        // no-shows (phase events) and the whole field at the final result
        // lose live access the moment the event lands — from here they
        // belong in the delayed spectator room. Rides the user rooms every
        // socket joins at auth (adapter-propagated across replicas).
        const evictIds = new Set<string>();
        for (const key of ['eliminated_user_ids', 'evicted_user_ids']) {
          const list = event.payload[key];
          if (Array.isArray(list)) for (const id of list as string[]) evictIds.add(id);
        }
        for (const userId of evictIds) {
          io.in(`user:${userId}`).socketsLeave(wlPlayersRoom(tournamentId));
        }
      }

      const done = await wlEventsRepo.markDelivered(tournamentId, event.seq, event.claim_token);
      if (!done) break; // fence lost after emit — client seq-dedup absorbs the retry
      delivered += 1;
    } catch (error) {
      logger.error({ err: error, tournamentId, seq: event.seq }, 'WL event delivery failed');
      await wlEventsRepo.recordError(
        tournamentId, event.seq, event.claim_token,
        error instanceof Error ? error.message : String(error)
      ).catch(() => {});
      break;
    }
  }
  return delivered;
}

/** Deliver spectator-due events past the persisted cursor. */
export async function wlDeliverSpectator(io: QuizballServer, tournamentId: string): Promise<number> {
  const tournament = await wlOrchestratorRepo.getById(tournamentId);
  if (!tournament) return 0;
  const redisNow = await wlRedisNowMs();
  const due = await wlEventsRepo.spectatorDue(
    tournamentId, Number(tournament.spec_delivered_seq), redisNow
  );
  let deliveredTo = Number(tournament.spec_delivered_seq);
  for (const event of due) {
    io.to(wlSpectatorsRoom(tournamentId)).emit(publicEventName(event), {
      ...event.payload,
      tournamentId,
      seq: event.seq,
      type: event.type,
      spectator: true,
      serverNowAtEmit: redisNow,
    } as never);
    deliveredTo = event.seq;
  }
  if (deliveredTo > Number(tournament.spec_delivered_seq)) {
    await wlEventsRepo.advanceSpectatorCursor(tournamentId, deliveredTo);
  }
  return due.length;
}

async function pauseForPoison(tournamentId: string, seq: number, attempts: number): Promise<void> {
  const tournament = await wlOrchestratorRepo.getById(tournamentId);
  if (!tournament || tournament.status === 'paused') return;
  logger.error(
    { tournamentId, seq, attempts },
    'WL outbox head is poison — pausing tournament for ops'
  );
  // Fail closed: without Redis there is no clock and no pause — the poison
  // head simply waits for the next tick to try again.
  const redisNow = await wlRedisNowMs();
  await wlOrchestratorRepo.transition({
    tournamentId,
    from: tournament.status,
    to: 'paused',
    setPausedFrom: tournament.status,
    redisTimeMs: redisNow,
    eventPayload: { reason: 'poison_event', seq },
  });
}

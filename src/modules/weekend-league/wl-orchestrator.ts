/**
 * WL orchestrator — the single periodic driver of tournament state.
 *
 * One replica wins a strict Redis lock per tick (fail-closed: no Redis, no
 * tick) and, for every non-terminal tournament: applies due time-driven
 * transitions (CAS + outbox), runs kickoff/final adjudication, lets the
 * engine advance live games, drains the outbox to sockets, and delivers
 * spectator-due events. Interval: 5s while anything is in a live phase,
 * 15s otherwise — this cadence IS the durability story for PR2 (timers
 * become wake-up hints in PR3; recovery SLO p99 ≤ 10s).
 *
 * Weekly creation: inside the creation horizon the reconciler inserts the
 * next real tournament (Mon 00:00 GE entry open → Sat 14:00 qualifier →
 * Sun 14:00 final); the partial unique index on week_key makes the
 * replica race single-winner.
 */

import { logger } from '../../core/logger.js';
import { acquireLock, releaseLock } from '../../realtime/locks.js';
import type { QuizballServer } from '../../realtime/socket-server.js';
import { sql } from '../../db/index.js';
import { wlDeliverPending, wlDeliverSpectator } from './wl-deliverer.js';
import { wlEventsRepo } from './wl-events.repo.js';
import { buildWlConfig, wlConfigFrom } from './wl-config.js';
import {
  wlDueTransition,
  type WlScheduleView,
} from './wl-phase.js';
import { wlOrchestratorRepo, type WlOrchestratorTournament } from './wl-orchestrator.repo.js';
import { wlRedis, wlRedisNowMs } from './wl-redis.js';
import { wlEngine } from './wl-engine.adapter.js';
import { weekKeyFor } from './wl-week.js';

const ORCHESTRATOR_LOCK_KEY = 'lock:wl:orchestrator';
const IDLE_TICK_MS = 15_000;
const LIVE_TICK_MS = 5_000;
const CREATION_HORIZON_MS = 24 * 60 * 60 * 1000;
const GE_OFFSET_MS = 4 * 60 * 60 * 1000;
const LIVE_STATUSES = new Set(['checkin', 'game_live', 'break', 'final_checkin', 'final_live']);
export const WL_MIN_FIELD = 2;

let loopTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;
let activeIo: QuizballServer | null = null;

export function startWlOrchestrator(io: QuizballServer): void {
  activeIo = io;
  scheduleNext(IDLE_TICK_MS);
  logger.info('WL orchestrator started');
}

export function getWlOrchestratorIo(): QuizballServer | null {
  return activeIo;
}

export function stopWlOrchestrator(): void {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = null;
  activeIo = null;
}

function scheduleNext(delayMs: number): void {
  if (loopTimer) clearTimeout(loopTimer);
  loopTimer = setTimeout(() => {
    void runTick().finally(() => {
      if (activeIo) scheduleNext(lastTickHadLive ? LIVE_TICK_MS : IDLE_TICK_MS);
    });
  }, delayMs);
  loopTimer.unref?.();
}

let lastTickHadLive = false;

async function runTick(): Promise<void> {
  if (tickInFlight || !activeIo) return;
  tickInFlight = true;
  try {
    // Fail closed: no Redis ⇒ no lock, no time domain, no tick.
    wlRedis();
    const lock = await acquireLock(ORCHESTRATOR_LOCK_KEY, Math.max(IDLE_TICK_MS, 20_000));
    if (!lock.acquired || !lock.token) return;
    try {
      await wlOrchestratorTick(activeIo);
    } finally {
      await releaseLock(ORCHESTRATOR_LOCK_KEY, lock.token).catch(() => {});
    }
  } catch (error) {
    logger.warn({ err: error }, 'WL orchestrator tick skipped');
  } finally {
    tickInFlight = false;
  }
}

/**
 * Advance + deliver a SINGLE tournament — the unit the full tick loops over.
 * Exported for the two-process harness (scoped, so harness processes can
 * never touch tournaments owned by other concurrently running tests).
 */
export async function wlAdvanceOneTournament(io: QuizballServer, tournamentId: string): Promise<void> {
  const redisNow = await wlRedisNowMs();
  const t = await wlOrchestratorRepo.getById(tournamentId);
  if (!t || ['completed', 'cancelled', 'voided'].includes(t.status)) return;
  try {
    await advanceTournament(io, t, redisNow);
  } catch (error) {
    logger.error({ err: error, tournamentId }, 'WL tournament advance failed');
  }
  await wlDeliverPending(io, tournamentId);
  await wlDeliverSpectator(io, tournamentId);
}

/** One full reconcile pass — exported for tests and the ops force-tick. */
export async function wlOrchestratorTick(io: QuizballServer): Promise<void> {
  const redisNow = await wlRedisNowMs();
  await ensureUpcomingTournament(redisNow);

  const active = await wlOrchestratorRepo.listActive();
  lastTickHadLive = active.some((t) => LIVE_STATUSES.has(t.status));

  for (const tournament of active) {
    try {
      await advanceTournament(io, tournament, redisNow);
    } catch (error) {
      logger.error({ err: error, tournamentId: tournament.id }, 'WL tournament advance failed');
    }
    await wlDeliverPending(io, tournament.id);
    await wlDeliverSpectator(io, tournament.id);
  }
}

function scheduleView(t: WlOrchestratorTournament): WlScheduleView {
  const config = wlConfigFrom(t.config);
  return {
    status: t.status,
    entryOpensAtMs: t.entry_opens_at ? Date.parse(t.entry_opens_at) : null,
    entryClosesAtMs: t.entry_closes_at ? Date.parse(t.entry_closes_at) : null,
    qualifierStartsAtMs: t.qualifier_starts_at ? Date.parse(t.qualifier_starts_at) : null,
    finalStartsAtMs: t.final_starts_at ? Date.parse(t.final_starts_at) : null,
    checkinWindowMs: config.checkin_window_ms,
  };
}

async function advanceTournament(
  _io: QuizballServer,
  t: WlOrchestratorTournament,
  redisNow: number
): Promise<void> {
  // Content pipeline (PR3 brings the real seeder): scheduled rows move
  // straight through content_pending to ready.
  if (t.status === 'scheduled') {
    await wlOrchestratorRepo.transition({
      tournamentId: t.id, from: 'scheduled', to: 'content_pending', redisTimeMs: redisNow,
    });
    t = await wlOrchestratorRepo.getById(t.id) ?? t;
  }
  if (t.status === 'content_pending') {
    const seeded = await wlEngine.seedContent(t);
    if (seeded) {
      await wlOrchestratorRepo.transition({
        tournamentId: t.id, from: 'content_pending', to: 'ready', redisTimeMs: redisNow,
      });
      t = await wlOrchestratorRepo.getById(t.id) ?? t;
    }
  }

  // Time-driven phase boundaries.
  const due = wlDueTransition(scheduleView(t), redisNow);
  if (due) {
    const moved = await wlOrchestratorRepo.transition({
      tournamentId: t.id, from: t.status, to: due, redisTimeMs: redisNow,
    });
    if (moved) {
      if (due === 'checkin' && !t.is_test) {
        // Everyone active hears the league is starting: entrants can join,
        // the rest can spectate from the same tab.
        void import('./wl-notifications.js').then(({ wlNotifyAllActiveUsers }) =>
          wlNotifyAllActiveUsers(t.id, 'started', {
            titleEn: 'Weekend League is starting!',
            titleKa: 'უიქენდის ლიგა იწყება!',
            bodyEn: 'Check in now if you are registered — or watch the games live.',
            bodyKa: 'გაიარე ჩექინი თუ დარეგისტრირებული ხარ — ან უყურე თამაშებს ლაივში.',
          })
        ).catch((err) => logger.warn({ err, tournamentId: t.id }, 'WL started wave failed'));
      }
      t = await wlOrchestratorRepo.getById(t.id) ?? t;
    }
  }

  // Kickoff adjudication: at qualifier start, a big-enough checked-in field
  // becomes game 1; a thin one cancels the event.
  const view = scheduleView(t);
  if (
    t.status === 'checkin'
    && view.qualifierStartsAtMs != null
    && redisNow >= view.qualifierStartsAtMs
  ) {
    const checkedIn = await wlOrchestratorRepo.checkedInCount(t.id);
    if (checkedIn < WL_MIN_FIELD) {
      await wlOrchestratorRepo.transition({
        tournamentId: t.id, from: 'checkin', to: 'cancelled', redisTimeMs: redisNow,
        cancelledReason: 'not_enough_players',
        eventPayload: { checked_in: checkedIn },
      });
      await notifyCancellation(t.id);
      return;
    }
    const started = await wlEngine.startQualifier(t, redisNow);
    if (started) {
      await wlOrchestratorRepo.transition({
        tournamentId: t.id, from: 'checkin', to: 'game_live', redisTimeMs: redisNow,
        eventPayload: { checked_in: checkedIn },
      });
      return;
    }
  }

  // Engine-driven live flow (PR2 stub completes games immediately;
  // PR3/PR4 replace the internals, not this seam).
  if (t.status === 'game_live' || t.status === 'break' || t.status === 'final_live') {
    await wlEngine.advance(t, redisNow);
    return;
  }

  // Sunday adjudication under dns_v1.
  if (
    t.status === 'final_checkin'
    && view.finalStartsAtMs != null
    && redisNow >= view.finalStartsAtMs
  ) {
    await wlEngine.adjudicateFinalStart(t, redisNow);
  }
}

async function notifyCancellation(tournamentId: string): Promise<void> {
  // Recipient-idempotent wave — see wl-notifications.ts.
  const { wlNotifyEntrants } = await import('./wl-notifications.js');
  await wlNotifyEntrants(tournamentId, 'cancelled', {
    titleEn: 'Weekend League cancelled',
    titleKa: 'უიქენდის ლიგა გაუქმდა',
    bodyEn: 'Not enough players checked in this week. See you next Saturday!',
    bodyKa: 'ამ კვირას საკმარისმა მოთამაშემ ვერ გაიარა ჩექინი. შეხვედრამდე მომავალ შაბათს!',
  }).catch((err) => logger.warn({ err, tournamentId }, 'WL cancellation wave failed'));
}

/**
 * Create next week's real tournament once its entry window is inside the
 * horizon. Georgia-time schedule: entry opens Monday 00:00, closes Friday
 * 12:00, qualifier Saturday 14:00, final Sunday 14:00 — all fixed UTC+4.
 */
async function ensureUpcomingTournament(nowMs: number): Promise<void> {
  // The Saturday of the week whose Monday is <= now+horizon.
  const probe = new Date(nowMs + CREATION_HORIZON_MS);
  const weekKey = weekKeyFor(probe) ?? weekKeyFor(new Date(probe.getTime() + 3 * 24 * 3600_000));
  if (!weekKey) return;
  const existing = await wlOrchestratorRepo.getByWeekKey(weekKey);
  if (existing) return;

  // weekKey is the GE Saturday date; GE wall-clock X = UTC X − 4h.
  const saturdayMidnightUtc = new Date(`${weekKey}T00:00:00Z`).getTime() - GE_OFFSET_MS;
  const DAY = 24 * 3600_000;
  const qualifierStartsAt = new Date(saturdayMidnightUtc + 14 * 3600_000); // Sat 14:00 GE
  const finalStartsAt = new Date(qualifierStartsAt.getTime() + DAY);        // Sun 14:00 GE
  const entryClosesAt = new Date(saturdayMidnightUtc - DAY + 12 * 3600_000); // Fri 12:00 GE
  const entryOpensAt = new Date(saturdayMidnightUtc - 5 * DAY);              // Mon 00:00 GE

  const created = await wlOrchestratorRepo.create({
    weekKey,
    isTest: false,
    config: buildWlConfig({ launch_edition: true }),
    entryOpensAt,
    entryClosesAt,
    qualifierStartsAt,
    finalStartsAt,
  });
  if (created) {
    logger.info({ weekKey, tournamentId: created.id }, 'WL weekly tournament created');
    const redisNow = await wlRedisNowMs();
    await sql.begin(async (tx) => {
      await wlEventsRepo.append(tx as unknown as typeof sql, {
        tournamentId: created.id,
        type: 'phase',
        payload: { from: null, to: 'scheduled', created: true },
        redisTimeMs: redisNow,
      });
    });
  }
}

/**
 * WL orchestrator — the single periodic driver of tournament state.
 *
 * Gated by WL_ORCHESTRATION_ENABLED (default off): when disabled, the loop
 * never starts and no REAL weekly tournament is ever created — test
 * tournaments still run via the ops API's force-tick, which routes through
 * the same strict lock as the loop.
 *
 * One process at a time holds a STRICT Redis lock (no local fallback),
 * renewed as a heartbeat between tournaments; losing the lock aborts the
 * pass immediately. Each pass: applies due time-driven transitions
 * (CAS + outbox in one tx, validated by the pure phase machine), runs
 * kickoff/final adjudication, lets the engine advance live games, retries
 * notification waves to exhaustion, and drains outbox work — including for
 * TERMINAL tournaments, so a completed/cancelled event still reaches
 * players and (30s later) spectators.
 */

import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import type { QuizballServer } from '../../realtime/socket-server.js';
import { wlDeliverPending, wlDeliverSpectator } from './wl-deliverer.js';
import { wlEventsRepo } from './wl-events.repo.js';
import { buildWlConfig, wlConfigFrom } from './wl-config.js';
import { wlDueTransition, type WlScheduleView } from './wl-phase.js';
import { wlOrchestratorRepo, type WlOrchestratorTournament } from './wl-orchestrator.repo.js';
import {
  wlAcquireStrictLock,
  wlReleaseStrictLock,
  wlRenewStrictLock,
  wlRedisNowMs,
} from './wl-redis.js';
import { wlEngine } from './wl-engine.adapter.js';
import { wlUpcomingEventSchedule } from './wl-week.js';

const ORCHESTRATOR_LOCK_KEY = 'lock:wl:orchestrator';
const LOCK_TTL_MS = 30_000;
const IDLE_TICK_MS = 15_000;
const LIVE_TICK_MS = 5_000;
const CREATION_HORIZON_MS = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = new Set(['checkin', 'game_live', 'break', 'final_checkin', 'final_live']);
export const WL_MIN_FIELD = 2;

let loopTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;
let activeIo: QuizballServer | null = null;
let lastTickHadLive = false;

export function startWlOrchestrator(io: QuizballServer): void {
  activeIo = io;
  if (!config.WL_ORCHESTRATION_ENABLED) {
    logger.info('WL orchestrator disabled (WL_ORCHESTRATION_ENABLED=false); ops force-tick only');
    return;
  }
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
    void loopTick().finally(() => {
      if (activeIo) scheduleNext(lastTickHadLive ? LIVE_TICK_MS : IDLE_TICK_MS);
    });
  }, delayMs);
  loopTimer.unref?.();
}

async function loopTick(): Promise<void> {
  if (tickInFlight || !activeIo) return;
  tickInFlight = true;
  try {
    await wlRunLockedTick(activeIo, { createWeekly: true });
  } catch (error) {
    logger.warn({ err: error }, 'WL orchestrator tick skipped');
  } finally {
    tickInFlight = false;
  }
}

/**
 * The ONE locked entrypoint — used by the loop, the ops force-tick and the
 * two-process harness. Returns false when the lock was not acquired.
 */
export async function wlRunLockedTick(
  io: QuizballServer,
  opts: { createWeekly?: boolean } = {}
): Promise<boolean> {
  const token = await wlAcquireStrictLock(ORCHESTRATOR_LOCK_KEY, LOCK_TTL_MS);
  if (!token) return false;
  try {
    await wlOrchestratorTick(io, {
      ...opts,
      heartbeat: () => wlRenewStrictLock(ORCHESTRATOR_LOCK_KEY, token, LOCK_TTL_MS),
    });
    return true;
  } finally {
    await wlReleaseStrictLock(ORCHESTRATOR_LOCK_KEY, token);
  }
}

/**
 * One full reconcile pass. `heartbeat` is called between tournaments; a
 * false return means the lock is lost and the pass MUST stop (another
 * process owns the work now).
 */
export async function wlOrchestratorTick(
  io: QuizballServer,
  opts: { createWeekly?: boolean; heartbeat?: () => Promise<boolean> } = {}
): Promise<void> {
  const redisNow = await wlRedisNowMs();
  if (opts.createWeekly && config.WL_ORCHESTRATION_ENABLED) {
    await ensureUpcomingTournament(redisNow);
  }

  // With the launch flag off, ONLY test tournaments move — a force-tick can
  // never advance a real event through the stub engine.
  const activeAll = await wlOrchestratorRepo.listActive();
  const active = config.WL_ORCHESTRATION_ENABLED
    ? activeAll
    : activeAll.filter((t) => t.is_test);
  for (const tournament of active) {
    if (opts.heartbeat && !(await opts.heartbeat())) {
      logger.warn('WL orchestrator lock lost mid-pass; aborting');
      return;
    }
    try {
      await advanceTournament(tournament, redisNow);
    } catch (error) {
      logger.error({ err: error, tournamentId: tournament.id }, 'WL tournament advance failed');
    }
    try {
      await reconcileWaves(tournament);
    } catch (error) {
      logger.warn({ err: error, tournamentId: tournament.id }, 'WL wave reconcile failed');
    }
  }

  // Waves for RECENTLY TERMINAL tournaments too: a crash between the
  // cancelled CAS and its wave must heal on later passes even though the
  // row left listActive.
  for (const t of await wlOrchestratorRepo.listRecentlyTerminal(48)) {
    try {
      await reconcileWaves(t);
    } catch (error) {
      logger.warn({ err: error, tournamentId: t.id }, 'WL terminal wave reconcile failed');
    }
  }

  // Outbox drain — includes TERMINAL tournaments with outstanding work.
  const pendingWork = await wlEventsRepo.listTournamentsWithPendingWork();
  for (const tournamentId of pendingWork) {
    if (opts.heartbeat && !(await opts.heartbeat())) {
      logger.warn('WL orchestrator lock lost mid-drain; aborting');
      return;
    }
    try {
      await wlDeliverPending(io, tournamentId, opts.heartbeat);
      await wlDeliverSpectator(io, tournamentId);
    } catch (error) {
      logger.error({ err: error, tournamentId }, 'WL outbox drain failed');
    }
  }

  // Cadence from POST-processing state, so entering a live phase speeds the
  // next pass up immediately.
  const after = await wlOrchestratorRepo.listActive();
  lastTickHadLive = after.some((t) => LIVE_STATUSES.has(t.status))
    || pendingWork.length > 0;
}

/** Scoped advance+drain for one tournament (two-process harness). */
export async function wlAdvanceOneTournament(io: QuizballServer, tournamentId: string): Promise<void> {
  const redisNow = await wlRedisNowMs();
  const t = await wlOrchestratorRepo.getById(tournamentId);
  if (!t) return;
  if (!['completed', 'cancelled', 'voided'].includes(t.status)) {
    try {
      await advanceTournament(t, redisNow);
    } catch (error) {
      logger.error({ err: error, tournamentId }, 'WL tournament advance failed');
    }
  }
  await wlDeliverPending(io, tournamentId);
  await wlDeliverSpectator(io, tournamentId);
}

function scheduleView(t: WlOrchestratorTournament): WlScheduleView {
  const cfg = wlConfigFrom(t.config);
  return {
    status: t.status,
    entryOpensAtMs: t.entry_opens_at ? Date.parse(t.entry_opens_at) : null,
    entryClosesAtMs: t.entry_closes_at ? Date.parse(t.entry_closes_at) : null,
    qualifierStartsAtMs: t.qualifier_starts_at ? Date.parse(t.qualifier_starts_at) : null,
    finalStartsAtMs: t.final_starts_at ? Date.parse(t.final_starts_at) : null,
    checkinWindowMs: cfg.checkin_window_ms,
  };
}

async function advanceTournament(
  t: WlOrchestratorTournament,
  redisNow: number
): Promise<void> {
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

  const due = wlDueTransition(scheduleView(t), redisNow);
  if (due) {
    const moved = await wlOrchestratorRepo.transition({
      tournamentId: t.id, from: t.status, to: due, redisTimeMs: redisNow,
    });
    if (moved) t = await wlOrchestratorRepo.getById(t.id) ?? t;
  }

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
      // The cancellation wave is delivered by reconcileWaves (state-derived,
      // crash-resumable) — not fired inline here.
      return;
    }
    await wlEngine.startQualifier(t, redisNow);
    return;
  }

  if (t.status === 'game_live' || t.status === 'break' || t.status === 'final_live') {
    await wlEngine.advance(t, redisNow);
    return;
  }

  if (
    t.status === 'final_checkin'
    && view.finalStartsAtMs != null
    && redisNow >= view.finalStartsAtMs
  ) {
    await wlEngine.adjudicateFinalStart(t, redisNow);
  }
}

/**
 * State-derived notification waves — idempotent and resumable: each pass
 * re-derives which waves a tournament OWES from its current status and
 * tops them up to candidate exhaustion. Crash anywhere ⇒ healed next pass.
 */
async function reconcileWaves(t: WlOrchestratorTournament): Promise<void> {
  const { wlEnsureStartedWave, wlNotifyEntrants } = await import('./wl-notifications.js');
  if (!t.is_test && ['checkin', 'game_live', 'break', 'qualifier_done', 'final_checkin', 'final_live']
    .includes(t.status)) {
    await wlEnsureStartedWave(t.id);
  }
  if (t.status === 'cancelled') {
    await wlNotifyEntrants(t.id, 'cancelled', {
      titleEn: 'Weekend League cancelled',
      titleKa: 'უიქენდის ლიგა გაუქმდა',
      bodyEn: 'Not enough players checked in this week. See you next Saturday!',
      bodyKa: 'ამ კვირას საკმარისმა მოთამაშემ ვერ გაიარა ჩექინი. შეხვედრამდე მომავალ შაბათს!',
    }, ['entered', 'playing', 'cancelled']);
  }
}

/**
 * Create the current-or-next applicable weekly event once its ENTRY OPEN is
 * inside the horizon. The calendar function owns week attribution (Sunday
 * belongs to the ongoing event; only a final that already started rolls to
 * next Saturday) — a Thursday-evening or weekend deploy bootstraps the
 * ongoing week instead of skipping to the next one.
 */
async function ensureUpcomingTournament(nowMs: number): Promise<void> {
  const schedule = wlUpcomingEventSchedule(nowMs);
  if (schedule.entryOpensAtMs > nowMs + CREATION_HORIZON_MS) return;
  const existing = await wlOrchestratorRepo.getByWeekKey(schedule.weekKey);
  if (existing) return;

  const created = await wlOrchestratorRepo.createWithInitialEvent({
    weekKey: schedule.weekKey,
    isTest: false,
    config: buildWlConfig({ launch_edition: true }),
    entryOpensAt: new Date(schedule.entryOpensAtMs),
    entryClosesAt: new Date(schedule.entryClosesAtMs),
    qualifierStartsAt: new Date(schedule.qualifierStartsAtMs),
    finalStartsAt: new Date(schedule.finalStartsAtMs),
    redisTimeMs: nowMs,
  });
  if (created) {
    logger.info({ weekKey: schedule.weekKey, tournamentId: created.id }, 'WL weekly tournament created');
  }
}

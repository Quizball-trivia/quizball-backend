import { logger } from '../../core/logger.js';
import type { AvatarCustomization } from '../users/avatar-customization.js';
import { createDailyContentStore } from '../daily/daily.content.js';
import { contentChanged } from '../daily/daily.errors.js';
import { createDailyRunsRepo, type DailyPlayer, type DailyRunRowBase } from '../daily/daily.repo.js';
import { createDailyService, type BoardsResponse, type LeaderboardResponse as DailyLeaderboardResponse, type RunResponse as DailyRunResponse } from '../daily/daily.service.js';
import type { DfJoker } from '../room/games/dato-falso/dato-falso.rules.js';
import { ANSWER_GRACE_MS, CONTENT_REFRESH_MS, LEADERBOARD_CACHE_MS, LEADERBOARD_TOP } from '../wordgame-daily/wordgame-daily.shared.js';
import { datoFalsoCalendar, RANKED_START } from './dato-falso.days.js';
import * as rules from './dato-falso.rules.js';

const SETTLE_BATCH = 100;
const SETTLE_EVERY_MS = 30_000;

export interface DatoFalsoDayRow { day: string; number: number; contentVersion: number; cards: unknown }
export interface DatoFalsoRunRow extends DailyRunRowBase<rules.RunState> { rights: number | null }
export interface LeaderboardEntry {
  rank: number; userId: string; username: string; avatarUrl: string | null; avatarCustomization: AvatarCustomization | null;
  country: string | null; tier: string | null; score: number; rights: number;
}
export interface IndexedDay { day: string; number: number; contentVersion: number; cards: rules.DayCards['cards'] }

export type RunResponse = DailyRunResponse<rules.PublicRunState>;
export type LeaderboardResponse = DailyLeaderboardResponse<LeaderboardEntry>;
export interface ReviewResponse { day: string; cards: rules.PublicResult[] }

/** The kit's runs repo for dato_falso_runs / dato_falso_days; equal points rank by right answers, then the earlier finish. */
export const datoFalsoRepo = createDailyRunsRepo<rules.RunState, DatoFalsoRunRow, LeaderboardEntry, DatoFalsoDayRow>(
  { runs: 'dato_falso_runs', days: 'dato_falso_days', payload: 'cards', stat: 'rights' }, { statTiebreak: true, openClockIndex: true },
);

/** A stored day in serving form; null when the row is malformed (the seed validates fully, this only keeps a bad row out). */
export function indexDay(row: DatoFalsoDayRow): IndexedDay | null {
  const parsed = rules.dayCardsSchema.safeParse(row.cards);
  return parsed.success ? { day: row.day, number: row.number, contentVersion: row.contentVersion, cards: parsed.data.cards } : null;
}

export const datoFalsoContent = createDailyContentStore(
  { fingerprint: () => datoFalsoRepo.daysFingerprint(), load: () => datoFalsoRepo.loadDays() },
  indexDay,
  { refreshMs: CONTENT_REFRESH_MS, now: () => Date.now(), log: logger, label: 'Dato falso futbolero' },
);

export interface DatoFalsoDeps {
  repo: typeof datoFalsoRepo;
  content: () => Promise<ReadonlyMap<string, IndexedDay>>;
  contentStale: () => void;
  now: () => Date;
}

/**
 * Dato falso futbolero on the daily-game kit. The card clock is the server's (the database clock, read after the row
 * lock); a card's fake leaves the server when that card is settled, the whole day once it is closed.
 */
export function createDatoFalsoService(deps: DatoFalsoDeps) {
  const core = createDailyService<rules.RunState, DatoFalsoRunRow, LeaderboardEntry, IndexedDay, rules.PublicRunState>(
    deps,
    {
      newState: rules.newState,
      project: rules.project,
      rebase: rules.rebase,
      completion: (s) => (s.done ? { score: rules.score(s), stat: rules.rights(s) } : null),
      publicState: (s, run, day, now, extra) => rules.publicState(s, run.day, day ? { cards: day.cards } : null, now, extra),
      settledAt: rules.settledAt,
    },
    { calendar: datoFalsoCalendar, rankedFrom: RANKED_START, leaderboardTop: LEADERBOARD_TOP, leaderboardCacheMs: LEADERBOARD_CACHE_MS, clock: 'database' },
  );

  /** A move on the open card; when its clock ran out before the move arrived, the card is settled (written now) and the move refused. */
  const onOpenCard = (player: DailyPlayer, runId: string, version: number, move: (s: rules.RunState, day: IndexedDay) => rules.RunState) =>
    core.mutate<{ result: 'ok' | 'late' }>(player, runId, version, (s, day, _now, stored) => {
      if (stored.open && !s.open) return { state: s, extra: { result: 'late' }, settledAt: rules.settledAt(stored, s) };
      if (!day.cards[s.r]) throw contentChanged();
      return { state: move(s, day), extra: { result: 'ok' } };
    });

  return {
    start: (dayId: string, player: DailyPlayer, clientContentVersion?: number): Promise<RunResponse> => core.start(dayId, player, clientContentVersion),

    /** Opens the first card, or the next one after a settled card. */
    next(player: DailyPlayer, runId: string, version: number): Promise<RunResponse> {
      // The last card's clock ran out before this `next`: the run is finished by the clock; record that.
      return core.mutate(player, runId, version, (s, _day, now, stored) =>
        (s.done && !stored.done ? { state: s, settledAt: rules.settledAt(stored, s) } : { state: rules.next(s, now) }));
    },

    joker: (player: DailyPlayer, runId: string, version: number, kind: DfJoker) => onOpenCard(player, runId, version, (s) => rules.joker(s, kind)),
    pick: (player: DailyPlayer, runId: string, version: number, option: number) => onOpenCard(player, runId, version, (s, day) => rules.pick(s, day.cards[s.r], option)),

    current: (player: DailyPlayer, dayId: string | undefined) => core.current(player, dayId),
    boards: (): Promise<BoardsResponse> => core.boards(),

    /** Every card of a day the database clock has closed, with its fake; anything else is the same 404 as a missing day. */
    async review(dayId: string): Promise<ReviewResponse> {
      const day = await core.closedDay(dayId);
      const shown = rules.publicState({ ...rules.newState(), done: true }, dayId, { cards: day.cards }, 0, { ranked: false, disclose: true });
      return { day: dayId, cards: shown.results };
    },

    leaderboard: (dayId: string | undefined, userId: string | null): Promise<LeaderboardResponse> => core.leaderboard(dayId, userId),

    /** One pass of the settling sweep: runs whose clock ran out with nobody coming back are settled (and finished, on the last card). */
    async settleOverdue(): Promise<number> {
      const ids = await deps.repo.overdueRuns(await deps.repo.clock(), ANSWER_GRACE_MS, SETTLE_BATCH);
      for (const id of ids) await core.settleExpired(id).catch((error: unknown) => logger.warn({ err: error, runId: id }, 'Dato falso settle failed'));
      return ids.length;
    },
  };
}

export const datoFalsoService = createDatoFalsoService({
  repo: datoFalsoRepo,
  content: () => datoFalsoContent.get(),
  contentStale: () => datoFalsoContent.invalidate(),
  now: () => new Date(),
});

let settleTimer: NodeJS.Timeout | null = null;
let settling = false;

/** Every replica sweeps (row locks make it safe to overlap): a run left with an expired clock is settled even if the player never returns. */
export function startDatoFalsoSweep(): void {
  if (settleTimer) return;
  settleTimer = setInterval(() => {
    if (settling) return;
    settling = true;
    void datoFalsoService.settleOverdue()
      .catch((error: unknown) => logger.warn({ err: error }, 'Dato falso settle sweep failed'))
      .finally(() => { settling = false; });
  }, SETTLE_EVERY_MS);
  settleTimer.unref?.();
}

/** Called once at boot; never blocks startup and never throws. Missing content only means every day answers 404. */
export function startDatoFalsoReadinessCheck(): void {
  startDatoFalsoSweep();
  void datoFalsoContent.get().then(
    (index) => {
      if (index.size === 0) logger.warn('No Dato falso days loaded (dato_falso_days is empty)');
      else logger.info({ days: index.size }, 'Dato falso days loaded');
    },
    (error: unknown) => logger.warn({ err: error }, 'Dato falso days could not be loaded at boot'),
  );
}

import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { adminStatsRepo } from '../admin-stats/admin-stats.repo.js';
import { hqGoalsAnalyticsRepo, hqGoalsRepo, isUniqueViolation, type GoalRow } from './hq.goals.repo.js';
import type { CreateGoalBody, DepartmentKey, Goal, GoalPage, GoalProgress, ListGoalsQuery, UpdateGoalBody } from './hq.schemas.js';
import { ttlCache } from './hq.cache.js';
import { hqService, tbilisiDate } from './hq.service.js';

// Company goals (north star / week / day). Metric goals measure themselves
// from analytics over the goal's period; manual goals report manual_progress.

/** YYYY-MM-DD ± n days (calendar arithmetic, no time zones involved). */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Monday of the ISO week containing `date`. */
export function mondayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}

/** Default period for a new goal, in Tbilisi dates. */
export function defaultPeriod(horizon: Goal['horizon'], today: string): { start: string; end: string } {
  if (horizon === 'day') return { start: today, end: today };
  if (horizon === 'week') {
    const start = mondayOf(today);
    return { start, end: addDays(start, 6) };
  }
  return { start: today, end: addDays(today, 90) };
}

const minDate = (a: string, b: string) => (a < b ? a : b);
const maxDate = (a: string, b: string) => (a > b ? a : b);
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** A cohort's D7 window ends cohort_start + 6 (last signup day) + 13 days. */
const D7_MATURITY_DAYS = 6 + 13;
/** hq.retention_cohorts clamps p_weeks to 26. */
const MAX_RETENTION_WEEKS = 26;

/**
 * D7 (0–1) of the latest non-empty cohort that was mature on `asOf`
 * (asOf > cohort_start + 19 days — the SQL function's maturity rule).
 */
export function latestMatureD7(
  cohorts: { cohort_start: string; size: number; d7: number | string | null }[],
  asOf: string
): number | null {
  const mature = cohorts
    .filter((c) => c.size > 0 && c.d7 !== null && addDays(c.cohort_start, D7_MATURITY_DAYS) < asOf)
    .sort((a, b) => (a.cohort_start < b.cohort_start ? 1 : -1));
  return mature.length ? Number(mature[0].d7) : null;
}

export function progressPct(current: number | null, target: number | null): number | null {
  if (current === null || target === null || !(target > 0)) return null;
  return Math.max(0, Math.min(100, Math.round((current / target) * 100)));
}

/**
 * Measures a metric goal. Definitions (all Tbilisi days, window = the goal's
 * period capped at today):
 *   new_users       registered signups summed over the window
 *   matches         games played on every surface (admin-stats definition) summed over the window
 *   active_players  distinct players (registered or guest) in the last 7 days of the window
 *                   — the Analytics page's WAU when the window ends today
 *   d7_retention    latest cohort with an elapsed D7 window, as a percentage (0–100)
 *   avg_rating      average feedback rating over the last 7 days of the window
 */
/**
 * Measured values are reused across requests for 3 minutes (per replica): the
 * standup page and the goals page poll, and a `matches` goal scans every play
 * table over the goal's window. Keys carry the metric and its date bounds.
 */
export const progressCache = ttlCache<string, number | null>(180_000);

export function createProgressCalculator(now: Date = new Date()) {
  const today = tbilisiDate(now);
  const memo = new Map<string, Promise<number | null>>();
  const once = (key: string, fn: () => Promise<number | null>) => {
    if (!memo.has(key)) memo.set(key, progressCache.get(key, fn).catch((err) => {
      logger.warn({ err, key }, 'hq: goal progress unavailable');
      return null;
    }));
    return memo.get(key)!;
  };

  async function measure(row: GoalRow): Promise<number | null> {
    const end = minDate(row.period_end, today);
    const start = row.period_start;
    switch (row.metric) {
      case 'new_users':
        return once(`new_users:${start}:${end}`, () => hqGoalsRepo.newUsersBetween(start, end));
      case 'matches':
        // Explicit date bounds — no lookback window, however old the goal.
        return once(`matches:${start}:${end}`, () => adminStatsRepo.gamesBetween(start, end));
      case 'active_players': {
        const from = maxDate(start, addDays(end, -6));
        return once(`active:${from}:${end}`, () => hqGoalsRepo.activeIdentitiesBetween(from, end));
      }
      case 'd7_retention':
        // As of the goal's (capped) end date: the latest cohort whose D7
        // window had fully elapsed by then. A cohort's D7 value is final once
        // mature, so today's data gives the right number for past goals too.
        return once(`d7:${end}`, async () => {
          // Enough weeks to reach a cohort mature by `end`, clamped to the SQL
          // function's limit; latestMatureD7 decides whether usable data exists
          // (the padded estimate alone must not turn a goal "unknown").
          const weeks = Math.min(MAX_RETENTION_WEEKS, Math.ceil((daysBetween(end, today) + D7_MATURITY_DAYS) / 7) + 2);
          let latest = latestMatureD7(await hqGoalsRepo.retentionCohorts(weeks), end);
          // No non-empty mature cohort in the short window (e.g. weeks without
          // signups): look further back, up to the function's 26-week limit.
          if (latest === null && weeks < MAX_RETENTION_WEEKS) {
            latest = latestMatureD7(await hqGoalsRepo.retentionCohorts(MAX_RETENTION_WEEKS), end);
          }
          return latest === null ? null : Math.round(latest * 1000) / 10;
        });
      case 'avg_rating': {
        const from = maxDate(start, addDays(end, -6));
        return once(`rating:${from}:${end}`, () => hqGoalsAnalyticsRepo.avgRatingBetween(from, end));
      }
      default:
        return null;
    }
  }

  return async function progressOf(row: GoalRow): Promise<GoalProgress> {
    if (!row.metric) return { current: null, pct: row.manual_progress ?? null };
    if (row.period_start > today) return { current: null, pct: 0 };
    const current = await measure(row);
    return { current, pct: progressPct(current, row.target === null ? null : Number(row.target)) };
  };
}

export function toGoal(r: GoalRow, progress: GoalProgress): Goal {
  return {
    id: r.id,
    horizon: r.horizon,
    title: r.title,
    description: r.description,
    metric: r.metric,
    target: r.target === null ? null : Number(r.target),
    manualProgress: r.manual_progress,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    status: r.status,
    department: r.department as DepartmentKey | null,
    position: Number(r.position),
    progress,
    createdAt: (r.created_at instanceof Date ? r.created_at : new Date(r.created_at)).toISOString(),
    updatedAt: (r.updated_at instanceof Date ? r.updated_at : new Date(r.updated_at)).toISOString(),
  };
}

/**
 * Goals with progress. Measured one goal at a time (identical windows are
 * memoised) — these are heavy aggregates, so never fan them out in parallel.
 */
export async function withProgress(rows: GoalRow[], now: Date = new Date()): Promise<Goal[]> {
  const progressOf = createProgressCalculator(now);
  const goals: Goal[] = [];
  for (const r of rows) goals.push(toGoal(r, await progressOf(r)));
  return goals;
}

const NORTH_STAR_TAKEN = 'There is already an active North Star — mark it achieved or dropped first';

function assertGoalShape(g: {
  metric: string | null;
  target: number | null;
  periodStart: string;
  periodEnd: string;
}): void {
  if (g.periodEnd < g.periodStart) {
    throw new ValidationError('The goal must end on or after its start date', { field: 'periodEnd' });
  }
  if (g.metric && (g.target === null || !(g.target > 0))) {
    throw new ValidationError('A metric goal needs a target above 0', { field: 'target' });
  }
}

export const hqGoalsService = {
  /** Progress is measured only for the returned page. */
  async list(q: ListGoalsQuery, now: Date = new Date()): Promise<GoalPage> {
    const activeOnly = q.status.every((s) => s === 'active');
    if (!activeOnly && q.before && !(await hqGoalsRepo.goalExists(q.before))) {
      throw new ValidationError('Unknown cursor — start again without `before`', { field: 'before' });
    }
    const rows = await hqGoalsRepo.listGoals({ statuses: q.status, horizon: q.horizon, limit: q.limit, before: q.before });
    const page = rows.slice(0, q.limit);
    const more = rows.length > q.limit;
    return {
      items: await withProgress(page, now),
      nextCursor: !activeOnly && more ? page[page.length - 1].id : null,
    };
  },

  async get(id: string, now: Date = new Date()): Promise<Goal> {
    const row = await hqGoalsRepo.getGoal(id);
    if (!row) throw new NotFoundError('Goal not found');
    return (await withProgress([row], now))[0];
  },

  async create(body: CreateGoalBody, userId: string | null | undefined, now: Date = new Date()): Promise<Goal> {
    const me = await hqService.actingMember(userId);
    // Defaults are anchored on the supplied start (or today): a week goal
    // starting next Monday ends next Sunday, a North Star starting in 4
    // months ends 90 days after that — never before its own start.
    const period = defaultPeriod(body.horizon, body.periodStart ?? tbilisiDate(now));
    const periodStart = body.periodStart ?? period.start;
    const periodEnd = body.periodEnd ?? period.end;
    const metric = body.metric ?? null;
    const target = metric ? body.target ?? null : null;
    assertGoalShape({ metric, target, periodStart, periodEnd });
    let id: string;
    try {
      id = await hqGoalsRepo.insertGoal({
        horizon: body.horizon,
        title: body.title,
        description: body.description ?? '',
        metric,
        target,
        manualProgress: metric ? null : body.manualProgress ?? null,
        periodStart,
        periodEnd,
        status: body.status ?? 'active',
        department: body.department ?? null,
        position: body.position ?? null,
        createdById: me.id,
        event: (goalId) => ({
          type: 'goal_created',
          memberId: me.id,
          message: `${me.name} set a ${body.horizon === 'north_star' ? 'North Star' : `${body.horizon} goal`}: "${body.title}"`,
          data: { goalId, horizon: body.horizon },
        }),
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(NORTH_STAR_TAKEN);
      throw err;
    }
    return this.get(id, now);
  },

  async update(id: string, body: UpdateGoalBody, userId: string | null | undefined, now: Date = new Date()): Promise<Goal> {
    const me = await hqService.actingMember(userId);
    const existing = await hqGoalsRepo.getGoal(id);
    if (!existing) throw new NotFoundError('Goal not found');
    const metric = body.metric !== undefined ? body.metric : existing.metric;
    const target =
      body.target !== undefined ? body.target : existing.target === null ? null : Number(existing.target);
    assertGoalShape({
      metric,
      target,
      periodStart: body.periodStart ?? existing.period_start,
      periodEnd: body.periodEnd ?? existing.period_end,
    });
    try {
      const ok = await hqGoalsRepo.updateGoal(id, {
        horizon: body.horizon,
        title: body.title,
        description: body.description,
        metric: body.metric,
        // Switching to a manual goal drops the target; a metric goal drops manual progress.
        target: body.metric === null ? null : body.target,
        manual_progress: metric ? (body.metric ? null : undefined) : body.manualProgress,
        period_start: body.periodStart,
        period_end: body.periodEnd,
        status: body.status,
        department: body.department,
        position: body.position,
      });
      if (!ok) throw new NotFoundError('Goal not found');
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError(NORTH_STAR_TAKEN);
      throw err;
    }
    const verb =
      body.status && body.status !== existing.status
        ? body.status === 'achieved' ? 'marked as achieved' : body.status === 'dropped' ? 'dropped' : 'reopened'
        : 'updated';
    await hqService.logEvent({
      type: 'goal_updated',
      memberId: me.id,
      message: `${me.name} ${verb} the goal "${body.title ?? existing.title}"`,
      data: { goalId: id, fields: Object.keys(body) },
    });
    return this.get(id, now);
  },

  async remove(id: string, userId: string | null | undefined): Promise<void> {
    const me = await hqService.actingMember(userId);
    const existing = await hqGoalsRepo.getGoal(id);
    if (!existing) throw new NotFoundError('Goal not found');
    await hqGoalsRepo.deleteGoal(id);
    await hqService.logEvent({
      type: 'goal_deleted',
      memberId: me.id,
      message: `${me.name} deleted the goal "${existing.title}"`,
      data: { goalId: id },
    });
  },
};

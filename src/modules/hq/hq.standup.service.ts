import { addDays, withProgress } from './hq.goals.service.js';
import { hqGoalsAnalyticsRepo, hqGoalsRepo } from './hq.goals.repo.js';
import { hqRepo, type MemberStatsRow, type StandupRow, type TaskRow } from './hq.repo.js';
import { DEPARTMENTS, type DepartmentKey, type Goal, type Standup, type StandupEntry, type Task } from './hq.schemas.js';
import { buildPulse, hqService, mapTask, tbilisiDate } from './hq.service.js';

// The morning standup: goals, one report per HQ agent, the ideas waiting for
// the CEO, and today-vs-yesterday KPIs — everything the /hq home page needs
// in one request.

const deptIndex = (key: string) => {
  const i = DEPARTMENTS.findIndex((d) => d.key === key);
  return i === -1 ? DEPARTMENTS.length : i;
};

const isActiveHqAgent = (m: MemberStatsRow) => m.kind === 'agent' && m.runtime === 'hq' && m.status === 'active';
const covers = (g: Goal, date: string) => g.periodStart <= date && date <= g.periodEnd;

const ref = (m: MemberStatsRow) => ({
  id: m.id,
  slug: m.slug,
  name: m.name,
  avatar: m.avatar,
  color: m.color,
  kind: m.kind,
});

/** Pure assembly of the standup payload (exported for tests). */
export function assembleStandup(input: {
  date: string;
  goals: Goal[];
  members: MemberStatsRow[];
  standups: StandupRow[];
  proposals: TaskRow[];
  working: { assignee_id: string; id: string; number: number | string; title: string }[];
  finishedYesterday: TaskRow[];
  kpis: Standup['kpis'];
}): Standup {
  const { date } = input;
  const reported = new Map(input.standups.map((s) => [s.member_id, s]));
  // Every active HQ agent, plus anyone who reported today even if paused since.
  const agents = input.members
    .filter((m) => isActiveHqAgent(m) || (m.kind === 'agent' && reported.has(m.id)))
    .sort((a, b) => deptIndex(a.department) - deptIndex(b.department) || a.name.localeCompare(b.name));

  const proposals = input.proposals.map(mapTask);
  const entries: StandupEntry[] = agents.map((m) => {
    const s = reported.get(m.id);
    const w = input.working.find((x) => x.assignee_id === m.id);
    return {
      member: { ...ref(m), title: m.title, department: m.department as DepartmentKey },
      standup: s
        ? {
            headline: s.headline,
            yesterday: s.yesterday,
            today: s.today,
            blockers: s.blockers,
            createdAt: (s.created_at instanceof Date ? s.created_at : new Date(s.created_at)).toISOString(),
          }
        : null,
      proposals: input.proposals
        .filter((p) => p.assignee_id === m.id || p.created_by_id === m.id)
        .map(mapTask),
      working: w ? { id: w.id, number: Number(w.number), title: w.title } : null,
      finishedYesterday: input.finishedYesterday.filter((t) => t.assignee_id === m.id).slice(0, 5).map(mapTask),
    };
  });

  const active = input.goals.filter((g) => g.status === 'active');
  return {
    date,
    goals: {
      northStar: active.find((g) => g.horizon === 'north_star') ?? null,
      week: active.filter((g) => g.horizon === 'week' && covers(g, date)),
      day: active.filter((g) => g.horizon === 'day' && covers(g, date)),
    },
    entries,
    waitingOn: agents.filter((m) => isActiveHqAgent(m) && !reported.has(m.id)).map(ref),
    proposals,
    kpis: input.kpis,
  };
}

/** Pulse window cap (hq.pulse/metrics_snapshot clamp days to 90). */
const MAX_PULSE_DAYS = 90;

const EMPTY_KPIS: Standup['kpis'] = {
  newUsers: { today: null, yesterday: null },
  activePlayers: { today: null, yesterday: null },
  matches: { today: null, yesterday: null },
  rating: { current: null, previous: null, lowRatings7d: null },
};

/** Picks the standup date and the day before out of a pulse series (null when absent). */
export function kpisFromSeries(
  series: { date: string; newUsers: number; matches: number; activePlayers: number }[],
  date: string
): Pick<Standup['kpis'], 'newUsers' | 'activePlayers' | 'matches'> {
  const d = series.find((e) => e.date === date);
  const y = series.find((e) => e.date === addDays(date, -1));
  return {
    newUsers: { today: d?.newUsers ?? null, yesterday: y?.newUsers ?? null },
    activePlayers: { today: d?.activePlayers ?? null, yesterday: y?.activePlayers ?? null },
    matches: { today: d?.matches ?? null, yesterday: y?.matches ?? null },
  };
}

/**
 * KPIs relative to the standup date: today = `date`, yesterday = `date - 1`.
 * Past dates read a pulse window long enough to reach them; dates in the
 * future or older than the 90-day window get nulls, never shifted numbers.
 */
async function kpisFor(date: string, now: Date): Promise<Standup['kpis']> {
  const today = tbilisiDate(now);
  if (date > today) return EMPTY_KPIS;
  const back = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const days = Math.max(14, back + 2);
  if (days > MAX_PULSE_DAYS) return EMPTY_KPIS;
  const pulse = buildPulse(await hqRepo.pulse(days), days, now);
  const series = kpisFromSeries(pulse.series, date);
  // One definition for every date (today included): 7 Tbilisi calendar days
  // ending on the standup date vs the 7 days before them.
  const [cur, prev] = await Promise.all([
    hqGoalsAnalyticsRepo.ratingSummary(addDays(date, -6), date),
    hqGoalsAnalyticsRepo.ratingSummary(addDays(date, -13), addDays(date, -7)),
  ]);
  return { ...series, rating: { current: cur.avg, previous: prev.avg, lowRatings7d: cur.low } };
}

export const hqStandupService = {
  async standup(date: string | undefined, now: Date = new Date()): Promise<Standup> {
    const day = date ?? tbilisiDate(now);
    const [goalRows, members, standups, proposals, working, finished, kpis] = await Promise.all([
      hqGoalsRepo.listGoals({ statuses: ['active'], limit: 200 }),
      hqRepo.listMembers(false),
      hqRepo.listStandups(day),
      hqRepo.listProposals(100),
      hqRepo.listWorking(),
      hqRepo.listFinishedOn(addDays(day, -1), 5),
      kpisFor(day, now),
    ]);
    const goals = await withProgress(goalRows, now);
    return assembleStandup({
      date: day,
      goals,
      members,
      standups,
      proposals,
      working,
      finishedYesterday: finished,
      kpis,
    });
  },

  /** Creates today's standup task for every active HQ agent that hasn't got one (idempotent). */
  async run(userId: string | null | undefined, now: Date = new Date()): Promise<{ created: number }> {
    const me = await hqService.actingMember(userId);
    const created = await hqRepo.createStandupTasks(tbilisiDate(now), me.id);
    if (created > 0) {
      await hqService.logEvent({
        type: 'standup_started',
        memberId: me.id,
        message: `${me.name} started the standup (${created} agent${created === 1 ? '' : 's'})`,
        data: { created },
      });
    }
    return { created };
  },
};

export type { Task };

import { config } from '../../core/config.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { hqAnalyticsService } from '../hq/hq.analytics.service.js';
import type { Analytics } from '../hq/hq.schemas.js';
import { gamesHub } from './harness.games.js';

// Reports (table harness.reports): written work by a desk agent for a
// department. The backend gathers the numbers the agent needs and queues a
// job (kind report); the harness worker writes; a person reads it in HQ.
// An agent never sends anything outside the company: a report is a draft or
// a list for a person to act on.

type Db = typeof sql;

export type ReportStatus = 'writing' | 'ready' | 'failed' | 'archived';
export type ReportDepartment = 'content' | 'games' | 'competitions' | 'marketing' | 'partners' | 'investors';

/** What an agent writes. Lists may be empty; the worker checks the shape before saving. */
export interface ReportBody {
  summary: string;
  sections: Array<{ heading: string; points: string[] }>;
  /** People or companies to approach (the scouts). */
  leads: Array<{ name: string; kind: string; where: string; why: string; source: string; reach: string }>;
  /** What the agent needs from a person to do better next time. */
  questions: string[];
}

type Games = Awaited<ReturnType<typeof gamesHub.overview>>;

interface ReportAgent {
  slug: string;
  department: ReportDepartment;
  /** The title a report carries until the agent names it. */
  title: (today: string) => string;
  /** When it is due by itself: 'week' = once per week from Monday, 'month' = once per calendar month, null = only when asked. */
  every: 'week' | 'month' | null;
  input: (sources: Sources) => Record<string, unknown>;
}

interface Sources {
  today: string;
  profile: string;
  /** 90 days, oldest first, ending today. */
  analytics: Analytics;
  games: Games;
  /** Changes to games that are asked for and not finished, so nobody proposes them twice. */
  openChanges: Array<{ game: string; title: string }>;
}

type Day = Analytics['series'][number];
const sum = (rows: Day[], pick: (d: Day) => number) => rows.reduce((n, d) => n + pick(d), 0);

/** Pure: whole days only (today is not over), as two back-to-back windows of `days`. Null when there are too few days. */
export function windows(series: Analytics['series'], days: number) {
  const whole = series.slice(0, -1);
  if (whole.length < days * 2) return null;
  const now = whole.slice(-days);
  const before = whole.slice(-days * 2, -days);
  const of = (rows: typeof whole) => ({
    from: rows[0]!.date,
    to: rows[rows.length - 1]!.date,
    newPlayers: sum(rows, (d) => d.newUsers),
    gamesPlayed: sum(rows, (d) => d.matches),
    averagePlayersPerDay: Math.round(sum(rows, (d) => d.activePlayers) / rows.length),
  });
  return { now: of(now), before: of(before) };
}

/** Pure: the numbers every desk agent may quote, cut down to what fits a prompt. */
export function traction(a: Analytics) {
  return {
    registeredPlayers: a.totals.registeredUsers,
    activeLast7Days: a.actives.wau,
    activeLast30Days: a.actives.mau,
    note: 'Active players include guests who have not registered.',
    topCountries: a.countries.slice(0, 8).map((c) => ({ country: c.country, players: c.players })),
    // Shares of registered players who came back; null = too early to say.
    // The newest eight join weeks, newest first, whatever order the source hands them in.
    retentionByJoinWeek: [...a.retention].sort((x, y) => y.cohortStart.localeCompare(x.cohortStart)).slice(0, 8).map((r) => ({ joinedWeekOf: r.cohortStart, players: r.size, nextDay: r.d1, week2: r.d7, month2: r.d30 })),
  };
}

function gamesTable(g: Games) {
  return g.games
    .filter((x) => x.state === 'on' || x.state === 'beta')
    .map((x) => ({
      name: x.name,
      kind: x.group,
      // A daily game counts players who started a day; the others count games played. Last 7 whole days against the 7 before.
      ...(x.stats.started ? { playersStarted: x.stats.started, playersFinished: x.stats.finished } : { played: x.stats.played }),
    }));
}

export const REPORT_AGENTS: ReportAgent[] = [
  {
    slug: 'growth-analyst',
    department: 'marketing',
    title: (today) => `Growth read, week to ${today}`,
    every: 'week',
    input: (s) => ({
      today: s.today,
      company: s.profile,
      last7DaysAgainstThe7Before: windows(s.analytics.series, 7),
      last30DaysAgainstThe30Before: windows(s.analytics.series, 30),
      // Whole days, oldest first.
      daily: s.analytics.series.slice(-31, -1).map((d) => ({ date: d.date, newPlayers: d.newUsers, players: d.activePlayers, games: d.matches })),
      ...traction(s.analytics),
      shareOfGamesByMode: s.analytics.modes.slice(0, 8).map((m) => ({ mode: s.analytics.modeLabels[m.mode] ?? m.mode, share: m.share })),
      games: gamesTable(s.games),
    }),
  },
  {
    slug: 'game-scout',
    department: 'games',
    title: (today) => `Games read, week to ${today}`,
    every: 'week',
    input: (s) => ({
      today: s.today,
      company: s.profile,
      // The two whole weeks the game numbers compare, as [first day, last day].
      weeks: s.games.weeks ?? null,
      games: s.games.games
        .filter((x) => x.state === 'on' || x.state === 'beta')
        .map((x) => ({
          name: x.name,
          kind: x.group,
          whatItIs: x.what,
          ...(x.stats.started ? { playersStarted: x.stats.started, playersFinished: x.stats.finished } : { played: x.stats.played }),
        })),
      // Not playable right now, so the scout does not propose changes to them.
      switchedOff: s.games.games.filter((x) => x.state !== 'on' && x.state !== 'beta').map((x) => ({ name: x.name, state: x.state })),
      changesAlreadyAskedFor: s.openChanges,
    }),
  },
  {
    slug: 'investor-update-writer',
    department: 'investors',
    title: (today) => `Investor update draft, ${monthName(today)}`,
    every: 'month',
    input: (s) => ({
      today: s.today,
      company: s.profile,
      last30DaysAgainstThe30Before: windows(s.analytics.series, 30),
      ...traction(s.analytics),
      gamesLive: s.games.games.filter((x) => x.state === 'on' || x.state === 'beta').length,
      shareOfGamesByMode: s.analytics.modes.slice(0, 6).map((m) => ({ mode: s.analytics.modeLabels[m.mode] ?? m.mode, share: m.share })),
    }),
  },
  {
    slug: 'investor-scout',
    department: 'investors',
    title: (today) => `Investors worth approaching, ${monthName(today)}`,
    every: 'month',
    input: (s) => ({ today: s.today, company: s.profile, ...traction(s.analytics) }),
  },
];

const monthName = (day: string) => new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
const tbilisiDay = (at: Date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(at);

/** Pure: the first day (Tbilisi) of the week (Monday) or month `today` is in. */
export function periodStart(today: string, every: 'week' | 'month'): string {
  if (every === 'month') return `${today.slice(0, 8)}01`;
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Pure: where a report job stands in the queue. harness.jobs.priority allows 0 (first) to 9 only. */
export const reportPriority = (by: string): number => (by === 'schedule' ? 1 : 0);

interface Row {
  id: string;
  number: number;
  agent_slug: string;
  agent_name: string | null;
  department: ReportDepartment;
  title: string;
  status: ReportStatus;
  body: ReportBody | null;
  requested_by: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
const COLUMNS = sql`r.id, r.number, r.agent_slug, a.name AS agent_name, r.department, r.title, r.status, r.body, r.requested_by, r.error, r.created_at, r.updated_at`;
const FROM = sql`harness.reports r LEFT JOIN harness.agents a ON a.slug = r.agent_slug`;

/** Pure: a report as HQ shows it. */
export function reportView(r: Row) {
  return {
    id: r.id,
    number: r.number,
    agent: r.agent_slug,
    agentName: r.agent_name ?? r.agent_slug,
    department: r.department,
    title: r.title,
    status: r.status,
    body: r.body,
    requestedBy: r.requested_by,
    error: r.error,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

async function profile(): Promise<string> {
  const [row] = await sql<Array<{ value: unknown }>>`SELECT value FROM harness.policies WHERE key = 'company.profile'`;
  return typeof row?.value === 'string' ? row.value : '';
}

async function sources(): Promise<Sources> {
  // One after the other: both are heavy reads on the same small pool.
  const analytics = await hqAnalyticsService.analytics(90);
  const games = await gamesHub.overview();
  const changes = await sql<Array<{ game_key: string; title: string }>>`
    SELECT game_key, title FROM harness.game_changes WHERE status IN ('suggested', 'planning', 'planned', 'building', 'ready') ORDER BY created_at DESC LIMIT 40`;
  const nameOf = new Map(games.games.map((g) => [g.key, g.name]));
  return { today: tbilisiDay(), profile: await profile(), analytics, games, openChanges: changes.map((c) => ({ game: nameOf.get(c.game_key) ?? c.game_key, title: c.title })) };
}

/** Whether a scheduled report is still owed for the period starting `since`. A failed one is tried again, but once a day. */
async function owed(db: Db, slug: string, since: string, today: string): Promise<boolean> {
  const [have] = await db<Array<{ id: string }>>`
    SELECT id FROM harness.reports
     WHERE agent_slug = ${slug}
       AND ((status <> 'failed' AND (created_at AT TIME ZONE 'Asia/Tbilisi')::date >= ${since}::date)
         OR (status = 'failed' AND (created_at AT TIME ZONE 'Asia/Tbilisi')::date = ${today}::date))
     LIMIT 1`;
  return !have;
}

/** Starts a report. `due`: a scheduled start, checked again under the agent's lock so two servers never both start it; null when it is no longer owed. */
async function start(agent: ReportAgent, by: string, s: Sources, due?: { since: string; today: string }) {
  return sql.begin(async (t) => {
    const tx = t as unknown as Db;
    // One start per agent at a time, across every server.
    await tx`SELECT pg_advisory_xact_lock(hashtext('harness_report'), hashtext(${agent.slug}))`;
    if (due && !(await owed(tx, agent.slug, due.since, due.today))) return null;
    // The agent must exist and be switched on: a paused agent writes nothing.
    const [a] = await tx<Array<{ status: string }>>`SELECT status FROM harness.agents WHERE slug = ${agent.slug}`;
    if (!a) throw new NotFoundError('That agent is not set up.');
    if (a.status !== 'active') throw new ConflictError('That agent is paused.');
    const [row] = await tx<Array<{ id: string; number: number }>>`
      INSERT INTO harness.reports (agent_slug, department, title, requested_by)
      VALUES (${agent.slug}, ${agent.department}, ${agent.title(s.today)}, ${by})
      ON CONFLICT (agent_slug) WHERE status = 'writing' DO NOTHING
      RETURNING id, number`;
    if (!row) throw new ConflictError('It is already writing one. It will be here in a few minutes.');
    // Ahead of the content queue (0 is first, 9 last): a person is waiting to read it, and a scheduled one is one job a week.
    await tx`INSERT INTO harness.jobs (kind, agent_slug, report_id, priority, input) VALUES ('report', ${agent.slug}, ${row.id}, ${reportPriority(by)}, ${sql.json(agent.input(s) as never)})`;
    await tx`INSERT INTO harness.events (type, level, message) VALUES ('report', 'info', ${`Report ${row.number} started (${agent.slug}), asked by ${by}`.slice(0, 1000)})`;
    const [full] = await tx<Row[]>`SELECT ${COLUMNS} FROM ${FROM} WHERE r.id = ${row.id}`;
    return reportView(full!);
  });
}

export const reports = {
  /** The newest reports that were not put away, and which agents can be asked for one. */
  async list() {
    const rows = await sql<Row[]>`SELECT ${COLUMNS} FROM ${FROM} WHERE r.status <> 'archived' ORDER BY r.created_at DESC LIMIT 60`;
    return { items: rows.map(reportView), agents: REPORT_AGENTS.map((a) => ({ slug: a.slug, department: a.department, every: a.every })), profile: await profile() };
  },

  /** A person asks an agent for a report now. */
  async create(slug: string, by: string) {
    const agent = REPORT_AGENTS.find((a) => a.slug === slug);
    if (!agent) throw new ValidationError('That agent does not write reports.');
    return (await start(agent, by, await sources()))!;
  },

  /** A person puts a finished or failed report away. */
  async archive(id: string, by: string) {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const [row] = await tx<Array<{ number: number; status: ReportStatus }>>`SELECT number, status FROM harness.reports WHERE id = ${id} FOR UPDATE`;
      if (!row) throw new NotFoundError('That report no longer exists.');
      if (row.status === 'writing') throw new ConflictError('It is still being written.');
      await tx`UPDATE harness.reports SET status = 'archived', updated_at = now() WHERE id = ${id}`;
      await tx`INSERT INTO harness.events (type, level, message) VALUES ('report', 'info', ${`Report ${row.number} put away by ${by}`})`;
      return { id, status: 'archived' as const };
    });
  },

  /** Starts every report that is due and not written yet this week or month. */
  async runDue(now: Date = new Date()): Promise<string[]> {
    const today = tbilisiDay(now);
    const started: string[] = [];
    let s: Sources | undefined;
    for (const agent of REPORT_AGENTS) {
      if (!agent.every) continue;
      const since = periodStart(today, agent.every);
      // A cheap look first; the real check is made again under the agent's lock when it starts.
      if (!(await owed(sql, agent.slug, since, today))) continue;
      try {
        s ??= await sources();
        if (await start(agent, 'schedule', s, { since, today })) started.push(agent.slug);
      } catch (err) {
        // Paused, already writing, or the numbers could not be read: the next round tries again.
        logger.warn({ err, agent: agent.slug }, 'Report not started');
      }
    }
    return started;
  },
};

// ── background loop ────────────────────────────────────────────────────────

const TICK_MS = 30 * 60_000;
let timer: ReturnType<typeof setInterval> | undefined;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    // Paused means the agents do nothing.
    const [settings] = await sql<Array<{ paused: boolean }>>`SELECT paused FROM harness.settings WHERE id`;
    if (!settings || settings.paused) return;
    await reports.runDue();
  } catch (err) {
    logger.warn({ err }, 'Reports tick skipped');
  } finally {
    running = false;
  }
}

/** Starts the reports that are due by themselves. Production only: staging has no real numbers to write about. */
export function startReportsLoop(): void {
  if (timer || config.NODE_ENV !== 'prod') return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  // Not at once: a restart should not race the first requests for the same heavy numbers.
  setTimeout(() => void tick(), 5 * 60_000).unref();
}

export function stopReportsLoop(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

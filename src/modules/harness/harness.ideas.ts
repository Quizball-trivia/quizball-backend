import { ConflictError, NotFoundError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { sql } from '../../db/index.js';
import { hqAnalyticsService } from '../hq/hq.analytics.service.js';
import { harnessRepo } from './harness.repo.js';
import { periodStart } from './harness.reports.js';
import { dailyRunway } from './harness.runway.js';
import { MARKETS, MARKET_NAMES, type CreateIdeaBody, type MarketOrAll } from './harness.schemas.js';

// Ideas (table harness.ideas): one thing worth doing in the content. The Market
// Scout suggests them (job kind idea_scout); a person writes their own, which
// the HQ Assistant turns into a plan (job kind idea_plan). Nothing happens
// until a person accepts: accepting runs the idea's actions through the same
// checks as the Content tab's buttons. A refusal and its reason are shown to
// the scout on its next round.

type Db = typeof sql;

export type IdeaStatus = 'planning' | 'open' | 'accepted' | 'refused' | 'failed';

export interface IdeaRow {
  id: string;
  number: number;
  source: 'person' | 'agent';
  agent_slug: string | null;
  agent_name: string | null;
  created_by: string | null;
  market: MarketOrAll;
  kind: string;
  title: string;
  detail: string;
  source_url: string | null;
  status: IdeaStatus;
  plan: string | null;
  actions: unknown;
  applied: unknown;
  decided_by: string | null;
  refuse_reason: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}
const COLUMNS = sql`i.id, i.number, i.source, i.agent_slug, a.name AS agent_name, i.created_by, i.market, i.kind, i.title, i.detail, i.source_url, i.status, i.plan, i.actions, i.applied, i.decided_by, i.refuse_reason, i.error, i.created_at, i.updated_at`;
const FROM = sql`harness.ideas i LEFT JOIN harness.agents a ON a.slug = i.agent_slug`;

/** The scout stops adding to a pile nobody is reading. */
export const MAX_WAITING_AGENT_IDEAS = 15;

/** Pure: a short name for a person's idea, cut at a word. */
export function ideaTitle(text: string): string {
  const line = text.trim().split(/\n/)[0]!.trim().replace(/\s+/g, ' ');
  const chars = [...line];
  if (chars.length <= 120) return chars.length >= 3 ? line : text.trim().slice(0, 120);
  const cut = chars.slice(0, 117).join('');
  const at = cut.lastIndexOf(' ');
  return `${at > 60 ? cut.slice(0, at) : cut}…`;
}

/** Pure: an idea as HQ shows it. `describe` puts one action into plain words. */
export function ideaView<A>(r: IdeaRow, describe: (action: unknown) => A) {
  return {
    id: r.id,
    number: r.number,
    source: r.source,
    agent: r.agent_slug,
    agentName: r.agent_name ?? r.agent_slug,
    createdBy: r.created_by,
    market: r.market,
    kind: r.kind,
    title: r.title,
    detail: r.detail,
    sourceUrl: r.source_url,
    status: r.status,
    plan: r.plan,
    actions: (Array.isArray(r.actions) ? r.actions : []).map(describe),
    applied: Array.isArray(r.applied) ? r.applied : [],
    decidedBy: r.decided_by,
    refuseReason: r.refuse_reason,
    error: r.error,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

const tbilisiDay = (at: Date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tbilisi' }).format(at);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Pure: how many ideas one scouting round may bring. One market: a handful for it. Every market: a couple each. */
export const scoutLimits = (focus: MarketOrAll) => (focus === 'all' ? { perMarket: 2, forEveryone: 3, total: 12 } : { perMarket: 5, forEveryone: 0, total: 5 });

/** What an agent is told about the content before it suggests or plans anything. */
async function context(withPlayers: boolean) {
  const cap = await harnessRepo.classicCap();
  const [health, steering, markets, active, events, requests, proposals, runway, known] = await Promise.all([
    harnessRepo.classicHealth(cap),
    harnessRepo.steering(),
    harnessRepo.categoryMarkets(),
    harnessRepo.activeCategories(),
    harnessRepo.contentEvents(),
    harnessRepo.requests(),
    harnessRepo.proposals(),
    dailyRunway(),
    sql<Array<{ market: string; title: string; status: IdeaStatus; refuse_reason: string | null }>>`
      SELECT market, title, status, refuse_reason FROM harness.ideas
       WHERE status IN ('open', 'planning') OR updated_at > now() - interval '60 days'
       ORDER BY updated_at DESC LIMIT 120`,
  ]);
  const marketOf = new Map(markets.map((m) => [m.category_id, m.market]));
  const steer = new Map(steering.map((s) => [s.category_id, s]));
  const healthOf = new Map(health.map((h) => [h.category_id, h]));
  const nameOf = new Map(active.map((c) => [c.id, c.name]));
  const filling = proposals.filter((p) => p.status === 'filling' && p.category_id);
  for (const p of filling) nameOf.set(p.category_id!, p.name);
  const today = tbilisiDay();
  // Only countries, and only for the scout: the analytics read is heavy.
  const countries = withPlayers ? (await hqAnalyticsService.analytics(30)).countries.slice(0, 15).map((c) => ({ country: c.country, players: c.players })) : undefined;
  return {
    today,
    markets: MARKETS.map((m) => ({ key: m, name: MARKET_NAMES[m] })),
    note: 'A category made for a market is still shown to players everywhere: the game does not filter by country yet. "all" means for everyone.',
    // Every category in the game. shortInRanked = questions missing in ranked matches for how much it is played.
    categories: active.map((c) => ({
      id: c.id,
      name: c.name,
      market: marketOf.get(c.id) ?? 'all',
      questionsInRanked: num(healthOf.get(c.id)?.pool),
      shortInRanked: num(healthOf.get(c.id)?.shortage),
      playedLast30Days: num(healthOf.get(c.id)?.views_30d),
      priority: steer.get(c.id)?.priority ?? 'normal',
    })),
    // New categories still being filled: hidden from players until a person puts them live.
    newCategoriesBeingFilled: filling.map((p) => ({ id: p.category_id!, name: p.name, market: marketOf.get(p.category_id!) ?? 'all', ready: num(p.live), target: p.target })),
    openOrders: requests.filter((r) => r.status === 'open').map((r) => ({ category: r.category_id ? (nameOf.get(r.category_id) ?? '?') : '?', topic: r.topic ?? '', count: r.count, deadline: r.deadline })),
    upcomingEvents: events.filter((e) => e.status === 'open' && e.happens_on >= today).map((e) => ({ title: e.title, happensOn: e.happens_on, market: e.market })),
    // Days of content each daily game has left. Daily games are built by hand today: an idea here is of kind "other".
    dailyGames: runway.map((r) => ({ game: r.label, daysLeft: r.daysLeft })),
    ...(countries ? { playersByCountryLast30Days: countries } : {}),
    ideasWaitingForAnAnswer: known.filter((k) => k.status === 'open' || k.status === 'planning').map((k) => ({ market: k.market, title: k.title })),
    ideasAcceptedLately: known.filter((k) => k.status === 'accepted').slice(0, 30).map((k) => ({ market: k.market, title: k.title })),
    // Read these before suggesting: the team said no, and often why.
    ideasRefusedLately: known.filter((k) => k.status === 'refused').slice(0, 30).map((k) => ({ market: k.market, title: k.title, reason: k.refuse_reason || null })),
  };
}

async function agentOn(db: Db, slug: string, what: string): Promise<void> {
  const [a] = await db<Array<{ status: string }>>`SELECT status FROM harness.agents WHERE slug = ${slug}`;
  if (!a) throw new NotFoundError(`${what} is not set up.`);
  if (a.status !== 'active') throw new ConflictError(`${what} is paused.`);
}

/** Whether the weekly scouting round is still owed for the week starting `since`. A failed one is tried again, but once a day. */
async function owed(db: Db, since: string, today: string): Promise<boolean> {
  const [have] = await db<Array<{ id: string }>>`
    SELECT id FROM harness.jobs
     WHERE kind = 'idea_scout' AND input->>'by' = 'schedule'
       AND ((status <> 'failed' AND (created_at AT TIME ZONE 'Asia/Tbilisi')::date >= ${since}::date)
         OR (status = 'failed' AND (created_at AT TIME ZONE 'Asia/Tbilisi')::date = ${today}::date))
     LIMIT 1`;
  return !have;
}

export const ideas = {
  /** Every idea still waiting, and the ones decided in the last two weeks. */
  async rows(): Promise<IdeaRow[]> {
    return sql<IdeaRow[]>`
      SELECT ${COLUMNS} FROM ${FROM}
       WHERE i.status IN ('open', 'planning', 'failed') OR i.updated_at > now() - interval '14 days'
       ORDER BY i.created_at DESC LIMIT 120`;
  },

  /** Whether the scout is looking for ideas right now. */
  async scouting(): Promise<{ market: string } | null> {
    const [j] = await sql<Array<{ market: string | null }>>`SELECT input->>'focus' AS market FROM harness.jobs WHERE kind = 'idea_scout' AND status IN ('queued', 'running') LIMIT 1`;
    return j ? { market: j.market ?? 'all' } : null;
  },

  /** A person's own idea: saved, and handed to the HQ Assistant for a plan. */
  async create(body: CreateIdeaBody, by: string) {
    const input = { idea: { text: body.text, market: body.market, kind: body.kind }, ...(await context(false)) };
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      await agentOn(tx, 'hq-assistant', 'The HQ Assistant');
      const [row] = await tx<Array<{ id: string; number: number }>>`
        INSERT INTO harness.ideas (source, created_by, market, kind, title, detail, status)
        VALUES ('person', ${by}, ${body.market}, ${body.kind}, ${ideaTitle(body.text)}, ${body.text}, 'planning')
        RETURNING id, number`;
      await tx`INSERT INTO harness.jobs (kind, agent_slug, idea_id, priority, input) VALUES ('idea_plan', 'hq-assistant', ${row!.id}, 0, ${sql.json(input as never)})`;
      await tx`INSERT INTO harness.events (type, level, message) VALUES ('idea', 'info', ${`Idea ${row!.number} from ${by}: the HQ Assistant is planning it`.slice(0, 1000)})`;
      return { id: row!.id, number: row!.number, status: 'planning' as const };
    });
  },

  /** Asks the Market Scout for ideas now: for one market, or for all of them. `due`: a scheduled start, checked again under the lock. */
  async scout(focus: MarketOrAll, by: string, due?: { since: string; today: string }) {
    const input = { by, focus, limits: scoutLimits(focus), ...(await context(true)) };
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      // One start at a time, across every server.
      await tx`SELECT pg_advisory_xact_lock(hashtext('harness_idea_scout'), 0)`;
      if (due && !(await owed(tx, due.since, due.today))) return null;
      await agentOn(tx, 'market-scout', 'The Market Scout');
      const rows = await tx<Array<{ id: string }>>`
        INSERT INTO harness.jobs (kind, agent_slug, priority, input) VALUES ('idea_scout', 'market-scout', ${by === 'schedule' ? 1 : 0}, ${sql.json(input as never)})
        ON CONFLICT (kind) WHERE kind = 'idea_scout' AND status IN ('queued', 'running') DO NOTHING
        RETURNING id`;
      if (!rows.length) throw new ConflictError('The scout is already looking. Its ideas will be here in a few minutes.');
      await tx`INSERT INTO harness.events (type, level, message) VALUES ('idea', 'info', ${`The Market Scout is looking for ideas (${focus === 'all' ? 'every market' : MARKET_NAMES[focus]}), asked by ${by}`.slice(0, 1000)})`;
      return { started: true as const, market: focus };
    });
  },

  /** Takes an open idea for accepting: one person, once. */
  async claim(id: string, by: string) {
    const [row] = await sql<Array<{ number: number; market: MarketOrAll; actions: unknown }>>`
      UPDATE harness.ideas SET status = 'accepted', decided_by = ${by}, updated_at = now() WHERE id = ${id} AND status = 'open' RETURNING number, market, actions`;
    return row ?? null;
  },

  async recordApplied(id: string, applied: unknown) {
    await sql`UPDATE harness.ideas SET applied = ${sql.json(applied as never)}, updated_at = now() WHERE id = ${id}`;
  },

  /** A person says no (or withdraws their own idea while it is still being planned). */
  async refuse(id: string, reason: string, by: string): Promise<boolean> {
    return sql.begin(async (t) => {
      const tx = t as unknown as Db;
      const rows = await tx<Array<{ number: number }>>`
        UPDATE harness.ideas SET status = 'refused', decided_by = ${by}, refuse_reason = ${reason || null}, updated_at = now()
         WHERE id = ${id} AND status IN ('open', 'planning', 'failed') RETURNING number`;
      if (rows.length !== 1) return false;
      // A plan still waiting in the queue is not needed any more; one already running writes nothing (the idea is no longer being planned).
      await tx`UPDATE harness.jobs SET status = 'cancelled', finished_at = now(), lease_owner = NULL, lease_token = NULL, lease_until = NULL WHERE idea_id = ${id} AND status = 'queued'`;
      await tx`INSERT INTO harness.events (type, level, message) VALUES ('idea', 'info', ${`Idea ${rows[0]!.number} refused by ${by}${reason ? `: ${reason}` : ''}`.slice(0, 1000)})`;
      return true;
    });
  },

  /** Starts the weekly scouting round (from Monday) when it is due and the team is keeping up with the ideas. */
  async runDue(now: Date = new Date()): Promise<boolean> {
    const today = tbilisiDay(now);
    const since = periodStart(today, 'week');
    if (!(await owed(sql, since, today))) return false;
    const [waiting] = await sql<Array<{ n: string }>>`SELECT count(*) AS n FROM harness.ideas WHERE source = 'agent' AND status = 'open'`;
    if (num(waiting?.n) >= MAX_WAITING_AGENT_IDEAS) return false;
    try {
      return (await this.scout('all', 'schedule', { since, today })) !== null;
    } catch (err) {
      // Paused, already looking, or the numbers could not be read: the next round tries again.
      logger.warn({ err }, 'Scouting round not started');
      return false;
    }
  },
};

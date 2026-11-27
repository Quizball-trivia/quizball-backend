import { config } from '../../core/config.js';
import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { ttlCache } from '../hq/hq.cache.js';
import { hqService, requireFounder } from '../hq/hq.service.js';
import { harnessRepo } from './harness.repo.js';
import { invalidateCategoryCache } from '../lobbies/lobbies.service.js';
import { dailyRunway } from './harness.runway.js';
import { gameChanges } from './harness.game-changes.js';
import { ideas, ideaView } from './harness.ideas.js';
import { reports } from './harness.reports.js';
import { showPacks } from './harness.show.js';
import {
  askActionSchema,
  EDITABLE_POLICIES,
  ideaActionSchema,
  MARKETS,
  MARKET_NAMES,
  type CreateEventBody,
  type CreateIdeaBody,
  type MarketOrAll,
  type CreateGameChangeBody,
  type CreateProposalBody,
  type CreateRequestBody,
  type ItemActionBody,
  type PolicyKeyParam,
  type SetSteeringBody,
  type SwapShowQuestionBody,
  type UpdateHarnessSettingsBody,
} from './harness.schemas.js';

// CMS Content tab: what the agent harness is doing, plus the owners' controls
// (pause switch, run caps, policies). Everything else is decided by the
// harness itself.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

// classic_health scans 30 days of ranked match questions: reuse it for a minute.
// Fourteen small max(day) reads: reuse them for five minutes.
const runwayCache = ttlCache<string, Awaited<ReturnType<typeof dailyRunway>>>(300_000);
const healthCache = ttlCache<number, Awaited<ReturnType<typeof harnessRepo.classicHealth>>>(60_000);

type Member = Awaited<ReturnType<typeof hqService.actingMember>>;

/** Steering the content is for the people on the team; agents and archived members cannot. */
async function steeringMember(userId: string | null | undefined, what: string): Promise<Member> {
  const me = await hqService.actingMember(userId);
  if (me.kind !== 'human' || me.status !== 'active') throw new AuthorizationError(`Only active team members can ${what}.`);
  return me;
}
/** A real YYYY-MM-DD day: 2026-02-30 is not one, though Date.parse would roll it into March. */
const isCalendarDate = (d: string) => {
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};
/** An Assistant proposal as the CMS shows it: the raw action plus one line in plain words. */
function describeAction(raw: unknown, catName: (id: string | null) => string | null) {
  const parsed = ideaActionSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, summary: 'An action that could not be read', action: raw };
  const a = parsed.data;
  const cat = (id: string | null) => (id ? (catName(id) as string) : 'every category');
  const summary =
    a.type === 'category'
      ? `Start a new category: ${a.name} (${a.target} questions first, hidden from players until you put it live)`
      : a.type === 'priority'
      ? `${a.priority === 'boost' ? 'Boost' : a.priority === 'hold' ? 'Hold' : 'Set to normal'}: ${cat(a.categoryId)}`
      : a.type === 'direction'
        ? a.text
          ? `Direction for ${cat(a.categoryId)}: “${a.text}”`
          : `Remove the direction for ${cat(a.categoryId)}`
        : a.type === 'order'
          ? `Order ${a.count} ${a.difficulty} questions for ${cat(a.categoryId)}: ${a.topic}${a.deadline ? ` (by ${a.deadline})` : ''}`
          : `Event ${a.title} on ${a.happensOn}: ${a.perCategory} questions each for ${a.categoryIds.map((c) => cat(c)).join(', ')}`;
  return { valid: true, summary, action: a };
}

const who = (me: Member) => me.name || 'a team member';

/** A question as the CMS shows it: every language, options with the right one marked. */
function questionView(payload: unknown) {
  const p = (payload ?? {}) as { prompt?: Record<string, string>; options?: Array<{ text?: Record<string, string>; is_correct?: boolean }>; explanation?: Record<string, string> };
  return {
    prompt: p.prompt ?? {},
    options: (p.options ?? []).map((o) => ({ text: o.text ?? {}, correct: o.is_correct === true })),
    explanation: p.explanation ?? {},
  };
}
const issuesView = (v: unknown) =>
  (Array.isArray(v) ? v : []).map((i: any) => String(i?.problem ?? i?.message ?? i ?? '')).filter(Boolean).slice(0, 6);

export const harnessService = {
  async overview() {
    const cap = await harnessRepo.classicCap();
    const [settings, accounts, agents, health, stages, jobs, runs, events, policies, today, steering, live7d, liveToday, needsYou, recentLive, requests, activeCategories, contentEvents, proposals, asks, runway, show, queue] = await Promise.all([
      harnessRepo.settings(),
      harnessRepo.accounts(),
      harnessRepo.agents(),
      healthCache.get(cap, () => harnessRepo.classicHealth(cap)),
      harnessRepo.stageCounts(),
      harnessRepo.jobCounts(),
      harnessRepo.recentRuns(),
      harnessRepo.recentEvents(),
      harnessRepo.policies(),
      harnessRepo.todayTotals(),
      harnessRepo.steering(),
      harnessRepo.liveLast7d(),
      harnessRepo.liveToday(),
      harnessRepo.needsYou(),
      harnessRepo.recentLive(),
      harnessRepo.requests(),
      harnessRepo.activeCategories(),
      harnessRepo.contentEvents(),
      harnessRepo.proposals(),
      harnessRepo.asks(),
      runwayCache.get('daily', () => dailyRunway()),
      showPacks.state(),
      harnessRepo.queueNow(),
    ]);
    // After the batch above, not inside it: the database lets only so many reads of one request wait at once
    // (12 running, 12 queued), and that batch is already close to it.
    const [markets, ideaRows, scouting] = await Promise.all([harnessRepo.categoryMarkets(), ideas.rows(), ideas.scouting()]);
    const marketOf = new Map(markets.map((m) => [m.category_id, m.market as MarketOrAll]));
    const marketOnly = new Set(markets.filter((m) => m.market_only).map((m) => m.category_id));
    const steer = new Map(steering.map((r) => [r.category_id, r]));
    const rate = new Map(live7d.map((r) => [r.category_id, num(r.n)]));
    const ids = new Set<string>(health.map((h) => h.category_id));
    for (const r of [...needsYou, ...recentLive, ...requests, ...events]) if (r.category_id) ids.add(r.category_id);
    for (const e of contentEvents) for (const c of e.category_ids) ids.add(c);
    // Ask HQ proposals can name a hidden category (a new one still filling): look those up too.
    for (const a of asks)
      for (const x of Array.isArray(a.actions) ? a.actions : []) {
        const p = askActionSchema.safeParse(x);
        if (!p.success) continue;
        for (const c of p.data.type === 'event' ? p.data.categoryIds : p.data.categoryId ? [p.data.categoryId] : []) ids.add(c);
      }
    for (const i of ideaRows)
      for (const x of Array.isArray(i.actions) ? i.actions : []) {
        const p = ideaActionSchema.safeParse(x);
        if (!p.success || p.data.type === 'category') continue;
        for (const c of p.data.type === 'event' ? p.data.categoryIds : p.data.categoryId ? [p.data.categoryId] : []) ids.add(c);
      }
    // Every active category is named, so Ask HQ proposals for any of them read right.
    const names = new Map<string, string>(activeCategories.map((c) => [c.id, c.name]));
    for (const c of await harnessRepo.categoryNames([...ids].filter((id) => !names.has(id)))) names.set(c.id, c.name ?? '');
    const slugOf = new Map(health.map((h) => [h.category_id, h.slug]));
    const catName = (id: string | null) => (id ? names.get(id) || slugOf.get(id) || 'Unknown category' : null);
    const categories = health.map((h) => ({
      categoryId: h.category_id,
      slug: h.slug,
      views30d: num(h.views_30d),
      pool: num(h.pool),
      inPipeline: num(h.in_pipeline),
      needed: num(h.needed),
      shortage: num(h.shortage),
      name: catName(h.category_id) ?? h.slug,
      priority: (steer.get(h.category_id)?.priority ?? 'normal') as 'boost' | 'normal' | 'hold',
      direction: steer.get(h.category_id)?.direction ?? '',
      liveLast7d: rate.get(h.category_id) ?? 0,
      /** Its home market; 'all' = for all markets. Players in the home market are offered it more often. */
      market: marketOf.get(h.category_id) ?? 'all',
      /** true = only players in the home market are offered it. */
      marketOnly: marketOnly.has(h.category_id),
    }));
    const directionPolicy = policies.find((p) => p.key === 'content.direction');
    return {
      settings: {
        paused: settings.paused,
        pausedReason: settings.paused_reason,
        maxConcurrentRuns: settings.max_concurrent_runs,
        dailyRunLimit: settings.daily_run_limit,
        updatedAt: iso(settings.updated_at),
      },
      today: { runs: num(today?.runs), costCents: num(today?.cost_cents), failed: num(today?.failed), live: liveToday },
      /** Days of content left per daily game, shortest first. */
      runway,
      /** The next ორშაბათობა show night and the pack prepared for it. */
      show,
      direction: typeof directionPolicy?.value === 'string' ? directionPolicy.value : '',
      /** Every active category, for ordering questions (also ones with no ranked play yet). */
      allCategories: activeCategories.map((c) => ({ id: c.id, name: c.name, market: marketOf.get(c.id) ?? 'all', marketOnly: marketOnly.has(c.id) })),
      /** The game's markets. A player's market comes from their country. */
      markets: MARKETS.map((m) => ({ key: m, name: MARKET_NAMES[m] })),
      ideas: ideaRows.map((r) => ideaView(r, (x) => describeAction(x, catName))),
      /** Set while the Market Scout is looking for ideas. */
      scouting,
      contentEvents: contentEvents.map((e) => ({
        id: e.id,
        title: e.title,
        happensOn: e.happens_on,
        notes: e.notes,
        categories: e.category_ids.map((c) => catName(c) ?? 'Unknown category'),
        perCategory: e.per_category,
        difficulty: e.difficulty,
        status: e.status,
        market: e.market as MarketOrAll,
        createdBy: e.created_by,
        live: num(e.live),
        working: num(e.working),
        dropped: num(e.dropped),
      })),
      proposals: proposals.map((p) => ({
        id: p.id,
        name: p.name,
        why: p.why,
        target: p.target,
        status: p.status,
        market: (p.category_id ? marketOf.get(p.category_id) : undefined) ?? 'all',
        proposedBy: p.proposed_by,
        inGame: p.is_active === true,
        live: num(p.live),
        working: num(p.working),
        putInOrder: num(p.put_in_order),
        clueChain: num(p.clue_chain),
        /** False in MCQ-only seasons, when ranked doesn't need the special types. */
        specialsRequired: !config.POSSESSION_MCQ_ONLY,
        createdAt: iso(p.created_at),
      })),
      asks: asks.map((a) => ({
        id: a.id,
        message: a.message,
        askedBy: a.asked_by,
        status: a.status,
        reply: a.reply,
        actions: (Array.isArray(a.actions) ? a.actions : []).map((x) => describeAction(x, catName)),
        applied: Array.isArray(a.applied) ? a.applied : [],
        error: a.error,
        appliedBy: a.applied_by,
        createdAt: iso(a.created_at),
      })),
      needsYou: needsYou.map((i) => ({
        id: i.id,
        version: i.version,
        category: catName(i.category_id),
        difficulty: i.difficulty,
        question: questionView(i.payload),
        issues: issuesView(i.last_issues),
        updatedAt: iso(i.updated_at),
      })),
      recentLive: recentLive.map((i) => ({
        id: i.id,
        version: i.version,
        category: catName(i.category_id),
        difficulty: i.difficulty,
        question: questionView(i.payload),
        questionId: i.question_id,
        releasedAt: iso(i.released_at),
      })),
      requests: requests.map((r) => ({
        id: r.id,
        category: catName(r.category_id),
        difficulty: r.difficulty,
        count: r.count,
        topic: r.topic ?? '',
        deadline: r.deadline,
        requestedBy: r.requested_by,
        status: r.status,
        market: (r.category_id ? marketOf.get(r.category_id) : undefined) ?? 'all',
        live: num(r.live),
        working: num(r.working),
        dropped: num(r.dropped),
        createdAt: iso(r.created_at),
      })),
      classic: {
        viewCap: cap,
        shortCategories: categories.filter((c) => c.shortage > 0).length,
        totalShortage: categories.reduce((s, c) => s + c.shortage, 0),
        categories,
      },
      stages: stages.map((s) => ({ mode: s.mode, stage: s.stage, count: num(s.n) })),
      jobs: jobs.map((j) => ({ kind: j.kind, status: j.status, count: num(j.n) })),
      accounts: accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        label: a.label,
        secretRef: a.secret_ref,
        status: a.status,
        reservedForPeople: a.reserved_for_people,
        softPct: a.soft_pct,
        state: a.state,
        blockedUntil: iso(a.blocked_until),
        windows: a.windows,
        lastError: a.last_error,
        /** Runs this seat takes at once, and how many it is running now. */
        maxParallel: a.max_parallel,
        running: num(a.running),
        runsToday: num(a.runs_today),
      })),
      /** The queue right now, so the page can say why agents are quiet. */
      queue: {
        running: accounts.reduce((n, a) => n + num(a.running), 0),
        ready: num(queue.ready),
        waiting: num(queue.waiting),
        nextAt: iso(queue.next_at),
        dailyLimitReached: num(queue.claims_today) >= settings.daily_run_limit,
      },
      agents: agents.map((a) => ({
        slug: a.slug,
        name: a.name,
        team: a.team,
        description: a.description,
        provider: a.provider,
        model: a.model,
        effort: a.effort,
        primaryAccount: a.primary_account,
        fallbackAccounts: a.fallback_accounts,
        /** A second AI the agent overflows to when its own seats are busy or at their limit. */
        altProvider: a.alt_provider,
        altModel: a.alt_model,
        status: a.status,
        runsToday: num(a.runs_today),
        costCentsToday: num(a.cost_cents_today),
        lastRunAt: iso(a.last_run_at),
      })),
      runs: runs.map((r) => ({
        id: r.id,
        agent: r.agent_slug,
        account: r.account_id,
        model: r.model,
        status: r.status,
        tokensIn: r.tokens_in,
        tokensOut: r.tokens_out,
        costCents: r.cost_cents,
        error: r.error,
        startedAt: iso(r.started_at),
        endedAt: iso(r.ended_at),
      })),
      events: events.map((e) => ({
        id: String(e.id),
        type: e.type,
        level: e.level,
        message: e.message,
        itemId: e.item_id,
        category: catName(e.category_id),
        prompt: e.prompt,
        createdAt: iso(e.created_at),
      })),
      policies: policies.map((p) => ({ key: p.key, value: p.value, note: p.note, editable: p.key in EDITABLE_POLICIES, updatedAt: iso(p.updated_at) })),
    };
  },

  async updateSettings(body: UpdateHarnessSettingsBody, userId: string | null | undefined) {
    const me = await hqService.actingMember(userId);
    requireFounder(me, 'change the harness settings');
    const row = await harnessRepo.updateSettings({
      paused: body.paused,
      paused_reason: body.pausedReason,
      max_concurrent_runs: body.maxConcurrentRuns,
      daily_run_limit: body.dailyRunLimit,
    });
    return { paused: row.paused, pausedReason: row.paused_reason, maxConcurrentRuns: row.max_concurrent_runs, dailyRunLimit: row.daily_run_limit, updatedAt: iso(row.updated_at) };
  },

  async setPolicy(key: PolicyKeyParam['key'], value: unknown, userId: string | null | undefined) {
    const me = await hqService.actingMember(userId);
    requireFounder(me, 'change harness policies');
    const parsed = EDITABLE_POLICIES[key].safeParse(value);
    if (!parsed.success) throw new ValidationError(`Invalid value for ${key}`, { field: 'value' });
    const ok = await harnessRepo.setPolicy(key, parsed.data);
    if (!ok) throw new ValidationError(`Unknown policy ${key}`, { field: 'key' });
    return { key, value: parsed.data };
  },

  // ── steering ──

  async setSteering(categoryId: string, body: SetSteeringBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'steer the content');
    if (!(await harnessRepo.categoryExists(categoryId))) throw new NotFoundError('Category not found');
    let scope: { market: MarketOrAll; marketOnly: boolean } | undefined;
    if (body.market !== undefined || body.marketOnly !== undefined) {
      const set = await harnessRepo.setCategoryMarket(categoryId, { market: body.market, only: body.marketOnly });
      if (!set) throw new ValidationError('Pick a market first: a category for all markets cannot be market-only', { field: 'marketOnly' });
      const market = (set.market ?? 'all') as MarketOrAll;
      const marketOnly = set.market_only;
      // The match pools cache each category's market fields.
      invalidateCategoryCache();
      // The activity line is a courtesy: the change is saved, so a failed note must not fail the request or stop the rest of it.
      await harnessRepo
        .note('steering', `${who(me)} set a category's market: ${market === 'all' ? 'all markets' : `${MARKET_NAMES[market]}${marketOnly ? ' only' : ' (home market)'}`}`)
        .catch(() => undefined);
      scope = { market, marketOnly };
    }
    if (body.priority === undefined && body.direction === undefined) return { categoryId, ...scope };
    const row = await harnessRepo.setSteering(categoryId, body, who(me));
    return { categoryId: row.category_id, priority: row.priority, direction: row.direction, ...scope, updatedAt: iso(row.updated_at) };
  },

  async setDirection(direction: string, userId: string | null | undefined) {
    await steeringMember(userId, 'steer the content');
    await harnessRepo.setPolicy('content.direction', direction);
    return { direction };
  },

  async createRequest(body: CreateRequestBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'order questions');
    if (!(await harnessRepo.categoryExists(body.categoryId))) throw new NotFoundError('Category not found');
    if (body.deadline && !isCalendarDate(body.deadline)) throw new ValidationError('Invalid deadline', { field: 'deadline' });
    const id = await harnessRepo.createRequest({ ...body, deadline: body.deadline ?? null, by: who(me) });
    return { id };
  },

  async cancelRequest(briefId: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'cancel orders');
    if (!(await harnessRepo.cancelRequest(briefId, who(me)))) throw new ConflictError('This order is already finished or cancelled.');
    return { id: briefId, status: 'cancelled' };
  },

  async itemAction(itemId: string, body: ItemActionBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'decide on questions');
    const r = await harnessRepo.itemAction({ itemId, version: body.version, action: body.action, note: body.note, by: who(me) });
    if (!r.ok) {
      if (r.reason === 'not_found') throw new NotFoundError('Question not found');
      throw new ConflictError('This question changed since you opened it. Refresh and try again.');
    }
    return { id: itemId, stage: r.stage };
  },

  // ── phase 2 ──

  async createEvent(body: CreateEventBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'add events');
    return { id: await this.placeEvent(body, who(me)) };
  },

  async placeEvent(body: Omit<CreateEventBody, 'market'> & { market?: MarketOrAll }, by: string) {
    if (!isCalendarDate(body.happensOn)) throw new ValidationError('Invalid date', { field: 'happensOn' });
    const unique = [...new Set(body.categoryIds)];
    for (const c of unique) if (!(await harnessRepo.categoryExists(c))) throw new NotFoundError('Category not found');
    return harnessRepo.createEvent({ ...body, categoryIds: unique, by });
  },

  async cancelEvent(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'cancel events');
    if (!(await harnessRepo.cancelEvent(id, who(me)))) throw new ConflictError('This event is already cancelled.');
    return { id, status: 'cancelled' };
  },

  async createProposal(body: CreateProposalBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'suggest categories');
    return harnessRepo.createProposal({ ...body, by: who(me) });
  },

  async proposalGoLive(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'put categories live');
    const r = await harnessRepo.proposalGoLive(id, who(me));
    if (r === 'missing_mcq') throw new ConflictError('Ranked needs more ready multiple-choice questions in this category first. Wait for the agents to finish the starter set.');
    if (r === 'missing_special')
      throw new ConflictError('Ranked needs at least one put-in-order and one clue-chain question in this category first. Add them under Questions.');
    if (!r) throw new ConflictError('This category is already live or was dropped.');
    return { id, status: 'live' };
  },

  async cancelProposal(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'drop suggested categories');
    if (!(await harnessRepo.cancelProposal(id, who(me)))) throw new ConflictError('This category is already live or was dropped.');
    return { id, status: 'cancelled' };
  },

  async createAsk(message: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'ask HQ');
    return { id: await harnessRepo.createAsk(message, who(me)) };
  },

  /** Changes to games: anyone on the team may ask for one; reading is open to every admin. */
  gameChanges: () => gameChanges.list(),
  async createGameChange(body: CreateGameChangeBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'ask for a change to a game');
    return gameChanges.create(body, who(me));
  },
  async replanGameChange(id: string, request: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'change a request');
    return gameChanges.replan(id, request, who(me));
  },
  async cancelGameChange(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'cancel a change');
    return gameChanges.cancel(id, who(me));
  },

  /** Reports by the desk agents: anyone on the team may ask for one or put one away; reading is open to every admin. */
  reports: () => reports.list(),
  async createReport(agent: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'ask an agent for a report');
    return reports.create(agent, who(me));
  },
  async archiveReport(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'put a report away');
    return reports.archive(id, who(me));
  },

  // The show actions answer with what was done, not with a fresh read: a change that was saved is never reported
  // as failed because the read after it failed (the CMS refreshes by itself).
  async swapShowQuestion(id: string, body: SwapShowQuestionBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'change the show pack');
    await showPacks.swap(id, body.index, body.seen, who(me));
    return { id, status: 'checking' };
  },

  /** Builds the pack again from scratch. */
  async newShowPack(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'change the show pack');
    await showPacks.rebuild(id, who(me));
    return { id, status: 'checking' };
  },

  async approveShowPack(id: string, seen: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'approve the show pack');
    await showPacks.approve(id, seen, who(me));
    return { id, status: 'approved' };
  },

  async dismissAsk(id: string, userId: string | null | undefined) {
    await steeringMember(userId, 'ask HQ');
    if (!(await harnessRepo.dismissAsk(id))) throw new ConflictError('This answer was already applied or dismissed.');
    return { id, status: 'dismissed' };
  },

  /**
   * Applies the chosen proposals of an answered ask, each through the same
   * checks as the buttons. The ask is claimed first, so it applies once.
   */
  async applyAsk(id: string, indexes: number[], userId: string | null | undefined) {
    const me = await steeringMember(userId, 'apply HQ suggestions');
    const claimed = await harnessRepo.claimAsk(id, who(me));
    if (!claimed) throw new ConflictError('This answer was already applied or dismissed.');
    const actions = Array.isArray(claimed.actions) ? claimed.actions : [];
    const results = await this.applyActions(actions, indexes, userId, me, 'all');
    await harnessRepo.recordAskApplied(id, results);
    return { id, results };
  },

  /** Runs the chosen actions one by one through the same checks as the buttons. One that fails does not stop the rest. */
  async applyActions(
    actions: unknown[],
    indexes: number[],
    userId: string | null | undefined,
    me: Member,
    market: MarketOrAll,
    /** Called after every action with the results so far, so what was done is on record even if the rest never runs. */
    onStep?: (results: Array<{ index: number; ok: boolean; error?: string }>) => Promise<void>,
  ) {
    const results: Array<{ index: number; ok: boolean; error?: string }> = [];
    for (const index of [...new Set(indexes)].sort((a, b) => a - b)) {
      const parsed = ideaActionSchema.safeParse(actions[index]);
      if (!parsed.success) {
        results.push({ index, ok: false, error: 'not a valid action' });
        await onStep?.(results);
        continue;
      }
      const a = parsed.data;
      try {
        if (a.type === 'priority') await this.setSteering(a.categoryId, { priority: a.priority }, userId);
        else if (a.type === 'direction') {
          if (a.categoryId) await this.setSteering(a.categoryId, { direction: a.text }, userId);
          else await this.setDirection(a.text, userId);
        } else if (a.type === 'order')
          await this.createRequest({ categoryId: a.categoryId, difficulty: a.difficulty, count: a.count, topic: a.topic, deadline: a.deadline ?? null }, userId);
        else if (a.type === 'category') await harnessRepo.createProposal({ name: a.name, why: a.why, target: a.target, market, by: who(me) });
        else await this.placeEvent({ ...a, market }, who(me));
        results.push({ index, ok: true });
      } catch (e) {
        results.push({ index, ok: false, error: e instanceof Error ? e.message.slice(0, 200) : 'failed' });
      }
      await onStep?.(results);
    }
    return results;
  },

  // ── ideas ──

  async createIdea(body: CreateIdeaBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'send ideas');
    return ideas.create(body, who(me));
  },

  async scoutIdeas(market: MarketOrAll, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'ask the scout for ideas');
    return (await ideas.scout(market, who(me)))!;
  },

  /** Accepting does everything the idea proposes; the idea is claimed first, so it happens once. */
  async acceptIdea(id: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'accept ideas');
    const claimed = await ideas.claim(id, who(me));
    if (!claimed) throw new ConflictError('This idea was already accepted or refused, or its plan is not ready yet.');
    const actions = Array.isArray(claimed.actions) ? claimed.actions : [];
    // Recorded step by step: if the server stops halfway, the idea shows which steps were done and which were not,
    // and nothing is ever run a second time (an accepted idea cannot be accepted again).
    const results = await this.applyActions(actions, actions.map((_, i) => i), userId, me, claimed.market, (soFar) => ideas.recordApplied(id, soFar));
    // The log line is a courtesy: the idea is accepted and recorded whether or not it is written.
    try {
      await harnessRepo.note('idea', `Idea ${claimed.number} accepted by ${who(me)}`);
    } catch {
      // Not written: nothing depends on it.
    }
    return { id, status: 'accepted', results };
  },

  async refuseIdea(id: string, reason: string, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'refuse ideas');
    if (!(await ideas.refuse(id, reason, who(me)))) throw new ConflictError('This idea was already accepted or refused.');
    return { id, status: 'refused' };
  },
};

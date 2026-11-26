import { AuthorizationError, ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { ttlCache } from '../hq/hq.cache.js';
import { hqService, requireFounder } from '../hq/hq.service.js';
import { harnessRepo } from './harness.repo.js';
import {
  EDITABLE_POLICIES,
  type CreateRequestBody,
  type ItemActionBody,
  type PolicyKeyParam,
  type SetSteeringBody,
  type UpdateHarnessSettingsBody,
} from './harness.schemas.js';

// CMS Content tab: what the agent harness is doing, plus the owners' controls
// (pause switch, run caps, policies). Everything else is decided by the
// harness itself.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

// classic_health scans 30 days of ranked match questions: reuse it for a minute.
const healthCache = ttlCache<number, Awaited<ReturnType<typeof harnessRepo.classicHealth>>>(60_000);

type Member = Awaited<ReturnType<typeof hqService.actingMember>>;

/** Steering the content is for the people on the team; agents and archived members cannot. */
async function steeringMember(userId: string | null | undefined, what: string): Promise<Member> {
  const me = await hqService.actingMember(userId);
  if (me.kind !== 'human' || me.status !== 'active') throw new AuthorizationError(`Only active team members can ${what}.`);
  return me;
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
    const [settings, accounts, agents, health, stages, jobs, runs, events, policies, today, steering, live7d, liveToday, needsYou, recentLive, requests] = await Promise.all([
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
    ]);
    const steer = new Map(steering.map((r) => [r.category_id, r]));
    const rate = new Map(live7d.map((r) => [r.category_id, num(r.n)]));
    const ids = new Set<string>(health.map((h) => h.category_id));
    for (const r of [...needsYou, ...recentLive, ...requests, ...events]) if (r.category_id) ids.add(r.category_id);
    const names = new Map((await harnessRepo.categoryNames([...ids])).map((c) => [c.id, c.name ?? '']));
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
      direction: typeof directionPolicy?.value === 'string' ? directionPolicy.value : '',
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
      })),
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
    const row = await harnessRepo.setSteering(categoryId, body, who(me));
    return { categoryId: row.category_id, priority: row.priority, direction: row.direction, updatedAt: iso(row.updated_at) };
  },

  async setDirection(direction: string, userId: string | null | undefined) {
    await steeringMember(userId, 'steer the content');
    await harnessRepo.setPolicy('content.direction', direction);
    return { direction };
  },

  async createRequest(body: CreateRequestBody, userId: string | null | undefined) {
    const me = await steeringMember(userId, 'order questions');
    if (!(await harnessRepo.categoryExists(body.categoryId))) throw new NotFoundError('Category not found');
    if (body.deadline && Number.isNaN(Date.parse(body.deadline))) throw new ValidationError('Invalid deadline', { field: 'deadline' });
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
};

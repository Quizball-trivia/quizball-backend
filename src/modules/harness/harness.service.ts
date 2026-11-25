import { ValidationError } from '../../core/errors.js';
import { ttlCache } from '../hq/hq.cache.js';
import { hqService, requireFounder } from '../hq/hq.service.js';
import { harnessRepo } from './harness.repo.js';
import { EDITABLE_POLICIES, type PolicyKeyParam, type UpdateHarnessSettingsBody } from './harness.schemas.js';

// CMS Content tab: what the agent harness is doing, plus the owners' controls
// (pause switch, run caps, policies). Everything else is decided by the
// harness itself.

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

// classic_health scans 30 days of ranked match questions: reuse it for a minute.
const healthCache = ttlCache<number, Awaited<ReturnType<typeof harnessRepo.classicHealth>>>(60_000);

export const harnessService = {
  async overview() {
    const cap = await harnessRepo.classicCap();
    const [settings, accounts, agents, health, stages, jobs, runs, events, policies, today] = await Promise.all([
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
    ]);
    const categories = health.map((h) => ({
      categoryId: h.category_id,
      slug: h.slug,
      views30d: num(h.views_30d),
      pool: num(h.pool),
      inPipeline: num(h.in_pipeline),
      needed: num(h.needed),
      shortage: num(h.shortage),
    }));
    return {
      settings: {
        paused: settings.paused,
        pausedReason: settings.paused_reason,
        maxConcurrentRuns: settings.max_concurrent_runs,
        dailyRunLimit: settings.daily_run_limit,
        updatedAt: iso(settings.updated_at),
      },
      today: { runs: num(today?.runs), costCents: num(today?.cost_cents), failed: num(today?.failed) },
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
      events: events.map((e) => ({ id: String(e.id), type: e.type, level: e.level, message: e.message, itemId: e.item_id, createdAt: iso(e.created_at) })),
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
};

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  accounts: vi.fn(),
  agents: vi.fn(),
  classicHealth: vi.fn(),
  classicCap: vi.fn(),
  stageCounts: vi.fn(),
  jobCounts: vi.fn(),
  recentRuns: vi.fn(),
  recentEvents: vi.fn(),
  policies: vi.fn(),
  setPolicy: vi.fn(),
  todayTotals: vi.fn(),
  steering: vi.fn(),
  setSteering: vi.fn(),
  categoryExists: vi.fn(),
  categoryNames: vi.fn(),
  liveLast7d: vi.fn(),
  liveToday: vi.fn(),
  needsYou: vi.fn(),
  recentLive: vi.fn(),
  requests: vi.fn(),
  createRequest: vi.fn(),
  cancelRequest: vi.fn(),
  itemAction: vi.fn(),
  activeCategories: vi.fn(),
  contentEvents: vi.fn(),
  proposals: vi.fn(),
  asks: vi.fn(),
  createEvent: vi.fn(),
  claimAsk: vi.fn(),
  recordAskApplied: vi.fn(),
}));
type ActingMember = { is_founder: boolean; kind?: string; status?: string; name?: string };
const acting = vi.hoisted(() => ({ member: { is_founder: true, kind: 'human', status: 'active', name: 'Nika' } as ActingMember }));

vi.mock('../../src/modules/harness/harness.repo.js', () => ({ harnessRepo: repo }));
vi.mock('../../src/modules/hq/hq.service.js', () => ({
  hqService: { actingMember: vi.fn(async () => acting.member) },
  requireFounder: (me: { is_founder: boolean }, what: string) => {
    if (!me.is_founder) throw Object.assign(new Error(`Only the founder can ${what}.`), { name: 'AuthorizationError' });
  },
}));

const { harnessService } = await import('../../src/modules/harness/harness.service.js');

const NOW = new Date('2026-11-25T12:00:00Z');

describe('harness service (CMS Content tab)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    acting.member = { is_founder: true, kind: 'human', status: 'active', name: 'Nika' };
    repo.settings.mockResolvedValue({ paused: true, paused_reason: 'new', max_concurrent_runs: 3, daily_run_limit: 1500, updated_at: NOW });
    repo.accounts.mockResolvedValue([
      { id: 'claude-people', provider: 'claude', label: 'people', secret_ref: 'HARNESS_NEVER_USED', status: 'disabled', reserved_for_people: true, soft_pct: 90, state: 'ok', blocked_until: null, windows: {}, last_error: null },
    ]);
    repo.agents.mockResolvedValue([
      { slug: 'question-maker', name: 'Question Maker', team: 'making', description: '', provider: 'claude', model: 'claude-opus-5-5', effort: null, primary_account: 'claude-premium-1', fallback_accounts: ['claude-premium-2'], status: 'active', runs_today: '4', cost_cents_today: '120', last_run_at: NOW },
    ]);
    repo.classicCap.mockResolvedValue(100);
    repo.classicHealth.mockResolvedValue([
      { category_id: 'c1', slug: 'manchester-united', views_30d: '12129', pool: '19', in_pipeline: '0', needed: '122', shortage: '103' },
      { category_id: 'c2', slug: 'world-cup', views_30d: '10046', pool: '921', in_pipeline: '0', needed: '101', shortage: '0' },
    ]);
    repo.stageCounts.mockResolvedValue([{ mode: 'classic', stage: 'approved', n: '8' }]);
    repo.jobCounts.mockResolvedValue([{ kind: 'make', status: 'queued', n: '2' }]);
    repo.recentRuns.mockResolvedValue([]);
    repo.recentEvents.mockResolvedValue([{ id: 7, type: 'item_stage', level: 'info', message: 'draft -> validated', item_id: 'i1', created_at: NOW }]);
    repo.policies.mockResolvedValue([
      { key: 'classic.release_status', value: 'draft', note: '', updated_at: NOW },
      { key: 'something.internal', value: 1, note: '', updated_at: NOW },
    ]);
    repo.todayTotals.mockResolvedValue({ runs: '12', cost_cents: '340', failed: '1' });
    repo.steering.mockResolvedValue([{ category_id: 'c1', priority: 'boost', direction: 'more 90s', updated_by: 'Tato', updated_at: NOW }]);
    repo.categoryNames.mockResolvedValue([{ id: 'c1', name: 'Manchester United' }]);
    repo.liveLast7d.mockResolvedValue([{ category_id: 'c1', n: '14' }]);
    repo.liveToday.mockResolvedValue(5);
    repo.needsYou.mockResolvedValue([
      { id: 'i9', category_id: 'c1', difficulty: 'hard', version: 6, revise_count: 2, updated_at: NOW,
        payload: { prompt: { en: 'Q?' }, options: [{ text: { en: 'A' }, is_correct: true }, { text: { en: 'B' }, is_correct: false }] },
        last_issues: [{ field: 'answer', problem: 'wrong year' }] },
    ]);
    repo.recentLive.mockResolvedValue([]);
    repo.requests.mockResolvedValue([]);
    repo.contentEvents.mockResolvedValue([]);
    repo.proposals.mockResolvedValue([]);
    repo.asks.mockResolvedValue([
      { id: 'a1', message: 'focus on Man U', asked_by: 'Tato', status: 'answered', reply: 'ok', error: null, applied_by: null, created_at: NOW, applied: [],
        actions: [{ type: 'priority', categoryId: '11111111-1111-4111-8111-111111111111', priority: 'boost' }, { type: 'nonsense' }] },
    ]);
    repo.activeCategories.mockResolvedValue([{ id: 'c1', name: 'Manchester United' }, { id: 'c7', name: 'Inter Miami' }]);
  });

  it('summarises the Classic gap, numbers as numbers', async () => {
    const o = await harnessService.overview();
    expect(o.classic).toMatchObject({ viewCap: 100, shortCategories: 1, totalShortage: 103 });
    expect(o.classic.categories[0]).toEqual({
      categoryId: 'c1', slug: 'manchester-united', views30d: 12129, pool: 19, inPipeline: 0, needed: 122, shortage: 103,
      name: 'Manchester United', priority: 'boost', direction: 'more 90s', liveLast7d: 14,
    });
    expect(o.classic.categories[1]).toMatchObject({ name: 'world-cup', priority: 'normal', direction: '', liveLast7d: 0 });
    expect(o.today).toEqual({ runs: 12, costCents: 340, failed: 1, live: 5 });
    expect(o.needsYou[0]).toMatchObject({
      id: 'i9', version: 6, category: 'Manchester United', issues: ['wrong year'],
      question: { prompt: { en: 'Q?' }, options: [{ text: { en: 'A' }, correct: true }, { text: { en: 'B' }, correct: false }] },
    });
    expect(o.agents[0]).toMatchObject({ runsToday: 4, costCentsToday: 120, fallbackAccounts: ['claude-premium-2'] });
    expect(o.accounts[0]).toMatchObject({ id: 'claude-people', reservedForPeople: true, secretRef: 'HARNESS_NEVER_USED' });
    expect(o.policies.find((p) => p.key === 'classic.release_status')?.editable).toBe(true);
    expect(o.policies.find((p) => p.key === 'something.internal')?.editable).toBe(false);
    expect(o.events[0]).toMatchObject({ id: '7', createdAt: NOW.toISOString() });
  });

  it('lets an owner pause and change caps', async () => {
    repo.updateSettings.mockResolvedValue({ paused: false, paused_reason: null, max_concurrent_runs: 4, daily_run_limit: 2000, updated_at: NOW });
    const s = await harnessService.updateSettings({ paused: false, pausedReason: null, maxConcurrentRuns: 4 }, 'u1');
    expect(repo.updateSettings).toHaveBeenCalledWith({ paused: false, paused_reason: null, max_concurrent_runs: 4, daily_run_limit: undefined });
    expect(s).toMatchObject({ paused: false, maxConcurrentRuns: 4 });
  });

  it('refuses settings and policy changes from non-owners', async () => {
    acting.member = { is_founder: false };
    await expect(harnessService.updateSettings({ paused: false }, 'u2')).rejects.toThrow(/Only the founder/);
    await expect(harnessService.setPolicy('classic.release_status', 'published', 'u2')).rejects.toThrow(/Only the founder/);
    expect(repo.updateSettings).not.toHaveBeenCalled();
    expect(repo.setPolicy).not.toHaveBeenCalled();
  });

  it('validates policy values before saving', async () => {
    repo.setPolicy.mockResolvedValue(true);
    await expect(harnessService.setPolicy('classic.release_status', 'live', 'u1')).rejects.toThrow(/Invalid value/);
    await expect(harnessService.setPolicy('classic.brief_size', 0, 'u1')).rejects.toThrow(/Invalid value/);
    expect(await harnessService.setPolicy('classic.release_status', 'published', 'u1')).toEqual({ key: 'classic.release_status', value: 'published' });
    expect(repo.setPolicy).toHaveBeenCalledWith('classic.release_status', 'published');
  });

  describe('steering', () => {
    it('lets any active team member steer a category, signed with their name', async () => {
      acting.member = { is_founder: false, kind: 'human', status: 'active', name: 'Tato' };
      repo.categoryExists.mockResolvedValue(true);
      repo.setSteering.mockResolvedValue({ category_id: 'c1', priority: 'hold', direction: '', updated_at: NOW });
      await expect(harnessService.setSteering('c1', { priority: 'hold' }, 'u2')).resolves.toMatchObject({ priority: 'hold' });
      expect(repo.setSteering).toHaveBeenCalledWith('c1', { priority: 'hold' }, 'Tato');
    });

    it('refuses steering from agents and archived members', async () => {
      acting.member = { is_founder: false, kind: 'agent', status: 'active', name: 'Bot' };
      await expect(harnessService.setSteering('c1', { priority: 'hold' }, 'u3')).rejects.toThrow(/active team members/);
      acting.member = { is_founder: false, kind: 'human', status: 'archived', name: 'Old' };
      await expect(harnessService.createRequest({ categoryId: 'c1', difficulty: 'easy', count: 5, topic: 'finals' }, 'u4')).rejects.toThrow(/active team members/);
      expect(repo.setSteering).not.toHaveBeenCalled();
      expect(repo.createRequest).not.toHaveBeenCalled();
    });

    it('lists every active category for orders, and refuses impossible deadlines', async () => {
      const o = await harnessService.overview();
      expect(o.allCategories).toEqual([{ id: 'c1', name: 'Manchester United' }, { id: 'c7', name: 'Inter Miami' }]);
      repo.categoryExists.mockResolvedValue(true);
      await expect(harnessService.createRequest({ categoryId: 'c1', difficulty: 'easy', count: 5, topic: 'finals', deadline: '2026-02-30' }, 'u1')).rejects.toThrow(/Invalid deadline/);
      expect(repo.createRequest).not.toHaveBeenCalled();
    });

    it('orders questions for a real category only', async () => {
      repo.categoryExists.mockResolvedValue(false);
      await expect(harnessService.createRequest({ categoryId: 'c404', difficulty: 'easy', count: 5, topic: 'finals' }, 'u1')).rejects.toThrow(/Category not found/);
      repo.categoryExists.mockResolvedValue(true);
      repo.createRequest.mockResolvedValue('b1');
      await expect(harnessService.createRequest({ categoryId: 'c1', difficulty: 'hard', count: 20, topic: 'CL finals', deadline: '2026-12-10' }, 'u1')).resolves.toEqual({ id: 'b1' });
      expect(repo.createRequest).toHaveBeenCalledWith({ categoryId: 'c1', difficulty: 'hard', count: 20, topic: 'CL finals', deadline: '2026-12-10', by: 'Nika' });
    });

    it('says so when a question changed since it was opened', async () => {
      repo.itemAction.mockResolvedValue({ ok: false, reason: 'moved' });
      await expect(harnessService.itemAction('i9', { action: 'approve', version: 5, note: '' }, 'u1')).rejects.toThrow(/changed since you opened it/);
      repo.itemAction.mockResolvedValue({ ok: true, stage: 'retired' });
      await expect(harnessService.itemAction('i9', { action: 'flag', version: 6, note: 'wrong year' }, 'u1')).resolves.toEqual({ id: 'i9', stage: 'retired' });
      expect(repo.itemAction).toHaveBeenLastCalledWith({ itemId: 'i9', version: 6, action: 'flag', note: 'wrong year', by: 'Nika' });
    });
  });

  describe('Ask HQ', () => {
    const CAT = '11111111-1111-4111-8111-111111111111';
    it('shows each proposed action in plain words, and marks unreadable ones', async () => {
      repo.categoryNames.mockResolvedValue([{ id: CAT, name: 'Manchester United' }]);
      const o = await harnessService.overview();
      expect(o.asks[0].actions[0]).toMatchObject({ valid: true, summary: 'Boost: Manchester United' });
      expect(o.asks[0].actions[1]).toMatchObject({ valid: false });
    });

    it('applies only the chosen, valid actions, once, through the same checks as the buttons', async () => {
      repo.claimAsk.mockResolvedValue({ actions: [
        { type: 'priority', categoryId: CAT, priority: 'hold' },
        { type: 'order', categoryId: CAT, difficulty: 'hard', count: 99, topic: 'too many' },
        { type: 'direction', categoryId: null, text: 'no injuries' },
      ] });
      repo.categoryExists.mockResolvedValue(true);
      repo.setSteering.mockResolvedValue({ category_id: CAT, priority: 'hold', direction: '', updated_at: NOW });
      repo.setPolicy.mockResolvedValue(true);
      const r = await harnessService.applyAsk('a1', [0, 1, 2, 2], 'u1');
      expect(r.results).toEqual([{ index: 0, ok: true }, { index: 1, ok: false, error: 'not a valid action' }, { index: 2, ok: true }]);
      expect(repo.setPolicy).toHaveBeenCalledWith('content.direction', 'no injuries');
      expect(repo.recordAskApplied).toHaveBeenCalledWith('a1', r.results);
      repo.claimAsk.mockResolvedValue(null);
      await expect(harnessService.applyAsk('a1', [0], 'u1')).rejects.toThrow(/already applied/);
    });
  });
});

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
}));
const acting = vi.hoisted(() => ({ member: { is_founder: true } as { is_founder: boolean } }));

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
    acting.member = { is_founder: true };
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
  });

  it('summarises the Classic gap, numbers as numbers', async () => {
    const o = await harnessService.overview();
    expect(o.classic).toMatchObject({ viewCap: 100, shortCategories: 1, totalShortage: 103 });
    expect(o.classic.categories[0]).toEqual({ categoryId: 'c1', slug: 'manchester-united', views30d: 12129, pool: 19, inPipeline: 0, needed: 122, shortage: 103 });
    expect(o.today).toEqual({ runs: 12, costCents: 340, failed: 1 });
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
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const repo = vi.hoisted(() => ({
  settings: vi.fn(),
  updateSettings: vi.fn(),
  accounts: vi.fn(),
  queueNow: vi.fn(async () => ({ ready: '3', waiting: '2', next_at: null, claims_today: '10' })),
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
  categoryMarkets: vi.fn(async () => [{ category_id: 'c1', market: 'uk', market_only: false }]),
  setCategoryMarket: vi.fn(),
  createProposal: vi.fn(async () => ({ id: 'p1', categoryId: 'c9', slug: 'dinamo-tbilisi' })),
  note: vi.fn(async () => undefined),
}));
const ideasMock = vi.hoisted(() => ({
  rows: vi.fn(async () => [] as unknown[]),
  scouting: vi.fn(async () => null as { market: string } | null),
  create: vi.fn(async () => ({ id: 'i9', number: 9, status: 'planning' })),
  scout: vi.fn(async () => ({ started: true, market: 'ge' })),
  claim: vi.fn(),
  recordApplied: vi.fn(),
  refuse: vi.fn(),
}));
type ActingMember = { is_founder: boolean; kind?: string; status?: string; name?: string };
const acting = vi.hoisted(() => ({ member: { is_founder: true, kind: 'human', status: 'active', name: 'Nika' } as ActingMember }));

vi.mock('../../src/modules/harness/harness.repo.js', () => ({ harnessRepo: repo }));
vi.mock('../../src/modules/harness/harness.ideas.js', async (orig) => ({ ...(await orig<object>()), ideas: ideasMock }));
vi.mock('../../src/modules/harness/harness.show.js', () => ({
  showPacks: { state: async () => ({ eventDate: '2027-01-04', episode: 307, showAt: '2027-01-04T18:00:00.000Z', loaded: false, loadedIsThisPack: false, pack: null }) },
}));
vi.mock('../../src/modules/harness/harness.runway.js', () => ({
  dailyRunway: vi.fn(async () => [{ key: 'dato-falso', label: 'Dato Falso', storedThrough: '2026-12-05', calendarEnds: '2026-12-05', endsOn: '2026-12-05', daysLeft: 9, limitedBy: 'both' }]),
}));
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
      { id: 'claude-people', provider: 'claude', label: 'people', secret_ref: 'HARNESS_NEVER_USED', status: 'disabled', reserved_for_people: true, soft_pct: 90, state: 'ok', blocked_until: null, windows: {}, last_error: null, max_parallel: 2, running: '1', runs_today: '7' },
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
    expect(o.queue).toEqual({ running: 1, ready: 3, waiting: 2, nextAt: null, dailyLimitReached: false });
    expect(o.accounts[0]).toMatchObject({ maxParallel: 2, running: 1, runsToday: 7 });
    expect(o.classic).toMatchObject({ viewCap: 100, shortCategories: 1, totalShortage: 103 });
    expect(o.classic.categories[0]).toEqual({
      categoryId: 'c1', slug: 'manchester-united', views30d: 12129, pool: 19, inPipeline: 0, needed: 122, shortage: 103,
      name: 'Manchester United', priority: 'boost', market: 'uk', marketOnly: false, direction: 'more 90s', liveLast7d: 14,
    });
    expect(o.classic.categories[1]).toMatchObject({ name: 'world-cup', priority: 'normal', direction: '', liveLast7d: 0 });
    expect(o.today).toEqual({ runs: 12, costCents: 340, failed: 1, live: 5 });
    expect(o.runway[0]).toMatchObject({ key: 'dato-falso', daysLeft: 9, limitedBy: 'both' });
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
      expect(o.allCategories).toEqual([{ id: 'c1', name: 'Manchester United', market: 'uk', marketOnly: false }, { id: 'c7', name: 'Inter Miami', market: 'all', marketOnly: false }]);
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

    it('names a proposal for any active category, even one with no recent activity', async () => {
      repo.categoryNames.mockResolvedValue([]);
      repo.activeCategories.mockResolvedValue([{ id: CAT, name: 'Real Betis' }]);
      const o = await harnessService.overview();
      expect(o.asks[0].actions[0].summary).toBe('Boost: Real Betis');
    });

    it('refuses to put a category live before ranked can use it', async () => {
      repo.proposalGoLive = vi.fn().mockResolvedValue('missing_special');
      await expect(harnessService.proposalGoLive('p1', 'u1')).rejects.toThrow(/put-in-order and one clue-chain/);
      repo.proposalGoLive = vi.fn().mockResolvedValue('missing_mcq');
      await expect(harnessService.proposalGoLive('p1', 'u1')).rejects.toThrow(/multiple-choice/);
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

  describe('markets and ideas', () => {
    const CAT = '11111111-1111-4111-8111-111111111111';
    const idea = (over: Record<string, unknown> = {}) => ({
      id: 'i1', number: 3, source: 'agent', agent_slug: 'market-scout', agent_name: 'Market Scout', created_by: null, market: 'ge', kind: 'category',
      title: 'A Dinamo Tbilisi category', detail: 'Georgia has no category of its own.', source_url: null, status: 'open', plan: null,
      actions: [{ type: 'category', name: 'Dinamo Tbilisi', why: 'The biggest Georgian club', target: 30 }, { type: 'priority', categoryId: CAT, priority: 'boost' }, { type: 'nonsense' }],
      applied: [], decided_by: null, refuse_reason: null, error: null, created_at: NOW, updated_at: NOW, ...over,
    });

    it('says which market each category is made for, and lists the markets', async () => {
      const o = await harnessService.overview();
      expect(o.markets.map((m) => m.key)).toEqual(['ge', 'tr', 'ar', 'uk', 'es']);
      expect(o.classic.categories.map((c) => [c.slug, c.market])).toEqual([['manchester-united', 'uk'], ['world-cup', 'all']]);
      expect(o.scouting).toBeNull();
    });

    it('says which categories are only for their market', async () => {
      repo.categoryMarkets.mockResolvedValueOnce([{ category_id: 'c1', market: 'uk', market_only: true }]);
      const o = await harnessService.overview();
      expect(o.classic.categories.map((c) => [c.slug, c.marketOnly])).toEqual([['manchester-united', true], ['world-cup', false]]);
    });

    it('moves a category to a market without touching its priority', async () => {
      repo.categoryExists.mockResolvedValue(true);
      repo.setCategoryMarket.mockResolvedValueOnce({ market: 'ge', market_only: false });
      expect(await harnessService.setSteering('c1', { market: 'ge' }, 'u1')).toEqual({ categoryId: 'c1', market: 'ge', marketOnly: false });
      expect(repo.setCategoryMarket).toHaveBeenCalledWith('c1', { market: 'ge', only: undefined });
      expect(repo.setSteering).not.toHaveBeenCalled();
    });

    it('makes a category only for its market, and reports what the game now holds', async () => {
      repo.categoryExists.mockResolvedValue(true);
      repo.setCategoryMarket.mockResolvedValueOnce({ market: 'uk', market_only: true });
      expect(await harnessService.setSteering('c1', { marketOnly: true }, 'u1')).toEqual({ categoryId: 'c1', market: 'uk', marketOnly: true });
      expect(repo.setCategoryMarket).toHaveBeenCalledWith('c1', { market: undefined, only: true });
    });

    it('still saves the rest of the change when the activity note cannot be written', async () => {
      repo.categoryExists.mockResolvedValue(true);
      repo.setCategoryMarket.mockResolvedValueOnce({ market: 'ge', market_only: false });
      repo.note.mockRejectedValueOnce(new Error('log is away'));
      repo.setSteering.mockResolvedValueOnce({ category_id: 'c1', priority: 'boost', direction: '', updated_at: new Date('2026-11-27T10:00:00Z') });
      const saved = await harnessService.setSteering('c1', { market: 'ge', priority: 'boost' }, 'u1');
      expect(saved).toMatchObject({ categoryId: 'c1', market: 'ge', marketOnly: false, priority: 'boost' });
    });

    it('reports a category put back to all markets', async () => {
      repo.categoryExists.mockResolvedValue(true);
      repo.setCategoryMarket.mockResolvedValueOnce({ market: null, market_only: false });
      expect(await harnessService.setSteering('c1', { market: 'all' }, 'u1')).toEqual({ categoryId: 'c1', market: 'all', marketOnly: false });
    });

    it('refuses to make a category for all markets market-only', async () => {
      repo.categoryExists.mockResolvedValue(true);
      repo.setCategoryMarket.mockResolvedValueOnce(undefined);
      await expect(harnessService.setSteering('c2', { marketOnly: true }, 'u1')).rejects.toThrow(/Pick a market first/);
    });

    it('shows an idea with its actions in plain words', async () => {
      ideasMock.rows.mockResolvedValueOnce([idea()]);
      repo.categoryNames.mockResolvedValue([{ id: CAT, name: 'Georgia' }]);
      const o = await harnessService.overview();
      expect(o.ideas[0]).toMatchObject({ number: 3, market: 'ge', agentName: 'Market Scout' });
      expect(o.ideas[0]!.actions.map((a) => [a.valid, a.summary])).toEqual([
        [true, 'Start a new category: Dinamo Tbilisi (30 questions first, hidden from players until you put it live)'],
        [true, 'Boost: Georgia'],
        [false, 'An action that could not be read'],
      ]);
    });

    it('accepting does everything the idea proposes, for its market, once', async () => {
      ideasMock.claim.mockResolvedValueOnce({ number: 3, market: 'ge', actions: idea().actions });
      repo.categoryExists.mockResolvedValue(true);
      repo.setSteering.mockResolvedValue({ category_id: CAT, priority: 'boost', direction: '', updated_at: NOW });
      const r = await harnessService.acceptIdea('i1', 'u1');
      expect(repo.createProposal).toHaveBeenCalledWith({ name: 'Dinamo Tbilisi', why: 'The biggest Georgian club', target: 30, market: 'ge', by: 'Nika' });
      expect(r.results).toEqual([{ index: 0, ok: true }, { index: 1, ok: true }, { index: 2, ok: false, error: 'not a valid action' }]);
      // Recorded after every step, so a stop halfway still shows what was done.
      expect(ideasMock.recordApplied).toHaveBeenCalledTimes(3);
      expect(ideasMock.recordApplied).toHaveBeenLastCalledWith('i1', r.results);
      // Someone else was faster: nothing is applied twice.
      ideasMock.claim.mockResolvedValueOnce(null);
      await expect(harnessService.acceptIdea('i1', 'u1')).rejects.toThrow(/already accepted or refused/);
      expect(repo.createProposal).toHaveBeenCalledTimes(1);
    });

    it('an acceptance stands even when the log line cannot be written', async () => {
      ideasMock.claim.mockResolvedValueOnce({ number: 5, market: 'all', actions: [] });
      repo.note.mockRejectedValueOnce(new Error('log down'));
      expect(await harnessService.acceptIdea('i5', 'u1')).toEqual({ id: 'i5', status: 'accepted', results: [] });
    });

    it('an event from an accepted idea carries the idea\'s market', async () => {
      ideasMock.claim.mockResolvedValueOnce({ number: 4, market: 'es', actions: [{ type: 'event', title: 'El Clasico', happensOn: '2026-12-14', categoryIds: [CAT], perCategory: 10 }] });
      repo.categoryExists.mockResolvedValue(true);
      repo.createEvent.mockResolvedValue('e1');
      await harnessService.acceptIdea('i2', 'u1');
      expect(repo.createEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'El Clasico', market: 'es', by: 'Nika' }));
    });

    it('keeps agents and archived members out of ideas', async () => {
      acting.member = { is_founder: false, kind: 'agent', status: 'active', name: 'Bot' };
      await expect(harnessService.createIdea({ text: 'A week of Maradona', market: 'ar', kind: 'event' }, 'u1')).rejects.toThrow(/Only active team members/);
      await expect(harnessService.acceptIdea('i1', 'u1')).rejects.toThrow(/Only active team members/);
      await expect(harnessService.refuseIdea('i1', '', 'u1')).rejects.toThrow(/Only active team members/);
      await expect(harnessService.scoutIdeas('ge', 'u1')).rejects.toThrow(/Only active team members/);
      expect(ideasMock.create).not.toHaveBeenCalled();
    });

    it('refuses once, with the reason kept for the scout', async () => {
      ideasMock.refuse.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      expect(await harnessService.refuseIdea('i1', 'We did this in October', 'u1')).toEqual({ id: 'i1', status: 'refused' });
      expect(ideasMock.refuse).toHaveBeenCalledWith('i1', 'We did this in October', 'Nika');
      await expect(harnessService.refuseIdea('i1', '', 'u1')).rejects.toThrow(/already accepted or refused/);
    });
  });
});

import { describe, expect, it } from 'vitest';
import '../setup.js';

const { ideaTitle, ideaView, scoutLimits, MAX_WAITING_AGENT_IDEAS } = await import('../../src/modules/harness/harness.ideas.js');
const { createIdeaBodySchema, ideaActionSchema, askActionSchema, refuseIdeaBodySchema, scoutIdeasBodySchema, setSteeringBodySchema, createEventBodySchema, createProposalBodySchema, MARKETS, MARKET_NAMES } = await import(
  '../../src/modules/harness/harness.schemas.js'
);

const CAT = '11111111-1111-4111-8111-111111111111';
const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'i1', number: 7, source: 'agent', agent_slug: 'market-scout', agent_name: 'Market Scout', created_by: null, market: 'ar', kind: 'questions',
    title: 'Fill Argentina before the derby', detail: 'Only 38 of 90.', source_url: null, status: 'open', plan: null,
    actions: [{ type: 'priority', categoryId: CAT, priority: 'boost' }], applied: [], decided_by: null, refuse_reason: null, error: null,
    created_at: '2026-11-27T08:00:00Z', updated_at: '2026-11-27T08:00:00Z', ...over,
  }) as never;

describe('ideas', () => {
  it('names a person\'s idea from its first line, cut at a word', () => {
    expect(ideaTitle('A week of Maradona\nwith a pack and an emote')).toBe('A week of Maradona');
    const long = ideaTitle(`${'word '.repeat(40)}end`);
    expect([...long].length).toBeLessThanOrEqual(118);
    expect(long.endsWith('…')).toBe(true);
    expect(long).not.toMatch(/ …$/);
    // Georgian counts by character, not by byte.
    expect(ideaTitle('დინამოს კვირა')).toBe('დინამოს კვირა');
  });

  it('shows an idea with each action in plain words', () => {
    const v = ideaView(row(), (a: unknown) => ({ summary: `did ${(a as { type: string }).type}` }));
    expect(v).toMatchObject({ number: 7, market: 'ar', agentName: 'Market Scout', status: 'open', actions: [{ summary: 'did priority' }], createdAt: '2026-11-27T08:00:00.000Z' });
    // Actions that are not a list (bad data) read as none.
    expect(ideaView(row({ actions: null, applied: 'x' }), () => 1)).toMatchObject({ actions: [], applied: [] });
  });

  it('brings a couple of ideas per market on a full round, a handful when one market is asked for', () => {
    expect(scoutLimits('all')).toEqual({ perMarket: 2, forEveryone: 3, total: 12 });
    expect(scoutLimits('ge')).toEqual({ perMarket: 5, forEveryone: 0, total: 5 });
    expect(scoutLimits('all').total).toBeLessThan(MAX_WAITING_AGENT_IDEAS);
  });

  it('accepts a person\'s idea with a market and a kind, and refuses an empty one', () => {
    expect(createIdeaBodySchema.parse({ text: 'A Dinamo Tbilisi category for Georgia' })).toEqual({ text: 'A Dinamo Tbilisi category for Georgia', market: 'all', kind: 'other' });
    expect(createIdeaBodySchema.safeParse({ text: 'too short' }).success).toBe(false);
    expect(createIdeaBodySchema.safeParse({ text: 'A category for France please', market: 'fr' }).success).toBe(false);
    expect(refuseIdeaBodySchema.parse({})).toEqual({ reason: '' });
    expect(scoutIdeasBodySchema.parse({})).toEqual({ market: 'all' });
  });

  it('lets an idea start a new category, which Ask HQ may not', () => {
    const category = { type: 'category', name: 'Dinamo Tbilisi', why: 'The biggest Georgian club' };
    expect(ideaActionSchema.parse(category)).toMatchObject({ target: 30 });
    expect(askActionSchema.safeParse(category).success).toBe(false);
    // Everything Ask HQ may propose, an idea may too.
    expect(ideaActionSchema.safeParse({ type: 'order', categoryId: CAT, difficulty: 'easy', count: 10, topic: 'The 1981 final' }).success).toBe(true);
    expect(ideaActionSchema.safeParse({ type: 'delete', categoryId: CAT }).success).toBe(false);
  });

  it('takes a market on its own when steering, and defaults events and new categories to everyone', () => {
    expect(setSteeringBodySchema.safeParse({ market: 'ge' }).success).toBe(true);
    expect(setSteeringBodySchema.safeParse({ market: 'all' }).success).toBe(true);
    expect(setSteeringBodySchema.safeParse({}).success).toBe(false);
    expect(createEventBodySchema.parse({ title: 'El Clasico', happensOn: '2026-12-14', categoryIds: [CAT], perCategory: 10 }).market).toBe('all');
    expect(createProposalBodySchema.parse({ name: 'Kvara', market: 'ge' }).market).toBe('ge');
    expect(Object.keys(MARKET_NAMES).sort()).toEqual([...MARKETS].sort());
  });
});

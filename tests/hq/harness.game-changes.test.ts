import { describe, expect, it } from 'vitest';
import '../setup.js';

const { changeView } = await import('../../src/modules/harness/harness.game-changes.js');
const { createGameChangeBodySchema, replanGameChangeBodySchema } = await import('../../src/modules/harness/harness.schemas.js');

describe('game changes', () => {
  it('shows a change with its game named and its dates as text', () => {
    const v = changeView({
      id: 'c1', number: 12, game_key: 'tenable', title: 'Four lives', request: 'Give players four lives instead of three.', source: 'person', requested_by: 'Nika',
      status: 'planned', plan: { summary: 's', size: 'small', changes: [], risks: [], test: [], questions: [] }, error: null, decided_by: null,
      created_at: new Date('2026-11-27T08:00:00Z'), updated_at: '2026-11-27T08:05:00Z',
    });
    expect(v).toMatchObject({ number: 12, gameKey: 'tenable', gameName: 'Football Tenable', status: 'planned', createdAt: '2026-11-27T08:00:00.000Z', updatedAt: '2026-11-27T08:05:00.000Z' });
    expect(changeView({ ...({} as never), id: 'c2', number: 1, game_key: 'gone-game', title: 't', request: 'r', source: 'agent', requested_by: null, status: 'suggested', plan: null, error: null, decided_by: null, created_at: '2026-11-27T08:00:00Z', updated_at: '2026-11-27T08:00:00Z' }).gameName).toBe('gone-game');
  });

  it('takes a real request and refuses an empty or oversized one', () => {
    expect(createGameChangeBodySchema.safeParse({ gameKey: 'tenable', title: 'Four lives', request: 'Give players four lives instead of three.' }).success).toBe(true);
    expect(createGameChangeBodySchema.safeParse({ gameKey: 'Tenable!', title: 'Four lives', request: 'Give players four lives instead of three.' }).success).toBe(false);
    expect(createGameChangeBodySchema.safeParse({ gameKey: 'tenable', title: 'x', request: 'Give players four lives.' }).success).toBe(false);
    expect(replanGameChangeBodySchema.safeParse({ request: 'short' }).success).toBe(false);
    expect(replanGameChangeBodySchema.safeParse({ request: 'x'.repeat(6001) }).success).toBe(false);
  });
});

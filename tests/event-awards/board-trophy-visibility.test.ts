import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const listForUser = vi.fn();
vi.mock('../../src/modules/event-awards/event-awards.repo.js', () => ({
  eventAwardsRepo: { listForUser: (...a: unknown[]) => listForUser(...a), markSeen: vi.fn() },
}));
vi.mock('../../src/modules/users/users.service.js', () => ({
  usersService: { assertPublicUserVisible: vi.fn() },
}));

const { eventAwardsController } = await import('../../src/modules/event-awards/event-awards.controller.js');

const ROWS = [
  { id: 'a', event_slug: 'weekend-league-2026-10-10', place: 1, awarded_at: '2026-10-11T00:00:00Z', seen_at: null },
  { id: 'b', event_slug: 'lb-s3-club-fc-barcelona', place: 2, awarded_at: '2026-11-01T00:00:00Z', seen_at: null },
  { id: 'c', event_slug: 'lb-s3-country-ge', place: 1, awarded_at: '2026-11-01T00:00:00Z', seen_at: null },
];

function call(query: Record<string, string>) {
  const json = vi.fn();
  return eventAwardsController
    .getMyAwards({ user: { id: 'u1' }, query } as never, { json } as never)
    .then(() => json.mock.calls[0][0].awards.map((award: { eventSlug: string }) => award.eventSlug));
}

beforeEach(() => listForUser.mockResolvedValue(ROWS));

describe('season board trophies', () => {
  it('are hidden from clients that would show them as World Cup medals', async () => {
    expect(await call({})).toEqual(['weekend-league-2026-10-10']);
  });

  it('are sent to clients that render them', async () => {
    expect(await call({ boardTrophies: '1' })).toEqual(ROWS.map((row) => row.event_slug));
  });
});

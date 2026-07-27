/**
 * PR3 realtime-payload test: rankPoints sourcing in buildParticipantPayloads.
 *
 * The pinned aiAnchorRp is substituted ONLY for ephemeral/auction AI. A
 * persistent bot is settle-eligible, so it loads its REAL ranked profile RP like
 * a human — even though its aiAnchorRp is pinned in the ranked context (PR7 will
 * feed persistent bots through this path). A human, likewise, uses its profile.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

const getByIdsMock = vi.fn();
const ensureProfileMock = vi.fn();

vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...args: unknown[]) => getByIdsMock(...args) },
}));
vi.mock('../../src/modules/ranked/ranked.service.js', () => ({
  rankedService: { ensureProfile: (...args: unknown[]) => ensureProfileMock(...args) },
}));
vi.mock('../../src/core/analytics.js', () => ({
  registerAiUserId: vi.fn(),
  identifyUser: vi.fn(),
}));
vi.mock('../../src/realtime/session-country.js', () => ({
  getCurrentCountriesForUsers: vi.fn(async () => new Map()),
  getCurrentCountryForUser: vi.fn(async () => null),
}));
vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ANCHOR_RP = 1900;
const HUMAN_PROFILE_RP = 1420;
const PERSISTENT_PROFILE_RP = 1580;

describe('buildParticipantPayloads — rankPoints anchor vs real profile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureProfileMock.mockImplementation(async (userId: string) => ({
      rp: userId === 'human-1' ? HUMAN_PROFILE_RP : PERSISTENT_PROFILE_RP,
    }));
  });

  it('persistent bot loads real profile RP; ephemeral bot takes the pinned anchor', async () => {
    getByIdsMock.mockResolvedValue(new Map<string, { id: string; is_ai: boolean; ai_kind: string | null; nickname: string }>([
      ['human-1', { id: 'human-1', is_ai: false, ai_kind: null, nickname: 'Human' }],
      ['persistent-1', { id: 'persistent-1', is_ai: true, ai_kind: 'persistent', nickname: 'Bot' }],
    ]));

    const { buildParticipantPayloads } = await import('../../src/realtime/services/match-participants.helpers.js');
    const payloads = await buildParticipantPayloads(
      [{ user_id: 'human-1', seat: 1 }, { user_id: 'persistent-1', seat: 2 }],
      'ranked',
      { aiAnchorRp: ANCHOR_RP },
    );

    const byId = new Map(payloads.map((p) => [p.userId, p]));
    expect(byId.get('human-1')?.rankPoints).toBe(HUMAN_PROFILE_RP);
    // Persistent bot must NOT read the anchor — it loads its real profile.
    expect(byId.get('persistent-1')?.rankPoints).toBe(PERSISTENT_PROFILE_RP);
    expect(byId.get('persistent-1')?.rankPoints).not.toBe(ANCHOR_RP);
  });

  it('ephemeral bot carries the pinned anchor and its profile is never fetched', async () => {
    getByIdsMock.mockResolvedValue(new Map<string, { id: string; is_ai: boolean; ai_kind: string | null; nickname: string }>([
      ['human-1', { id: 'human-1', is_ai: false, ai_kind: null, nickname: 'Human' }],
      ['ephemeral-1', { id: 'ephemeral-1', is_ai: true, ai_kind: 'ephemeral', nickname: 'AI' }],
    ]));

    const { buildParticipantPayloads } = await import('../../src/realtime/services/match-participants.helpers.js');
    const payloads = await buildParticipantPayloads(
      [{ user_id: 'human-1', seat: 1 }, { user_id: 'ephemeral-1', seat: 2 }],
      'ranked',
      { aiAnchorRp: ANCHOR_RP },
    );

    const byId = new Map(payloads.map((p) => [p.userId, p]));
    expect(byId.get('ephemeral-1')?.rankPoints).toBe(ANCHOR_RP);
    // The ephemeral bot's profile is skipped (only the human's is ensured).
    expect(ensureProfileMock).toHaveBeenCalledWith('human-1');
    expect(ensureProfileMock).not.toHaveBeenCalledWith('ephemeral-1');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';

// TEST-E1 (BUG-1): a ranked match that abandons as a no-contest (both players
// gone, progress undecidable) must refund every HUMAN participant's ranked
// ticket — matching the single-forfeiter early-forfeit cancel. Previously the
// abandon path skipped the refund, so a round-1 double-drop silently cost both
// players a ticket.

const refundRankedTicketsMock = vi.fn();
const getByIdsMock = vi.fn();
const abandonMatchWithCompleteLockMock = vi.fn();
const cleanupKeysMock = vi.fn();
const cancelHalftimeMock = vi.fn();

vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: (...a: unknown[]) => refundRankedTicketsMock(...a) },
}));
vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...a: unknown[]) => getByIdsMock(...a) },
}));
vi.mock('../../src/modules/matches/matches.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/matches/matches.service.js')>();
  return { ...actual }; // keep the real resolveMatchVariant
});
vi.mock('../../src/realtime/possession-match-flow.js', () => ({
  cancelPossessionHalftimeTimer: (...a: unknown[]) => cancelHalftimeMock(...a),
}));

// match-cache / lock cleanup helpers used by the abandon path — stub to no-ops.
vi.mock('../../src/realtime/match-cache.js', () => ({
  cleanupPossessionTerminalRedisKeys: (...a: unknown[]) => cleanupKeysMock(...a),
  possessionTerminalCleanupKeys: vi.fn(() => []),
}));

vi.mock('../../src/realtime/services/match-terminal.service.js', () => ({
  abandonMatchWithCompleteLock: (...a: unknown[]) => abandonMatchWithCompleteLockMock(...a),
}));

function createIo() {
  const emit = vi.fn();
  return { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
}

describe('abandonPossessionTerminalMatch — no-contest ticket refund', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    abandonMatchWithCompleteLockMock.mockResolvedValue({ abandoned: true });
    refundRankedTicketsMock.mockResolvedValue({ wallets: {} });
  });

  it('refunds both humans on a ranked no-contest abandon', async () => {
    const { abandonPossessionTerminalMatch } = await import('../../src/realtime/services/match-disconnect.service.js');
    getByIdsMock.mockResolvedValue(
      new Map([
        ['u1', { id: 'u1', is_ai: false }],
        ['u2', { id: 'u2', is_ai: false }],
      ])
    );
    const match = {
      id: 'm1',
      mode: 'ranked',
      state_payload: { variant: 'ranked_sim' },
    } as never;
    const roster = [{ user_id: 'u1' }, { user_id: 'u2' }] as never;

    const ok = await abandonPossessionTerminalMatch(createIo(), match, roster, 'disconnect_grace_expired');

    expect(ok).toBe(true);
    expect(refundRankedTicketsMock).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('excludes the AI opponent from the refund (only the human is refunded)', async () => {
    const { abandonPossessionTerminalMatch } = await import('../../src/realtime/services/match-disconnect.service.js');
    getByIdsMock.mockResolvedValue(
      new Map([
        ['u1', { id: 'u1', is_ai: false }],
        ['ai-bot', { id: 'ai-bot', is_ai: true }],
      ])
    );
    const match = { id: 'm1', mode: 'ranked', state_payload: { variant: 'ranked_sim' } } as never;
    const roster = [{ user_id: 'u1' }, { user_id: 'ai-bot' }] as never;

    await abandonPossessionTerminalMatch(createIo(), match, roster, 'reconnect_limit');

    expect(refundRankedTicketsMock).toHaveBeenCalledWith(['u1']);
  });

  it('does NOT refund for a friendly (non-ranked) abandon', async () => {
    const { abandonPossessionTerminalMatch } = await import('../../src/realtime/services/match-disconnect.service.js');
    getByIdsMock.mockResolvedValue(new Map([['u1', { id: 'u1', is_ai: false }]]));
    const match = { id: 'm1', mode: 'friendly', state_payload: { variant: 'friendly_possession' } } as never;
    const roster = [{ user_id: 'u1' }, { user_id: 'u2' }] as never;

    await abandonPossessionTerminalMatch(createIo(), match, roster, 'disconnect_grace_expired');

    expect(refundRankedTicketsMock).not.toHaveBeenCalled();
  });

  it('does not refund when the abandon itself did not take (lock not acquired)', async () => {
    const { abandonPossessionTerminalMatch } = await import('../../src/realtime/services/match-disconnect.service.js');
    abandonMatchWithCompleteLockMock.mockResolvedValue({ abandoned: false });
    const match = { id: 'm1', mode: 'ranked', state_payload: { variant: 'ranked_sim' } } as never;
    const roster = [{ user_id: 'u1' }, { user_id: 'u2' }] as never;

    const ok = await abandonPossessionTerminalMatch(createIo(), match, roster, 'reconnect_limit');

    expect(ok).toBe(false);
    expect(refundRankedTicketsMock).not.toHaveBeenCalled();
  });
});

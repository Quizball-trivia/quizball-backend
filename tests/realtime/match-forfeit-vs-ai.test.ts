import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import type { MatchRow } from '../../src/modules/matches/matches.types.js';
import {
  canForfeitToPresentPlayers,
  type MatchPresenceResolution,
} from '../../src/realtime/services/match-presence.service.js';

// Regression: a human who drops vs an AI opponent must NOT forfeit the match to
// the bot. The AI is synthetically "present" (no socket to lose), so the lone
// absent human would otherwise lose by forfeit-first — even while leading on
// points (prod case Thenotorious vs qartlosii, 2026-06-19). Both terminal
// resolvers (live disconnect grace + orphan/stale) must skip forfeit-first when
// every present player is an AI and fall through to progress / no-contest.

const resolveMatchPresenceMock = vi.fn();
const completeFromProgressMock = vi.fn();
const finalizeForfeitMock = vi.fn();
const abandonWithLockMock = vi.fn();
const refundRankedTicketsMock = vi.fn();
const getByIdsMock = vi.fn();

vi.mock('../../src/realtime/services/match-presence.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-presence.service.js')>();
  return { ...actual, resolveMatchPresence: (...a: unknown[]) => resolveMatchPresenceMock(...a) };
});
vi.mock('../../src/realtime/possession-completion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/possession-completion.js')>();
  return { ...actual, completePossessionMatchFromProgress: (...a: unknown[]) => completeFromProgressMock(...a) };
});
vi.mock('../../src/realtime/services/match-forfeit.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-forfeit.service.js')>();
  return {
    ...actual,
    finalizeMatchAsForfeit: (...a: unknown[]) => finalizeForfeitMock(...a),
    buildOpponentForfeitPendingPayload: vi.fn(() => ({})),
  };
});
vi.mock('../../src/realtime/services/match-terminal.service.js', () => ({
  abandonMatchWithCompleteLock: (...a: unknown[]) => abandonWithLockMock(...a),
}));
vi.mock('../../src/realtime/services/match-final-results.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-final-results.service.js')>();
  return {
    ...actual,
    buildFinalResultsPayload: vi.fn(async () => null),
    emitFinalResultsToMatchParticipants: vi.fn(),
  };
});
vi.mock('../../src/realtime/match-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/match-cache.js')>();
  return { ...actual, getMatchCache: vi.fn(async () => null) };
});
// The orphan resolver's no-contest abandon path refunds ranked tickets to humans.
vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: (...a: unknown[]) => refundRankedTicketsMock(...a) },
}));
vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: { getByIds: (...a: unknown[]) => getByIdsMock(...a) },
}));

function createIo() {
  const emit = vi.fn();
  return { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
}

const HUMAN = 'human-1';
const BOT = 'ai-bot';
const roster = [{ user_id: HUMAN, seat: 1 }, { user_id: BOT, seat: 2 }] as never[];
const match = {
  id: 'm1', mode: 'ranked', status: 'active',
  state_payload: { phase: 'NORMAL_PLAY' }, current_q_index: 5,
} as unknown as MatchRow;

function presence(states: Array<{ id: string; present: boolean; reasons: string[] }>) {
  const playerStates = states.map((s) => ({
    player: { user_id: s.id }, userId: s.id, present: s.present, absent: !s.present, reasons: s.reasons,
  }));
  return {
    playerStates,
    presentPlayers: playerStates.filter((p) => p.present).map((p) => p.player),
    absentPlayers: playerStates.filter((p) => !p.present).map((p) => p.player),
  } as unknown as MatchPresenceResolution<{ user_id: string }>;
}

describe('canForfeitToPresentPlayers', () => {
  it('blocks a forfeit win when every present player is an AI', () => {
    expect(canForfeitToPresentPlayers(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
      { id: BOT, present: true, reasons: ['ai'] },
    ]))).toBe(false);
  });
  it('allows a forfeit win when a present player is human', () => {
    expect(canForfeitToPresentPlayers(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
      { id: 'human-2', present: true, reasons: ['room_socket'] },
    ]))).toBe(true);
  });
  it('blocks when there are no present players at all', () => {
    expect(canForfeitToPresentPlayers(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
    ]))).toBe(false);
  });
});

describe('resolvePossessionTerminalAfterDisconnect — never forfeit a human to an AI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completeFromProgressMock.mockResolvedValue({ completed: true, winnerId: HUMAN, decisionBasis: 'total_points' });
    finalizeForfeitMock.mockResolvedValue({ completed: true, winnerId: BOT, resultVersion: 1 });
  });

  it('AI-present + human dropped -> resolves from progress, no forfeit', async () => {
    const { resolvePossessionTerminalAfterDisconnect } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    resolveMatchPresenceMock.mockResolvedValue(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
      { id: BOT, present: true, reasons: ['ai'] },
    ]));
    const result = await resolvePossessionTerminalAfterDisconnect({
      io: createIo(), match, roster, cacheSnapshot: null,
      disconnectedUserIds: [HUMAN], source: 'disconnect_grace_expired',
    });
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ finalized: true, abandoned: false });
  });

  it('human opponent present -> forfeit-first still protects the human who stayed', async () => {
    const { resolvePossessionTerminalAfterDisconnect } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    const OTHER = 'human-2';
    const humanRoster = [{ user_id: HUMAN, seat: 1 }, { user_id: OTHER, seat: 2 }] as never[];
    resolveMatchPresenceMock.mockResolvedValue(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
      { id: OTHER, present: true, reasons: ['room_socket'] },
    ]));
    await resolvePossessionTerminalAfterDisconnect({
      io: createIo(), match, roster: humanRoster, cacheSnapshot: null,
      disconnectedUserIds: [HUMAN], source: 'disconnect_grace_expired',
    });
    expect(finalizeForfeitMock).toHaveBeenCalledOnce();
    expect(finalizeForfeitMock.mock.calls[0][0]).toMatchObject({ forfeitingUserId: HUMAN });
    expect(completeFromProgressMock).not.toHaveBeenCalled();
  });
});

describe('resolveOrphanPossessionMatchTerminal — same guard on the stale/orphan path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completeFromProgressMock.mockResolvedValue({ completed: true, winnerId: HUMAN, decisionBasis: 'total_points' });
    finalizeForfeitMock.mockResolvedValue({ completed: true, winnerId: BOT, resultVersion: 1 });
    abandonWithLockMock.mockResolvedValue({ abandoned: true });
    refundRankedTicketsMock.mockResolvedValue({ wallets: {} });
    getByIdsMock.mockResolvedValue(new Map([
      [HUMAN, { id: HUMAN, is_ai: false }],
      [BOT, { id: BOT, is_ai: true }],
    ]));
  });

  it('AI-present + human stale-absent -> resolves from progress, no forfeit to bot', async () => {
    const { resolveOrphanPossessionMatchTerminal } = await import(
      '../../src/realtime/services/match-orphan-resolver.service.js'
    );
    resolveMatchPresenceMock.mockResolvedValue(presence([
      { id: HUMAN, present: false, reasons: ['stale_missing_signal'] },
      { id: BOT, present: true, reasons: ['ai'] },
    ]));
    const result = await resolveOrphanPossessionMatchTerminal({
      io: createIo(), match, roster, source: 'session_guard_orphan',
    });
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('completed_from_progress');
  });

  it('AI-present + undecidable progress -> abandons AND refunds the human ranked ticket', async () => {
    // The AI-forfeit guard routes this away from forfeit; progress can't decide
    // (no answers). It must abandon as a no-contest and refund the human — NOT
    // silently cost them a ticket (CodeRabbit finding on the orphan abandon path).
    const { resolveOrphanPossessionMatchTerminal } = await import(
      '../../src/realtime/services/match-orphan-resolver.service.js'
    );
    resolveMatchPresenceMock.mockResolvedValue(presence([
      { id: HUMAN, present: false, reasons: ['stale_missing_signal'] },
      { id: BOT, present: true, reasons: ['ai'] },
    ]));
    completeFromProgressMock.mockResolvedValue({ completed: false, reason: 'undecidable' });

    const result = await resolveOrphanPossessionMatchTerminal({
      io: createIo(), match, roster, source: 'session_guard_orphan',
    });

    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(abandonWithLockMock).toHaveBeenCalledWith('m1');
    expect(refundRankedTicketsMock).toHaveBeenCalledWith([HUMAN]);
    expect(result.outcome).toBe('abandoned');
  });
});

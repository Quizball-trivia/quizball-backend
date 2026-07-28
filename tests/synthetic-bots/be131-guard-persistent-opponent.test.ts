/**
 * Regression (be#131 family, deep): a human who drops vs a PERSISTENT roster bot
 * must NOT forfeit the match to the bot — byte-identical to the ephemeral-AI
 * case. Persistent bots are is_ai=true, so the presence layer marks them
 * synthetically "present" (reason 'ai') and canForfeitToPresentPlayers blocks
 * the forfeit-first win; the terminal resolver falls through to progress /
 * no-contest exactly as with an ephemeral bot.
 *
 * This drives the REAL resolvePossessionTerminalAfterDisconnect flow (not just
 * the classifier), with a persistent-bot opponent, and confirms the added
 * reservation release runs on the direct-abandon terminal path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';
import type { QuizballServer } from '../../src/realtime/socket-server.js';
import type { MatchRow } from '../../src/modules/matches/matches.types.js';
import {
  canForfeitToPresentPlayers,
  type MatchPresenceResolution,
} from '../../src/realtime/services/match-presence.service.js';
import { isPersistentBot, isRankedSettleEligible } from '../../src/modules/users/ai-classification.js';

const resolveMatchPresenceMock = vi.fn();
const completeFromProgressMock = vi.fn();
const finalizeForfeitMock = vi.fn();
const isRankedEarlyForfeitMatchMock = vi.fn(
  (m: MatchRow, snap?: { currentQIndex?: number } | null) =>
    m.mode === 'ranked' && (snap?.currentQIndex ?? m.current_q_index) < 2,
);
const abandonWithLockMock = vi.fn();
const releaseByMatchMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/realtime/services/match-presence.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-presence.service.js')>();
  return { ...actual, resolveMatchPresence: (...a: unknown[]) => resolveMatchPresenceMock(...a) };
});
vi.mock('../../src/realtime/possession-completion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/possession-completion.js')>();
  return { ...actual, completePossessionMatchFromProgress: (...a: unknown[]) => completeFromProgressMock(...a) };
});
vi.mock('../../src/realtime/services/match-forfeit.service.js', () => ({
  finalizeMatchAsForfeit: (...a: unknown[]) => finalizeForfeitMock(...a),
  isRankedEarlyForfeitMatch: (...a: unknown[]) => isRankedEarlyForfeitMatchMock(...a),
  buildOpponentForfeitPendingPayload: vi.fn(() => ({})),
  buildReconnectLimitForfeitPendingPayload: vi.fn(() => ({})),
  setForfeitPendingForUser: vi.fn(),
  parseForfeitPendingPayload: vi.fn(() => null),
  handleMatchForfeit: vi.fn(),
  emitPendingForfeitIfAny: vi.fn(),
  matchForfeitKey: vi.fn((matchId: string) => `match:${matchId}:forfeit`),
}));
vi.mock('../../src/realtime/services/match-terminal.service.js', () => ({
  abandonMatchWithCompleteLock: (...a: unknown[]) => abandonWithLockMock(...a),
}));
vi.mock('../../src/realtime/services/match-final-results.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/services/match-final-results.service.js')>();
  return { ...actual, buildFinalResultsPayload: vi.fn(async () => null), emitFinalResultsToMatchParticipants: vi.fn() };
});
vi.mock('../../src/realtime/match-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/realtime/match-cache.js')>();
  return { ...actual, getMatchCache: vi.fn(async () => null) };
});
vi.mock('../../src/modules/store/store.service.js', () => ({
  storeService: { refundRankedTickets: vi.fn().mockResolvedValue(undefined) },
}));
// The persistent bot is is_ai=true; the human is not.
vi.mock('../../src/modules/users/users.repo.js', () => ({
  usersRepo: {
    getByIds: vi.fn(async () => new Map([
      ['human-1', { id: 'human-1', is_ai: false, ai_kind: null }],
      ['persistent-bot', { id: 'persistent-bot', is_ai: true, ai_kind: 'persistent' }],
    ])),
  },
}));
// Spy the settlement-gated release so we can assert the terminal path frees the bot.
vi.mock('../../src/modules/synthetic-bots/reservation.service.js', () => ({
  reservationService: {
    releaseIfSettled: (...a: unknown[]) => releaseByMatchMock(...a),
    releaseByMatch: vi.fn().mockResolvedValue(undefined),
    releaseByLobby: vi.fn().mockResolvedValue(undefined),
    releaseIfLobbyAbortable: vi.fn().mockResolvedValue(undefined),
  },
}));

function createIo(): QuizballServer {
  const emit = vi.fn();
  return { to: vi.fn(() => ({ emit })) } as unknown as QuizballServer;
}

const HUMAN = 'human-1';
const BOT = 'persistent-bot';
const roster = [{ user_id: HUMAN, seat: 1 }, { user_id: BOT, seat: 2 }] as never[];
const match = {
  id: 'm-persistent', mode: 'ranked', status: 'active',
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

describe('classifier sanity (persistent bot is AI for guards, settle-eligible for RP)', () => {
  it('isPersistentBot / isRankedSettleEligible distinguish the roster bot correctly', () => {
    const bot = { is_ai: true, ai_kind: 'persistent' };
    const human = { is_ai: false, ai_kind: null };
    const ephemeral = { is_ai: true, ai_kind: 'ephemeral' };
    expect(isPersistentBot(bot)).toBe(true);
    expect(isPersistentBot(human)).toBe(false);
    expect(isPersistentBot(ephemeral)).toBe(false);
    expect(isRankedSettleEligible(bot)).toBe(true);
    expect(isRankedSettleEligible(ephemeral)).toBe(false);
  });
});

describe('canForfeitToPresentPlayers with a persistent bot', () => {
  it('blocks a forfeit win when the only present player is a persistent bot (reason ai)', () => {
    expect(canForfeitToPresentPlayers(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
      { id: BOT, present: true, reasons: ['ai'] },
    ]))).toBe(false);
  });
});

describe('resolvePossessionTerminalAfterDisconnect — never forfeit a human to a PERSISTENT bot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    completeFromProgressMock.mockResolvedValue({ completed: true, winnerId: HUMAN, decisionBasis: 'total_points' });
    finalizeForfeitMock.mockResolvedValue({ completed: true, winnerId: BOT, resultVersion: 1 });
  });

  it('persistent-bot present + human dropped -> resolves from progress, no forfeit to the bot', async () => {
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
    // The human is NEVER forfeited to the persistent bot; progress resolves it.
    expect(finalizeForfeitMock).not.toHaveBeenCalled();
    expect(completeFromProgressMock).toHaveBeenCalledOnce();
    expect(result).toEqual({ finalized: true, abandoned: false });
  });

  it('both drop (undecidable) -> direct abandon path releases the persistent-bot reservation', async () => {
    const { resolvePossessionTerminalAfterDisconnect } = await import(
      '../../src/realtime/services/match-disconnect.service.js'
    );
    resolveMatchPresenceMock.mockResolvedValue(presence([
      { id: HUMAN, present: false, reasons: ['disconnect_key'] },
      { id: BOT, present: false, reasons: ['disconnect_key'] },
    ]));
    // Undecidable progress → abandon-as-no-contest (the direct-abandon terminal
    // path whose cleanup releases the reservation).
    completeFromProgressMock.mockResolvedValue({ completed: false });
    abandonWithLockMock.mockResolvedValue({ abandoned: true });

    await resolvePossessionTerminalAfterDisconnect({
      io: createIo(), match, roster, cacheSnapshot: null,
      disconnectedUserIds: [HUMAN, BOT], source: 'disconnect_grace_expired',
    });
    // The terminal cleanup released the bot's reservation by match id.
    expect(releaseByMatchMock).toHaveBeenCalledWith('m-persistent', 'disconnect_terminal');
  });
});

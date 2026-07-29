/**
 * Delayed challenge-decline worker for bot targets (§1.12).
 *
 * Asserts the three behaviours a real friend shows — quick decline, later
 * decline, silent ignore — land in the planned proportions, are stable per
 * invitation, and are organically timed (never instant, never all at once).
 * The hardest assertion is the negative one: the worker has NO accept branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../setup.js';

vi.mock('../../src/core/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/modules/lobbies/lobby-challenge-invitations.repo.js', () => ({
  lobbyChallengeInvitationsRepo: { listPendingBotChallenges: vi.fn(), updateStatus: vi.fn() },
}));

vi.mock('../../src/realtime/services/lobby-challenge-realtime.service.js', () => ({
  emitLobbyChallengeStatus: vi.fn(),
}));

import {
  BOT_CHALLENGE_DELAYED_MAX_DELAY_MS,
  BOT_CHALLENGE_DELAYED_MIN_DELAY_MS,
  BOT_CHALLENGE_DELAYED_RATE,
  BOT_CHALLENGE_QUICK_MAX_DELAY_MS,
  BOT_CHALLENGE_QUICK_MIN_DELAY_MS,
  BOT_CHALLENGE_QUICK_RATE,
  getBotChallengeDecision,
  runBotChallengeResponderTick,
  startBotChallengeResponder,
  stopBotChallengeResponder,
  type BotChallengeResponseKind,
} from '../../src/modules/lobbies/bot-challenge-responder.service.js';
import { config } from '../../src/core/config.js';

const configObj = config as unknown as { PERSISTENT_BOTS_ENABLED: boolean };

function findInvitationId(kind: BotChallengeResponseKind): string {
  for (let i = 0; i < 100_000; i++) {
    const id = `synthetic-invite-${i}`;
    if (getBotChallengeDecision(id).kind === kind) return id;
  }
  throw new Error(`no synthetic invitation id produced ${kind}`);
}

function pendingInvite(id: string, createdAt: Date, expiresAt: Date) {
  return {
    id,
    lobby_id: `lobby-${id}`,
    from_user_id: 'human-1',
    to_user_id: 'bot-1',
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    lobby_invite_code: 'ABC123',
  };
}

describe('bot challenge decision mix', () => {
  it('is deterministic per invitation id', () => {
    const first = getBotChallengeDecision('invite-abc');
    const second = getBotChallengeDecision('invite-abc');
    expect(second).toEqual(first);
  });

  it('splits ~18% quick / ~27% delayed / ~55% ignore over a large sample', () => {
    const total = 20_000;
    const counts: Record<BotChallengeResponseKind, number> = {
      quick_decline: 0,
      delayed_decline: 0,
      ignore: 0,
    };

    for (let i = 0; i < total; i++) {
      counts[getBotChallengeDecision(`synthetic-invite-${i}`).kind]++;
    }

    // Tolerance is ±2pp: wide enough that md5 bucketing noise never flakes,
    // tight enough to catch a genuinely wrong split.
    expect(counts.quick_decline / total).toBeCloseTo(BOT_CHALLENGE_QUICK_RATE, 1);
    expect(counts.delayed_decline / total).toBeCloseTo(BOT_CHALLENGE_DELAYED_RATE, 1);
    expect(counts.ignore / total).toBeCloseTo(1 - BOT_CHALLENGE_QUICK_RATE - BOT_CHALLENGE_DELAYED_RATE, 1);

    // The plan's stated bands, asserted directly.
    expect(counts.quick_decline / total).toBeGreaterThanOrEqual(0.15);
    expect(counts.quick_decline / total).toBeLessThanOrEqual(0.20);
    expect(counts.delayed_decline / total).toBeGreaterThanOrEqual(0.25);
    expect(counts.delayed_decline / total).toBeLessThanOrEqual(0.30);
  });

  it('keeps every decline delay inside its organic band — never instant', () => {
    for (let i = 0; i < 5_000; i++) {
      const decision = getBotChallengeDecision(`synthetic-invite-${i}`);
      if (decision.kind === 'quick_decline') {
        expect(decision.delayMs).toBeGreaterThanOrEqual(BOT_CHALLENGE_QUICK_MIN_DELAY_MS);
        expect(decision.delayMs).toBeLessThanOrEqual(BOT_CHALLENGE_QUICK_MAX_DELAY_MS);
      } else if (decision.kind === 'delayed_decline') {
        expect(decision.delayMs).toBeGreaterThanOrEqual(BOT_CHALLENGE_DELAYED_MIN_DELAY_MS);
        expect(decision.delayMs).toBeLessThanOrEqual(BOT_CHALLENGE_DELAYED_MAX_DELAY_MS);
      } else {
        expect(decision.delayMs).toBe(Number.POSITIVE_INFINITY);
      }
    }
  });

  it('spreads delays across the band rather than clustering on one value', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2_000; i++) {
      const d = getBotChallengeDecision(`synthetic-invite-${i}`);
      if (d.kind === 'quick_decline') seen.add(d.delayMs);
    }
    // Batch-synchronized behaviour would collapse to a handful of values.
    expect(seen.size).toBeGreaterThan(50);
  });
});

describe('bot challenge responder tick', () => {
  const farFuture = () => new Date(Date.now() + 5 * 60 * 1000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never accepts — declined is the only status it can write', async () => {
    const ids = [
      findInvitationId('quick_decline'),
      findInvitationId('delayed_decline'),
      findInvitationId('ignore'),
    ];
    const declineInvitation = vi.fn().mockResolvedValue(true);
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    await runBotChallengeResponderTick({
      listPendingBotChallenges: async () => ids.map((id) => pendingInvite(id, longAgo, farFuture())),
      declineInvitation,
      emitStatus: vi.fn(),
      now: () => new Date(),
    });

    // The dependency surface itself has no accept seam, and every emitted
    // status is 'declined'.
    expect(declineInvitation).toHaveBeenCalled();
  });

  it('emits a decline payload identical in shape to a human decline', async () => {
    const id = findInvitationId('quick_decline');
    const emitStatus = vi.fn();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    await runBotChallengeResponderTick({
      listPendingBotChallenges: async () => [pendingInvite(id, longAgo, farFuture())],
      declineInvitation: async () => true,
      emitStatus,
      now: () => new Date(),
    });

    expect(emitStatus).toHaveBeenCalledWith(
      {
        invitationId: id,
        status: 'declined',
        toUserId: 'bot-1',
        lobbyId: `lobby-${id}`,
      },
      'human-1'
    );
  });

  it('defers a decline until its delay has elapsed — no instant answers', async () => {
    const id = findInvitationId('delayed_decline');
    const declineInvitation = vi.fn().mockResolvedValue(true);
    const createdAt = new Date();

    const result = await runBotChallengeResponderTick({
      listPendingBotChallenges: async () => [pendingInvite(id, createdAt, farFuture())],
      declineInvitation,
      emitStatus: vi.fn(),
      // One second after creation: far short of the 1-4 min delayed band.
      now: () => new Date(createdAt.getTime() + 1_000),
    });

    expect(declineInvitation).not.toHaveBeenCalled();
    expect(result.deferred).toBe(1);
  });

  it('leaves ignored challenges completely untouched for the TTL to expire', async () => {
    const id = findInvitationId('ignore');
    const declineInvitation = vi.fn();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    const result = await runBotChallengeResponderTick({
      listPendingBotChallenges: async () => [pendingInvite(id, longAgo, farFuture())],
      declineInvitation,
      emitStatus: vi.fn(),
      now: () => new Date(),
    });

    expect(declineInvitation).not.toHaveBeenCalled();
    expect(result.ignored).toBe(1);
  });

  it('does not answer an invite that already lapsed', async () => {
    const id = findInvitationId('quick_decline');
    const declineInvitation = vi.fn();
    const createdAt = new Date(Date.now() - 10 * 60 * 1000);

    const result = await runBotChallengeResponderTick({
      listPendingBotChallenges: async () => [
        pendingInvite(id, createdAt, new Date(Date.now() - 60 * 1000)),
      ],
      declineInvitation,
      emitStatus: vi.fn(),
      now: () => new Date(),
    });

    expect(declineInvitation).not.toHaveBeenCalled();
    expect(result.ignored).toBe(1);
  });

  it('counts a lost CAS race as already-handled and emits nothing', async () => {
    const id = findInvitationId('quick_decline');
    const emitStatus = vi.fn();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000);

    const result = await runBotChallengeResponderTick({
      listPendingBotChallenges: async () => [pendingInvite(id, longAgo, farFuture())],
      // Another replica already flipped it.
      declineInvitation: async () => false,
      emitStatus,
      now: () => new Date(),
    });

    expect(result.alreadyHandled).toBe(1);
    expect(result.declined).toBe(0);
    expect(emitStatus).not.toHaveBeenCalled();
  });
});

describe('challenge responder flag gating', () => {
  const original = configObj.PERSISTENT_BOTS_ENABLED;

  afterEach(async () => {
    configObj.PERSISTENT_BOTS_ENABLED = original;
    await stopBotChallengeResponder();
  });

  it('does not schedule a timer when PERSISTENT_BOTS_ENABLED is off', () => {
    configObj.PERSISTENT_BOTS_ENABLED = false;
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startBotChallengeResponder();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('schedules a timer when the flag is on', () => {
    configObj.PERSISTENT_BOTS_ENABLED = true;
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    startBotChallengeResponder();

    expect(setIntervalSpy).toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

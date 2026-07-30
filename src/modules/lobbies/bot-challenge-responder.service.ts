import { createHash } from 'node:crypto';
import { logger } from '../../core/logger.js';
import { config } from '../../core/config.js';
import {
  lobbyChallengeInvitationsRepo,
  type PendingBotChallengeInvitationRow,
} from './lobby-challenge-invitations.repo.js';
import { emitLobbyChallengeStatus } from '../../realtime/services/lobby-challenge-realtime.service.js';

/**
 * Delayed challenge-decline worker for bot targets (PERSISTENT-BOTS-PLAN §1.12).
 *
 * A befriended bot that silently swallowed every challenge — or rejected it
 * instantly at send time — is a tell. Real friends behave three ways, so the
 * bot does too, chosen hash-deterministically per invitation:
 *
 *   QUICK   (~18%)  decline after 5-30s   — "saw it, said no"
 *   DELAYED (~27%)  decline after 1-4min  — "noticed it a while later"
 *   IGNORE  (~55%)  no action at all      — the invite's own 5-minute TTL
 *                                           lazy-expires it, exactly as it
 *                                           does for an unresponsive human.
 *
 * The ignore branch is why this worker needs no cleanup cron: it never writes a
 * row, and expiry is already lazy on read/touch.
 *
 * INVARIANT: this worker can only ever write 'declined'. There is no accept
 * branch, because the friendly-possession engine cannot drive a bot (v1). The
 * complementary half of that invariant — a HUMAN cannot accept on a bot's
 * behalf either — is enforced in `lobby-challenge.service.ts:acceptChallenge`.
 */

export const BOT_CHALLENGE_RESPONDER_INTERVAL_MS = 15 * 1000;

export const BOT_CHALLENGE_QUICK_MIN_DELAY_MS = 5 * 1000;
export const BOT_CHALLENGE_QUICK_MAX_DELAY_MS = 30 * 1000;
export const BOT_CHALLENGE_DELAYED_MIN_DELAY_MS = 60 * 1000;
export const BOT_CHALLENGE_DELAYED_MAX_DELAY_MS = 4 * 60 * 1000;

/** Mix boundaries on the unit interval: [0,0.18) quick, [0.18,0.45) delayed, rest ignore. */
export const BOT_CHALLENGE_QUICK_RATE = 0.18;
export const BOT_CHALLENGE_DELAYED_RATE = 0.27;

const UINT32_RANGE = 0x1_0000_0000;

export type BotChallengeResponseKind = 'quick_decline' | 'delayed_decline' | 'ignore';

export interface BotChallengeDecision {
  kind: BotChallengeResponseKind;
  /** Delay from invite creation before the decline lands; Infinity when ignoring. */
  delayMs: number;
  decisionValue: number;
  delayValue: number;
}

export interface BotChallengeResponderTickResult {
  scanned: number;
  ignored: number;
  deferred: number;
  attempted: number;
  declined: number;
  alreadyHandled: number;
  failed: number;
}

interface BotChallengeResponderDependencies {
  listPendingBotChallenges: () => Promise<PendingBotChallengeInvitationRow[]>;
  declineInvitation: (invitationId: string) => Promise<boolean>;
  emitStatus: typeof emitLobbyChallengeStatus;
  now: () => Date;
}

let timer: NodeJS.Timeout | null = null;
let inFlightTick: Promise<void> | null = null;

function parseHashSegment(hash: string, start: number): number {
  return Number.parseInt(hash.slice(start, start + 8), 16);
}

function scaleDelay(delayValue: number, minMs: number, maxMs: number): number {
  return minMs + Math.floor((delayValue / UINT32_RANGE) * (maxMs - minMs + 1));
}

/**
 * Stable per-(bot, challenger) response. Keyed on the invitation id — which is
 * unique per challenge — so a re-challenge after a decline draws a fresh
 * behaviour, exactly as a real friend would answer differently next time.
 */
export function getBotChallengeDecision(invitationId: string): BotChallengeDecision {
  const hash = createHash('md5').update(invitationId).digest('hex');
  const decisionValue = parseHashSegment(hash, 0);
  const delayValue = parseHashSegment(hash, 8);
  const roll = decisionValue / UINT32_RANGE;

  if (roll < BOT_CHALLENGE_QUICK_RATE) {
    return {
      kind: 'quick_decline',
      delayMs: scaleDelay(delayValue, BOT_CHALLENGE_QUICK_MIN_DELAY_MS, BOT_CHALLENGE_QUICK_MAX_DELAY_MS),
      decisionValue,
      delayValue,
    };
  }

  if (roll < BOT_CHALLENGE_QUICK_RATE + BOT_CHALLENGE_DELAYED_RATE) {
    return {
      kind: 'delayed_decline',
      delayMs: scaleDelay(delayValue, BOT_CHALLENGE_DELAYED_MIN_DELAY_MS, BOT_CHALLENGE_DELAYED_MAX_DELAY_MS),
      decisionValue,
      delayValue,
    };
  }

  return { kind: 'ignore', delayMs: Number.POSITIVE_INFINITY, decisionValue, delayValue };
}

function isReadyToDecline(
  invite: PendingBotChallengeInvitationRow,
  decision: BotChallengeDecision,
  nowMs: number
): boolean {
  const createdAtMs = Date.parse(invite.created_at);
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs >= decision.delayMs;
}

function buildTickResult(scanned: number): BotChallengeResponderTickResult {
  return {
    scanned,
    ignored: 0,
    deferred: 0,
    attempted: 0,
    declined: 0,
    alreadyHandled: 0,
    failed: 0,
  };
}

export async function runBotChallengeResponderTick(
  overrides: Partial<BotChallengeResponderDependencies> = {}
): Promise<BotChallengeResponderTickResult> {
  const deps: BotChallengeResponderDependencies = {
    listPendingBotChallenges: () => lobbyChallengeInvitationsRepo.listPendingBotChallenges(),
    declineInvitation: async (invitationId) =>
      // The repo CAS only flips a row that is STILL 'pending', so a challenge
      // canceled or expired between scan and write is a no-op, and concurrent
      // replicas cannot both emit a decline for the same invitation.
      Boolean(await lobbyChallengeInvitationsRepo.updateStatus(invitationId, 'declined')),
    emitStatus: emitLobbyChallengeStatus,
    now: () => new Date(),
    ...overrides,
  };

  const nowMs = deps.now().getTime();
  const invites = await deps.listPendingBotChallenges();
  const result = buildTickResult(invites.length);

  for (const invite of invites) {
    const decision = getBotChallengeDecision(invite.id);
    if (decision.kind === 'ignore') {
      result.ignored++;
      continue;
    }

    if (!isReadyToDecline(invite, decision, nowMs)) {
      result.deferred++;
      continue;
    }

    // Never answer after the invite has already lapsed: the challenger's client
    // has moved on, and a late 'declined' would contradict the lazy 'expired'
    // the read path already reports.
    if (Date.parse(invite.expires_at) <= nowMs) {
      result.ignored++;
      continue;
    }

    result.attempted++;
    try {
      const declined = await deps.declineInvitation(invite.id);
      if (!declined) {
        result.alreadyHandled++;
        continue;
      }
      result.declined++;
      deps.emitStatus(
        {
          invitationId: invite.id,
          status: 'declined',
          toUserId: invite.to_user_id,
          lobbyId: invite.lobby_id,
        },
        invite.from_user_id
      );
    } catch (error) {
      result.failed++;
      logger.warn({ error, invitationId: invite.id }, 'Bot challenge responder failed to decline');
    }
  }

  if (result.declined > 0) {
    logger.info(
      { declined: result.declined, scanned: result.scanned, alreadyHandled: result.alreadyHandled },
      'Bot challenge responder declined challenges'
    );
  }

  return result;
}

function scheduleTick(): void {
  if (inFlightTick) return;
  const tick = (async () => {
    try {
      await runBotChallengeResponderTick();
    } catch (error) {
      logger.error({ error }, 'Bot challenge responder tick failed');
    } finally {
      inFlightTick = null;
    }
  })();
  inFlightTick = tick;
}

export function startBotChallengeResponder(): void {
  if (timer) return;
  // Flag-off parity: with PERSISTENT_BOTS_ENABLED off no roster bot is
  // befriended or challengeable, so the worker would only ever scan an empty
  // set. Not starting it at all keeps the flag-off footprint exactly zero.
  if (!config.PERSISTENT_BOTS_ENABLED) {
    logger.info('Bot challenge responder disabled (PERSISTENT_BOTS_ENABLED off)');
    return;
  }
  timer = setInterval(scheduleTick, BOT_CHALLENGE_RESPONDER_INTERVAL_MS);
  timer.unref?.();
  scheduleTick();
  logger.info('Bot challenge responder started');
}

export async function stopBotChallengeResponder(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  const activeTick = inFlightTick;
  if (activeTick) {
    await activeTick;
  }
}

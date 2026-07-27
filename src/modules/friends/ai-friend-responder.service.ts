import { createHash } from 'node:crypto';
import { logger } from '../../core/logger.js';
import { friendsRepo, type PendingAiFriendRequestRow } from './friends.repo.js';

export const AI_FRIEND_RESPONDER_INTERVAL_MS = 10 * 60 * 1000;
export const AI_FRIEND_REQUEST_MIN_DELAY_MS = 2 * 60 * 1000;
export const AI_FRIEND_REQUEST_MAX_DELAY_MS = 6 * 60 * 60 * 1000;

const UINT32_RANGE = 0x1_0000_0000;
const ACCEPT_RATE = 0.3;

export interface AiFriendResponderDecision {
  shouldAccept: boolean;
  delayMs: number;
  decisionValue: number;
  delayValue: number;
}

export interface AiFriendResponderTickResult {
  scanned: number;
  ignored: number;
  deferred: number;
  attempted: number;
  accepted: number;
  alreadyHandled: number;
  inactiveUser: number;
  failed: number;
}

type AcceptRequestResult = 'accepted' | 'not_found' | 'inactive_user';

interface AiFriendResponderDependencies {
  listPendingAiFriendRequests: () => Promise<PendingAiFriendRequestRow[]>;
  acceptRequest: (requestId: string, receiverUserId: string) => Promise<AcceptRequestResult>;
  now: () => Date;
}

let timer: NodeJS.Timeout | null = null;
let inFlightTick: Promise<void> | null = null;

function parseHashSegment(hash: string, start: number): number {
  return Number.parseInt(hash.slice(start, start + 8), 16);
}

export function getAiFriendResponderDecision(requestId: string): AiFriendResponderDecision {
  const hash = createHash('md5').update(requestId).digest('hex');
  const decisionValue = parseHashSegment(hash, 0);
  const delayValue = parseHashSegment(hash, 8);
  const delayRangeMs = AI_FRIEND_REQUEST_MAX_DELAY_MS - AI_FRIEND_REQUEST_MIN_DELAY_MS;

  return {
    shouldAccept: decisionValue / UINT32_RANGE < ACCEPT_RATE,
    delayMs: AI_FRIEND_REQUEST_MIN_DELAY_MS + Math.floor((delayValue / UINT32_RANGE) * (delayRangeMs + 1)),
    decisionValue,
    delayValue,
  };
}

function isReadyToAccept(
  request: PendingAiFriendRequestRow,
  decision: AiFriendResponderDecision,
  nowMs: number
): boolean {
  const createdAtMs = Date.parse(request.created_at);
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs >= decision.delayMs;
}

function buildTickResult(scanned: number): AiFriendResponderTickResult {
  return {
    scanned,
    ignored: 0,
    deferred: 0,
    attempted: 0,
    accepted: 0,
    alreadyHandled: 0,
    inactiveUser: 0,
    failed: 0,
  };
}

export async function runAiFriendResponderTick(
  overrides: Partial<AiFriendResponderDependencies> = {}
): Promise<AiFriendResponderTickResult> {
  const deps: AiFriendResponderDependencies = {
    listPendingAiFriendRequests: () => friendsRepo.listPendingAiFriendRequests(),
    acceptRequest: (requestId, receiverUserId) => friendsRepo.acceptRequest(requestId, receiverUserId),
    now: () => new Date(),
    ...overrides,
  };

  const nowMs = deps.now().getTime();
  const requests = await deps.listPendingAiFriendRequests();
  const result = buildTickResult(requests.length);

  for (const request of requests) {
    const decision = getAiFriendResponderDecision(request.id);
    if (!decision.shouldAccept) {
      result.ignored++;
      continue;
    }

    if (!isReadyToAccept(request, decision, nowMs)) {
      result.deferred++;
      continue;
    }

    result.attempted++;
    try {
      const acceptResult = await deps.acceptRequest(request.id, request.receiver_user_id);
      switch (acceptResult) {
        case 'accepted':
          result.accepted++;
          break;
        case 'not_found':
          result.alreadyHandled++;
          break;
        case 'inactive_user':
          result.inactiveUser++;
          break;
      }
    } catch (error) {
      result.failed++;
      logger.warn({ error, requestId: request.id }, 'AI friend responder failed to accept request');
    }
  }

  if (result.accepted > 0) {
    logger.info(
      {
        accepted: result.accepted,
        scanned: result.scanned,
        alreadyHandled: result.alreadyHandled,
        inactiveUser: result.inactiveUser,
        failed: result.failed,
      },
      'AI friend responder accepted friend requests'
    );
  }

  return result;
}

function scheduleTick(): void {
  if (inFlightTick) return;
  const tick = (async () => {
    try {
      await runAiFriendResponderTick();
    } catch (error) {
      logger.error({ error }, 'AI friend responder tick failed');
    } finally {
      inFlightTick = null;
    }
  })();
  inFlightTick = tick;
}

export function startAiFriendResponder(): void {
  if (timer) return;
  timer = setInterval(scheduleTick, AI_FRIEND_RESPONDER_INTERVAL_MS);
  timer.unref?.();
  scheduleTick();
  logger.info('AI friend responder started');
}

export async function stopAiFriendResponder(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  const activeTick = inFlightTick;
  if (activeTick) {
    await activeTick;
  }
}

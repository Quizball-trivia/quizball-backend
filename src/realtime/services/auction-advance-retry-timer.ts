import { harnessDelayMs } from '../../core/harness-timing.js';
import {
  scheduleRealtimeTimer,
  type RealtimeTimerPayload,
} from '../realtime-timer-scheduler.js';
import type { AuctionUiReadyPhase } from '../socket.types.js';

const AUCTION_ADVANCE_RETRY_MS = 4_000;
const AUCTION_ADVANCE_RETRY_HARNESS_MS = 100;

export type AuctionAdvanceRetryTimerPayload = Extract<
  RealtimeTimerPayload,
  { kind: 'auction_advance_retry' }
>;

export async function scheduleAuctionAdvanceRetryTimer(
  matchId: string,
  phaseHint: AuctionUiReadyPhase,
  dueAt = new Date(
    Date.now() + harnessDelayMs(
      AUCTION_ADVANCE_RETRY_MS,
      AUCTION_ADVANCE_RETRY_HARNESS_MS,
    ),
  ),
): Promise<void> {
  await scheduleRealtimeTimer(
    'auction_advance_retry',
    matchId,
    dueAt,
    {
      kind: 'auction_advance_retry',
      matchId,
      phaseHint,
    },
  );
}

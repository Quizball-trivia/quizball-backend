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
    // Keyed per phase: scheduling by matchId alone let a later phase's retry
    // overwrite an earlier phase's armed payload, and the redrive then no-op'd
    // on the phase mismatch — stranding clue reveals until a reconnect.
    `${matchId}:${phaseHint}`,
    dueAt,
    {
      kind: 'auction_advance_retry',
      matchId,
      phaseHint,
    },
  );
}

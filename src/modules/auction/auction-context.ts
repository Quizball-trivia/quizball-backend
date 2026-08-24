import { randomUUID } from 'crypto';
import { getRandom } from '../../core/rng.js';
import {
  CLUE_STUDY_MS,
  OPENING_TURN_MS,
  RAISE_TURN_MS,
} from './auction.constants.js';

export interface AuctionEngineContext {
  now?: () => Date;
  random?: () => number;
  createId?: (kind: 'match' | 'round' | 'bot-seat') => string;
  clueStudyMs?: number;
  openingTurnMs?: number;
  raiseTurnMs?: number;
}

export interface AuctionContextOptions {
  now?: Date;
  context?: AuctionEngineContext;
}

export interface ResolvedAuctionEngineContext {
  now: () => Date;
  nowIso: () => string;
  random: () => number;
  createId: (kind: 'match' | 'round' | 'bot-seat') => string;
  clueStudyMs: number;
  openingTurnMs: number;
  raiseTurnMs: number;
}

export function resolveAuctionContext(
  input?: AuctionEngineContext | AuctionContextOptions
): ResolvedAuctionEngineContext {
  const options = isAuctionContextOptions(input) ? input : undefined;
  const context = options?.context ?? (input as AuctionEngineContext | undefined);
  const now = context?.now ?? (() => options?.now ?? new Date());

  return {
    now,
    nowIso: () => now().toISOString(),
    random: context?.random ?? getRandom,
    createId: context?.createId ?? (() => randomUUID()),
    clueStudyMs: context?.clueStudyMs ?? CLUE_STUDY_MS,
    openingTurnMs: context?.openingTurnMs ?? OPENING_TURN_MS,
    raiseTurnMs: context?.raiseTurnMs ?? RAISE_TURN_MS,
  };
}

function isAuctionContextOptions(
  input?: AuctionEngineContext | AuctionContextOptions
): input is AuctionContextOptions {
  return Boolean(
    input
    && (
      'context' in input
      || input.now instanceof Date
    )
  );
}

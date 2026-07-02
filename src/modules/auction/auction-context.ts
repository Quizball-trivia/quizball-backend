import { randomUUID } from 'crypto';
import { getRandom } from '../../core/rng.js';

export interface AuctionEngineContext {
  now?: () => Date;
  random?: () => number;
  createId?: (kind: 'match' | 'round' | 'bot-seat') => string;
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

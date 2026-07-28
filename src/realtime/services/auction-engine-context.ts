import { harnessDelayMs } from '../../core/harness-timing.js';
import {
  resolveAuctionContext,
  type AuctionContextOptions,
  type AuctionEngineContext,
  type ResolvedAuctionEngineContext,
} from '../../modules/auction/auction-context.js';
import {
  CLUE_STUDY_MS,
  OPENING_TURN_MS,
  RAISE_TURN_MS,
} from '../../modules/auction/auction.constants.js';

const HARNESS_CLUE_STUDY_MS = 150;
const HARNESS_TURN_MS = 400;

export function resolveRealtimeAuctionContext(
  input?: AuctionEngineContext | AuctionContextOptions
): ResolvedAuctionEngineContext {
  const context = getExplicitContext(input);
  return resolveAuctionContext({
    ...context,
    now: context?.now ?? getOptionsNow(input) ?? (() => new Date(Date.now())),
    clueStudyMs: context?.clueStudyMs ?? harnessDelayMs(CLUE_STUDY_MS, HARNESS_CLUE_STUDY_MS),
    openingTurnMs: context?.openingTurnMs ?? harnessDelayMs(OPENING_TURN_MS, HARNESS_TURN_MS),
    raiseTurnMs: context?.raiseTurnMs ?? harnessDelayMs(RAISE_TURN_MS, HARNESS_TURN_MS),
  });
}

function getExplicitContext(
  input?: AuctionEngineContext | AuctionContextOptions
): AuctionEngineContext | undefined {
  return isAuctionContextOptions(input)
    ? input.context
    : input as AuctionEngineContext | undefined;
}

function getOptionsNow(
  input?: AuctionEngineContext | AuctionContextOptions
): (() => Date) | undefined {
  return isAuctionContextOptions(input) && input.now instanceof Date
    ? () => input.now as Date
    : undefined;
}

function isAuctionContextOptions(
  input?: AuctionEngineContext | AuctionContextOptions
): input is AuctionContextOptions {
  return Boolean(input && ('context' in input || input.now instanceof Date));
}

import type { EventTrace } from './adapter.mjs';

export interface AuctionInvariantViolation {
  code: string;
  message: string;
  eventSeq?: number;
}

export interface AuctionInvariantResult {
  ok: boolean;
  violations: AuctionInvariantViolation[];
  facts: {
    matchStarted: number;
    matchFinished: number;
    clueRevealed: number;
    biddingStarted: number;
    turnStarted: number;
    roundRevealed: number;
    squadUpdated: number;
  };
}

const PRE_REVEAL_ROUND_EVENTS = new Set([
  'auction:round_started',
  'auction:clue_revealed',
  'auction:bidding_started',
  'auction:turn_started',
  'auction:bid_accepted',
  'auction:fold_accepted',
  'auction:turn_timeout',
]);

const HIDDEN_FOOTBALLER_KEYS = [
  'id',
  'clueCardId',
  'name',
  'trueValue',
  'imageUrl',
  'currentClub',
  'nationality',
];

export function checkAuctionInvariants(trace: EventTrace): AuctionInvariantResult {
  const violations: AuctionInvariantViolation[] = [];
  const facts = {
    matchStarted: trace.byEvent('auction:match_started').length,
    matchFinished: trace.byEvent('auction:match_finished').length,
    clueRevealed: trace.byEvent('auction:clue_revealed').length,
    biddingStarted: trace.byEvent('auction:bidding_started').length,
    turnStarted: trace.byEvent('auction:turn_started').length,
    roundRevealed: trace.byEvent('auction:round_revealed').length,
    squadUpdated: trace.byEvent('auction:squad_updated').length,
  };

  requireCount(facts.matchStarted, 1, 'match_started_count', 'Auction match should start exactly once', violations);
  requireCount(facts.matchFinished, 1, 'match_finished_count', 'Auction match should finish exactly once', violations);
  requireAtLeast(facts.clueRevealed, 3, 'clue_revealed_count', 'Auction should reveal clues through the timer flow', violations);
  requireAtLeast(facts.biddingStarted, 1, 'bidding_started_count', 'Auction should enter bidding at least once', violations);
  requireAtLeast(facts.turnStarted, 1, 'turn_started_count', 'Auction should start at least one bidding turn', violations);
  requireAtLeast(facts.roundRevealed, 1, 'round_revealed_count', 'Auction should reveal at least one won/unsold round', violations);
  requireAtLeast(facts.squadUpdated, 1, 'squad_updated_count', 'Auction should assign at least one player to a squad', violations);

  const seenClues = new Set<string>();
  const seenReveals = new Set<string>();
  for (const event of trace.events) {
    if (event.event === 'auction:clue_revealed') {
      const payload = event.payload as { roundId?: string; clueIndex?: number };
      const key = `${payload.roundId ?? 'missing'}:${payload.clueIndex ?? 'missing'}`;
      if (seenClues.has(key)) {
        violations.push({
          code: 'duplicate_clue_reveal',
          message: `Duplicate clue reveal for ${key}`,
          eventSeq: event.seq,
        });
      }
      seenClues.add(key);
    }

    if (event.event === 'auction:round_revealed') {
      const payload = event.payload as { roundId?: string; round?: { footballer?: unknown } };
      const key = payload.roundId ?? 'missing';
      if (seenReveals.has(key)) {
        violations.push({
          code: 'duplicate_round_reveal',
          message: `Duplicate round reveal for ${key}`,
          eventSeq: event.seq,
        });
      }
      seenReveals.add(key);
      const footballer = asRecord(payload.round?.footballer);
      if (!footballer?.name || typeof footballer.trueValue !== 'number' || footballer.trueValue <= 0) {
        violations.push({
          code: 'revealed_footballer_missing_identity',
          message: 'Revealed round payload should include footballer identity and true value',
          eventSeq: event.seq,
        });
      }
    }

    if (!PRE_REVEAL_ROUND_EVENTS.has(event.event)) continue;
    const round = asRecord((event.payload as { round?: unknown }).round);
    const footballer = asRecord(round?.footballer);
    if (!footballer) continue;
    if (round?.revealed === true) continue;
    for (const key of HIDDEN_FOOTBALLER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(footballer, key)) {
        violations.push({
          code: 'pre_reveal_identity_leak',
          message: `${event.event} leaked footballer.${key} before reveal`,
          eventSeq: event.seq,
        });
      }
    }
    if (typeof footballer.startingPrice !== 'number' || footballer.startingPrice <= 0) {
      violations.push({
        code: 'missing_starting_price',
        message: `${event.event} should expose a positive startingPrice before reveal`,
        eventSeq: event.seq,
      });
    }
  }

  const finished = trace.byEvent('auction:match_finished')[0]?.payload as {
    rankings?: Array<{ isComplete?: boolean; totalTrueValue?: number; budgetRemaining?: number }>;
    state?: { phase?: string };
  } | undefined;
  if (finished) {
    if (finished.state?.phase !== 'finished') {
      violations.push({
        code: 'final_state_not_finished',
        message: 'auction:match_finished payload state should be finished',
      });
    }
    if (!Array.isArray(finished.rankings) || finished.rankings.length !== 3) {
      violations.push({
        code: 'ranking_count',
        message: 'auction:match_finished should include exactly 3 rankings',
      });
    } else {
      for (const [index, ranking] of finished.rankings.entries()) {
        if (ranking.isComplete !== true) {
          violations.push({
            code: 'incomplete_final_squad',
            message: `Ranking ${index + 1} should have a complete squad in the seeded full-flow harness`,
          });
        }
        if (typeof ranking.totalTrueValue !== 'number' || ranking.totalTrueValue <= 0) {
          violations.push({
            code: 'invalid_final_true_value',
            message: `Ranking ${index + 1} should have a positive totalTrueValue`,
          });
        }
        if (typeof ranking.budgetRemaining !== 'number' || ranking.budgetRemaining < 0) {
          violations.push({
            code: 'negative_final_budget',
            message: `Ranking ${index + 1} should not have a negative budget`,
          });
        }
      }
    }
  }

  return { ok: violations.length === 0, violations, facts };
}

export function formatAuctionViolation(violation: AuctionInvariantViolation): string {
  const seq = violation.eventSeq === undefined ? '' : ` seq=${violation.eventSeq}`;
  return `[${violation.code}${seq}] ${violation.message}`;
}

function requireCount(
  actual: number,
  expected: number,
  code: string,
  message: string,
  violations: AuctionInvariantViolation[]
): void {
  if (actual === expected) return;
  violations.push({ code, message: `${message}; got ${actual}, expected ${expected}` });
}

function requireAtLeast(
  actual: number,
  expected: number,
  code: string,
  message: string,
  violations: AuctionInvariantViolation[]
): void {
  if (actual >= expected) return;
  violations.push({ code, message: `${message}; got ${actual}, expected at least ${expected}` });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

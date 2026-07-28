import { STARTING_BUDGET } from '../../src/modules/auction/auction.constants.js';
import { rankAuctionPlayers } from '../../src/modules/auction/auction-rules.js';
import type { AuctionPlayer } from '../../src/modules/auction/auction.types.js';
import type { EventTrace, TraceEvent } from './adapter.mjs';

export interface AuctionInvariantViolation {
  code: string;
  message: string;
  eventSeq?: number;
}

export interface AuctionInvariantOptions {
  userMatchIndexes?: Record<string, string | null>;
  requireProgress?: boolean;
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
    paused: number;
    resumed: number;
    forfeited: number;
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

const ACTION_EVENTS = new Set([
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

export function checkAuctionInvariants(
  trace: EventTrace,
  options: AuctionInvariantOptions = {}
): AuctionInvariantResult {
  const violations: AuctionInvariantViolation[] = [];
  const facts = {
    matchStarted: trace.byEvent('auction:match_started').length,
    matchFinished: trace.byEvent('auction:match_finished').length,
    clueRevealed: trace.byEvent('auction:clue_revealed').length,
    biddingStarted: trace.byEvent('auction:bidding_started').length,
    turnStarted: trace.byEvent('auction:turn_started').length,
    roundRevealed: trace.byEvent('auction:round_revealed').length,
    squadUpdated: trace.byEvent('auction:squad_updated').length,
    paused: trace.byEvent('auction:paused').length,
    resumed: trace.byEvent('auction:resume').length,
    forfeited: trace.byEvent('auction:player_forfeited').length,
  };

  requireCount(facts.matchStarted, 1, 'match_started_count', 'Auction match should start exactly once', violations);
  requireCount(facts.matchFinished, 1, 'match_finished_count', 'Auction match should finish exactly once', violations);
  if (options.requireProgress !== false) {
    requireAtLeast(facts.clueRevealed, 3, 'clue_revealed_count', 'Auction should reveal clues through the timer flow', violations);
    requireAtLeast(facts.biddingStarted, 1, 'bidding_started_count', 'Auction should enter bidding at least once', violations);
    requireAtLeast(facts.turnStarted, 1, 'turn_started_count', 'Auction should start at least one bidding turn', violations);
    requireAtLeast(facts.roundRevealed, 1, 'round_revealed_count', 'Auction should reveal at least one won/unsold round', violations);
    requireAtLeast(facts.squadUpdated, 1, 'squad_updated_count', 'Auction should assign at least one player to a squad', violations);
  }

  const terminalSeatSeq = new Map<string, number>();
  const seenClues = new Set<string>();
  const seenReveals = new Set<string>();
  for (const event of trace.events) {
    inspectHiddenInformation(event, seenClues, seenReveals, violations);
    inspectTerminalSeatEvent(event, terminalSeatSeq);
    inspectPostTerminalAction(event, terminalSeatSeq, violations);

    const serialized = safeSerialize(event.payload);
    if (
      event.event === 'auction:error'
      && (
        serialized.includes('AuctionMatchLockUnavailableError')
        || serialized.toLowerCase().includes('auction match lock unavailable')
      )
    ) {
      violations.push({
        code: 'auction_lock_unavailable',
        message: 'AuctionMatchLockUnavailableError escaped to a client action',
        eventSeq: event.seq,
      });
    }
  }

  const finished = trace.byEvent('auction:match_finished')[0]?.payload as FinishedPayload | undefined;
  if (finished) {
    inspectFinishedState(finished, violations);
    inspectBudgetConservation(finished, violations);
    inspectRankings(finished, violations);
  }

  for (const [userId, matchId] of Object.entries(options.userMatchIndexes ?? {})) {
    if (!matchId) continue;
    violations.push({
      code: 'orphaned_user_match_index',
      message: `Finished Auction left user-match index ${userId} -> ${matchId}`,
    });
  }

  return { ok: violations.length === 0, violations, facts };
}

export function formatAuctionViolation(violation: AuctionInvariantViolation): string {
  const seq = violation.eventSeq === undefined ? '' : ` seq=${violation.eventSeq}`;
  return `[${violation.code}${seq}] ${violation.message}`;
}

interface FinishedRanking {
  seatId: string;
  rank: number;
  isComplete?: boolean;
  totalTrueValue?: number;
  budgetRemaining?: number;
  player?: AuctionPlayer;
}

interface FinishedRound {
  winnerSeatId?: string | null;
  winningBid?: number;
}

interface FinishedPayload {
  rankings?: FinishedRanking[];
  state?: {
    phase?: string;
    seats?: AuctionPlayer[];
    completedRounds?: FinishedRound[];
  };
}

function inspectHiddenInformation(
  event: TraceEvent,
  seenClues: Set<string>,
  seenReveals: Set<string>,
  violations: AuctionInvariantViolation[]
): void {
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

  if (!PRE_REVEAL_ROUND_EVENTS.has(event.event)) return;
  const round = asRecord((event.payload as { round?: unknown }).round);
  const footballer = asRecord(round?.footballer);
  if (!footballer || round?.revealed === true) return;
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

function inspectTerminalSeatEvent(
  event: TraceEvent,
  terminalSeatSeq: Map<string, number>
): void {
  if (event.event === 'auction:player_forfeited') {
    const seatId = (event.payload as { seatId?: string }).seatId;
    if (seatId && !terminalSeatSeq.has(seatId)) terminalSeatSeq.set(seatId, event.seq);
    return;
  }
  if (event.event !== 'auction:squad_updated') return;
  const payload = event.payload as {
    seatId?: string;
    player?: { isEliminated?: boolean };
  };
  if (payload.seatId && payload.player?.isEliminated && !terminalSeatSeq.has(payload.seatId)) {
    terminalSeatSeq.set(payload.seatId, event.seq);
  }
}

function inspectPostTerminalAction(
  event: TraceEvent,
  terminalSeatSeq: Map<string, number>,
  violations: AuctionInvariantViolation[]
): void {
  if (!ACTION_EVENTS.has(event.event)) return;
  const payload = event.payload as {
    seatId?: string;
    currentTurnSeatId?: string;
  };
  const seatId = payload.seatId ?? payload.currentTurnSeatId;
  if (!seatId) return;
  const terminalSeq = terminalSeatSeq.get(seatId);
  if (terminalSeq === undefined || event.seq <= terminalSeq) return;
  violations.push({
    code: 'terminal_seat_action',
    message: `${event.event} referenced terminal seat ${seatId} after seq ${terminalSeq}`,
    eventSeq: event.seq,
  });
}

function inspectFinishedState(
  finished: FinishedPayload,
  violations: AuctionInvariantViolation[]
): void {
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
    return;
  }
  const seats = finished.state?.seats ?? [];
  const lastPlayerStanding = seats.length > 1
    && seats.filter((seat) => seat.forfeited).length === seats.length - 1;
  for (const [index, ranking] of finished.rankings.entries()) {
    if (!lastPlayerStanding && !ranking.player?.forfeited && ranking.isComplete !== true) {
      violations.push({
        code: 'incomplete_final_squad',
        message: `Non-forfeited ranking ${index + 1} should have a complete squad`,
      });
    }
    if (
      !lastPlayerStanding
      && !ranking.player?.forfeited
      && (typeof ranking.totalTrueValue !== 'number' || ranking.totalTrueValue <= 0)
    ) {
      violations.push({
        code: 'invalid_final_true_value',
        message: `Non-forfeited ranking ${index + 1} should have a positive totalTrueValue`,
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

function inspectBudgetConservation(
  finished: FinishedPayload,
  violations: AuctionInvariantViolation[]
): void {
  if (!Array.isArray(finished.rankings)) return;
  const paidBySeat = new Map<string, number>();
  for (const round of finished.state?.completedRounds ?? []) {
    if (!round.winnerSeatId) continue;
    const amount = typeof round.winningBid === 'number' ? round.winningBid : 0;
    paidBySeat.set(round.winnerSeatId, (paidBySeat.get(round.winnerSeatId) ?? 0) + amount);
  }
  for (const ranking of finished.rankings) {
    if (typeof ranking.budgetRemaining !== 'number') continue;
    const paid = paidBySeat.get(ranking.seatId) ?? 0;
    if (ranking.budgetRemaining + paid === STARTING_BUDGET) continue;
    violations.push({
      code: 'budget_conservation',
      message: `${ranking.seatId} budget ${ranking.budgetRemaining} + paid ${paid} != initial ${STARTING_BUDGET}`,
    });
  }
}

function inspectRankings(
  finished: FinishedPayload,
  violations: AuctionInvariantViolation[]
): void {
  if (!Array.isArray(finished.rankings) || !Array.isArray(finished.state?.seats)) return;
  const expected = rankAuctionPlayers(finished.state.seats);
  const actualSeatIds = finished.rankings.map((ranking) => ranking.seatId);
  const expectedSeatIds = expected.map((ranking) => ranking.seatId);
  if (actualSeatIds.join('|') !== expectedSeatIds.join('|')) {
    violations.push({
      code: 'ranking_order',
      message: `Ranking order ${actualSeatIds.join(',')} does not match auction-rules ${expectedSeatIds.join(',')}`,
    });
  }
  for (const [index, ranking] of finished.rankings.entries()) {
    if (ranking.rank === index + 1) continue;
    violations.push({
      code: 'ranking_number',
      message: `${ranking.seatId} has rank ${ranking.rank}; expected ${index + 1}`,
    });
  }

  const forfeiterRanks = finished.rankings
    .filter((ranking) => ranking.player?.forfeited)
    .map((ranking) => ranking.rank);
  const liveRanks = finished.rankings
    .filter((ranking) => !ranking.player?.forfeited)
    .map((ranking) => ranking.rank);
  if (
    forfeiterRanks.length > 0
    && liveRanks.length > 0
    && Math.min(...forfeiterRanks) <= Math.max(...liveRanks)
  ) {
    violations.push({
      code: 'forfeiter_not_last',
      message: 'Every forfeited seat should rank below every non-forfeited seat',
    });
  }
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

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

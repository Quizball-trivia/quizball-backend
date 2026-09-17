import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('quizball-backend');

const rankedQueueJoins = meter.createCounter('quizball_ranked_queue_joins_total', {
  description: 'Number of ranked queue join attempts',
});

const rankedQueueLeaves = meter.createCounter('quizball_ranked_queue_leaves_total', {
  description: 'Number of ranked queue leave attempts',
});

const rankedAiFallbacks = meter.createCounter('quizball_ranked_ai_fallbacks_total', {
  description: 'Number of ranked queue searches that fell back to AI',
});

const rankedHumanMatches = meter.createCounter('quizball_ranked_human_matches_total', {
  description: 'Number of human-vs-human ranked matches created',
});

const rankedMatchmakingStageDuration = meter.createHistogram(
  'quizball_ranked_matchmaking_stage_duration_ms',
  {
    description: 'Latency of each ranked matchmaking stage',
    unit: 'ms',
  }
);

let auctionMatchmakingQueueDepthValue = 0;
const auctionMatchmakingQueueDepth = meter.createObservableGauge(
  'quizball_auction_matchmaking_queue_depth',
  { description: 'Current number of queued Auction searches on this shared fleet' },
);
auctionMatchmakingQueueDepth.addCallback((result) => {
  result.observe(auctionMatchmakingQueueDepthValue);
});

export function setAuctionMatchmakingQueueDepth(depth: number): void {
  auctionMatchmakingQueueDepthValue = Math.max(0, Math.floor(depth));
}

const auctionMatchmakingQueueWaitDuration = meter.createHistogram(
  'quizball_auction_matchmaking_queue_wait_duration_ms',
  { description: 'Auction search-to-match wait per human seat', unit: 'ms' },
);

const auctionMatchmakingHumanSeatShare = meter.createHistogram(
  'quizball_auction_matchmaking_human_seat_share',
  { description: 'Share of human seats in each queue-origin Auction match', unit: '1' },
);

const socketReconnects = meter.createCounter('quizball_socket_reconnects_total', {
  description: 'Number of active-match rejoins on connect',
});

const matchPauses = meter.createCounter('quizball_match_pauses_total', {
  description: 'Number of match pauses caused by disconnects',
});

const cacheRebuilds = meter.createCounter('quizball_match_cache_rebuilds_total', {
  description: 'Number of match cache rebuilds from database state',
});

const partyQuestionsSent = meter.createCounter('quizball_party_questions_sent_total', {
  description: 'Number of party quiz questions sent',
});

const partyRoundsResolved = meter.createCounter('quizball_party_rounds_resolved_total', {
  description: 'Number of party quiz rounds resolved',
});

const partyAnswersSubmitted = meter.createCounter('quizball_party_answers_submitted_total', {
  description: 'Number of party quiz answers submitted',
});

const questionGenerationDuration = meter.createHistogram('quizball_question_generation_duration_ms', {
  description: 'Latency for building or picking a question payload',
  unit: 'ms',
});

const roundResolutionDuration = meter.createHistogram('quizball_round_resolution_duration_ms', {
  description: 'Latency for resolving a round',
  unit: 'ms',
});

// ── Persistent-bot selection + reservation lifecycle (PR7) ───────────────────
const persistentBotSelections = meter.createCounter('quizball_persistent_bot_selections_total', {
  description: 'Persistent-bot selections tagged by outcome (hit / unavailable / ephemeral_fallback / flag_off) and relaxation level',
});

const persistentBotReservationReleases = meter.createCounter('quizball_persistent_bot_reservation_releases_total', {
  description: 'Persistent-bot reservation releases tagged by teardown path',
});

const persistentBotSweeperActions = meter.createCounter('quizball_persistent_bot_sweeper_actions_total', {
  description: 'Reconciliation sweeper actions tagged by action (rekey / release / skipped_live)',
});

const footballGridQueueJoins = meter.createCounter('quizball_football_grid_queue_joins_total', {
  description: 'Football Grid queue join attempts',
});
const footballGridMatches = meter.createCounter('quizball_football_grid_matches_total', {
  description: 'Football Grid matches created by opponent type and origin',
});
const footballGridCommands = meter.createCounter('quizball_football_grid_commands_total', {
  description: 'Football Grid commands resolved by outcome',
});
const footballGridResolverDuration = meter.createHistogram('quizball_football_grid_resolver_duration_ms', {
  description: 'Football Grid answer resolver latency', unit: 'ms',
});
const footballGridSettlements = meter.createCounter('quizball_football_grid_settlements_total', {
  description: 'Football Grid reward settlements by outcome',
});
const footballGridQueueWaitDuration = meter.createHistogram('quizball_football_grid_queue_wait_duration_ms', {
  description: 'Football Grid queue wait before a human or bot pairing', unit: 'ms',
});
const footballGridPhaseTimeouts = meter.createCounter('quizball_football_grid_phase_timeouts_total', {
  description: 'Football Grid authoritative phase deadline expirations',
});
const footballGridPresenceTransitions = meter.createCounter('quizball_football_grid_presence_transitions_total', {
  description: 'Football Grid disconnect and reconnect transitions',
});
const footballGridContentExhaustion = meter.createCounter('quizball_football_grid_content_exhaustion_total', {
  description: 'Football Grid match creation attempts with no selectable published board',
});
const footballGridRewardEligibility = meter.createCounter('quizball_football_grid_reward_eligibility_total', {
  description: 'Football Grid coin and TP decisions by reward type, reason, and origin',
});
const footballGridPairingRecovery = meter.createCounter('quizball_football_grid_pairing_recovery_total', {
  description: 'Football Grid stale pairing reconciliation outcomes',
});
const footballGridBotActions = meter.createCounter('quizball_football_grid_bot_actions_total', {
  description: 'Football Tic Tac Toe bot actions by pinned tier, policy version, outcome, and scarcity bucket',
});
const footballGridBotGovernorObservations = meter.createCounter('quizball_football_grid_bot_governor_observations_total', {
  description: 'Competitive Football Tic Tac Toe bot outcomes folded into the Grid-only safety governor',
});
const footballGridBotGovernorProcessing = meter.createCounter('quizball_football_grid_bot_governor_processing_total', {
  description: 'Independent Football Tic Tac Toe governor processing outcomes, including retryable failures',
});

export const appMetrics = {
  rankedQueueJoins,
  rankedQueueLeaves,
  rankedAiFallbacks,
  rankedHumanMatches,
  rankedMatchmakingStageDuration,
  auctionMatchmakingQueueWaitDuration,
  auctionMatchmakingHumanSeatShare,
  socketReconnects,
  matchPauses,
  cacheRebuilds,
  partyQuestionsSent,
  partyRoundsResolved,
  partyAnswersSubmitted,
  questionGenerationDuration,
  roundResolutionDuration,
  persistentBotSelections,
  persistentBotReservationReleases,
  persistentBotSweeperActions,
  footballGridQueueJoins,
  footballGridMatches,
  footballGridCommands,
  footballGridResolverDuration,
  footballGridSettlements,
  footballGridQueueWaitDuration,
  footballGridPhaseTimeouts,
  footballGridPresenceTransitions,
  footballGridContentExhaustion,
  footballGridRewardEligibility,
  footballGridPairingRecovery,
  footballGridBotActions,
  footballGridBotGovernorObservations,
  footballGridBotGovernorProcessing,
};

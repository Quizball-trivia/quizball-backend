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

export const appMetrics = {
  rankedQueueJoins,
  rankedQueueLeaves,
  rankedAiFallbacks,
  rankedHumanMatches,
  socketReconnects,
  matchPauses,
  cacheRebuilds,
  partyQuestionsSent,
  partyRoundsResolved,
  partyAnswersSubmitted,
  questionGenerationDuration,
  roundResolutionDuration,
};

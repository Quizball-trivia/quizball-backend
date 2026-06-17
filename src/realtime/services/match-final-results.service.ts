import type { QuizballServer, QuizballSocket } from '../socket-server.js';
import { logger } from '../../core/logger.js';
import { achievementsService } from '../../modules/achievements/index.js';
import { matchAnswersRepo } from '../../modules/matches/match-answers.repo.js';
import { matchPlayersRepo } from '../../modules/matches/match-players.repo.js';
import { matchesRepo } from '../../modules/matches/matches.repo.js';
import { resolveMatchVariant } from '../../modules/matches/matches.service.js';
import { progressionService } from '../../modules/progression/progression.service.js';
import { rankedService } from '../../modules/ranked/ranked.service.js';
import { getRedisClient } from '../redis.js';
import {
  lastMatchKey,
  matchForfeitPendingUserKey,
} from '../match-keys.js';
import { buildStandings } from '../match-utils.js';
import type { AchievementUnlockPayload, MatchFinalResultsPayload } from '../socket.types.js';
import type { MatchFinalResultsAckPayload } from '../schemas/match.schemas.js';
import { resolveMatchReplayEvidence } from './match-entry.service.js';
import { buildParticipantPayloads } from './match-participants.helpers.js';

type QuestionResult = NonNullable<MatchFinalResultsPayload['questionResults']>[string][number];

function isCancelledNoContestPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as {
    cancelledNoContest?: unknown;
    winnerDecisionMethod?: unknown;
  };
  return candidate.cancelledNoContest === true && candidate.winnerDecisionMethod === 'forfeit';
}

export type LastMatchReplay = {
  matchId: string;
  resultVersion: number;
};

export function parseLastMatchReplay(raw: string): LastMatchReplay {
  try {
    const parsed = JSON.parse(raw) as Partial<LastMatchReplay>;
    if (typeof parsed.matchId === 'string' && typeof parsed.resultVersion === 'number') {
      return {
        matchId: parsed.matchId,
        resultVersion: parsed.resultVersion,
      };
    }
  } catch {
    // Backward-compat path for legacy string format.
  }
  return {
    matchId: raw,
    resultVersion: Date.now(),
  };
}

export async function buildFinalQuestionResults(
  matchId: string,
  userIds: string[],
  totalQuestions: number
): Promise<NonNullable<MatchFinalResultsPayload['questionResults']>> {
  const safeTotal = Math.max(0, totalQuestions);
  const results = Object.fromEntries(
    userIds.map((userId) => [
      userId,
      Array.from({ length: safeTotal }, () => null as QuestionResult),
    ])
  ) as NonNullable<MatchFinalResultsPayload['questionResults']>;

  if (safeTotal === 0) return results;

  const answers = await matchAnswersRepo.listAnswersForMatch(matchId);
  for (const answer of answers) {
    const playerResults = results[answer.user_id];
    if (!playerResults) continue;
    const answerQIndex = answer.q_index;
    if (answerQIndex < 0 || answerQIndex >= safeTotal) continue;
    playerResults[answerQIndex] = answer.is_correct ? 'correct' : 'wrong';
  }

  return results;
}

export async function buildFinalResultsPayload(matchId: string, resultVersion: number): Promise<{
  matchId: string;
  variant?: 'friendly_possession' | 'friendly_party_quiz' | 'ranked_sim';
  winnerId: string | null;
  players: Record<string, {
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
    goals?: number;
    penaltyGoals?: number;
  }>;
  participants?: MatchFinalResultsPayload['participants'];
  standings?: Array<{
    userId: string;
    rank: number;
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
  }>;
  unlockedAchievements?: Record<string, AchievementUnlockPayload[]>;
  totalQuestions?: number;
  questionResults?: Record<string, Array<'correct' | 'wrong' | null>>;
  durationMs: number;
  resultVersion: number;
  winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points' | 'total_points_fallback' | 'forfeit' | null;
  cancelledNoContest?: boolean;
  totalPointsFallbackUsed?: boolean;
  rankedOutcome?: Awaited<ReturnType<typeof rankedService.getMatchOutcome>> | null;
} | null> {
  const match = await matchesRepo.getMatch(matchId);
  const cancelledNoContest = isCancelledNoContestPayload(match?.state_payload);
  if (!match || (match.status !== 'completed' && !(match.status === 'abandoned' && cancelledNoContest))) {
    return null;
  }

  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const payloadPlayers: Record<string, {
    totalPoints: number;
    correctAnswers: number;
    avgTimeMs: number | null;
    goals?: number;
    penaltyGoals?: number;
  }> = {};
  for (const player of players) {
    payloadPlayers[player.user_id] = {
      totalPoints: player.total_points,
      correctAnswers: player.correct_answers,
      avgTimeMs: player.avg_time_ms,
      goals: player.goals,
      penaltyGoals: player.penalty_goals,
    };
  }

  const standings = buildStandings(players);
  const participants = await buildParticipantPayloads(players, match.mode, match.ranked_context);
  const variant = resolveMatchVariant(match.state_payload, match.mode);
  const unlockedAchievements = await achievementsService.listUnlockedForMatch(matchId);
  let questionResults: MatchFinalResultsPayload['questionResults'];
  if (variant !== 'friendly_party_quiz') {
    try {
      questionResults = await buildFinalQuestionResults(
        matchId,
        players.map((player) => player.user_id),
        match.total_questions
      );
    } catch (err) {
      logger.warn({ err, matchId }, 'Failed to build replay final question results');
    }
  }
  const seat1UserId = players.find((player) => player.seat === 1)?.user_id ?? null;
  const seat2UserId = players.find((player) => player.seat === 2)?.user_id ?? null;
  const fallbackWinnerId = standings[0]?.userId ?? seat1UserId ?? seat2UserId ?? players[0]?.user_id ?? null;
  const statePayload = (match.state_payload ?? {}) as Partial<{
    goals: { seat1?: number; seat2?: number };
    penaltyGoals: { seat1?: number; seat2?: number };
  }>;
  const goalsSeat1 = Number(statePayload.goals?.seat1 ?? 0);
  const goalsSeat2 = Number(statePayload.goals?.seat2 ?? 0);
  const penaltiesSeat1 = Number(statePayload.penaltyGoals?.seat1 ?? 0);
  const penaltiesSeat2 = Number(statePayload.penaltyGoals?.seat2 ?? 0);
  const seat1Points = players.find((player) => player.seat === 1)?.total_points ?? 0;
  const seat2Points = players.find((player) => player.seat === 2)?.total_points ?? 0;
  const derivedWinnerId =
    variant === 'friendly_party_quiz'
      ? (standings[0]?.userId ?? fallbackWinnerId)
      : goalsSeat1 > goalsSeat2
        ? (seat1UserId ?? fallbackWinnerId)
        : goalsSeat2 > goalsSeat1
          ? (seat2UserId ?? fallbackWinnerId)
          : penaltiesSeat1 > penaltiesSeat2
            ? (seat1UserId ?? fallbackWinnerId)
            : penaltiesSeat2 > penaltiesSeat1
              ? (seat2UserId ?? fallbackWinnerId)
              : seat1Points > seat2Points
                ? (seat1UserId ?? fallbackWinnerId)
                : seat2Points > seat1Points
                  ? (seat2UserId ?? fallbackWinnerId)
                  : fallbackWinnerId;

  // Calculate endedAt and durationMs deterministically
  let endedAt: number;
  let durationMs: number;

  if (match.ended_at) {
    // Normal case: ended_at is present
    endedAt = new Date(match.ended_at).getTime();
    durationMs = endedAt - new Date(match.started_at).getTime();
  } else if (match.status === 'completed') {
    // Match is completed but ended_at is missing - data inconsistency
    logger.warn(
      { matchId, startedAt: match.started_at, status: match.status },
      'Match is completed but ended_at is null - using started_at as fallback'
    );
    endedAt = new Date(match.started_at).getTime();
    durationMs = 0; // Duration is 0 since we don't have accurate end time
  } else {
    // Match is in-progress (shouldn't happen due to status check above, but defensive)
    endedAt = Date.now();
    durationMs = endedAt - new Date(match.started_at).getTime();
  }

  const winnerDecisionMethod =
    (
      match.state_payload as {
        winnerDecisionMethod?: 'goals' | 'penalty_goals' | 'total_points' | 'total_points_fallback' | 'forfeit';
      } | null
    )?.winnerDecisionMethod ?? null;
  const explicitNoWinnerForfeit = winnerDecisionMethod === 'forfeit' && match.winner_user_id === null;

  let rankedOutcome = null;
  if (match.mode === 'ranked' && !cancelledNoContest) {
    try { rankedOutcome = await rankedService.getMatchOutcome(matchId); }
    catch (err) { logger.warn({ err, matchId }, 'Failed to fetch ranked outcome for replay'); }
  }

  return {
    matchId,
    variant,
    winnerId: explicitNoWinnerForfeit ? null : (match.winner_user_id ?? derivedWinnerId),
    players: payloadPlayers,
    participants,
    ...(variant === 'friendly_party_quiz' ? { standings } : {}),
    totalQuestions: match.total_questions,
    ...(questionResults ? { questionResults } : {}),
    unlockedAchievements,
    durationMs,
    resultVersion,
    winnerDecisionMethod,
    ...(cancelledNoContest ? { cancelledNoContest: true } : {}),
    totalPointsFallbackUsed: winnerDecisionMethod === 'total_points_fallback',
    ...(rankedOutcome ? { rankedOutcome } : {}),
  };
}

export async function emitFinalResultsToMatchParticipants(
  io: QuizballServer,
  matchId: string,
  payload: NonNullable<Awaited<ReturnType<typeof buildFinalResultsPayload>>>
): Promise<void> {
  const players = await matchPlayersRepo.listMatchPlayers(matchId);
  const rooms = [
    `match:${matchId}`,
    ...players.map((player) => `user:${player.user_id}`),
  ];
  io.to(rooms).emit('match:final_results', payload);
}

export async function emitLastMatchResultIfAny(
  _io: QuizballServer,
  socket: QuizballSocket
): Promise<void> {
  const redis = getRedisClient();
  if (!redis) return;

  const userId = socket.data.user.id;
  const rawReplay = await redis.get(lastMatchKey(userId));
  if (!rawReplay) return;
  const replay = parseLastMatchReplay(rawReplay);

  const lastMatch = await matchesRepo.getMatch(replay.matchId);
  if (!lastMatch) {
    await redis.del(lastMatchKey(userId));
    return;
  }

  const cancelledNoContest = isCancelledNoContestPayload(lastMatch.state_payload);
  if (lastMatch.status === 'abandoned' && !cancelledNoContest) {
    socket.emit('error', {
      code: 'MATCH_ABANDONED',
      message: 'Match was abandoned due to disconnects.',
    });
    await redis.del(lastMatchKey(userId));
    return;
  }

  const evidence = await resolveMatchReplayEvidence(replay.matchId, userId);
  if (!evidence.allowed) {
    logger.warn(
      {
        userId,
        matchId: replay.matchId,
        status: lastMatch.status,
        winnerDecisionMethod: (
          lastMatch.state_payload as { winnerDecisionMethod?: string } | null
        )?.winnerDecisionMethod ?? null,
        isParticipant: evidence.isParticipant,
        hasEnteredMarker: evidence.hasEnteredMarker,
        hasRecordedActivity: evidence.hasRecordedActivity,
      },
      'Suppressing final results replay for user without entered-match evidence'
    );
    await redis.del(lastMatchKey(userId));
    return;
  }

  // Retry idempotent post-completion writes that may have been missed
  // (e.g. player disconnected before they fired after match completion).
  try {
    if (lastMatch.mode === 'ranked' && !cancelledNoContest) {
      const existing = await rankedService.getMatchOutcome(replay.matchId);
      if (!existing) {
        await rankedService.settleCompletedRankedMatch(replay.matchId);
      }
    }
  } catch (err) { logger.warn({ err, matchId: replay.matchId }, 'Failed to settle ranked outcome during replay'); }

  try {
    if (!cancelledNoContest) {
      await progressionService.awardCompletedMatchXp(replay.matchId);
    }
  } catch (err) { logger.warn({ err, matchId: replay.matchId }, 'Failed to retry XP award during replay'); }

  const payload = await buildFinalResultsPayload(replay.matchId, replay.resultVersion);
  if (payload) {
    socket.emit('match:final_results', payload);
    await redis.del(matchForfeitPendingUserKey(userId));
  }
}

export async function handleFinalResultsAck(
  socket: QuizballSocket,
  payload: MatchFinalResultsAckPayload
): Promise<void> {
  const userId = socket.data.user.id;
  const redis = getRedisClient();

  // Validate against the stored replay BEFORE clearing the socket's
  // matchId binding — a bogus ACK (no replay match, wrong resultVersion)
  // must not unbind an in-progress match, otherwise handleMatchDisconnect
  // loses the matchId it needs for pause/forfeit bookkeeping. When the
  // replay exists and doesn't match, ignore the ACK; when it exists and
  // matches, delete it as part of the cleanup; when it's absent (Redis
  // down or already consumed), proceed (idempotent ACK).
  if (redis) {
    const rawReplay = await redis.get(lastMatchKey(userId));
    if (rawReplay) {
      const replay = parseLastMatchReplay(rawReplay);
      if (replay.matchId !== payload.matchId || replay.resultVersion !== payload.resultVersion) {
        logger.warn(
          {
            userId,
            payloadMatchId: payload.matchId,
            payloadResultVersion: payload.resultVersion,
            replayMatchId: replay.matchId,
            replayResultVersion: replay.resultVersion,
          },
          'Ignoring final_results_ack with mismatched matchId/resultVersion'
        );
        return;
      }
      await redis.del(lastMatchKey(userId));
    }
  }

  socket.leave(`match:${payload.matchId}`);
  if (socket.data.matchId === payload.matchId) {
    socket.data.matchId = undefined;
  }
}

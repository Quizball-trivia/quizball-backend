/**
 * WL live engine — the real gameplay behind the orchestrator's engine seam.
 *
 * PR3 scope: one fully playable game (game_index 0: 5 rounds, 19 question
 * slots) from kickoff to qualifier_done with REAL standings. PR4 extends the
 * same machinery to the 3-game gauntlet, breaks and the Sunday final.
 *
 * Design (converged plan):
 *  - Every question attempt is durable (wl_question_runs) and every
 *    player-visible moment is an outbox event, delivered in order by the
 *    fenced deliverer. Question content (incl. evaluation — the owner chose
 *    ranked-style answers-in-payload for instant feedback) rides in the
 *    dispatch event, so re-broadcast identity is stable and the spectator
 *    replay is self-contained.
 *  - Timing lives in the Redis clock domain. The deliverer stamps
 *    playable/deadline ONCE per attempt at first emission (+3s lead); a
 *    crash-retry either re-broadcasts the identical stamped payload (>400ms
 *    lead remaining) or voids the attempt and plays a reserve question.
 *  - Answers: once-only per (attempt, user) in a Redis hash, admitted by
 *    Redis time within [playable, deadline), scored server-side at accept
 *    (the ack carries the authoritative points; client-side correctness
 *    display is cosmetic).
 *  - Freeze at deadline: persist all accepted answers + run→frozen in one
 *    tx, apply ABSOLUTE cumulative scores to the standings ZSET (repair-safe
 *    — recomputed from wl_answers, never incremented), then run→revealed +
 *    reveal event carrying the correct answer, answer distribution and the
 *    top-24 board (the spectator standings contract).
 */

import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { wlEventsRepo } from './wl-events.repo.js';
import { wlRedis, wlRedisNowMs } from './wl-redis.js';
import { wlConfigFrom } from './wl-config.js';
import {
  WL_FINALISTS,
  WL_QUESTIONS_PER_ROUND,
  WL_ROUND_ORDER,
  wlCompareStanding,
  wlEncodeScore,
  wlStepPoints,
  wlTimeChargeMs,
  wlWhoAmIPoints,
  type WlRoundKind,
} from './wl-rules.js';

export const WL_MIN_REMAINING_LEAD_MS = 400;
const REDIS_TTL_SECONDS = 48 * 3600;

export interface WlSlotRef {
  gameIndex: number;
  roundIndex: number;
  questionIndex: number;
}

export interface WlRunRow {
  attempt_id: string;
  tournament_id: string;
  game_index: number;
  round_index: number;
  question_index: number;
  question_id: string;
  status: 'created' | 'dispatched' | 'frozen' | 'revealed' | 'voided';
  playable_at_ms: string | null;
  deadline_at_ms: string | null;
}

function answersKey(tournamentId: string, attemptId: string): string {
  return `wl:${tournamentId}:a:${attemptId}:answers`;
}

export function wlSlotSequence(): WlSlotRef[] {
  const slots: WlSlotRef[] = [];
  for (let round = 0; round < WL_ROUND_ORDER.length; round += 1) {
    const kind = WL_ROUND_ORDER[round]!;
    for (let q = 0; q < WL_QUESTIONS_PER_ROUND[kind]; q += 1) {
      slots.push({ gameIndex: 0, roundIndex: round, questionIndex: q });
    }
  }
  return slots;
}

export function wlNextSlot(current: WlSlotRef): WlSlotRef | null {
  const seq = wlSlotSequence();
  const idx = seq.findIndex(
    (s) => s.roundIndex === current.roundIndex && s.questionIndex === current.questionIndex
  );
  return idx >= 0 && idx + 1 < seq.length ? seq[idx + 1]! : null;
}

export const wlLiveEngineInternals = {
  /**
   * Append the dispatch event + create the run for a slot, idempotently:
   * the partial unique index on live runs per slot makes a duplicate append
   * a no-op. Reserve replacement passes reserveOrdinal > 0.
   */
  async appendDispatch(
    tournamentId: string,
    slot: WlSlotRef,
    redisNow: number,
    reserveOrdinal = 0
  ): Promise<boolean> {
    const [question] = reserveOrdinal === 0
      ? await sql<Array<{ question_id: string; kind: WlRoundKind; payload: unknown; evaluation: unknown }>>`
          SELECT question_id, kind, payload, evaluation FROM wl_questions
          WHERE tournament_id = ${tournamentId} AND game_index = ${slot.gameIndex}
            AND round_index = ${slot.roundIndex} AND question_index = ${slot.questionIndex}
            AND reserve_ordinal = 0
        `
      : await sql<Array<{ question_id: string; kind: WlRoundKind; payload: unknown; evaluation: unknown }>>`
          SELECT q.question_id, q.kind, q.payload, q.evaluation FROM wl_questions q
          WHERE q.tournament_id = ${tournamentId} AND q.game_index = ${slot.gameIndex}
            AND q.reserve_ordinal = ${reserveOrdinal}
            AND q.kind = (
              SELECT kind FROM wl_questions
              WHERE tournament_id = ${tournamentId} AND game_index = ${slot.gameIndex}
                AND round_index = ${slot.roundIndex} AND question_index = ${slot.questionIndex}
                AND reserve_ordinal = 0
            )
        `;
    if (!question) {
      logger.error({ tournamentId, slot, reserveOrdinal }, 'WL dispatch: no content for slot');
      return false;
    }

    let appended = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const run = await txSql<{ attempt_id: string }[]>`
        INSERT INTO wl_question_runs (
          tournament_id, game_index, round_index, question_index, question_id, status
        )
        VALUES (
          ${tournamentId}, ${slot.gameIndex}, ${slot.roundIndex}, ${slot.questionIndex},
          ${question.question_id}, 'created'
        )
        ON CONFLICT DO NOTHING
        RETURNING attempt_id
      `;
      if (run.length === 0) return; // live run already exists for the slot
      await wlEventsRepo.append(txSql, {
        tournamentId,
        type: 'dispatch',
        payload: {
          attempt_id: run[0]!.attempt_id,
          game_index: slot.gameIndex,
          round_index: slot.roundIndex,
          question_index: slot.questionIndex,
          kind: question.kind,
          question: question.payload,
          evaluation: question.evaluation,
        },
        redisTimeMs: redisNow,
      });
      appended = true;
    });
    return appended;
  },

  /**
   * Deliverer hook for dispatch events: one-shot stamping. Returns the
   * enriched payload to broadcast, or null when the attempt must be voided
   * instead (insufficient lead on a crash-retry).
   */
  async stampForEmission(
    tournamentId: string,
    eventPayload: Record<string, unknown>,
    redisNow: number
  ): Promise<Record<string, unknown> | null> {
    const attemptId = String(eventPayload['attempt_id'] ?? '');
    if (!attemptId) return eventPayload;
    const [t] = await sql<Array<{ config: Record<string, unknown> }>>`
      SELECT config FROM wl_tournaments WHERE id = ${tournamentId}
    `;
    const cfg = wlConfigFrom(t?.config);
    // One-shot: only a NULL stamp is written; retries keep the original.
    const stampedNow = await sql`
      UPDATE wl_question_runs
      SET playable_at_ms = ${redisNow + cfg.dispatch_lead_ms},
          deadline_at_ms = ${redisNow + cfg.dispatch_lead_ms + cfg.question_time_ms},
          status = 'dispatched'
      WHERE attempt_id = ${attemptId} AND playable_at_ms IS NULL
        AND status IN ('created', 'dispatched')
      RETURNING attempt_id
    `;
    const isFirstEmission = stampedNow.length > 0;
    const [run] = await sql<WlRunRow[]>`
      SELECT attempt_id, tournament_id, game_index, round_index, question_index,
             question_id, status, playable_at_ms::text, deadline_at_ms::text
      FROM wl_question_runs WHERE attempt_id = ${attemptId}
    `;
    if (!run || run.status === 'voided') return null;
    const playable = Number(run.playable_at_ms);
    if (run.status !== 'dispatched' || !Number.isFinite(playable)) return null;
    // The staleness rule applies ONLY to crash-retries of an already-stamped
    // attempt: a first emission is by definition on time (its window was
    // stamped from this very moment). A retry either still has meaningful
    // lead before playableAt (re-broadcast the identical payload) or the
    // window is burned and the attempt must be voided to a reserve.
    if (!isFirstEmission && redisNow > playable - WL_MIN_REMAINING_LEAD_MS) {
      return null;
    }
    return {
      ...eventPayload,
      playableAt: playable,
      deadlineAt: Number(run.deadline_at_ms),
    };
  },

  /** Void an attempt and (once) queue its reserve replacement. */
  async voidAttempt(
    tournamentId: string,
    attemptId: string,
    redisNow: number,
    reason: string
  ): Promise<void> {
    const [run] = await sql<WlRunRow[]>`
      UPDATE wl_question_runs SET status = 'voided', void_reason = ${reason}
      WHERE attempt_id = ${attemptId} AND status IN ('created', 'dispatched')
      RETURNING attempt_id, tournament_id, game_index, round_index, question_index,
                question_id, status, playable_at_ms::text, deadline_at_ms::text
    `;
    if (!run) return;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      await wlEventsRepo.append(txSql, {
        tournamentId,
        type: 'void',
        payload: {
          attempt_id: attemptId,
          game_index: run.game_index,
          round_index: run.round_index,
          question_index: run.question_index,
          reason,
        },
        redisTimeMs: redisNow,
      });
    });
    // Reserve replacement for the same slot (next unused reserve ordinal of
    // the slot's kind). Exhausted reserves ⇒ the slot scores 0 for everyone
    // (nominal-1000 rule) and play continues with the next slot.
    const voidedCount = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_question_runs
      WHERE tournament_id = ${tournamentId} AND game_index = ${run.game_index}
        AND round_index = ${run.round_index} AND question_index = ${run.question_index}
        AND status = 'voided'
    `;
    const nextReserve = voidedCount[0]?.n ?? 1;
    const replaced = await this.appendDispatch(
      tournamentId,
      { gameIndex: run.game_index, roundIndex: run.round_index, questionIndex: run.question_index },
      redisNow,
      nextReserve
    );
    if (!replaced) {
      logger.warn({ tournamentId, attemptId, nextReserve }, 'WL void: reserves exhausted, slot skipped');
      const next = wlNextSlot({
        gameIndex: run.game_index, roundIndex: run.round_index, questionIndex: run.question_index,
      });
      if (next) await this.appendDispatch(tournamentId, next, redisNow);
    }
  },

  /**
   * Freeze + reveal an attempt whose deadline passed: persist answers +
   * misses charging, apply absolute standings, emit the reveal, queue the
   * next dispatch (or finish the game). Fully idempotent via status CAS.
   */
  async freezeAndReveal(tournamentId: string, run: WlRunRow, redisNow: number): Promise<void> {
    const redis = wlRedis();
    const kind = await this.kindOf(run.question_id);
    const raw = await redis.hGetAll(answersKey(tournamentId, run.attempt_id));

    // CAS dispatched→frozen; the loser (concurrent freezer / replay) exits.
    const frozen = await sql`
      UPDATE wl_question_runs SET status = 'frozen'
      WHERE attempt_id = ${run.attempt_id} AND status = 'dispatched'
      RETURNING attempt_id
    `;
    if (frozen.length === 0) return;

    const answerRows = Object.entries(raw).map(([userId, packed]) => {
      const a = JSON.parse(packed) as {
        answer: unknown; correct: boolean; points: number; elapsedMs: number;
      };
      return { userId, ...a };
    });

    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      for (const row of answerRows) {
        await txSql`
          INSERT INTO wl_answers (
            attempt_id, user_id, tournament_id, game_index, answer, correct,
            points, elapsed_ms, time_charge_ms, timing_source
          )
          VALUES (
            ${run.attempt_id}, ${row.userId}, ${tournamentId}, ${run.game_index},
            ${sql.json(row.answer as never)}, ${row.correct}, ${row.points},
            ${row.elapsedMs}, ${wlTimeChargeMs(true, row.elapsedMs)}, 'redis_accept'
          )
          ON CONFLICT (attempt_id, user_id) DO NOTHING
        `;
      }
    });

    await this.applyAbsoluteStandings(tournamentId, run.game_index);

    const distribution: Record<string, number> = {};
    for (const row of answerRows) {
      const key = typeof row.answer === 'string' ? row.answer : JSON.stringify(row.answer);
      distribution[key] = (distribution[key] ?? 0) + 1;
    }
    const board = await this.topBoard(tournamentId, run.game_index, WL_FINALISTS);
    const [content] = await sql<Array<{ evaluation: unknown }>>`
      SELECT evaluation FROM wl_questions WHERE question_id = ${run.question_id}
    `;

    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const revealed = await txSql`
        UPDATE wl_question_runs SET status = 'revealed'
        WHERE attempt_id = ${run.attempt_id} AND status = 'frozen'
        RETURNING attempt_id
      `;
      if (revealed.length === 0) return;
      await wlEventsRepo.append(txSql, {
        tournamentId,
        type: 'reveal',
        payload: {
          attempt_id: run.attempt_id,
          game_index: run.game_index,
          round_index: run.round_index,
          question_index: run.question_index,
          kind,
          evaluation: content?.evaluation ?? null,
          answered: answerRows.length,
          distribution,
          board,
        },
        redisTimeMs: redisNow,
      });
    });

    const next = wlNextSlot({
      gameIndex: run.game_index, roundIndex: run.round_index, questionIndex: run.question_index,
    });
    if (next) {
      await this.appendDispatch(tournamentId, next, redisNow);
    }
  },

  /** Absolute (repair-safe) standings from persisted answers + miss charges. */
  async applyAbsoluteStandings(tournamentId: string, gameIndex: number): Promise<void> {
    const rows = await sql<Array<{ user_id: string; points: number; time_ms: string; answered: number }>>`
      SELECT p.user_id,
             COALESCE(SUM(a.points), 0)::int AS points,
             COALESCE(SUM(a.time_charge_ms), 0)::text AS time_ms,
             COUNT(a.user_id)::int AS answered
      FROM wl_game_participants p
      LEFT JOIN wl_answers a
        ON a.tournament_id = p.tournament_id AND a.game_index = p.game_index
       AND a.user_id = p.user_id
      WHERE p.tournament_id = ${tournamentId} AND p.game_index = ${gameIndex}
      GROUP BY p.user_id
    `;
    const revealedCount = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_question_runs
      WHERE tournament_id = ${tournamentId} AND game_index = ${gameIndex}
        AND status IN ('frozen', 'revealed')
    `;
    const asked = revealedCount[0]?.n ?? 0;
    const redis = wlRedis();
    const key = `wl:${tournamentId}:g${gameIndex}:scores`;
    if (rows.length === 0) return;
    await redis.zAdd(key, rows.map((r) => {
      const missed = Math.max(0, asked - r.answered);
      const timeTotal = Number(r.time_ms) + missed * wlTimeChargeMs(false, 0);
      return { score: wlEncodeScore(r.points, timeTotal), value: r.user_id };
    }));
    await redis.expire(key, REDIS_TTL_SECONDS);
  },

  /** Top-N board with the canonical comparator (never raw ZSET order). */
  async topBoard(
    tournamentId: string,
    gameIndex: number,
    limit: number
  ): Promise<Array<{ user_id: string; points: number; time_ms_total: number; rank: number }>> {
    const rows = await sql<Array<{ user_id: string; points: number; time_ms: string; answered: number }>>`
      SELECT p.user_id,
             COALESCE(SUM(a.points), 0)::int AS points,
             COALESCE(SUM(a.time_charge_ms), 0)::text AS time_ms,
             COUNT(a.user_id)::int AS answered
      FROM wl_game_participants p
      LEFT JOIN wl_answers a
        ON a.tournament_id = p.tournament_id AND a.game_index = p.game_index
       AND a.user_id = p.user_id
      WHERE p.tournament_id = ${tournamentId} AND p.game_index = ${gameIndex}
      GROUP BY p.user_id
    `;
    const askedRows = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_question_runs
      WHERE tournament_id = ${tournamentId} AND game_index = ${gameIndex}
        AND status IN ('frozen', 'revealed')
    `;
    const asked = askedRows[0]?.n ?? 0;
    const standings = rows.map((r) => ({
      userId: r.user_id,
      points: r.points,
      timeMsTotal: Number(r.time_ms) + Math.max(0, asked - r.answered) * wlTimeChargeMs(false, 0),
    }));
    standings.sort(wlCompareStanding);
    return standings.slice(0, limit).map((s, i) => ({
      user_id: s.userId, points: s.points, time_ms_total: s.timeMsTotal, rank: i + 1,
    }));
  },

  async kindOf(questionId: string): Promise<WlRoundKind> {
    const [row] = await sql<Array<{ kind: WlRoundKind }>>`
      SELECT kind FROM wl_questions WHERE question_id = ${questionId}
    `;
    return row?.kind ?? 'mcq';
  },

  /** Score an accepted answer server-side (authoritative). */
  scoreAnswer(
    kind: WlRoundKind,
    evaluation: Record<string, unknown>,
    answer: unknown,
    elapsedMs: number
  ): { correct: boolean; points: number } {
    switch (kind) {
      case 'mcq':
      case 'true_false': {
        const correct = answer === evaluation['correct_id'];
        return { correct, points: wlStepPoints(kind, correct, elapsedMs) };
      }
      case 'higher_lower': {
        const left = Number(evaluation['left_value']);
        const right = Number(evaluation['right_value']);
        const expected = left > right ? 'left' : 'right';
        const correct = answer === expected;
        return { correct, points: wlStepPoints(kind, correct, elapsedMs) };
      }
      case 'career_path': {
        const correct = matchesAccepted(answer, evaluation);
        return { correct, points: wlStepPoints(kind, correct, elapsedMs) };
      }
      case 'who_am_i': {
        const parsed = answer as { guess?: unknown; clue_index?: unknown } | null;
        const correct = matchesAccepted(parsed?.guess, evaluation);
        const clueIndex = Number(parsed?.clue_index ?? 4);
        return { correct, points: wlWhoAmIPoints(correct, clueIndex) };
      }
    }
  },
};

function matchesAccepted(guess: unknown, evaluation: Record<string, unknown>): boolean {
  if (typeof guess !== 'string' || guess.trim() === '') return false;
  const accepted = Array.isArray(evaluation['accepted_answers'])
    ? (evaluation['accepted_answers'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  const normalized = normalizeGuess(guess);
  return accepted.some((a) => normalizeGuess(a) === normalized);
}

function normalizeGuess(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    .replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ');
}

/** Accept an answer: once-only, Redis-time admitted, scored at accept. */
export async function wlAcceptAnswer(input: {
  tournamentId: string;
  attemptId: string;
  userId: string;
  answer: unknown;
}): Promise<
  | { accepted: true; correct: boolean; points: number; elapsedMs: number }
  | { accepted: false; reason: 'closed' | 'not_participant' | 'duplicate' | 'unknown_attempt' }
> {
  const [run] = await sql<WlRunRow[]>`
    SELECT r.attempt_id, r.tournament_id, r.game_index, r.round_index,
           r.question_index, r.question_id, r.status,
           r.playable_at_ms::text, r.deadline_at_ms::text
    FROM wl_question_runs r
    WHERE r.attempt_id = ${input.attemptId} AND r.tournament_id = ${input.tournamentId}
  `;
  if (!run) return { accepted: false, reason: 'unknown_attempt' };
  const playable = Number(run.playable_at_ms);
  const deadline = Number(run.deadline_at_ms);
  const redisNow = await wlRedisNowMs();
  if (run.status !== 'dispatched' || !Number.isFinite(playable)
    || redisNow < playable || redisNow >= deadline) {
    return { accepted: false, reason: 'closed' };
  }
  const [participant] = await sql<{ user_id: string }[]>`
    SELECT user_id FROM wl_game_participants
    WHERE tournament_id = ${input.tournamentId} AND game_index = ${run.game_index}
      AND user_id = ${input.userId}
  `;
  if (!participant) return { accepted: false, reason: 'not_participant' };

  const [content] = await sql<Array<{ kind: WlRoundKind; evaluation: Record<string, unknown> }>>`
    SELECT kind, evaluation FROM wl_questions WHERE question_id = ${run.question_id}
  `;
  if (!content) return { accepted: false, reason: 'unknown_attempt' };

  const elapsedMs = Math.max(0, redisNow - playable);
  const { correct, points } = wlLiveEngineInternals.scoreAnswer(
    content.kind, content.evaluation, input.answer, elapsedMs
  );

  const redis = wlRedis();
  const stored = await redis.hSetNX(
    answersKey(input.tournamentId, input.attemptId),
    input.userId,
    JSON.stringify({ answer: input.answer, correct, points, elapsedMs })
  );
  if (!stored) {
    const prior = await redis.hGet(answersKey(input.tournamentId, input.attemptId), input.userId);
    if (prior) {
      const p = JSON.parse(prior) as { correct: boolean; points: number; elapsedMs: number };
      return { accepted: true, correct: p.correct, points: p.points, elapsedMs: p.elapsedMs };
    }
    return { accepted: false, reason: 'duplicate' };
  }
  await redis.expire(answersKey(input.tournamentId, input.attemptId), REDIS_TTL_SECONDS);
  return { accepted: true, correct, points, elapsedMs };
}

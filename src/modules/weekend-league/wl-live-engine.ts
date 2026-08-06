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
  WL_ROUND_INTRO_MS,
  WL_WHO_AM_I_CLUE_POINTS,
  wlCompareStanding,
  wlEncodeScore,
  wlStepPoints,
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

function closedKey(tournamentId: string, attemptId: string): string {
  return `wl:${tournamentId}:a:${attemptId}:closed`;
}

/**
 * Atomic accept: validates the window against REDIS TIME and the freeze
 * marker, then stores once-only — all inside one script, so a freeze that
 * begins after our PG reads can no longer accept-then-lose an answer.
 * KEYS: [answersKey, closedKey]; ARGV: [userId, packedAnswer, deadlineMs, ttl]
 * Returns: 1 stored | 0 duplicate | -1 closed/past-deadline.
 */
const ACCEPT_SCRIPT = `
  if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
  local t = redis.call('TIME')
  local nowMs = t[1] * 1000 + math.floor(t[2] / 1000)
  if nowMs >= tonumber(ARGV[3]) then return -1 end
  local stored = redis.call('HSETNX', KEYS[1], ARGV[1], ARGV[2])
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return stored
`;

/**
 * Atomic close: sets the freeze marker and returns the full snapshot in one
 * script — no answer can land between snapshot and close.
 * KEYS: [answersKey, closedKey]; ARGV: [ttl]
 */
const CLOSE_SCRIPT = `
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[1]))
  return redis.call('HGETALL', KEYS[1])
`;

export function wlSlotSequence(gameIndex = 0): WlSlotRef[] {
  const slots: WlSlotRef[] = [];
  for (let round = 0; round < WL_ROUND_ORDER.length; round += 1) {
    const kind = WL_ROUND_ORDER[round]!;
    for (let q = 0; q < WL_QUESTIONS_PER_ROUND[kind]; q += 1) {
      slots.push({ gameIndex, roundIndex: round, questionIndex: q });
    }
  }
  return slots;
}

export function wlNextSlot(current: WlSlotRef): WlSlotRef | null {
  const seq = wlSlotSequence(current.gameIndex);
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
    let appended = false;
    await sql.begin(async (tx) => {
      appended = await this.appendDispatchTx(
        tx as unknown as typeof sql, tournamentId, slot, redisNow, reserveOrdinal
      );
    });
    return appended;
  },

  /** Same as appendDispatch but composes into a caller-owned transaction. */
  async appendDispatchTx(
    db: typeof sql,
    tournamentId: string,
    slot: WlSlotRef,
    redisNow: number,
    reserveOrdinal = 0
  ): Promise<boolean> {
    const [question] = reserveOrdinal === 0
      ? await db<Array<{ question_id: string; kind: WlRoundKind; payload: unknown; evaluation: unknown }>>`
          SELECT question_id, kind, payload, evaluation FROM wl_questions
          WHERE tournament_id = ${tournamentId} AND game_index = ${slot.gameIndex}
            AND round_index = ${slot.roundIndex} AND question_index = ${slot.questionIndex}
            AND reserve_ordinal = 0
        `
      : await db<Array<{ question_id: string; kind: WlRoundKind; payload: unknown; evaluation: unknown }>>`
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
    const run = await db<{ attempt_id: string }[]>`
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
    if (run.length === 0) return false; // live run already exists for the slot
    const seq = await wlEventsRepo.append(db, {
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
    await db`
      UPDATE wl_question_runs SET dispatched_seq = ${seq}
      WHERE attempt_id = ${run[0]!.attempt_id}
    `;
    return true;
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
    const kind = String(eventPayload['kind'] ?? '');
    // Who-Am-I runs one window per clue (5 clues, one puzzle); every other
    // kind gets a single question window.
    const windowMs = kind === 'who_am_i'
      ? cfg.question_time_ms * WL_WHO_AM_I_CLUE_POINTS.length
      : cfg.question_time_ms;
    // A round's FIRST question carries extra lead so the round-intro overlay
    // can play before the 3s reading grace starts.
    const questionIndex = Number(eventPayload['question_index'] ?? 0);
    const leadMs = cfg.dispatch_lead_ms + (questionIndex === 0 ? WL_ROUND_INTRO_MS : 0);
    // One-shot: only a NULL stamp is written; retries keep the original.
    const stampedNow = await sql`
      UPDATE wl_question_runs
      SET playable_at_ms = ${redisNow + leadMs},
          deadline_at_ms = ${redisNow + leadMs + windowMs},
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
    const deadlineMs = Number(run.deadline_at_ms);
    if (run.status !== 'dispatched' || !Number.isFinite(playable)) return null;
    // ANY emission (first stamp included — the process may have stalled
    // between stamping and here) requires a meaningfully open window; a
    // re-broadcast of the identical payload mid-window is no worse than
    // network delay and clients dedup by seq. An effectively-over window
    // voids the attempt to a reserve.
    void isFirstEmission;
    const freshNow = await wlRedisNowMs();
    if (!Number.isFinite(deadlineMs) || freshNow > deadlineMs - WL_MIN_REMAINING_LEAD_MS) {
      return null;
    }
    return {
      ...eventPayload,
      playableAt: playable,
      deadlineAt: Number(run.deadline_at_ms),
    };
  },

  /**
   * Void an attempt and queue its reserve replacement — ONE transaction for
   * the abort of the dispatch event (fenced by the caller's claim token),
   * the run void, the client-facing void event (whose payload names the
   * aborted seq so the visible sequence gap is accounted for), and the
   * replacement/next dispatch. A crash leaves either the fully-dispatched
   * old state or the fully-voided new state, never a stranded question.
   */
  async voidAttempt(
    tournamentId: string,
    attemptId: string,
    redisNow: number,
    reason: string,
    fence?: { seq: number; claimToken: string }
  ): Promise<boolean> {
    // Close the Redis window FIRST: after this, no accept can succeed for
    // the attempt (the accept script checks the closed marker atomically),
    // so an answer can never be acknowledged after its attempt was voided.
    // Already-accepted answers are snapshotted and persisted below for
    // audit — the void event supersedes their acks client-side (a voided
    // attempt scores nobody, equally).
    const redis = wlRedis();
    const rawFlat = await redis.eval(CLOSE_SCRIPT, {
      keys: [answersKey(tournamentId, attemptId), closedKey(tournamentId, attemptId)],
      arguments: [String(REDIS_TTL_SECONDS)],
    }) as string[];
    const raw: Record<string, string> = {};
    for (let i = 0; i + 1 < rawFlat.length; i += 2) raw[rawFlat[i]!] = rawFlat[i + 1]!;

    class VoidLost extends Error {}
    let voided = false;
    try {
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as typeof sql;
        if (fence) {
          const aborted = await txSql`
            UPDATE wl_events
            SET aborted_at = NOW(), last_error = ${'void:' + reason}
            WHERE tournament_id = ${tournamentId} AND seq = ${fence.seq}
              AND claim_token = ${fence.claimToken}
              AND delivered_at IS NULL AND aborted_at IS NULL AND skipped_at IS NULL
            RETURNING seq
          `;
          // Fence lost ⇒ another claimant owns this dispatch — do NOT void.
          if (aborted.length === 0) throw new VoidLost();
        }
        const runs = await txSql<WlRunRow[]>`
          UPDATE wl_question_runs SET status = 'voided', void_reason = ${reason}
          WHERE attempt_id = ${attemptId} AND status IN ('created', 'dispatched')
          RETURNING attempt_id, tournament_id, game_index, round_index, question_index,
                    question_id, status, playable_at_ms::text, deadline_at_ms::text
        `;
        const run = runs[0];
        // The run moved on (frozen/revealed by another path): the whole tx —
        // INCLUDING the event abort — must roll back, never commit an abort
        // for a question that actually played.
        if (!run) throw new VoidLost();
        // Audit-persist any answers accepted before the void (scored 0 by
        // the nominal-void rule: a voided attempt never enters standings —
        // standings aggregate only frozen/revealed runs).
        const users = Object.keys(raw);
        if (users.length > 0) {
          const answers = users.map((u) => raw[u]!);
          await txSql`
            INSERT INTO wl_answers (
              attempt_id, user_id, tournament_id, game_index, answer, correct,
              points, elapsed_ms, time_charge_ms, timing_source
            )
            SELECT ${attemptId}, u, ${tournamentId}, ${run.game_index},
                   (a::jsonb)->'answer', COALESCE(((a::jsonb)->>'correct')::boolean, false),
                   0, COALESCE(((a::jsonb)->>'elapsedMs')::int, 0), 0, 'voided_audit'
            FROM unnest(${sql.array(users)}::uuid[], ${sql.array(answers)}::text[]) AS t(u, a)
            ON CONFLICT (attempt_id, user_id) DO NOTHING
          `;
        }
      await wlEventsRepo.append(txSql, {
        tournamentId,
        type: 'void',
        payload: {
          attempt_id: attemptId,
          game_index: run.game_index,
          round_index: run.round_index,
          question_index: run.question_index,
          reason,
          covers_seq: fence?.seq ?? null,
        },
        redisTimeMs: redisNow,
      });
      const voidedCount = await txSql<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM wl_question_runs
        WHERE tournament_id = ${tournamentId} AND game_index = ${run.game_index}
          AND round_index = ${run.round_index} AND question_index = ${run.question_index}
          AND status = 'voided'
      `;
      const nextReserve = voidedCount[0]?.n ?? 1;
      const replaced = await this.appendDispatchTx(
        txSql, tournamentId,
        { gameIndex: run.game_index, roundIndex: run.round_index, questionIndex: run.question_index },
        redisNow, nextReserve
      );
      if (!replaced) {
        logger.warn({ tournamentId, attemptId, nextReserve }, 'WL void: reserves exhausted, slot skipped');
        const next = wlNextSlot({
          gameIndex: run.game_index, roundIndex: run.round_index, questionIndex: run.question_index,
        });
        // Same rule as revealFrozen: within the round we skip straight on, but
        // a ROUND boundary is left to the orchestrator so the breather applies.
        // A void has no standings beat of its own (nobody saw the question),
        // yet the pacing must stay identical or rounds would start early.
        if (next && next.roundIndex === run.round_index) {
          await this.appendDispatchTx(txSql, tournamentId, next, redisNow);
        }
      }
        voided = true;
      });
    } catch (error) {
      if (!(error instanceof VoidLost)) throw error;
    }
    if (voided) {
      // Purge the answers hash: a voided attempt scores nobody, so its
      // stored answers must not be servable through the late-idempotency
      // recovery path (which reads Redis before the audit-filtered DB row).
      await redis.del(answersKey(tournamentId, attemptId)).catch(() => {});
    }
    return voided;
  },

  /**
   * Freeze + reveal an attempt whose deadline passed: persist answers +
   * misses charging, apply absolute standings, emit the reveal, queue the
   * next dispatch (or finish the game). Fully idempotent via status CAS.
   */
  async freezeAndReveal(tournamentId: string, run: WlRunRow, redisNow: number): Promise<void> {
    const redis = wlRedis();
    // Atomic close + snapshot: after this, the accept script rejects — no
    // answer can be acknowledged yet miss the snapshot.
    const rawFlat = await redis.eval(CLOSE_SCRIPT, {
      keys: [answersKey(tournamentId, run.attempt_id), closedKey(tournamentId, run.attempt_id)],
      arguments: [String(REDIS_TTL_SECONDS)],
    }) as string[];
    const raw: Record<string, string> = {};
    for (let i = 0; i + 1 < rawFlat.length; i += 2) raw[rawFlat[i]!] = rawFlat[i + 1]!;

    const windowMs = Math.max(
      1, Number(run.deadline_at_ms) - Number(run.playable_at_ms)
    );
    const answerRows = Object.entries(raw).map(([userId, packed]) => {
      const a = JSON.parse(packed) as {
        answer: unknown; correct: boolean; points: number; elapsedMs: number;
      };
      return { userId, ...a };
    });

    // Freeze CAS + answer persistence in ONE transaction: a crash cannot
    // strand a frozen run without its answers (finding P1-1), and the CAS
    // loser (concurrent freezer / replay) commits nothing.
    let won = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const frozen = await txSql`
        UPDATE wl_question_runs SET status = 'frozen'
        WHERE attempt_id = ${run.attempt_id} AND status = 'dispatched'
        RETURNING attempt_id
      `;
      if (frozen.length === 0) return;
      if (answerRows.length > 0) {
        // One bulk statement — a 600-player freeze must not issue 600
        // sequential inserts against the admission-limited pool.
        const userIds = answerRows.map((r) => r.userId);
        const answers = answerRows.map((r) => JSON.stringify(r.answer ?? null));
        const corrects = answerRows.map((r) => r.correct);
        const points = answerRows.map((r) => r.points);
        const elapsed = answerRows.map((r) => Math.min(Math.max(r.elapsedMs, 0), windowMs));
        await txSql`
          INSERT INTO wl_answers (
            attempt_id, user_id, tournament_id, game_index, answer, correct,
            points, elapsed_ms, time_charge_ms, timing_source
          )
          SELECT ${run.attempt_id}, u, ${tournamentId}, ${run.game_index},
                 a::jsonb, c, p, e, e, 'redis_accept'
          FROM unnest(
            ${sql.array(userIds)}::uuid[], ${sql.array(answers)}::text[],
            ${sql.array(corrects)}::boolean[], ${sql.array(points)}::int[],
            ${sql.array(elapsed)}::int[]
          ) AS t(u, a, c, p, e)
          ON CONFLICT (attempt_id, user_id) DO NOTHING
        `;
      }
      won = true;
    });
    if (!won && run.status !== 'frozen') return;
    await this.revealFrozen(tournamentId, run, redisNow);
  },

  /**
   * Idempotent frozen→revealed tail: recompute standings from the durable
   * answers, then CAS-reveal with the reveal event. Also the recovery path
   * for a crash between the freeze commit and the reveal commit.
   */
  async revealFrozen(tournamentId: string, run: WlRunRow, redisNow: number): Promise<void> {
    await this.applyAbsoluteStandings(tournamentId, run.game_index);

    // Distribution from the DURABLE answers (identical on resume).
    const persisted = await sql<Array<{ answer: unknown }>>`
      SELECT answer FROM wl_answers WHERE attempt_id = ${run.attempt_id}
    `;
    const distribution: Record<string, number> = {};
    for (const row of persisted) {
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
        UPDATE wl_question_runs
        SET status = 'revealed', revealed_at_ms = ${redisNow}
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
          kind: await this.kindOf(run.question_id),
          evaluation: content?.evaluation ?? null,
          answered: persisted.length,
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
      // At a ROUND boundary the next dispatch is deliberately NOT appended here:
      // the orchestrator's advance() holds it for WL_ROUND_BREATHER_MS so the
      // round-end standings beat can play. Mid-round we dispatch immediately.
      if (next.roundIndex === run.round_index) {
        await this.appendDispatch(tournamentId, next, redisNow);
      }
    }
  },

  /** Recovery alias — advance() resumes a stranded frozen run through here. */
  async resumeFrozen(tournamentId: string, run: WlRunRow, redisNow: number): Promise<void> {
    await this.revealFrozen(tournamentId, run, redisNow);
  },

  /** Absolute (repair-safe) standings from persisted answers + miss charges. */
  async applyAbsoluteStandings(tournamentId: string, gameIndex: number): Promise<void> {
    // Per-user totals with WINDOW-correct miss charges: an unanswered
    // attempt charges that attempt's full window (who_am_i = 5 clue windows),
    // never a flat constant — wrong-but-present must always beat absent.
    const rows = await sql<Array<{ user_id: string; points: number; time_ms: string }>>`
      WITH asked AS (
        SELECT attempt_id,
               GREATEST(1, deadline_at_ms - playable_at_ms) AS window_ms
        FROM wl_question_runs
        WHERE tournament_id = ${tournamentId} AND game_index = ${gameIndex}
          AND status IN ('frozen', 'revealed')
      )
      SELECT p.user_id,
             COALESCE(SUM(a.points), 0)::int AS points,
             (
               COALESCE(SUM(LEAST(a.time_charge_ms, asked.window_ms)), 0)
               + COALESCE((SELECT SUM(window_ms) FROM asked), 0)
               - COALESCE(SUM(asked.window_ms), 0)
             )::text AS time_ms
      FROM wl_game_participants p
      LEFT JOIN wl_answers a
        ON a.tournament_id = p.tournament_id AND a.game_index = p.game_index
       AND a.user_id = p.user_id
      LEFT JOIN asked ON asked.attempt_id = a.attempt_id
      WHERE p.tournament_id = ${tournamentId} AND p.game_index = ${gameIndex}
      GROUP BY p.user_id
    `;
    const redis = wlRedis();
    const key = `wl:${tournamentId}:g${gameIndex}:scores`;
    if (rows.length === 0) return;
    await redis.zAdd(key, rows.map((r) => (
      { score: wlEncodeScore(r.points, Number(r.time_ms)), value: r.user_id }
    )));
    await redis.expire(key, REDIS_TTL_SECONDS);
  },

  /** Top-N board with the canonical comparator (never raw ZSET order). */
  async topBoard(
    tournamentId: string,
    gameIndex: number,
    limit: number
  ): Promise<Array<{ user_id: string; nickname: string | null; points: number; time_ms_total: number; rank: number }>> {
    // Per-user totals with WINDOW-correct miss charges: an unanswered
    // attempt charges that attempt's full window (who_am_i = 5 clue windows),
    // never a flat constant — wrong-but-present must always beat absent.
    const rows = await sql<Array<{ user_id: string; nickname: string | null; points: number; time_ms: string }>>`
      WITH asked AS (
        SELECT attempt_id,
               GREATEST(1, deadline_at_ms - playable_at_ms) AS window_ms
        FROM wl_question_runs
        WHERE tournament_id = ${tournamentId} AND game_index = ${gameIndex}
          AND status IN ('frozen', 'revealed')
      )
      SELECT p.user_id,
             MIN(u.nickname) AS nickname,
             COALESCE(SUM(a.points), 0)::int AS points,
             (
               COALESCE(SUM(LEAST(a.time_charge_ms, asked.window_ms)), 0)
               + COALESCE((SELECT SUM(window_ms) FROM asked), 0)
               - COALESCE(SUM(asked.window_ms), 0)
             )::text AS time_ms
      FROM wl_game_participants p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN wl_answers a
        ON a.tournament_id = p.tournament_id AND a.game_index = p.game_index
       AND a.user_id = p.user_id
      LEFT JOIN asked ON asked.attempt_id = a.attempt_id
      WHERE p.tournament_id = ${tournamentId} AND p.game_index = ${gameIndex}
      GROUP BY p.user_id
    `;
    const standings = rows.map((r) => ({
      userId: r.user_id,
      nickname: r.nickname,
      points: r.points,
      timeMsTotal: Number(r.time_ms),
    }));
    standings.sort(wlCompareStanding);
    // Nickname rides on every board row so clients never fall back to
    // placeholder names; deliberately NO is_ai flag — spectators and players
    // must not be able to tell roster bots apart.
    return standings.slice(0, limit).map((s, i) => ({
      user_id: s.userId, nickname: s.nickname, points: s.points, time_ms_total: s.timeMsTotal, rank: i + 1,
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
    elapsedMs: number,
    clueWindowMs = 10_000
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
        // The clue index is SERVER-derived from elapsed time (the clue the
        // player could have seen when answering) — a client-claimed index
        // would let a modified client take clue-1 points at clue 5.
        const parsed = answer as { guess?: unknown } | null;
        const correct = matchesAccepted(parsed?.guess, evaluation);
        const clueIndex = Math.min(
          WL_WHO_AM_I_CLUE_POINTS.length - 1,
          Math.floor(elapsedMs / Math.max(1, clueWindowMs))
        );
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

// ── Answer hot-path caches ───────────────────────────────────────────────────
// The three PG lookups below return data that is immutable for the lifetime
// of an attempt (run row), a question (evaluation/config) and a game
// (participant roster) — yet at 1k concurrent answerers the per-answer
// round-trips saturate the pool (observed ack p95 5.3s, in-time answers
// processed past their deadline). Caching them makes the hot path
// Redis-only. Correctness is unaffected: closure and once-only acceptance
// are gated in the Redis accept script (closed marker + deadline), never in
// these rows, and void/freeze both set the closed marker BEFORE anything
// else. Per-process cache; replicas warm independently.
const HOT_CACHE_TTL_MS = 120_000;
const HOT_CACHE_MAX = 300;
interface HotCacheEntry<T> { value: T; at: number }
function hotCacheGet<T>(map: Map<string, HotCacheEntry<T>>, key: string): T | null {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > HOT_CACHE_TTL_MS) { map.delete(key); return null; }
  return hit.value;
}
function hotCacheSet<T>(map: Map<string, HotCacheEntry<T>>, key: string, value: T): void {
  if (map.size >= HOT_CACHE_MAX) {
    const cutoff = Date.now() - HOT_CACHE_TTL_MS;
    for (const [k, v] of map) { if (v.at < cutoff) map.delete(k); }
    if (map.size >= HOT_CACHE_MAX) map.delete(map.keys().next().value!);
  }
  map.set(key, { value, at: Date.now() });
}
const runHotCache = new Map<string, HotCacheEntry<WlRunRow>>();
const contentHotCache = new Map<string, HotCacheEntry<{
  kind: WlRoundKind; evaluation: Record<string, unknown>; config: Record<string, unknown>;
}>>();
const participantHotCache = new Map<string, HotCacheEntry<Set<string>>>();
// In-flight coalescing: without it a fresh dispatch stampedes — every
// answer arriving before the first query resolves misses the cache and
// fires the identical query, defeating the fix exactly when it matters.
// One loader per key; failures propagate to all waiters and cache nothing.
const hotInflight = new Map<string, Promise<unknown>>();
async function hotLoad<T>(
  map: Map<string, HotCacheEntry<T>>,
  namespace: string,
  key: string,
  loader: () => Promise<T | null>,
  cacheable: (value: T) => boolean
): Promise<T | null> {
  const cached = hotCacheGet(map, key);
  if (cached != null) return cached;
  const inflightKey = `${namespace}:${key}`;
  let pending = hotInflight.get(inflightKey) as Promise<T | null> | undefined;
  if (!pending) {
    pending = (async () => {
      const value = await loader();
      if (value != null && cacheable(value)) hotCacheSet(map, key, value);
      return value;
    })();
    hotInflight.set(inflightKey, pending);
    void pending.catch(() => {}).then(() => hotInflight.delete(inflightKey));
  }
  return pending;
}

/** Test seam for the answer hot-path cache (unit-tested coalescing). */
export const wlAnswerHotCacheInternals = {
  hotLoad,
  caches: { runHotCache, contentHotCache, participantHotCache },
  inflight: hotInflight,
};

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
  const runKey = `${input.tournamentId}:${input.attemptId}`;
  // Cache only the live shape: window stamps are immutable, and closure is
  // enforced by deadline + the Redis closed marker, not this status.
  const run = await hotLoad(runHotCache, 'run', runKey, async () => {
    const [row] = await sql<WlRunRow[]>`
      SELECT r.attempt_id, r.tournament_id, r.game_index, r.round_index,
             r.question_index, r.question_id, r.status,
             r.playable_at_ms::text, r.deadline_at_ms::text
      FROM wl_question_runs r
      WHERE r.attempt_id = ${input.attemptId} AND r.tournament_id = ${input.tournamentId}
    `;
    return row ?? null;
  }, (row) => row.status === 'dispatched');
  if (!run) return { accepted: false, reason: 'unknown_attempt' };
  const playable = Number(run.playable_at_ms);
  const deadline = Number(run.deadline_at_ms);
  const redisNow = await wlRedisNowMs();
  if (run.status !== 'dispatched' || !Number.isFinite(playable)
    || redisNow < playable || redisNow >= deadline) {
    // Idempotent recovery MUST survive closure: a client whose ack was
    // dropped near the deadline retries after it — the accepted result it
    // already earned has to come back, not `closed`. Redis first (until
    // TTL), then the persisted row after freeze.
    const storedLate = await wlRedis()
      .hGet(answersKey(input.tournamentId, input.attemptId), input.userId)
      .catch(() => null);
    if (storedLate) {
      try {
        const p = JSON.parse(storedLate) as { correct: boolean; points: number; elapsedMs: number };
        return { accepted: true, correct: p.correct, points: p.points, elapsedMs: p.elapsedMs };
      } catch { /* fall through to the persisted row */ }
    }
    const [persistedRow] = await sql<Array<{ correct: boolean; points: number; elapsed_ms: number }>>`
      SELECT correct, points, elapsed_ms FROM wl_answers
      WHERE attempt_id = ${input.attemptId} AND user_id = ${input.userId}
        AND timing_source <> 'voided_audit'
    `;
    if (persistedRow) {
      return {
        accepted: true,
        correct: persistedRow.correct,
        points: persistedRow.points,
        elapsedMs: persistedRow.elapsed_ms,
      };
    }
    return { accepted: false, reason: 'closed' };
  }
  const rosterKey = `${input.tournamentId}:${run.game_index}`;
  // A roster is written once at game start; never cache an empty read (it
  // could race the game-setup transaction).
  const roster = await hotLoad(participantHotCache, 'roster', rosterKey, async () => {
    const rows = await sql<{ user_id: string }[]>`
      SELECT user_id FROM wl_game_participants
      WHERE tournament_id = ${input.tournamentId} AND game_index = ${run.game_index}
    `;
    return new Set(rows.map((r) => r.user_id));
  }, (set) => set.size > 0);
  if (!roster || !roster.has(input.userId)) return { accepted: false, reason: 'not_participant' };

  const content = await hotLoad(contentHotCache, 'content', run.question_id, async () => {
    const [row] = await sql<Array<{ kind: WlRoundKind; evaluation: Record<string, unknown>; config: Record<string, unknown> }>>`
      SELECT q.kind, q.evaluation, t.config
      FROM wl_questions q
      JOIN wl_tournaments t ON t.id = q.tournament_id
      WHERE q.question_id = ${run.question_id}
    `;
    return row ?? null;
  }, () => true);
  if (!content) return { accepted: false, reason: 'unknown_attempt' };

  const elapsedMs = Math.max(0, redisNow - playable);
  const { correct, points } = wlLiveEngineInternals.scoreAnswer(
    content.kind, content.evaluation, input.answer, elapsedMs,
    wlConfigFrom(content.config).question_time_ms
  );

  const redis = wlRedis();
  const stored = await redis.eval(ACCEPT_SCRIPT, {
    keys: [
      answersKey(input.tournamentId, input.attemptId),
      closedKey(input.tournamentId, input.attemptId),
    ],
    arguments: [
      input.userId,
      JSON.stringify({ answer: input.answer, correct, points, elapsedMs }),
      String(deadline),
      String(REDIS_TTL_SECONDS),
    ],
  }) as number;
  if (stored === -1) {
    // The window closed between our PG time check and the script (TOCTOU) —
    // same idempotency duty as the early-closed path: if THIS user already
    // has a stored answer, return it instead of `closed`.
    const prior = await redis
      .hGet(answersKey(input.tournamentId, input.attemptId), input.userId)
      .catch(() => null);
    if (prior) {
      try {
        const p = JSON.parse(prior) as { correct: boolean; points: number; elapsedMs: number };
        return { accepted: true, correct: p.correct, points: p.points, elapsedMs: p.elapsedMs };
      } catch { /* unreadable → closed */ }
    }
    return { accepted: false, reason: 'closed' };
  }
  if (stored === 0) {
    const prior = await redis.hGet(answersKey(input.tournamentId, input.attemptId), input.userId);
    if (prior) {
      const p = JSON.parse(prior) as { correct: boolean; points: number; elapsedMs: number };
      return { accepted: true, correct: p.correct, points: p.points, elapsedMs: p.elapsedMs };
    }
    return { accepted: false, reason: 'duplicate' };
  }
  return { accepted: true, correct, points, elapsedMs };
}

export interface WlSubscribeSnapshot {
  status: string;
  /** Redis server clock at snapshot build — seeds the client's clock offset. */
  server_now: number;
  game_index: number;
  /** Dispatch-shaped payload for the in-flight question (players only). */
  attempt: Record<string, unknown> | null;
  /** The caller's already-accepted answer on that attempt, if any. */
  your_answer: { correct: boolean; points: number; elapsedMs: number } | null;
  /** The caller's most recent PERSISTED answer this game, attempt-identified —
      recovers the verdict even when the attempt froze before this snapshot. */
  your_last_answer: { attempt_id: string; correct: boolean; points: number; elapsedMs: number } | null;
  /** The caller's accepted points this game (persisted + in-flight). */
  score: number;
  /** Exact outbox boundary: events ≤ this seq are fully reflected in score;
      events above it not at all (read in the same MVCC statement). */
  snapshot_seq: number;
  board: Array<{ user_id: string; nickname: string | null; points: number; time_ms_total: number; rank: number }>;
}

/**
 * PLAYER state snapshot for the wl:subscribe ack, so a late join or a
 * transient reconnect resumes mid-question instead of waiting for the next
 * dispatch: the in-flight attempt (question + evaluation + window stamps —
 * the same payload a live dispatch carries) plus the caller's own accepted
 * answer and per-game score. Spectators get NO snapshot at all — their whole
 * world is the 30s-delayed stream, and live standings/status through the ack
 * would leak ahead of it.
 *
 * Read ordering makes the score safe against a concurrent freeze: the
 * persisted sum is read BEFORE the dispatched-run/Redis pair, and the freeze
 * transaction persists answers atomically with the run leaving 'dispatched',
 * so an attempt can never be counted twice (a freeze landing between the
 * reads can only cause a momentary undercount that the very next reveal
 * event corrects).
 */
export async function wlSubscribeSnapshot(
  tournamentId: string,
  userId: string
): Promise<WlSubscribeSnapshot | null> {
  // The persisted score and the event cursor are read in ONE statement, so
  // they see the same MVCC snapshot. Persisted-answer transitions (freeze,
  // void, game results) commit their wl_events row + next_event_seq bump in
  // the same transaction as the state they describe, which makes
  // snapshot_seq an exact boundary FOR THE PERSISTED COMPONENT: such an
  // event with seq ≤ snapshot_seq is fully reflected in the persisted sum,
  // one above it not at all. The in-flight Redis component added below has
  // no outbox seq — clients that reconcile against this boundary must treat
  // your_answer / your_last_answer as the source of the in-flight attempts
  // the score already counts.
  const [t] = await sql<Array<{
    status: string; stage: Record<string, unknown> | null;
    snapshot_seq: string; my_points: number;
  }>>`
    SELECT status, stage, next_event_seq::text AS snapshot_seq,
           (SELECT COALESCE(SUM(a.points), 0)::int
            FROM wl_answers a
            WHERE a.tournament_id = wl_tournaments.id
              AND a.user_id = ${userId}
              AND a.game_index = COALESCE(NULLIF(wl_tournaments.stage->>'current_game', ''), '0')::int
           ) AS my_points
    FROM wl_tournaments WHERE id = ${tournamentId}
  `;
  if (!t) return null;
  const stage = t.stage ?? {};
  const gameIndex = Number.isFinite(Number(stage['current_game'])) ? Number(stage['current_game']) : 0;
  const board = await wlLiveEngineInternals.topBoard(tournamentId, gameIndex, WL_FINALISTS);
  const redisNow = await wlRedisNowMs();

  const persisted = { points: t.my_points };

  let attempt: Record<string, unknown> | null = null;
  let yourAnswer: WlSubscribeSnapshot['your_answer'] = null;
  let inFlightPoints = 0;
  // No in-flight attempt outside an actually-running game: cancellation does
  // not close runs, so gate by tournament status rather than run state alone.
  const gameRunning = t.status === 'game_live' || t.status === 'final_live';
  const [run] = gameRunning
    ? await sql<Array<{
        attempt_id: string; game_index: number; round_index: number; question_index: number;
        question_id: string; playable_at_ms: string | null; deadline_at_ms: string | null;
      }>>`
        SELECT attempt_id, game_index, round_index, question_index, question_id,
               playable_at_ms::text, deadline_at_ms::text
        FROM wl_question_runs
        WHERE tournament_id = ${tournamentId} AND game_index = ${gameIndex}
          AND status = 'dispatched'
        ORDER BY round_index DESC, question_index DESC
        LIMIT 1
      `
    : [];
  if (run && Number(run.deadline_at_ms) > redisNow) {
    const [content] = await sql<Array<{ kind: WlRoundKind; payload: unknown; evaluation: unknown }>>`
      SELECT kind, payload, evaluation FROM wl_questions WHERE question_id = ${run.question_id}
    `;
    if (content) {
      attempt = {
        attempt_id: run.attempt_id,
        game_index: run.game_index,
        round_index: run.round_index,
        question_index: run.question_index,
        kind: content.kind,
        question: content.payload,
        evaluation: content.evaluation,
        playableAt: Number(run.playable_at_ms),
        deadlineAt: Number(run.deadline_at_ms),
      };
      const stored = await wlRedis().hGet(answersKey(tournamentId, run.attempt_id), userId);
      if (stored) {
        try {
          const p = JSON.parse(stored) as { correct?: boolean; points?: number; elapsedMs?: number };
          yourAnswer = {
            correct: p.correct === true,
            points: Number(p.points) || 0,
            elapsedMs: Number(p.elapsedMs) || 0,
          };
          inFlightPoints = yourAnswer.points;
        } catch {
          // unreadable stored answer — treat as unanswered
        }
      }
    }
  }

  const [lastPersisted] = await sql<Array<{
    attempt_id: string; correct: boolean; points: number; elapsed_ms: number;
  }>>`
    SELECT a.attempt_id, a.correct, a.points, a.elapsed_ms
    FROM wl_answers a
    JOIN wl_question_runs r ON r.attempt_id = a.attempt_id
    WHERE a.tournament_id = ${tournamentId} AND a.game_index = ${gameIndex}
      AND a.user_id = ${userId} AND a.timing_source <> 'voided_audit'
    ORDER BY r.round_index DESC, r.question_index DESC
    LIMIT 1
  `;
  return {
    status: t.status,
    server_now: redisNow,
    game_index: gameIndex,
    attempt,
    your_answer: yourAnswer,
    your_last_answer: lastPersisted
      ? {
          attempt_id: lastPersisted.attempt_id,
          correct: lastPersisted.correct,
          points: lastPersisted.points,
          elapsedMs: lastPersisted.elapsed_ms,
        }
      : null,
    score: (persisted?.points ?? 0) + inFlightPoints,
    snapshot_seq: Number(t.snapshot_seq),
    board,
  };
}

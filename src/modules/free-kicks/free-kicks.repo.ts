import { sql, type TransactionSql } from '../../db/index.js';
import type { QuestionWithPayload } from '../../db/types.js';
import { QUESTION_CANDIDATES, RECENT_QUESTION_WINDOW, STALE_AFTER_MS } from './free-kicks.constants.js';
import type { FreeKicksEventInput, FreeKicksRoundRow } from './free-kicks.types.js';

/** postgres.js TransactionSql loses its call signature through the type
 *  re-export; the repo-wide convention is to cast (see tuning.repo.ts). */
const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

export const freeKicksRepo = {
  async insertRound(
    tx: TransactionSql,
    data: {
      userId: string;
      stakeCoins: number;
      serverSeed: string;
      commitHash: string;
      clientNonce: string | null;
    }
  ): Promise<FreeKicksRoundRow> {
    const [row] = await exec(tx)<FreeKicksRoundRow[]>`
      INSERT INTO free_kicks_rounds (
        user_id, stake_coins, pot_coins, server_seed, commit_hash, client_nonce
      ) VALUES (
        ${data.userId}, ${data.stakeCoins}, ${data.stakeCoins},
        ${data.serverSeed}, ${data.commitHash}, ${data.clientNonce}
      )
      RETURNING *
    `;
    return row;
  },

  async getActiveRound(userId: string): Promise<FreeKicksRoundRow | null> {
    const [row] = await sql<FreeKicksRoundRow[]>`
      SELECT * FROM free_kicks_rounds
      WHERE user_id = ${userId} AND status = 'active'
    `;
    return row ?? null;
  },

  /** Lock the caller's active round for a mutation. */
  async getActiveRoundForUpdate(
    tx: TransactionSql,
    userId: string
  ): Promise<FreeKicksRoundRow | null> {
    const [row] = await exec(tx)<FreeKicksRoundRow[]>`
      SELECT * FROM free_kicks_rounds
      WHERE user_id = ${userId} AND status = 'active'
      FOR UPDATE
    `;
    return row ?? null;
  },

  /** Sweeper claim: lock a specific round if nobody else holds it. */
  async getRoundForUpdateSkipLocked(
    tx: TransactionSql,
    roundId: string
  ): Promise<FreeKicksRoundRow | null> {
    const [row] = await exec(tx)<FreeKicksRoundRow[]>`
      SELECT * FROM free_kicks_rounds
      WHERE id = ${roundId}
      FOR UPDATE SKIP LOCKED
    `;
    return row ?? null;
  },

  /**
   * Optimistic conditional update: applies `patch` and bumps state_version
   * only if the caller's expected version still holds. Returns null when the
   * round moved underneath the caller (stale command).
   */
  async updateRoundState(
    tx: TransactionSql,
    roundId: string,
    expectedVersion: number,
    patch: Record<string, unknown>
  ): Promise<FreeKicksRoundRow | null> {
    const [row] = await exec(tx)<FreeKicksRoundRow[]>`
      UPDATE free_kicks_rounds
      SET ${exec(tx)(patch as Record<string, never>)}, state_version = state_version + 1, last_seen_at = now()
      WHERE id = ${roundId} AND state_version = ${expectedVersion} AND status = 'active'
      RETURNING *
    `;
    return row ?? null;
  },

  async touchLastSeen(userId: string): Promise<void> {
    await sql`
      UPDATE free_kicks_rounds
      SET last_seen_at = now()
      WHERE user_id = ${userId} AND status = 'active'
    `;
  },

  async insertEvent(tx: TransactionSql, event: FreeKicksEventInput): Promise<void> {
    await exec(tx)`
      INSERT INTO free_kicks_events (
        round_id, user_id, attack, state_version, event_type,
        question_id, answer_option, answer_correct, answer_ms,
        open_count, picked_zone, keeper_zone, scored,
        commit_hash, server_seed, client_nonce, hmac_input,
        pot_before, pot_after
      ) VALUES (
        ${event.roundId}, ${event.userId}, ${event.attack}, ${event.stateVersion}, ${event.eventType},
        ${event.questionId ?? null}, ${event.answerOption ?? null}, ${event.answerCorrect ?? null}, ${event.answerMs ?? null},
        ${event.openCount ?? null}, ${event.pickedZone ?? null}, ${event.keeperZone ?? null}, ${event.scored ?? null},
        ${event.commitHash ?? null}, ${event.serverSeed ?? null}, ${event.clientNonce ?? null}, ${event.hmacInput ?? null},
        ${event.potBefore ?? null}, ${event.potAfter ?? null}
      )
    `;
  },

  /** Recently served question ids for this user (repeat avoidance). */
  async getRecentQuestionIds(userId: string): Promise<string[]> {
    const rows = await sql<Array<{ question_id: string }>>`
      SELECT DISTINCT question_id
      FROM (
        SELECT question_id
        FROM free_kicks_events
        WHERE user_id = ${userId} AND question_id IS NOT NULL
        ORDER BY id DESC
        LIMIT ${RECENT_QUESTION_WINDOW}
      ) recent
    `;
    return rows.map((row) => row.question_id);
  },

  /**
   * Bounded random sample of eligible questions. Uses the production
   * eligibility rules (published + ranked_eligible + public), not just
   * "published". Candidates are validated/filtered in the service.
   */
  async pickQuestionCandidates(excludeIds: string[]): Promise<QuestionWithPayload[]> {
    return sql<QuestionWithPayload[]>`
      SELECT q.*, qp.payload
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.status = 'published'
        AND q.type = 'mcq_single'
        AND q.ranked_eligible = true
        AND q.visibility = 'public'
        AND q.id != ALL(${sql.array(excludeIds)}::uuid[])
      ORDER BY random()
      LIMIT ${QUESTION_CANDIDATES}
    `;
  },

  /** Active rounds whose owner has gone quiet — candidates for auto-settle. */
  async getStaleActiveRoundIds(limit: number): Promise<string[]> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM free_kicks_rounds
      WHERE status = 'active'
        AND last_seen_at < now() - make_interval(secs => ${STALE_AFTER_MS / 1000})
      ORDER BY last_seen_at ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },
};

import { sql, type TransactionSql } from '../../db/index.js';
import { pickIdleRosterBots, topUpRosterBotWallet } from '../synthetic-bots/roster.js';
import type { QuestionWithPayload } from '../../db/types.js';
import { QUESTION_CANDIDATES, RECENT_QUESTION_WINDOW, STALE_AFTER_MS } from './trivia-mines.constants.js';
import type { TriviaMinesEventInput, TriviaMinesRoundRow } from './trivia-mines.types.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;

export const triviaMinesRepo = {
  async insertRound(
    tx: TransactionSql,
    data: { userId: string; stakeCoins: number; serverSeed: string; commitHash: string; clientNonce: string | null }
  ): Promise<TriviaMinesRoundRow> {
    const [row] = await exec(tx)<TriviaMinesRoundRow[]>`
      INSERT INTO trivia_mines_rounds (user_id, stake_coins, pot_coins, server_seed, commit_hash, client_nonce)
      VALUES (${data.userId}, ${data.stakeCoins}, ${data.stakeCoins}, ${data.serverSeed}, ${data.commitHash}, ${data.clientNonce})
      RETURNING *
    `;
    return row;
  },

  async getActiveRound(userId: string): Promise<TriviaMinesRoundRow | null> {
    const [row] = await sql<TriviaMinesRoundRow[]>`
      SELECT * FROM trivia_mines_rounds WHERE user_id = ${userId} AND status = 'active'
    `;
    return row ?? null;
  },

  async getActiveRoundForUpdate(tx: TransactionSql, userId: string): Promise<TriviaMinesRoundRow | null> {
    const [row] = await exec(tx)<TriviaMinesRoundRow[]>`
      SELECT * FROM trivia_mines_rounds WHERE user_id = ${userId} AND status = 'active' FOR UPDATE
    `;
    return row ?? null;
  },

  async getRoundForUpdateSkipLocked(tx: TransactionSql, roundId: string): Promise<TriviaMinesRoundRow | null> {
    const [row] = await exec(tx)<TriviaMinesRoundRow[]>`
      SELECT * FROM trivia_mines_rounds WHERE id = ${roundId} FOR UPDATE SKIP LOCKED
    `;
    return row ?? null;
  },

  /** Optimistic conditional update; null when the round moved underneath the caller. */
  async updateRoundState(
    tx: TransactionSql,
    roundId: string,
    expectedVersion: number,
    patch: Record<string, unknown>
  ): Promise<TriviaMinesRoundRow | null> {
    const [row] = await exec(tx)<TriviaMinesRoundRow[]>`
      UPDATE trivia_mines_rounds
      SET ${exec(tx)(patch as Record<string, never>)}, state_version = state_version + 1, last_seen_at = now()
      WHERE id = ${roundId} AND state_version = ${expectedVersion} AND status = 'active'
      RETURNING *
    `;
    return row ?? null;
  },

  async setQuestionSnapshot(
    tx: TransactionSql,
    roundId: string,
    expectedVersion: number,
    data: { questionId: string; snapshot: unknown; correctOption: string; deadlineAt: string }
  ): Promise<TriviaMinesRoundRow | null> {
    const [row] = await exec(tx)<TriviaMinesRoundRow[]>`
      UPDATE trivia_mines_rounds
      SET phase = 'question',
          question_id = ${data.questionId},
          question_payload = ${exec(tx).json(data.snapshot as never)},
          question_correct_option = ${data.correctOption},
          question_deadline_at = ${data.deadlineAt},
          state_version = state_version + 1,
          last_seen_at = now()
      WHERE id = ${roundId} AND state_version = ${expectedVersion} AND status = 'active'
      RETURNING *
    `;
    return row ?? null;
  },

  async touchLastSeen(userId: string): Promise<void> {
    await sql`UPDATE trivia_mines_rounds SET last_seen_at = now() WHERE user_id = ${userId} AND status = 'active'`;
  },

  async insertEvent(tx: TransactionSql, event: TriviaMinesEventInput): Promise<void> {
    await exec(tx)`
      INSERT INTO trivia_mines_events (
        round_id, user_id, state_version, event_type, tile, question_id, answer_option, answer_correct, answer_ms,
        flagged_tile, commit_hash, server_seed, client_nonce, hmac_input, pot_before, pot_after
      ) VALUES (
        ${event.roundId}, ${event.userId}, ${event.stateVersion}, ${event.eventType}, ${event.tile ?? null},
        ${event.questionId ?? null}, ${event.answerOption ?? null}, ${event.answerCorrect ?? null}, ${event.answerMs ?? null},
        ${event.flaggedTile ?? null}, ${event.commitHash ?? null}, ${event.serverSeed ?? null}, ${event.clientNonce ?? null},
        ${event.hmacInput ?? null}, ${event.potBefore ?? null}, ${event.potAfter ?? null}
      )
    `;
  },

  async getRecentQuestionIds(userId: string): Promise<string[]> {
    const rows = await sql<Array<{ question_id: string }>>`
      SELECT DISTINCT question_id FROM (
        SELECT question_id FROM trivia_mines_events
        WHERE user_id = ${userId} AND question_id IS NOT NULL
        ORDER BY id DESC LIMIT ${RECENT_QUESTION_WINDOW}
      ) recent
    `;
    return rows.map((row) => row.question_id);
  },

  /** Bounded random sample from the ranked-eligible published MCQ pool (same rules as Free Kicks). */
  async pickQuestionCandidates(excludeIds: string[]): Promise<QuestionWithPayload[]> {
    return sql<QuestionWithPayload[]>`
      SELECT q.*, qp.payload
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE q.status = 'published' AND q.type = 'mcq_single' AND q.ranked_eligible = true AND q.visibility = 'public'
        AND q.id != ALL(${sql.array(excludeIds)}::uuid[])
      ORDER BY random()
      LIMIT ${QUESTION_CANDIDATES}
    `;
  },

  async getStaleActiveRoundIds(limit: number): Promise<string[]> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM trivia_mines_rounds
      WHERE status = 'active' AND last_seen_at < now() - make_interval(secs => ${STALE_AFTER_MS / 1000})
      ORDER BY last_seen_at ASC LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },

  async countPlayingNow(): Promise<number> {
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM trivia_mines_rounds
      WHERE status = 'active' AND last_seen_at > now() - interval '90 seconds'
    `;
    return Number(row?.count ?? 0);
  },

  async getRecentWins(limit: number): Promise<Array<{ nickname: string; payout_coins: number; stake_coins: number; settled_at: string }>> {
    return sql<Array<{ nickname: string; payout_coins: number; stake_coins: number; settled_at: string }>>`
      SELECT u.nickname, r.payout_coins, r.stake_coins, r.settled_at
      FROM trivia_mines_rounds r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'cashed' AND r.payout_coins > r.stake_coins
      ORDER BY r.settled_at DESC LIMIT ${limit}
    `;
  },

  /** Best run multipliers (payout/stake) cashed in the last 24h, per user. */
  async getTopRuns(limit: number): Promise<Array<{ nickname: string; run_mult: number }>> {
    return sql<Array<{ nickname: string; run_mult: number }>>`
      SELECT u.nickname, MAX(r.payout_coins::float / r.stake_coins)::float AS run_mult
      FROM trivia_mines_rounds r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'cashed' AND r.payout_coins > r.stake_coins AND r.settled_at > now() - interval '24 hours'
      GROUP BY u.id, u.nickname
      ORDER BY run_mult DESC LIMIT ${limit}
    `;
  },

  pickIdleBots(limit: number) {
    return pickIdleRosterBots('trivia_mines_rounds', limit, 'trivia-mines');
  },

  topUpBotWallet(userId: string, amount: number) {
    return topUpRosterBotWallet(userId, amount, 'trivia_mines_bot_topup');
  },
};

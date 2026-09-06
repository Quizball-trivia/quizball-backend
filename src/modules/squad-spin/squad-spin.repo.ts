import { sql, type TransactionSql } from '../../db/index.js';
import { pickIdleRosterBots, topUpRosterBotWallet } from '../synthetic-bots/roster.js';
import { CALIBRATION_MAX_ANSWERS_PER_USER, CALIBRATION_WINDOW_DAYS, PLAYING_NOW_WINDOW_S, SEEN_COMBO_WINDOW_DAYS, type SquadSpinTier } from './squad-spin.constants.js';
import type { TierObservation } from './squad-spin.calibration.js';
import type {
  SquadSpinAliasRow,
  SquadSpinCalibrationRow,
  SquadSpinComboRow,
  SquadSpinCriterionRow,
  SquadSpinEventInput,
  SquadSpinPlayerRow,
  SquadSpinRoundRow,
  StepsSnapshot,
} from './squad-spin.types.js';

const exec = (tx: TransactionSql): typeof sql => tx as unknown as typeof sql;
/** Content reads run on the caller's transaction when one is open, so a locked round never waits on a second pool connection. */
const db = (tx?: TransactionSql): typeof sql => (tx ? exec(tx) : sql);

export const squadSpinRepo = {
  async insertRound(
    tx: TransactionSql,
    data: {
      roundId: string; userId: string; stakeCoins: number; reels: number; comboId: string; questionDealtAt: string; questionDeadlineAt: string;
      stepsBp: StepsSnapshot; calibrationDay: string; serverSeed: string; commitHash: string; clientNonce: string | null;
    },
  ): Promise<SquadSpinRoundRow> {
    const [row] = await exec(tx)<SquadSpinRoundRow[]>`
      INSERT INTO squad_spin_rounds (
        id, user_id, stake_coins, reels, pot_coins, combo_id, combo_ids, question_dealt_at, question_deadline_at,
        steps_bp, calibration_day, server_seed, commit_hash, client_nonce
      ) VALUES (
        ${data.roundId}, ${data.userId}, ${data.stakeCoins}, ${data.reels}, ${data.stakeCoins}, ${data.comboId}, ${sql.array([data.comboId])}::uuid[],
        ${data.questionDealtAt}, ${data.questionDeadlineAt}, ${exec(tx).json(data.stepsBp as never)}, ${data.calibrationDay}, ${data.serverSeed}, ${data.commitHash}, ${data.clientNonce}
      )
      RETURNING *
    `;
    return row;
  },

  async getActiveRoundForUpdate(tx: TransactionSql, userId: string): Promise<SquadSpinRoundRow | null> {
    const [row] = await exec(tx)<SquadSpinRoundRow[]>`
      SELECT * FROM squad_spin_rounds WHERE user_id = ${userId} AND status = 'active' FOR UPDATE
    `;
    return row ?? null;
  },

  async getRoundByNonceForUpdate(tx: TransactionSql, userId: string, clientNonce: string): Promise<SquadSpinRoundRow | null> {
    const [row] = await exec(tx)<SquadSpinRoundRow[]>`
      SELECT * FROM squad_spin_rounds WHERE user_id = ${userId} AND client_nonce = ${clientNonce} FOR UPDATE
    `;
    return row ?? null;
  },

  async getLatestRound(userId: string): Promise<SquadSpinRoundRow | null> {
    const [row] = await sql<SquadSpinRoundRow[]>`
      SELECT * FROM squad_spin_rounds WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT 1
    `;
    return row ?? null;
  },

  async getActiveRound(userId: string): Promise<SquadSpinRoundRow | null> {
    const [row] = await sql<SquadSpinRoundRow[]>`
      SELECT * FROM squad_spin_rounds WHERE user_id = ${userId} AND status = 'active'
    `;
    return row ?? null;
  },

  async getRoundForUpdateSkipLocked(tx: TransactionSql, roundId: string): Promise<SquadSpinRoundRow | null> {
    const [row] = await exec(tx)<SquadSpinRoundRow[]>`
      SELECT * FROM squad_spin_rounds WHERE id = ${roundId} FOR UPDATE SKIP LOCKED
    `;
    return row ?? null;
  },

  /** Optimistic conditional update; null when the round moved underneath the caller. */
  async updateRoundState(tx: TransactionSql, roundId: string, expectedVersion: number, patch: Record<string, unknown>): Promise<SquadSpinRoundRow | null> {
    const [row] = await exec(tx)<SquadSpinRoundRow[]>`
      UPDATE squad_spin_rounds
      SET ${exec(tx)(patch as Record<string, never>)}, state_version = state_version + 1, last_seen_at = now()
      WHERE id = ${roundId} AND state_version = ${expectedVersion} AND status = 'active'
      RETURNING *
    `;
    return row ?? null;
  },

  async touchLastSeen(userId: string): Promise<void> {
    await sql`UPDATE squad_spin_rounds SET last_seen_at = now() WHERE user_id = ${userId} AND status = 'active'`;
  },

  async insertEvent(tx: TransactionSql, event: SquadSpinEventInput): Promise<void> {
    await exec(tx)`
      INSERT INTO squad_spin_events (
        round_id, user_id, state_version, event_type, spin_index, combo_id, tier, submitted_text, resolved_player_id,
        answer_correct, answer_late, answer_ms, commit_hash, server_seed, client_nonce, hmac_input, pot_before, pot_after
      ) VALUES (
        ${event.roundId}, ${event.userId}, ${event.stateVersion}, ${event.eventType}, ${event.spinIndex ?? null}, ${event.comboId ?? null},
        ${event.tier ?? null}, ${event.submittedText ?? null}, ${event.resolvedPlayerId ?? null}, ${event.answerCorrect ?? null},
        ${event.answerLate ?? null}, ${event.answerMs ?? null}, ${event.commitHash ?? null}, ${event.serverSeed ?? null},
        ${event.clientNonce ?? null}, ${event.hmacInput ?? null}, ${event.potBefore ?? null}, ${event.potAfter ?? null}
      )
    `;
  },

  // Content --------------------------------------------------------------
  /** Active combos for a reel count the player has not been dealt inside the seen window. */
  async countEligibleCombos(tx: TransactionSql, userId: string, reels: number): Promise<number> {
    const [row] = await exec(tx)<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM squad_spin_combos c
      WHERE c.reels = ${reels} AND c.active
        AND NOT EXISTS (
          SELECT 1 FROM squad_spin_seen_combos s
          WHERE s.user_id = ${userId} AND s.combo_id = c.id
            AND s.seen_at > now() - make_interval(days => ${SEEN_COMBO_WINDOW_DAYS})
        )
    `;
    return Number(row?.count ?? 0);
  },

  /** The n-th eligible combo in a stable (id) order, so a derived offset is reproducible inside the transaction. */
  async getEligibleComboAtOffset(tx: TransactionSql, userId: string, reels: number, offset: number): Promise<SquadSpinComboRow | null> {
    const [row] = await exec(tx)<SquadSpinComboRow[]>`
      SELECT c.id, c.reels, c.club_id, c.nation_id, c.position_group, c.extra_ids, c.answer_ids, c.n_answers, c.tier
      FROM squad_spin_combos c
      WHERE c.reels = ${reels} AND c.active
        AND NOT EXISTS (
          SELECT 1 FROM squad_spin_seen_combos s
          WHERE s.user_id = ${userId} AND s.combo_id = c.id
            AND s.seen_at > now() - make_interval(days => ${SEEN_COMBO_WINDOW_DAYS})
        )
      ORDER BY c.id OFFSET ${offset} LIMIT 1
    `;
    return row ?? null;
  },

  async countActiveCombos(tx: TransactionSql, reels: number): Promise<number> {
    const [row] = await exec(tx)<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM squad_spin_combos WHERE reels = ${reels} AND active
    `;
    return Number(row?.count ?? 0);
  },

  async getComboAtOffset(tx: TransactionSql, reels: number, offset: number): Promise<SquadSpinComboRow | null> {
    const [row] = await exec(tx)<SquadSpinComboRow[]>`
      SELECT id, reels, club_id, nation_id, position_group, extra_ids, answer_ids, n_answers, tier
      FROM squad_spin_combos WHERE reels = ${reels} AND active
      ORDER BY id OFFSET ${offset} LIMIT 1
    `;
    return row ?? null;
  },

  async markComboSeen(tx: TransactionSql, userId: string, comboId: string): Promise<void> {
    await exec(tx)`
      INSERT INTO squad_spin_seen_combos (user_id, combo_id, seen_at) VALUES (${userId}, ${comboId}, now())
      ON CONFLICT (user_id, combo_id) DO UPDATE SET seen_at = now()
    `;
  },

  async getComboById(comboId: string, tx?: TransactionSql): Promise<SquadSpinComboRow | null> {
    const [row] = await db(tx)<SquadSpinComboRow[]>`
      SELECT id, reels, club_id, nation_id, position_group, extra_ids, answer_ids, n_answers, tier
      FROM squad_spin_combos WHERE id = ${comboId}
    `;
    return row ?? null;
  },

  async getCriteriaByIds(ids: string[], tx?: TransactionSql): Promise<SquadSpinCriterionRow[]> {
    if (ids.length === 0) return [];
    return db(tx)<SquadSpinCriterionRow[]>`
      SELECT id, family, criterion_key, label_en, label_ka, asset_key FROM squad_spin_criteria WHERE id = ANY(${sql.array(ids)}::uuid[])
    `;
  },

  async getPlayersByIds(ids: string[], tx?: TransactionSql): Promise<SquadSpinPlayerRow[]> {
    if (ids.length === 0) return [];
    return db(tx)<SquadSpinPlayerRow[]>`
      SELECT id, name_en, name_ka, image_url, position_group, nationality_code
      FROM squad_spin_players WHERE id = ANY(${sql.array(ids)}::uuid[])
      ORDER BY peak_value_eur DESC NULLS LAST, name_en
    `;
  },

  async getAliasesForPlayers(ids: string[], tx?: TransactionSql): Promise<SquadSpinAliasRow[]> {
    if (ids.length === 0) return [];
    return db(tx)<SquadSpinAliasRow[]>`
      SELECT player_id, normalized_alias, locale, acceptance_policy
      FROM squad_spin_player_aliases WHERE player_id = ANY(${sql.array(ids)}::uuid[])
    `;
  },

  // Calibration ----------------------------------------------------------
  async getDatabaseDay(tx: TransactionSql): Promise<string> {
    const [row] = await exec(tx)<Array<{ day: string }>>`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`;
    return row.day;
  },

  async lockCalibrationPublisher(tx: TransactionSql): Promise<void> {
    await exec(tx)`SELECT pg_advisory_xact_lock(hashtext('squad_spin_calibration'))`;
  },

  async getCalibration(tx: TransactionSql, day: string): Promise<SquadSpinCalibrationRow | null> {
    const [row] = await exec(tx)<SquadSpinCalibrationRow[]>`
      SELECT publication_day::text AS publication_day, accuracy_bp, steps_bp, samples, rules_version, created_at
      FROM squad_spin_calibrations WHERE publication_day = ${day}::date
    `;
    return row ?? null;
  },

  async getLatestCalibrationBefore(tx: TransactionSql, day: string): Promise<SquadSpinCalibrationRow | null> {
    const [row] = await exec(tx)<SquadSpinCalibrationRow[]>`
      SELECT publication_day::text AS publication_day, accuracy_bp, steps_bp, samples, rules_version, created_at
      FROM squad_spin_calibrations WHERE publication_day < ${day}::date
      ORDER BY publication_day DESC LIMIT 1
    `;
    return row ?? null;
  },

  async insertCalibration(
    tx: TransactionSql,
    data: { publicationDay: string; accuracy: Record<SquadSpinTier, number>; steps: StepsSnapshot; samples: Record<SquadSpinTier, number>; rulesVersion: number },
  ): Promise<SquadSpinCalibrationRow> {
    const [row] = await exec(tx)<SquadSpinCalibrationRow[]>`
      INSERT INTO squad_spin_calibrations (publication_day, accuracy_bp, steps_bp, samples, rules_version)
      VALUES (${data.publicationDay}::date, ${exec(tx).json(data.accuracy as never)}, ${exec(tx).json(data.steps as never)}, ${exec(tx).json(data.samples as never)}, ${data.rulesVersion})
      RETURNING publication_day::text AS publication_day, accuracy_bp, steps_bp, samples, rules_version, created_at
    `;
    return row;
  },

  /**
   * Human answers (timeouts count as wrong) per tier inside the calibration window.
   * Bots are excluded and one account counts for at most CALIBRATION_MAX_ANSWERS_PER_USER
   * rows per tier, so a single grinder cannot move everyone's multipliers.
   */
  async getHumanTierObservations(tx: TransactionSql): Promise<TierObservation[]> {
    const rows = await exec(tx)<Array<{ tier: SquadSpinTier; correct: string; total: string }>>`
      WITH ranked AS (
        SELECT e.tier, e.answer_correct,
               row_number() OVER (PARTITION BY e.user_id, e.tier ORDER BY e.id DESC) AS rn
        FROM squad_spin_events e
        JOIN users u ON u.id = e.user_id
        WHERE e.event_type = 'answer' AND e.tier IS NOT NULL AND u.is_ai = false
          AND e.created_at > now() - make_interval(days => ${CALIBRATION_WINDOW_DAYS})
      )
      SELECT tier, count(*) FILTER (WHERE answer_correct)::text AS correct, count(*)::text AS total
      FROM ranked WHERE rn <= ${CALIBRATION_MAX_ANSWERS_PER_USER}
      GROUP BY tier
    `;
    return rows.map((row) => ({ tier: row.tier, correct: Number(row.correct), total: Number(row.total) }));
  },

  // Sweeper / stats --------------------------------------------------------
  async getExpiredActiveRoundIds(limit: number): Promise<string[]> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM squad_spin_rounds
      WHERE status = 'active' AND (
        (phase = 'question' AND question_deadline_at < now())
        OR (phase = 'decision' AND decision_deadline_at < now())
      )
      ORDER BY last_seen_at ASC LIMIT ${limit}
    `;
    return rows.map((row) => row.id);
  },

  async countPlayingNow(): Promise<number> {
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM squad_spin_rounds
      WHERE status = 'active' AND last_seen_at > now() - make_interval(secs => ${PLAYING_NOW_WINDOW_S})
    `;
    return Number(row?.count ?? 0);
  },

  async getRecentWins(limit: number): Promise<Array<{ nickname: string; payout_coins: number; stake_coins: number; settled_at: string }>> {
    return sql<Array<{ nickname: string; payout_coins: number; stake_coins: number; settled_at: string }>>`
      SELECT u.nickname, r.payout_coins, r.stake_coins, r.settled_at
      FROM squad_spin_rounds r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'cashed' AND r.payout_coins > r.stake_coins
      ORDER BY r.settled_at DESC LIMIT ${limit}
    `;
  },

  /** Best run multipliers (payout/stake) cashed in the last 24h, per user. */
  async getTopRuns(limit: number): Promise<Array<{ nickname: string; run_mult: number }>> {
    return sql<Array<{ nickname: string; run_mult: number }>>`
      SELECT u.nickname, MAX(r.payout_coins::float / r.stake_coins)::float AS run_mult
      FROM squad_spin_rounds r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'cashed' AND r.payout_coins > r.stake_coins AND r.settled_at > now() - interval '24 hours'
      GROUP BY u.id, u.nickname
      ORDER BY run_mult DESC LIMIT ${limit}
    `;
  },

  pickIdleBots(limit: number) {
    return pickIdleRosterBots('squad_spin_rounds', limit, 'squad-spin');
  },

  topUpBotWallet(userId: string, amount: number) {
    return topUpRosterBotWallet(userId, amount, 'squad_spin_bot_topup');
  },
};

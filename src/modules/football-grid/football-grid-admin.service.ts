import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import { sql } from '../../db/index.js';
import { normalizeFootballGridAnswer } from './football-grid.answer-resolver.js';
import { resetFootballGridAliasCache } from './football-grid.service.js';
import { resetFootballGridTypeaheadCache } from './football-grid-typeahead.controller.js';
import type { Json } from '../../db/types.js';

// Must match COIN_DAILY_CAP in football-grid-settlement.service.ts.
const FOOTBALL_GRID_COIN_DAILY_CAP = 3_500;

export const footballGridAdminService = {
  async inspectRewards(matchId: string): Promise<unknown> {
    const [match, eligibility, coinEvents, coinAudit, pointEvents, pointAudit] = await Promise.all([
      sql`SELECT m.id, m.status, m.winner_user_id, gm.origin, gm.completion_reason,
                 gm.reward_schedule_version, o.status AS settlement_status, o.attempt_count, o.last_error
            FROM matches m JOIN football_grid_matches gm ON gm.match_id = m.id
            LEFT JOIN football_grid_settlement_outbox o ON o.match_id = m.id
           WHERE m.id = ${matchId}`,
      sql`SELECT * FROM football_grid_reward_eligibility WHERE match_id = ${matchId} ORDER BY user_id`,
      sql`SELECT * FROM football_grid_coin_events WHERE match_id = ${matchId} ORDER BY created_at`,
      sql`SELECT a.* FROM football_grid_coin_event_audit a
            JOIN football_grid_coin_events e ON e.id = a.coin_event_id
           WHERE e.match_id = ${matchId} ORDER BY a.created_at`,
      sql`SELECT * FROM football_grid_point_events WHERE match_id = ${matchId} ORDER BY created_at`,
      sql`SELECT a.* FROM football_grid_point_event_audit a
            JOIN football_grid_point_events e ON e.id = a.point_event_id
           WHERE e.match_id = ${matchId} ORDER BY a.created_at`,
    ]);
    if (match.length === 0) throw new NotFoundError('Football Grid match not found');
    return { match: match[0], eligibility, coinEvents, coinAudit, pointEvents, pointAudit };
  },

  async releaseHeldCoin(eventId: string, actorUserId: string, reason: string): Promise<void> {
    await sql.begin(async (tx) => {
      const owners = await tx.unsafe<Array<{ user_id: string }>>(
        `SELECT user_id FROM football_grid_coin_events WHERE id = $1`,
        [eventId],
      );
      if (!owners[0]) throw new NotFoundError('Football Grid coin event not found');
      await tx.unsafe(
        `INSERT INTO football_grid_reward_budgets (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [owners[0].user_id],
      );
      await tx.unsafe(
        `SELECT user_id FROM football_grid_reward_budgets WHERE user_id = $1 FOR UPDATE`,
        [owners[0].user_id],
      );
      const rows = await tx.unsafe<Array<{ match_id: string; user_id: string; amount: number; status: string; has_reversal: boolean }>>(
        `SELECT e.match_id, e.user_id, e.amount, e.status,
                EXISTS (SELECT 1 FROM football_grid_coin_events r WHERE r.reversal_of = e.id) AS has_reversal
           FROM football_grid_coin_events e WHERE e.id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = rows[0];
      if (!event) throw new NotFoundError('Football Grid coin event not found');
      if (event.status !== 'held') throw new ConflictError('Only held rewards can be released');
      if (event.has_reversal) throw new ConflictError('This held reward was already denied');
      const rolling = await tx.unsafe<Array<{ amount: string }>>(
        `SELECT COALESCE(sum(original.amount), 0)::text AS amount
           FROM football_grid_coin_events original
          WHERE original.user_id = $1 AND original.reversal_of IS NULL
            AND (
              original.status = 'held'
              OR (original.status = 'committed' AND original.credited_at >= now() - interval '24 hours')
            )
            AND NOT EXISTS (
              SELECT 1 FROM football_grid_coin_events reversal
               WHERE reversal.reversal_of = original.id
            )`,
        [event.user_id],
      );
      if (Number(rolling[0]?.amount ?? 0) > FOOTBALL_GRID_COIN_DAILY_CAP) {
        throw new ConflictError('Releasing this held reward would exceed the current rolling coin cap');
      }
      await tx.unsafe(`UPDATE users SET coins = coins + $2, updated_at = now() WHERE id = $1`, [event.user_id, event.amount]);
      await tx.unsafe(
        `UPDATE football_grid_coin_events SET status = 'committed', credited_at = now() WHERE id = $1`,
        [eventId],
      );
      await tx.unsafe(
        `UPDATE football_grid_reward_eligibility
            SET decision = 'eligible', reason = 'risk_hold_released'
          WHERE match_id = $1 AND user_id = $2 AND decision = 'held'`,
        [event.match_id, event.user_id],
      );
      await tx.unsafe(
        `INSERT INTO football_grid_coin_event_audit (coin_event_id, action, amount, reason, actor_user_id)
         VALUES ($1,'release',$2,$3,$4)`,
        [eventId, event.amount, reason, actorUserId],
      );
    });
  },

  async reverseCoin(eventId: string, actorUserId: string, reason: string): Promise<void> {
    await sql.begin(async (tx) => {
      const rows = await tx.unsafe<Array<{ id: string; match_id: string; user_id: string; amount: number; status: string; has_reversal: boolean }>>(
        `SELECT e.id, e.match_id, e.user_id, e.amount, e.status,
                EXISTS (SELECT 1 FROM football_grid_coin_events r WHERE r.reversal_of = e.id) AS has_reversal
           FROM football_grid_coin_events e WHERE e.id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = rows[0];
      if (!event) throw new NotFoundError('Football Grid coin event not found');
      if (event.status !== 'committed' && event.status !== 'held') {
        throw new ConflictError('Only committed or held rewards can be reversed');
      }
      if (event.has_reversal) throw new ConflictError('This reward was already reversed');
      if (event.status === 'committed') {
        const wallets = await tx.unsafe<Array<{ coins: number }>>(
          `SELECT coins FROM users WHERE id = $1 FOR UPDATE`,
          [event.user_id],
        );
        if (!wallets[0] || wallets[0].coins < event.amount) {
          throw new ConflictError('Wallet balance is too low for an exact reversal');
        }
        await tx.unsafe(
          `UPDATE users SET coins = coins - $2, updated_at = now() WHERE id = $1`,
          [event.user_id, event.amount],
        );
      }
      await tx.unsafe(
        `INSERT INTO football_grid_coin_events (
           match_id, user_id, reward_type, amount, status, eligibility_reason, reversal_of
         ) VALUES ($1,$2,$3,$4,'reversed',$5,$6)`,
        [event.match_id, event.user_id, `football_grid_reversal:${event.id}`, event.amount, reason, event.id],
      );
      await tx.unsafe(
        `INSERT INTO football_grid_coin_event_audit (coin_event_id, action, amount, reason, actor_user_id)
         VALUES ($1,'reverse',$2,$3,$4)`,
        [eventId, event.amount, reason, actorUserId],
      );
      if (event.status === 'held') {
        await tx.unsafe(
          `UPDATE football_grid_reward_eligibility
              SET decision = 'ineligible', reason = 'risk_hold_denied'
            WHERE match_id = $1 AND user_id = $2 AND decision = 'held'`,
          [event.match_id, event.user_id],
        );
      }
    });
  },

  async releaseHeldPoints(eventId: string, actorUserId: string, reason: string): Promise<void> {
    await sql.begin(async (tx) => {
      const rows = await tx.unsafe<Array<{
        match_id: string;
        user_id: string;
        amount: number;
        status: string;
        has_reversal: boolean;
      }>>(
        `SELECT e.match_id, e.user_id, e.amount, e.status,
                EXISTS (SELECT 1 FROM football_grid_point_events r WHERE r.reversal_of = e.id) AS has_reversal
           FROM football_grid_point_events e WHERE e.id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = rows[0];
      if (!event) throw new NotFoundError('Football Grid point event not found');
      if (event.status !== 'held') throw new ConflictError('Only held points can be released');
      if (event.has_reversal) throw new ConflictError('These held points were already denied');
      await tx.unsafe(
        `UPDATE users
            SET tic_tac_toe_points = tic_tac_toe_points + $2,
                tic_tac_toe_points_updated_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [event.user_id, event.amount],
      );
      await tx.unsafe(
        `UPDATE football_grid_point_events SET status = 'committed', credited_at = now() WHERE id = $1`,
        [eventId],
      );
      await tx.unsafe(
        `UPDATE football_grid_reward_eligibility
            SET points_decision = 'eligible', points_reason = 'risk_hold_released'
          WHERE match_id = $1 AND user_id = $2 AND points_decision = 'held'`,
        [event.match_id, event.user_id],
      );
      await tx.unsafe(
        `INSERT INTO football_grid_point_event_audit (
           point_event_id, action, amount, reason, actor_user_id
         ) VALUES ($1,'release',$2,$3,$4)`,
        [eventId, event.amount, reason, actorUserId],
      );
    });
  },

  async reversePoints(eventId: string, actorUserId: string, reason: string): Promise<void> {
    await sql.begin(async (tx) => {
      const rows = await tx.unsafe<Array<{
        id: string;
        match_id: string;
        user_id: string;
        amount: number;
        status: string;
        has_reversal: boolean;
      }>>(
        `SELECT e.id, e.match_id, e.user_id, e.amount, e.status,
                EXISTS (SELECT 1 FROM football_grid_point_events r WHERE r.reversal_of = e.id) AS has_reversal
           FROM football_grid_point_events e WHERE e.id = $1 FOR UPDATE`,
        [eventId],
      );
      const event = rows[0];
      if (!event) throw new NotFoundError('Football Grid point event not found');
      if (event.status !== 'committed' && event.status !== 'held') {
        throw new ConflictError('Only committed or held points can be reversed');
      }
      if (event.has_reversal) throw new ConflictError('These points were already reversed');
      if (event.status === 'committed') {
        const balances = await tx.unsafe<Array<{ tic_tac_toe_points: number }>>(
          `SELECT tic_tac_toe_points FROM users WHERE id = $1 FOR UPDATE`,
          [event.user_id],
        );
        if (!balances[0] || balances[0].tic_tac_toe_points < event.amount) {
          throw new ConflictError('Tic Tac Toe Points balance is too low for an exact reversal');
        }
        await tx.unsafe(
          `UPDATE users
              SET tic_tac_toe_points = tic_tac_toe_points - $2,
                  tic_tac_toe_points_updated_at = CASE
                    WHEN tic_tac_toe_points = $2 THEN NULL ELSE now()
                  END,
                  updated_at = now()
            WHERE id = $1`,
          [event.user_id, event.amount],
        );
      }
      await tx.unsafe(
        `INSERT INTO football_grid_point_events (
           match_id, user_id, reward_type, amount, status, eligibility_reason, reversal_of
         ) VALUES ($1,$2,$3,$4,'reversed',$5,$6)`,
        [
          event.match_id,
          event.user_id,
          `football_grid_points_reversal:${event.id}`,
          event.amount,
          reason,
          event.id,
        ],
      );
      await tx.unsafe(
        `UPDATE football_grid_reward_eligibility
            SET points_decision = 'ineligible', points_reason = 'points_reversed'
          WHERE match_id = $1 AND user_id = $2`,
        [event.match_id, event.user_id],
      );
      await tx.unsafe(
        `INSERT INTO football_grid_point_event_audit (
           point_event_id, action, amount, reason, actor_user_id
         ) VALUES ($1,'reverse',$2,$3,$4)`,
        [eventId, event.amount, reason, actorUserId],
      );
    });
  },

  async quarantineContent(input: {
    releaseId: string;
    boardId?: string | null;
    action: 'disable' | 'enable';
    reason: string;
    expiresAt?: string | null;
    actorUserId: string;
  }): Promise<unknown> {
    if (input.action === 'enable' && input.expiresAt) {
      throw new BadRequestError('Enable quarantine events cannot expire');
    }
    if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
      throw new BadRequestError('A temporary quarantine expiry must be in the future');
    }
    return sql.begin(async (tx) => {
      const targets = await tx.unsafe<Array<{
        release_id: string;
        release_status: string;
        board_id: string | null;
      }>>(
        `SELECT release.id AS release_id, release.status AS release_status, board.id AS board_id
           FROM football_grid_content_releases release
           LEFT JOIN football_grid_boards board
             ON board.id = $2::uuid AND board.release_id = release.id
          WHERE release.id = $1`,
        [input.releaseId, input.boardId ?? null],
      );
      const target = targets[0];
      if (!target || (input.boardId && !target.board_id)) {
        throw new NotFoundError('Football Grid quarantine target not found');
      }
      if (target.release_status !== 'published') {
        throw new ConflictError('Only a published Football Grid release can be quarantined');
      }
      const rows = await tx.unsafe<Array<{
        id: string;
        release_id: string;
        board_id: string | null;
        action: 'disable' | 'enable';
        reason: string;
        actor: string;
        expires_at: string | null;
        created_at: string;
      }>>(
        `INSERT INTO football_grid_content_quarantines (
           release_id, board_id, action, reason, actor, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, release_id, board_id, action, reason, actor, expires_at, created_at`,
        [
          input.releaseId,
          input.boardId ?? null,
          input.action,
          input.reason,
          input.actorUserId,
          input.expiresAt ?? null,
        ],
      );
      const quarantine = rows[0];
      await tx.unsafe(
        `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [
          input.actorUserId,
          `football_grid_content_${input.action}`,
          input.boardId ? 'football_grid_board' : 'football_grid_release',
          input.boardId ?? input.releaseId,
          sql.json({
            quarantineId: quarantine.id,
            releaseId: input.releaseId,
            boardId: input.boardId ?? null,
            reason: input.reason,
            expiresAt: input.expiresAt ?? null,
          } as Json),
        ],
      );
      return quarantine;
    });
  },

  async listQuarantines(input: {
    releaseId?: string;
    boardId?: string;
    limit: number;
  }): Promise<unknown[]> {
    return sql.unsafe(
      `SELECT id, release_id, board_id, action, reason, actor, expires_at, created_at
         FROM football_grid_content_quarantines
        WHERE ($1::uuid IS NULL OR release_id = $1)
          AND ($2::uuid IS NULL OR board_id = $2)
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [input.releaseId ?? null, input.boardId ?? null, input.limit],
    );
  },

  async listReports(status: string | undefined, limit: number): Promise<unknown[]> {
    return sql.unsafe(
      `SELECT r.*, a.match_id, a.turn_number, a.cell_index, a.locale,
              a.submitted_text, a.normalized_text, a.outcome, a.resolved_player_id,
              gm.board_id, gm.content_release_id, gm.alias_release_id,
              gm.resolver_policy_version, gm.board_checksum
         FROM football_grid_missing_answer_reports r
         JOIN football_grid_attempts a ON a.id = r.attempt_id
         JOIN football_grid_matches gm ON gm.match_id = a.match_id
        WHERE ($1::text IS NULL OR r.status = $1)
        ORDER BY r.created_at
        LIMIT $2`,
      [status ?? null, limit],
    );
  },

  async decideReport(input: {
    reportId: string;
    status: 'accepted' | 'rejected' | 'duplicate' | 'closed';
    notes: string;
    decisionReleaseId?: string | null;
    actorUserId: string;
  }): Promise<void> {
    if (input.status === 'accepted' && !input.decisionReleaseId) {
      throw new BadRequestError('Accepted reports require the correcting content release');
    }
    await sql.begin(async (tx) => {
      if (input.status === 'accepted') {
        const corrections = await tx.unsafe<Array<{ id: string }>>(
          `SELECT candidate.id
             FROM football_grid_missing_answer_reports report
             JOIN football_grid_attempts attempt ON attempt.id = report.attempt_id
             JOIN football_grid_matches grid_match ON grid_match.match_id = attempt.match_id
             JOIN football_grid_content_releases pinned ON pinned.id = grid_match.content_release_id
             JOIN football_grid_boards old_board ON old_board.id = grid_match.board_id
             JOIN football_grid_criteria old_row
               ON old_row.id = old_board.row_criteria[(attempt.cell_index / 3) + 1]
             JOIN football_grid_criteria old_column
               ON old_column.id = old_board.column_criteria[(attempt.cell_index % 3) + 1]
             JOIN football_grid_content_releases candidate ON candidate.id = $2
            WHERE report.id = $1
              AND report.status = 'open'
              AND candidate.status = 'published'
              AND candidate.version > pinned.version
              AND attempt.normalized_text IS NOT NULL
              AND 1 = (
                SELECT count(DISTINCT alias.football_player_id)
                  FROM football_grid_player_aliases alias
                  JOIN football_grid_criteria new_row
                    ON new_row.release_id = candidate.id
                   AND new_row.criterion_key = old_row.criterion_key
                  JOIN football_grid_criterion_memberships row_membership
                    ON row_membership.release_id = candidate.id
                   AND row_membership.criterion_id = new_row.id
                   AND row_membership.football_player_id = alias.football_player_id
                  JOIN football_grid_criteria new_column
                    ON new_column.release_id = candidate.id
                   AND new_column.criterion_key = old_column.criterion_key
                  JOIN football_grid_criterion_memberships column_membership
                    ON column_membership.release_id = candidate.id
                   AND column_membership.criterion_id = new_column.id
                   AND column_membership.football_player_id = alias.football_player_id
                 WHERE alias.release_id = candidate.id
                   AND alias.normalized_alias = attempt.normalized_text
                   AND alias.acceptance_policy IN ('exact', 'unique_only', 'safe_typo')
              )
            FOR UPDATE OF report, candidate`,
          [input.reportId, input.decisionReleaseId!],
        );
        if (!corrections[0]) {
          throw new BadRequestError(
            'Accepted reports require a newer published release that resolves this answer for both cell criteria',
          );
        }
      }
      const rows = await tx.unsafe<Array<{ id: string }>>(
        `UPDATE football_grid_missing_answer_reports
            SET status = $2, reviewer_notes = $3,
                reviewed_by = $4, reviewed_at = now(),
                decision_release_id = $5
          WHERE id = $1 AND status = 'open'
          RETURNING id`,
        [
          input.reportId,
          input.status,
          input.notes,
          input.actorUserId,
          input.decisionReleaseId ?? null,
        ],
      );
      if (!rows[0]) throw new NotFoundError('Open Football Grid report not found');
    });
  },

  /**
   * Corrects a player's display names across every published board answer and
   * adds the corrected spellings as exact aliases, so the fix is both visible
   * and accepted without a republish. Everything else stays append-only.
   */
  async renamePlayer(input: {
    playerId: string;
    nameEn?: string;
    nameKa?: string;
    reason: string;
    actor: string;
  }): Promise<{
    playerId: string;
    previousNameEn: string | null;
    previousNameKa: string | null;
    nameEn: string | null;
    nameKa: string | null;
    rowsUpdated: number;
    aliasesAdded: number;
    releaseIds: string[];
  }> {
    const nameEn = input.nameEn?.trim() || null;
    const nameKa = input.nameKa?.trim() || null;
    if (!nameEn && !nameKa) throw new BadRequestError('Provide nameEn and/or nameKa');
    return sql.begin(async (tx) => {
      const current = await tx.unsafe<Array<{ name_en: string | null; name_ka: string | null; release_ids: string[] }>>(
        `SELECT (array_agg(player_name_en ORDER BY created_at DESC))[1] AS name_en,
                (array_agg(player_name_ka ORDER BY created_at DESC))[1] AS name_ka,
                array_agg(DISTINCT release_id) AS release_ids
           FROM football_grid_board_answers
          WHERE football_player_id = $1`,
        [input.playerId],
      );
      if (!current[0] || !current[0].release_ids) {
        throw new NotFoundError('Football Grid player has no published board answers');
      }
      const updated = await tx.unsafe<Array<{ n: number }>>(
        `WITH upd AS (
           UPDATE football_grid_board_answers
              SET player_name_en = COALESCE($2, player_name_en),
                  player_name_ka = COALESCE($3, player_name_ka)
            WHERE football_player_id = $1
              AND (player_name_en IS DISTINCT FROM COALESCE($2, player_name_en)
                   OR player_name_ka IS DISTINCT FROM COALESCE($3, player_name_ka))
            RETURNING 1
         ) SELECT count(*)::int AS n FROM upd`,
        [input.playerId, nameEn, nameKa],
      );
      let aliasesAdded = 0;
      for (const releaseId of current[0].release_ids) {
        for (const [locale, alias, aliasType] of [['en', nameEn, 'full_name'], ['ka', nameKa, 'georgian']] as const) {
          if (!alias) continue;
          const inserted = await tx.unsafe<Array<{ id: string }>>(
            `INSERT INTO football_grid_player_aliases (
               release_id, football_player_id, alias, normalized_alias, locale,
               alias_type, acceptance_policy, reviewed_by, reviewed_at
             ) VALUES ($1, $2, $3, $4, $5, $6, 'exact', $7, now())
             ON CONFLICT (release_id, football_player_id, normalized_alias, locale, alias_type) DO NOTHING
             RETURNING id`,
            [releaseId, input.playerId, alias, normalizeFootballGridAnswer(alias), locale, aliasType, input.actor],
          );
          aliasesAdded += inserted.length;
        }
      }
      await tx.unsafe(
        `INSERT INTO football_grid_player_name_edits (
           football_player_id, previous_name_en, previous_name_ka, name_en, name_ka,
           rows_updated, aliases_added, reason, actor
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [input.playerId, current[0].name_en, current[0].name_ka, nameEn, nameKa, updated[0].n, aliasesAdded, input.reason, input.actor],
      );
      for (const releaseId of current[0].release_ids) resetFootballGridAliasCache(releaseId);
      resetFootballGridTypeaheadCache();
      return {
        playerId: input.playerId,
        previousNameEn: current[0].name_en,
        previousNameKa: current[0].name_ka,
        nameEn,
        nameKa,
        rowsUpdated: updated[0].n,
        aliasesAdded,
        releaseIds: current[0].release_ids,
      };
    });
  },
};

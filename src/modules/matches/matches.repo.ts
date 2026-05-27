import { sql, type TransactionSql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import { withSpan } from '../../core/tracing.js';
import type { MatchRow } from './matches.types.js';
import type { RankedLobbyContext } from '../lobbies/lobbies.types.js';

export interface CreateMatchData {
  lobbyId: string | null;
  mode: 'friendly' | 'ranked';
  categoryAId: string;
  categoryBId: string | null;
  totalQuestions: number;
  statePayload?: unknown;
  rankedContext?: RankedLobbyContext | null;
  isDev?: boolean;
}

/**
 * Pure-data repo for the `matches` table.
 *
 * Sibling repos own the other match-* entities:
 *   match_players       → matchPlayersRepo
 *   match_questions     → matchQuestionsRepo
 *   match_answers       → matchAnswersRepo
 *   match_goal_events   → matchEventsRepo
 *
 * Cross-entity orchestration (party-quiz answer recording, goal event
 * + player totals atomicity, dev-match cleanup, match completion +
 * user-mode stats) lives in matchesService — that owns the sql.begin
 * transactions and drives the tx-aware primitives on each repo.
 */
export const matchesRepo = {
  async createMatch(data: CreateMatchData): Promise<MatchRow> {
    const [row] = await sql<MatchRow[]>`
      INSERT INTO matches (
        id, lobby_id, mode, status, category_a_id, category_b_id, current_q_index, total_questions, state_payload, ranked_context, is_dev, started_at
      )
      VALUES (
        gen_random_uuid(), ${data.lobbyId}, ${data.mode}, 'active',
        ${data.categoryAId}, ${data.categoryBId}, 0, ${data.totalQuestions},
        ${sql.json(data.statePayload as Json ?? null)},
        ${sql.json((data.rankedContext ?? null) as Json)},
        ${data.isDev ?? false},
        NOW()
      )
      RETURNING *
    `;
    return row;
  },

  async setMatchCurrentIndex(matchId: string, qIndex: number): Promise<void> {
    await sql`
      UPDATE matches
      SET current_q_index = ${qIndex}
      WHERE id = ${matchId} AND current_q_index < ${qIndex}
    `;
  },

  async setMatchStatePayload(
    matchId: string,
    statePayload: unknown,
    qIndex?: number
  ): Promise<void> {
    await withSpan('db.matches.set_state_payload', {
      'db.operation.name': 'update',
      'quizball.match_id': matchId,
      'quizball.q_index': qIndex ?? -1,
    }, async () => {
      const jsonPayload = sql.json(statePayload as Json ?? null);
      if (qIndex === undefined) {
        await sql`
          UPDATE matches
          SET state_payload = ${jsonPayload}
          WHERE id = ${matchId}
        `;
        return;
      }

      await sql`
        UPDATE matches
        SET state_payload = ${jsonPayload},
            current_q_index = GREATEST(current_q_index, ${qIndex})
        WHERE id = ${matchId}
      `;
    });
  },

  async setMatchCategoryB(matchId: string, categoryBId: string | null): Promise<void> {
    await sql`
      UPDATE matches
      SET category_b_id = ${categoryBId}
      WHERE id = ${matchId}
    `;
  },

  /**
   * Atomically flip a match to "completed" and return the metadata the
   * service needs to make downstream stat decisions. Returns `null` if
   * the row was already in a terminal state — idempotency-safe so
   * concurrent callers can't double-complete the same match.
   *
   * Service layer drives the transaction; this just executes the write.
   */
  async markMatchCompleted(
    tx: TransactionSql,
    matchId: string,
    winnerId: string | null,
  ): Promise<Pick<MatchRow, 'id' | 'mode' | 'ended_at' | 'is_dev'> | null> {
    // tx.unsafe pattern matches other tx-aware repos in this codebase
    // (TransactionSql doesn't expose the tagged-template call signature
    // cleanly to TS).
    const rows = await tx.unsafe<Pick<MatchRow, 'id' | 'mode' | 'ended_at' | 'is_dev'>[]>(
      `
      UPDATE matches
      SET status = 'completed', winner_user_id = $2, ended_at = NOW()
      WHERE id = $1 AND status = 'active'
      RETURNING id, mode, ended_at, is_dev
      `,
      [matchId, winnerId],
    );
    return rows[0] ?? null;
  },

  /**
   * Multi-row upsert into user_mode_match_stats. Service pre-computes
   * wins/losses/draws — repo just writes what it's given.
   *
   * Uses tx.unsafe with a dynamically-built placeholder string because
   * postgres.js's TransactionSql type doesn't expose the helper-call
   * form (`tx(rows)`) for variable VALUES clauses — only tagged
   * templates. Parameters are still bound positionally, so this is
   * injection-safe; the only "unsafe" bit is the dynamically-sized
   * placeholder list itself (no user data in the SQL string).
   */
  async recordUserModeStats(
    tx: TransactionSql,
    rows: Array<{
      userId: string;
      mode: 'friendly' | 'ranked';
      wins: 0 | 1;
      losses: 0 | 1;
      draws: 0 | 1;
      lastMatchAt: string | null;
    }>,
  ): Promise<void> {
    if (rows.length === 0) return;
    const params: (string | number | null)[] = [];
    const placeholders: string[] = [];
    rows.forEach((r, i) => {
      const off = i * 6;
      placeholders.push(
        `($${off + 1}, $${off + 2}, 1, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6}, NOW())`,
      );
      params.push(r.userId, r.mode, r.wins, r.losses, r.draws, r.lastMatchAt);
    });
    await tx.unsafe(
      `
      INSERT INTO user_mode_match_stats (
        user_id, mode, games_played, wins, losses, draws, last_match_at, updated_at
      )
      VALUES ${placeholders.join(', ')}
      ON CONFLICT (user_id, mode) DO UPDATE SET
        games_played = user_mode_match_stats.games_played + 1,
        wins = user_mode_match_stats.wins + EXCLUDED.wins,
        losses = user_mode_match_stats.losses + EXCLUDED.losses,
        draws = user_mode_match_stats.draws + EXCLUDED.draws,
        last_match_at = COALESCE(
          GREATEST(user_mode_match_stats.last_match_at, EXCLUDED.last_match_at),
          EXCLUDED.last_match_at,
          user_mode_match_stats.last_match_at
        ),
        updated_at = NOW()
      `,
      params,
    );
  },

  async getMatch(matchId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches WHERE id = ${matchId}
    `;
    return row ?? null;
  },

  async getActiveMatchForLobby(lobbyId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT * FROM matches
      WHERE lobby_id = ${lobbyId} AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async getActiveMatchForUser(userId: string): Promise<MatchRow | null> {
    const [row] = await sql<MatchRow[]>`
      SELECT m.*
      FROM matches m
      JOIN match_players mp ON mp.match_id = m.id
      WHERE mp.user_id = ${userId} AND m.status = 'active'
      ORDER BY m.started_at DESC
      LIMIT 1
    `;
    return row ?? null;
  },

  async abandonMatch(matchId: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
      UPDATE matches
      SET status = 'abandoned', ended_at = NOW()
      WHERE id = ${matchId} AND status = 'active'
      RETURNING id
    `;
    return rows.length > 0;
  },
};

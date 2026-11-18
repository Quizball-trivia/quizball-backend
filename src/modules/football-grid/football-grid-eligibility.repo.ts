import { sql, type TransactionSql } from '../../db/index.js';
import type { FootballGridAliasRecord } from './football-grid.types.js';

export type FootballGridJudgeSurface = 'online' | 'solo' | 'daily';
export type FootballGridJudgeVersionStatus = 'building' | 'ready' | 'active' | 'revoked';

export interface FootballGridJudgeRollout {
  online: number;
  solo: number;
  daily: number;
  shadow: number;
}

export interface FootballGridJudgeCellRow {
  cellIndex: number;
  playerId: string;
  nameEn: string;
  nameKa: string | null;
  nameRu: string | null;
  nameEl: string | null;
  imageUrl: string | null;
}

type Executor = TransactionSql | typeof sql;

const rolloutOf = (row: { online_percent: number; solo_percent: number; daily_percent: number; shadow_percent: number } | undefined): FootballGridJudgeRollout => ({
  online: row?.online_percent ?? 0,
  solo: row?.solo_percent ?? 0,
  daily: row?.daily_percent ?? 0,
  shadow: row?.shadow_percent ?? 0,
});

export const footballGridEligibilityRepo = {
  async getVersionStatus(versionId: string): Promise<FootballGridJudgeVersionStatus | null> {
    const rows = await sql<Array<{ status: FootballGridJudgeVersionStatus }>>`
      SELECT status FROM football_grid_judge_versions WHERE id = ${versionId}
    `;
    return rows[0]?.status ?? null;
  },

  async getRollout(executor: Executor = sql): Promise<FootballGridJudgeRollout> {
    const rows = await executor.unsafe<Array<{ online_percent: number; solo_percent: number; daily_percent: number; shadow_percent: number }>>(
      `SELECT online_percent, solo_percent, daily_percent, shadow_percent FROM football_grid_judge_rollout WHERE id = 1`,
    );
    return rolloutOf(rows[0]);
  },

  async getActiveVersion(): Promise<string | null> {
    const rows = await sql<Array<{ id: string }>>`SELECT id FROM football_grid_judge_versions WHERE status = 'active'`;
    return rows[0]?.id ?? null;
  },

  /**
   * The active version when it certified this board (and, for a pick-from-four game, certified that every cell can
   * offer four options); null otherwise: the board stays on its own answer list.
   */
  async getActiveVersionForBoard(executor: Executor, boardId: string, requireChoice: boolean): Promise<string | null> {
    const rows = await executor.unsafe<Array<{ id: string }>>(
      `SELECT v.id
         FROM football_grid_judge_versions v
         JOIN football_grid_board_certifications c
           ON c.judge_version_id = v.id AND c.board_id = $1 AND c.status = 'certified'
        WHERE v.status = 'active'
          AND (NOT $2::boolean OR (c.metrics->>'choiceOk')::boolean IS TRUE)`,
      [boardId, requireChoice],
    );
    return rows[0]?.id ?? null;
  },

  /**
   * In the transaction that commits a verdict: the pinned version is still servable, and it stays so until commit
   * (a revocation updates the row and waits). Every outcome is checked, so cache warmth never decides enforcement.
   */
  async assertServableInTx(tx: TransactionSql, versionId: string): Promise<boolean> {
    const rows = await tx.unsafe<Array<{ status: FootballGridJudgeVersionStatus }>>(
      `SELECT status FROM football_grid_judge_versions WHERE id = $1 FOR SHARE`,
      [versionId],
    );
    return rows[0]?.status === 'ready' || rows[0]?.status === 'active';
  },

  /** The version's definition for each of the board's six criteria; a criterion it does not bind is absent. */
  async getBoardBindings(boardId: string, versionId: string): Promise<{ rows: Array<string | null>; columns: Array<string | null> } | null> {
    const rows = await sql<Array<{ axis: 'row' | 'column'; position: number; definition_id: string | null }>>`
      WITH b AS (SELECT row_criteria, column_criteria FROM football_grid_boards WHERE id = ${boardId}),
      axes AS (
        SELECT 'row'::text AS axis, p.i AS position, b.row_criteria[p.i + 1] AS criterion_id FROM b CROSS JOIN generate_series(0, 2) AS p(i)
        UNION ALL
        SELECT 'column', p.i, b.column_criteria[p.i + 1] FROM b CROSS JOIN generate_series(0, 2) AS p(i)
      )
      SELECT axes.axis, axes.position, cb.definition_id
        FROM axes
        LEFT JOIN football_grid_criterion_bindings cb
          ON cb.judge_version_id = ${versionId} AND cb.criterion_id = axes.criterion_id AND cb.status = 'bound'
    `;
    if (rows.length !== 6) return null;
    const result = { rows: [null, null, null] as Array<string | null>, columns: [null, null, null] as Array<string | null> };
    for (const row of rows) (row.axis === 'row' ? result.rows : result.columns)[row.position] = row.definition_id;
    return result;
  },

  /**
   * Every footballer who meets both criteria of each cell under the version. Best known first: the board's own
   * published order for the footballers it lists (immutable), then the version's frozen rank, then id.
   */
  async getBoardCells(boardId: string, versionId: string, rowDefinitions: string[], columnDefinitions: string[]): Promise<FootballGridJudgeCellRow[]> {
    const rows = await sql<Array<{
      cell_index: number; football_player_id: string; name_en: string; name_ka: string | null;
      name_ru: string | null; name_el: string | null; image_url: string | null;
    }>>`
      WITH cells AS (
        SELECT r.i * 3 + c.i AS cell_index,
               (${rowDefinitions}::uuid[])[r.i + 1] AS row_def,
               (${columnDefinitions}::uuid[])[c.i + 1] AS col_def
          FROM generate_series(0, 2) AS r(i) CROSS JOIN generate_series(0, 2) AS c(i)
      )
      SELECT cells.cell_index, rp.football_player_id, jp.name_en, jp.name_ka, jp.name_ru, jp.name_el, fp.image_url
        FROM cells
        JOIN football_grid_criterion_players rp
          ON rp.judge_version_id = ${versionId} AND rp.definition_id = cells.row_def
        JOIN football_grid_criterion_players cp
          ON cp.judge_version_id = ${versionId} AND cp.definition_id = cells.col_def
         AND cp.football_player_id = rp.football_player_id
        JOIN football_grid_judge_players jp
          ON jp.judge_version_id = ${versionId} AND jp.football_player_id = rp.football_player_id
        JOIN football_players fp ON fp.id = rp.football_player_id
        JOIN football_grid_judge_versions v ON v.id = ${versionId}
        -- The board's published hints (its samples and ranked answers) lead; everyone else by the version's frozen
        -- rank. Board rows are append-only: only those published before the version was sealed count.
        LEFT JOIN football_grid_board_answers a
          ON a.board_id = ${boardId} AND a.cell_index = cells.cell_index AND a.football_player_id = rp.football_player_id
         AND a.created_at <= v.ready_at AND (a.is_sample OR a.recognizable_rank IS NOT NULL)
       ORDER BY cells.cell_index, coalesce(a.is_sample, false) DESC,
                a.recognizable_rank ASC NULLS LAST, jp.rank_score DESC, rp.football_player_id
    `;
    return rows.map((row) => ({
      cellIndex: row.cell_index,
      playerId: row.football_player_id,
      nameEn: row.name_en,
      nameKa: row.name_ka,
      nameRu: row.name_ru,
      nameEl: row.name_el,
      imageUrl: row.image_url,
    }));
  },

  /** A page of the version's aliases, by id (plain statements, safe behind the pooler). */
  async getAliasesPage(versionId: string, afterId: string | null, limit: number): Promise<FootballGridAliasRecord[]> {
    const rows = await sql<Array<{
      id: string; football_player_id: string; alias: string; normalized_alias: string;
      locale: FootballGridAliasRecord['locale']; acceptance_policy: FootballGridAliasRecord['acceptancePolicy'];
    }>>`
      SELECT id, football_player_id, alias, normalized_alias, locale, acceptance_policy
        FROM football_grid_judge_aliases
       WHERE judge_version_id = ${versionId} AND (${afterId}::uuid IS NULL OR id > ${afterId}::uuid)
       ORDER BY id LIMIT ${limit}
    `;
    return rows.map((row) => ({
      id: row.id,
      playerId: row.football_player_id,
      alias: row.alias,
      normalizedAlias: row.normalized_alias,
      locale: row.locale,
      acceptancePolicy: row.acceptance_policy,
    }));
  },

  async getNamesakesPage(versionId: string, after: { playerId: string; name: string } | null, limit: number): Promise<Array<{ playerId: string; normalized: string }>> {
    const rows = await sql<Array<{ football_player_id: string; normalized_name: string }>>`
      SELECT football_player_id, normalized_name
        FROM football_grid_judge_namesakes
       WHERE judge_version_id = ${versionId}
         AND (${after?.playerId ?? null}::uuid IS NULL
              OR (football_player_id, normalized_name) > (${after?.playerId ?? null}::uuid, ${after?.name ?? ''}))
       ORDER BY football_player_id, normalized_name LIMIT ${limit}
    `;
    return rows.map((row) => ({ playerId: row.football_player_id, normalized: row.normalized_name }));
  },

  /**
   * Every footballer a usable version (ready or active) can credit, with the active version's names first: added to
   * the typeahead roster, which stays general (never cell-filtered). Older ready versions are included because a match
   * or solo ticket may still be pinned to them.
   */
  async getUsableRosterPlayers(): Promise<Array<{ id: string; nameEn: string; nameKa: string | null; nameRu: string | null; nameEl: string | null }>> {
    const rows = await sql<Array<{ football_player_id: string; name_en: string; name_ka: string | null; name_ru: string | null; name_el: string | null }>>`
      SELECT DISTINCT ON (jp.football_player_id) jp.football_player_id, jp.name_en, jp.name_ka, jp.name_ru, jp.name_el
        FROM football_grid_judge_players jp
        JOIN football_grid_judge_versions v ON v.id = jp.judge_version_id AND v.status IN ('ready', 'active')
       ORDER BY jp.football_player_id, (v.status = 'active') DESC, v.ready_at DESC
    `;
    return rows.map((row) => ({ id: row.football_player_id, nameEn: row.name_en, nameKa: row.name_ka, nameRu: row.name_ru, nameEl: row.name_el }));
  },

  async insertShadowVerdict(input: {
    commandInboxId: string;
    matchId: string;
    judgeVersionId: string;
    boardId: string;
    cellIndex: number;
    answerKind: 'typed' | 'picked';
    certified: boolean;
    legacy: { outcome: string; playerId: string | null; reason: string; checksum: string };
    shadow: { outcome: string; playerId: string | null; reason: string; checksum: string };
    usedPlayerIds: readonly string[];
    latencyMs: number;
  }): Promise<void> {
    await sql`
      INSERT INTO football_grid_shadow_verdicts (
        command_inbox_id, match_id, judge_version_id, board_id, cell_index, answer_kind, certified,
        legacy_outcome, legacy_player_id, legacy_reason, shadow_outcome, shadow_player_id, shadow_reason,
        legacy_checksum, shadow_checksum, used_player_ids, latency_ms
      ) VALUES (
        ${input.commandInboxId}, ${input.matchId}, ${input.judgeVersionId}, ${input.boardId}, ${input.cellIndex},
        ${input.answerKind}, ${input.certified}, ${input.legacy.outcome}, ${input.legacy.playerId}, ${input.legacy.reason},
        ${input.shadow.outcome}, ${input.shadow.playerId}, ${input.shadow.reason}, ${input.legacy.checksum},
        ${input.shadow.checksum}, ${[...input.usedPlayerIds]}::uuid[], ${input.latencyMs}
      ) ON CONFLICT (command_inbox_id) DO NOTHING
    `;
  },

  async isBoardCertified(boardId: string, versionId: string): Promise<boolean> {
    const rows = await sql<Array<{ ok: boolean }>>`
      SELECT true AS ok FROM football_grid_board_certifications
       WHERE judge_version_id = ${versionId} AND board_id = ${boardId} AND status = 'certified'
    `;
    return rows.length > 0;
  },
};

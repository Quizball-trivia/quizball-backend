import { config } from '../../core/config.js';
import { BadRequestError } from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import { acquireLock, releaseLock, startLockHeartbeat } from '../../realtime/locks.js';
import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import {
  fitGridDifficultyModel,
  scoreGridBoard,
  type GridDifficultyBoardInput,
  type GridDifficultyBoardScore,
  type GridDifficultySample,
} from './football-grid-difficulty.js';
import type { FootballGridDifficulty } from './football-grid.types.js';

const WRITE_BATCH = 500;
const RECOMPUTE_STATEMENT_TIMEOUT = '120s';
const NIGHTLY_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const NIGHTLY_STARTUP_MIN_DELAY_MS = 5 * 60_000;
const NIGHTLY_STARTUP_JITTER_MS = 5 * 60_000;
/** Replicas start at different times; scores this fresh are not recomputed by the next one. */
const NIGHTLY_FRESH_MS = 20 * 60 * 60 * 1_000;
const NIGHTLY_LOCK_KEY = 'lock:football_grid:difficulty';
const NIGHTLY_LOCK_TTL_MS = 120_000;
let nightlyStartupTimer: NodeJS.Timeout | null = null;
let nightlyIntervalTimer: NodeJS.Timeout | null = null;

/** One board cell's typed answers, keyed by the board's content checksum so a re-released board keeps its history. */
export interface GridDifficultyCellCount extends GridDifficultySample {
  checksum: string;
  cellIndex: number;
}

export interface GridDifficultySummary {
  boards: number;
  measured: number;
  answers: number;
  globalRate: number;
  familyRates: Record<string, number>;
  byLabel: Record<FootballGridDifficulty, {
    boards: number;
    measured: number;
    keep: number;
    move: number;
    retire: number;
    suggested: Record<FootballGridDifficulty, number>;
  }>;
}

interface BoardCellRow {
  board_id: string;
  checksum: string;
  label: FootballGridDifficulty;
  cell_index: number;
  row_key: string;
  row_family: string;
  col_key: string;
  col_family: string;
}

const LIVE_BOARD_SQL = `
  r.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM football_grid_content_quarantines q
     WHERE q.release_id = b.release_id AND (q.board_id IS NULL OR q.board_id = b.id)
       AND q.action = 'disable'
       AND (q.expires_at IS NULL OR q.expires_at > now())
       AND NOT EXISTS (
         SELECT 1 FROM football_grid_content_quarantines newer
          WHERE newer.release_id = q.release_id
            AND newer.board_id IS NOT DISTINCT FROM q.board_id
            AND newer.action = 'enable'
            AND (newer.created_at, newer.id) > (q.created_at, q.id)
       )
  )`;

function emptyLabelSummary(): GridDifficultySummary['byLabel'][FootballGridDifficulty] {
  return { boards: 0, measured: 0, keep: 0, move: 0, retire: 0, suggested: { easy: 0, normal: 0, hard: 0 } };
}

export function summarizeGridDifficulty(
  scores: readonly GridDifficultyBoardScore[],
  model: { globalRate: number; familyRates: Record<string, number> },
): GridDifficultySummary {
  const summary: GridDifficultySummary = {
    boards: scores.length,
    measured: 0,
    answers: 0,
    globalRate: model.globalRate,
    familyRates: model.familyRates,
    byLabel: { easy: emptyLabelSummary(), normal: emptyLabelSummary(), hard: emptyLabelSummary() },
  };
  for (const score of scores) {
    const label = summary.byLabel[score.label];
    label.boards += 1;
    label[score.verdict] += 1;
    label.suggested[score.suggested] += 1;
    summary.answers += score.answers;
    if (score.basis === 'measured') {
      summary.measured += 1;
      label.measured += 1;
    }
  }
  return summary;
}

async function loadCellCounts(): Promise<GridDifficultyCellCount[]> {
  // Typed answers only: a pick-from-four answer says little about how hard the cell is to recall.
  const rows = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL statement_timeout = '${RECOMPUTE_STATEMENT_TIMEOUT}'`);
    return tx.unsafe<Array<{
      checksum: string; cell_index: number; row_key: string; row_family: string;
      col_key: string; col_family: string; answers: number; correct: number;
    }>>(
      `WITH counts AS (
         SELECT m.board_id, a.cell_index,
                count(*)::int AS answers,
                (count(*) FILTER (WHERE a.outcome = 'correct'))::int AS correct
           FROM football_grid_attempts a
           JOIN football_grid_matches m ON m.match_id = a.match_id
          WHERE a.outcome IN ('correct', 'wrong') AND a.cell_index IS NOT NULL
            AND COALESCE(m.settings->>'answerMode', 'type') = 'type'
          GROUP BY m.board_id, a.cell_index
       )
       SELECT b.canonical_checksum AS checksum, c.cell_index,
              rc.criterion_key AS row_key, rc.family AS row_family,
              cc.criterion_key AS col_key, cc.family AS col_family,
              sum(c.answers)::int AS answers, sum(c.correct)::int AS correct
         FROM counts c
         JOIN football_grid_boards b ON b.id = c.board_id
         JOIN football_grid_criteria rc ON rc.id = b.row_criteria[(c.cell_index / 3) + 1]
         JOIN football_grid_criteria cc ON cc.id = b.column_criteria[(c.cell_index % 3) + 1]
        GROUP BY 1, 2, 3, 4, 5, 6`,
    );
  });
  return rows.map((row) => ({
    checksum: row.checksum,
    cellIndex: row.cell_index,
    rowKey: row.row_key,
    rowFamily: row.row_family,
    colKey: row.col_key,
    colFamily: row.col_family,
    answers: row.answers,
    correct: row.correct,
  }));
}

async function loadLiveBoardCells(): Promise<BoardCellRow[]> {
  return sql.unsafe<BoardCellRow[]>(
    `SELECT b.id AS board_id, b.canonical_checksum AS checksum,
            COALESCE(d.applied, b.difficulty) AS label, cell.cell_index,
            rc.criterion_key AS row_key, rc.family AS row_family,
            cc.criterion_key AS col_key, cc.family AS col_family
       FROM football_grid_boards b
       JOIN football_grid_content_releases r ON r.id = b.release_id
       LEFT JOIN football_grid_board_difficulty d ON d.board_id = b.id
      CROSS JOIN generate_series(0, 8) AS cell(cell_index)
       JOIN football_grid_criteria rc ON rc.id = b.row_criteria[(cell.cell_index / 3) + 1]
       JOIN football_grid_criteria cc ON cc.id = b.column_criteria[(cell.cell_index % 3) + 1]
      WHERE ${LIVE_BOARD_SQL}`,
  );
}

export const footballGridDifficultyService = {
  /**
   * Scores every live board. `counts` replaces this database's own answers, for checking a pool against answers
   * exported from another environment. Nothing is written unless `write` is set, and `applied` is never touched.
   */
  async recompute(options: { write: boolean; counts?: readonly GridDifficultyCellCount[] }): Promise<{
    summary: GridDifficultySummary;
    scores: GridDifficultyBoardScore[];
  }> {
    const counts = options.counts ?? await loadCellCounts();
    const model = fitGridDifficultyModel(counts);
    const countsByCell = new Map<string, { answers: number; correct: number }>();
    for (const count of counts) {
      const key = `${count.checksum}:${count.cellIndex}`;
      const totals = countsByCell.get(key) ?? { answers: 0, correct: 0 };
      totals.answers += count.answers;
      totals.correct += count.correct;
      countsByCell.set(key, totals);
    }
    const boards = new Map<string, GridDifficultyBoardInput>();
    for (const row of await loadLiveBoardCells()) {
      const board = boards.get(row.board_id) ?? { boardId: row.board_id, label: row.label, cells: [] };
      const totals = countsByCell.get(`${row.checksum}:${row.cell_index}`);
      board.cells.push({
        cellIndex: row.cell_index,
        rowKey: row.row_key,
        rowFamily: row.row_family,
        colKey: row.col_key,
        colFamily: row.col_family,
        answers: totals?.answers ?? 0,
        correct: totals?.correct ?? 0,
      });
      boards.set(row.board_id, board);
    }
    const scores = [...boards.values()].map((board) => scoreGridBoard(model, board));
    const summary = summarizeGridDifficulty(scores, model);
    if (options.write) {
      const criteria = [...model.criteria.values()];
      await sql.begin(async (tx) => {
        for (let offset = 0; offset < criteria.length; offset += WRITE_BATCH) {
          await tx.unsafe(
            `INSERT INTO football_grid_criterion_stats (criterion_key, family, answers, correct, rate, computed_at)
             SELECT x.criterion_key, x.family, x.answers, x.correct, x.rate, now()
               FROM jsonb_to_recordset($1::jsonb)
                 AS x(criterion_key text, family text, answers int, correct int, rate numeric)
             ON CONFLICT (criterion_key) DO UPDATE
               SET family = EXCLUDED.family, answers = EXCLUDED.answers, correct = EXCLUDED.correct,
                   rate = EXCLUDED.rate, computed_at = EXCLUDED.computed_at`,
            [sql.json(criteria.slice(offset, offset + WRITE_BATCH).map((stat) => ({
              criterion_key: stat.criterionKey,
              family: stat.family,
              answers: stat.answers,
              correct: stat.correct,
              rate: Number(stat.rate.toFixed(4)),
            })) as Json)],
          );
        }
        for (let offset = 0; offset < scores.length; offset += WRITE_BATCH) {
          await tx.unsafe(
            `INSERT INTO football_grid_board_difficulty (
               board_id, answers, correct, predicted_rate, score, weakest_cell_index, weakest_cell_rate,
               basis, suggested, verdict, cells, computed_at
             )
             SELECT x.board_id, x.answers, x.correct, x.predicted_rate, x.score, x.weakest_cell_index,
                    x.weakest_cell_rate, x.basis, x.suggested, x.verdict, x.cells, now()
               FROM jsonb_to_recordset($1::jsonb) AS x(
                 board_id uuid, answers int, correct int, predicted_rate numeric, score numeric,
                 weakest_cell_index smallint, weakest_cell_rate numeric, basis text, suggested text,
                 verdict text, cells jsonb
               )
             ON CONFLICT (board_id) DO UPDATE
               SET answers = EXCLUDED.answers, correct = EXCLUDED.correct,
                   predicted_rate = EXCLUDED.predicted_rate, score = EXCLUDED.score,
                   weakest_cell_index = EXCLUDED.weakest_cell_index,
                   weakest_cell_rate = EXCLUDED.weakest_cell_rate, basis = EXCLUDED.basis,
                   suggested = EXCLUDED.suggested, verdict = EXCLUDED.verdict, cells = EXCLUDED.cells,
                   computed_at = EXCLUDED.computed_at`,
            [sql.json(scores.slice(offset, offset + WRITE_BATCH).map((score) => ({
              board_id: score.boardId,
              answers: score.answers,
              correct: score.correct,
              predicted_rate: Number(score.predictedRate.toFixed(4)),
              score: Number(score.score.toFixed(4)),
              weakest_cell_index: score.weakestCellIndex,
              weakest_cell_rate: Number(score.weakestCellRate.toFixed(4)),
              basis: score.basis,
              suggested: score.suggested,
              verdict: score.verdict,
              cells: score.cells.map((cell) => ({
                ...cell,
                predicted: Number(cell.predicted.toFixed(4)),
                rate: Number(cell.rate.toFixed(4)),
              })),
            })) as Json)],
          );
        }
      });
      logger.info({ boards: summary.boards, measured: summary.measured, answers: summary.answers },
        'Football Grid board difficulty recomputed');
    }
    return { summary, scores };
  },

  /** The checker's list: boards whose label does not fit their score, worst mismatch first. */
  async listBoards(filter: {
    verdict?: 'keep' | 'move' | 'retire';
    basis?: 'measured' | 'predicted';
    theme?: string;
    limit: number;
  }): Promise<unknown[]> {
    return sql.unsafe(
      `SELECT d.board_id AS "boardId", b.theme, b.difficulty AS "contentLabel", d.applied,
              COALESCE(d.applied, b.difficulty) AS label, d.suggested, d.verdict, d.basis,
              d.answers, d.correct, d.score::float8 AS score, d.predicted_rate::float8 AS "predictedRate",
              d.weakest_cell_index AS "weakestCellIndex", d.weakest_cell_rate::float8 AS "weakestCellRate",
              d.cells, d.computed_at AS "computedAt",
              (SELECT array_agg(c.label_en ORDER BY x.ord) FROM unnest(b.row_criteria) WITH ORDINALITY AS x(id, ord)
                 JOIN football_grid_criteria c ON c.id = x.id) AS rows,
              (SELECT array_agg(c.label_en ORDER BY x.ord) FROM unnest(b.column_criteria) WITH ORDINALITY AS x(id, ord)
                 JOIN football_grid_criteria c ON c.id = x.id) AS columns
         FROM football_grid_board_difficulty d
         JOIN football_grid_boards b ON b.id = d.board_id
         JOIN football_grid_content_releases r ON r.id = b.release_id
        WHERE ${LIVE_BOARD_SQL}
          AND ($1::text IS NULL OR d.verdict = $1)
          AND ($2::text IS NULL OR d.basis = $2)
          AND ($3::text IS NULL OR b.theme = $3)
        ORDER BY (d.verdict = 'retire') DESC, (d.verdict = 'move') DESC,
                 abs(d.score - CASE COALESCE(d.applied, b.difficulty)
                                 WHEN 'easy' THEN 0.75 WHEN 'hard' THEN 0.40 ELSE 0.575 END) DESC,
                 d.answers DESC
        LIMIT $4`,
      [filter.verdict ?? null, filter.basis ?? null, filter.theme ?? null, filter.limit],
    );
  },

  async storedSummary(): Promise<unknown[]> {
    return sql.unsafe(
      `SELECT COALESCE(d.applied, b.difficulty) AS label, d.suggested, d.verdict, d.basis,
              count(*)::int AS boards, round(avg(d.score), 3)::float8 AS "avgScore"
         FROM football_grid_board_difficulty d
         JOIN football_grid_boards b ON b.id = d.board_id
         JOIN football_grid_content_releases r ON r.id = b.release_id
        WHERE ${LIVE_BOARD_SQL}
        GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`,
    );
  },

  /**
   * The nightly check: scores are refreshed once a day by whichever replica gets there first. It only stores
   * scores and verdicts; changing the label selection uses stays a reviewed step (applySuggested).
   */
  async runNightly(): Promise<'done' | 'skipped'> {
    if (!config.FOOTBALL_GRID_CONTENT_ENABLED) return 'skipped';
    const lock = await acquireLock(NIGHTLY_LOCK_KEY, NIGHTLY_LOCK_TTL_MS);
    if (!lock.acquired || !lock.token) return 'skipped';
    const heartbeat = startLockHeartbeat(NIGHTLY_LOCK_KEY, lock.token, NIGHTLY_LOCK_TTL_MS);
    try {
      const [latest] = await sql<Array<{ fresh: boolean }>>`
        SELECT COALESCE(max(computed_at) > now() - make_interval(secs => ${NIGHTLY_FRESH_MS / 1_000}), false) AS fresh
          FROM football_grid_board_difficulty`;
      if (latest?.fresh) return 'skipped';
      await this.recompute({ write: true });
      return 'done';
    } finally {
      heartbeat.stop();
      await releaseLock(NIGHTLY_LOCK_KEY, lock.token).catch(() => false);
    }
  },

  startNightly(): void {
    if (nightlyStartupTimer || nightlyIntervalTimer) return;
    const tick = (): void => {
      void this.runNightly().catch((error: unknown) => {
        logger.warn({ error }, 'Football Grid board difficulty check failed');
      });
    };
    nightlyStartupTimer = setTimeout(() => {
      nightlyStartupTimer = null;
      tick();
    }, NIGHTLY_STARTUP_MIN_DELAY_MS + Math.floor(Math.random() * NIGHTLY_STARTUP_JITTER_MS));
    nightlyStartupTimer.unref?.();
    nightlyIntervalTimer = setInterval(tick, NIGHTLY_INTERVAL_MS);
    nightlyIntervalTimer.unref?.();
  },

  /**
   * The reviewed step: makes the suggested label the one board selection uses. With no board list it applies
   * every board whose suggestion differs from its label, of the given basis.
   */
  async applySuggested(input: {
    actor: string;
    boardIds?: readonly string[];
    basis?: 'measured' | 'predicted';
  }): Promise<{ applied: number }> {
    if (!input.actor.trim()) throw new BadRequestError('An actor is required to apply difficulty labels');
    const rows = await sql.unsafe<Array<{ board_id: string }>>(
      `UPDATE football_grid_board_difficulty d
          SET applied = d.suggested, applied_by = $1, applied_at = now()
         FROM football_grid_boards b
        WHERE b.id = d.board_id
          AND d.verdict IN ('move', 'retire')
          AND d.suggested IS DISTINCT FROM COALESCE(d.applied, b.difficulty)
          AND ($2::uuid[] IS NULL OR d.board_id = ANY($2::uuid[]))
          AND ($3::text IS NULL OR d.basis = $3)
        RETURNING d.board_id`,
      [input.actor, input.boardIds ? [...input.boardIds] : null, input.basis ?? null],
    );
    return { applied: rows.length };
  },
};

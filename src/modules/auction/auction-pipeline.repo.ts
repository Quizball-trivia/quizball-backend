import { sql } from '../../db/index.js';
import type {
  AuctionPipelineAttemptErrorClass,
  AuctionPipelineCardStatusCounts,
  AuctionPipelineFailureSample,
  AuctionPipelinePoolCounts,
  AuctionPipelinePrompt,
  AuctionPipelinePromptKey,
  AuctionPipelineSnapshot,
  AuctionPipelineStageCount,
  AuctionPipelineVariantCount,
  AuctionPipelineWorker,
} from './auction-pipeline.types.js';

const FAILURE_SAMPLE_LIMIT = 20;
const ERROR_MESSAGE_MAX_LENGTH = 300;

/** A worker that has not checked in for this long is reported as stale. */
const WORKER_STALE_SECONDS = 120;

/**
 * Mirrors the auction eligibility rules used by the content pipeline: a player
 * enters the generation pool only when active, priced at or above the floor,
 * and renderable in the auction UI.
 */
const eligiblePlayerPredicate = sql`
  active_status = 'active'
  AND current_value_eur IS NOT NULL
  AND current_value_eur >= 5000000
  AND image_url IS NOT NULL
  AND position_group IN ('GK', 'DEF', 'MID', 'FWD')
`;

function parseCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : Number.parseInt(value, 10);
}

export const auctionPipelineRepo = {
  async getTaskStageCounts(): Promise<AuctionPipelineStageCount[]> {
    const rows = await sql<{ stage: string; count: string | number }[]>`
      SELECT stage, COUNT(*)::text AS count
      FROM card_generation_tasks
      GROUP BY stage
      ORDER BY stage
    `;

    return rows.map((row) => ({ stage: row.stage, count: parseCount(row.count) }));
  },

  async getTaskVariantCounts(): Promise<AuctionPipelineVariantCount[]> {
    const rows = await sql<{
      variant_key: string;
      count: string | number;
      published: string | number;
    }[]>`
      SELECT
        variant_key,
        COUNT(*)::text AS count,
        COUNT(*) FILTER (WHERE stage = 'published')::text AS published
      FROM card_generation_tasks
      GROUP BY variant_key
      ORDER BY variant_key
    `;

    return rows.map((row) => ({
      variant_key: row.variant_key,
      count: parseCount(row.count),
      published: parseCount(row.published),
    }));
  },

  async getAttemptErrorClasses(): Promise<AuctionPipelineAttemptErrorClass[]> {
    const rows = await sql<{
      error_class: string | null;
      count: string | number;
    }[]>`
      SELECT COALESCE(error_class, 'unclassified') AS error_class, COUNT(*)::text AS count
      FROM card_generation_attempts
      WHERE created_at >= now() - interval '24 hours'
        AND status <> 'success'
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `;

    return rows.map((row) => ({
      error_class: row.error_class ?? 'unclassified',
      count: parseCount(row.count),
    }));
  },

  async getAttemptTotals(): Promise<{ total: number; success: number; rejected: number; failed: number }> {
    const [row] = await sql<{
      total: string | number;
      success: string | number;
      rejected: string | number;
      failed: string | number;
    }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'success')::text AS success,
        COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
      FROM card_generation_attempts
      WHERE created_at >= now() - interval '24 hours'
    `;

    return {
      total: parseCount(row?.total),
      success: parseCount(row?.success),
      rejected: parseCount(row?.rejected),
      failed: parseCount(row?.failed),
    };
  },

  async getRecentFailures(): Promise<AuctionPipelineFailureSample[]> {
    const rows = await sql<{
      id: string;
      task_id: string;
      task_stage: string;
      status: string;
      error_class: string | null;
      error_message: string | null;
      external_call: string | null;
      created_at: Date;
    }[]>`
      SELECT
        id,
        task_id,
        task_stage,
        status,
        error_class,
        LEFT(error_message, ${ERROR_MESSAGE_MAX_LENGTH}) AS error_message,
        external_call,
        created_at
      FROM card_generation_attempts
      WHERE status <> 'success'
      ORDER BY created_at DESC
      LIMIT ${FAILURE_SAMPLE_LIMIT}
    `;

    return rows.map((row) => ({
      id: row.id,
      task_id: row.task_id,
      task_stage: row.task_stage,
      status: row.status,
      error_class: row.error_class,
      error_message: row.error_message,
      external_call: row.external_call,
      created_at: row.created_at.toISOString(),
    }));
  },

  /**
   * Variant cards only. Legacy rows predate the card-family model and carry a
   * NULL variant_key, so counting them here would inflate pipeline output.
   */
  async getVariantCardStatusCounts(): Promise<AuctionPipelineCardStatusCounts> {
    const [row] = await sql<{
      published: string | number;
      needs_review: string | number;
      superseded: string | number;
      rejected: string | number;
      published_families: string | number;
    }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'published')::text AS published,
        COUNT(*) FILTER (WHERE status = 'needs_review')::text AS needs_review,
        COUNT(*) FILTER (WHERE status = 'superseded')::text AS superseded,
        COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected,
        COUNT(DISTINCT card_family_id) FILTER (WHERE status = 'published')::text
          AS published_families
      FROM player_clue_cards
      WHERE variant_key IS NOT NULL
    `;

    return {
      published: parseCount(row?.published),
      needs_review: parseCount(row?.needs_review),
      superseded: parseCount(row?.superseded),
      rejected: parseCount(row?.rejected),
      published_families: parseCount(row?.published_families),
    };
  },

  async getLatestSnapshot(): Promise<AuctionPipelineSnapshot | null> {
    const [row] = await sql<{
      id: string;
      source: string;
      status: string;
      player_row_count: number;
      valuation_row_count: number;
      created_at: Date;
      promoted_at: Date | null;
    }[]>`
      SELECT id, source, status, player_row_count, valuation_row_count, created_at, promoted_at
      FROM content_snapshots
      ORDER BY created_at DESC
      LIMIT 1
    `;

    if (!row) return null;

    return {
      id: row.id,
      source: row.source,
      status: row.status,
      player_row_count: row.player_row_count,
      valuation_row_count: row.valuation_row_count,
      created_at: row.created_at.toISOString(),
      promoted_at: row.promoted_at ? row.promoted_at.toISOString() : null,
    };
  },

  /**
   * Eligible pool size vs. players that already have at least one published
   * variant card, so the CMS can show how much of the roster remains.
   */
  async getPoolCounts(): Promise<AuctionPipelinePoolCounts> {
    const [row] = await sql<{
      eligible_players: string | number;
      players_with_published_card: string | number;
    }[]>`
      SELECT
        COUNT(*)::text AS eligible_players,
        COUNT(*) FILTER (
          WHERE EXISTS (
            SELECT 1
            FROM player_clue_cards pcc
            WHERE pcc.football_player_id = fp.id
              AND pcc.variant_key IS NOT NULL
              AND pcc.status = 'published'
          )
        )::text AS players_with_published_card
      FROM football_players fp
      WHERE ${eligiblePlayerPredicate}
    `;

    return {
      eligible_players: parseCount(row?.eligible_players),
      players_with_published_card: parseCount(row?.players_with_published_card),
    };
  },

  /**
   * Live runner heartbeats. Staleness is derived in SQL against now() so it
   * reflects the database clock rather than the API server's.
   */
  async listWorkers(): Promise<AuctionPipelineWorker[]> {
    const rows = await sql<{
      worker_id: string;
      hostname: string;
      task_id: string | null;
      player_name: string | null;
      variant_key: string | null;
      stage: string | null;
      started_at: Date;
      updated_at: Date;
      seconds_since_heartbeat: number;
      is_stale: boolean;
    }[]>`
      SELECT
        worker_id,
        hostname,
        task_id,
        player_name,
        variant_key,
        stage,
        started_at,
        updated_at,
        EXTRACT(EPOCH FROM (now() - updated_at))::int AS seconds_since_heartbeat,
        EXTRACT(EPOCH FROM (now() - updated_at)) > ${WORKER_STALE_SECONDS} AS is_stale
      FROM pipeline_workers
      ORDER BY updated_at DESC
    `;

    return rows.map((row) => ({
      worker_id: row.worker_id,
      hostname: row.hostname,
      task_id: row.task_id,
      player_name: row.player_name,
      variant_key: row.variant_key,
      stage: row.stage,
      started_at: row.started_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
      seconds_since_heartbeat: row.seconds_since_heartbeat,
      is_stale: row.is_stale,
    }));
  },

  async listPrompts(): Promise<AuctionPipelinePrompt[]> {
    const rows = await sql<{
      key: string;
      text: string;
      updated_at: Date;
      updated_by: string | null;
    }[]>`
      SELECT key, text, updated_at, updated_by
      FROM pipeline_prompts
      ORDER BY key
    `;

    return rows.map((row) => ({
      key: row.key,
      text: row.text,
      updated_at: row.updated_at.toISOString(),
      updated_by: row.updated_by,
    }));
  },

  async upsertPrompt(
    key: AuctionPipelinePromptKey,
    text: string,
    updatedBy: string
  ): Promise<AuctionPipelinePrompt> {
    const [row] = await sql<{
      key: string;
      text: string;
      updated_at: Date;
      updated_by: string | null;
    }[]>`
      INSERT INTO pipeline_prompts (key, text, updated_by, updated_at)
      VALUES (${key}, ${text}, ${updatedBy}, now())
      ON CONFLICT (key) DO UPDATE SET
        text = EXCLUDED.text,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING key, text, updated_at, updated_by
    `;

    return {
      key: row.key,
      text: row.text,
      updated_at: row.updated_at.toISOString(),
      updated_by: row.updated_by,
    };
  },

  /**
   * Reset terminal tasks back to 'queued' so the runner picks them up again.
   * Only rejected/failed tasks are eligible — published families are never
   * touched, so a requeue can't destroy shipped content. Leases are cleared so
   * a task is not stuck waiting for a lease that no live worker owns.
   */
  async requeueTasks(params: {
    taskIds?: string[];
    filter?: 'failed' | 'rejected';
  }): Promise<number> {
    const selector =
      params.taskIds && params.taskIds.length > 0
        ? sql`id = ANY(${params.taskIds}::uuid[])`
        : sql`stage = ${params.filter as string}`;

    const rows = await sql<{ id: string }[]>`
      UPDATE card_generation_tasks
      SET stage = 'queued',
          lease_owner = NULL,
          lease_expires_at = NULL,
          failure_class = NULL,
          failure_message = NULL,
          rejection_reason = NULL,
          completed_at = NULL
      WHERE ${selector}
        AND stage IN ('rejected', 'failed')
      RETURNING id
    `;

    return rows.length;
  },
};

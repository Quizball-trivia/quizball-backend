/**
 * Orchestrator persistence: CAS phase transitions that commit atomically with
 * their outbox event, tournament creation, and the due-work reads. Every
 * transition is idempotent — the CAS WHERE clause makes the loser a no-op.
 */

import { sql } from '../../db/index.js';
import { wlEventsRepo } from './wl-events.repo.js';
import { wlCanTransition } from './wl-phase.js';
import { wlInsertTournamentSlots, type SlotInsert } from './wl-seeder.js';
import type { WlTournamentStatus } from './weekend-league.schemas.js';
import type { WlTournamentConfig } from './wl-config.js';

export interface WlOrchestratorTournament {
  id: string;
  week_key: string | null;
  is_test: boolean;
  status: WlTournamentStatus;
  paused_from_status: WlTournamentStatus | null;
  config: Record<string, unknown>;
  stage: Record<string, unknown> | null;
  ladder: Record<string, unknown> | null;
  entry_opens_at: string | null;
  entry_closes_at: string | null;
  qualifier_starts_at: string | null;
  final_starts_at: string | null;
  live_delivered_seq: number;
  spec_delivered_seq: number;
  champion_user_id: string | null;
  final_played: boolean;
}

const TOURNAMENT_COLUMNS = sql`
  id, week_key::text, is_test, status, paused_from_status, config, stage, ladder,
  entry_opens_at::text, entry_closes_at::text,
  qualifier_starts_at::text, final_starts_at::text,
  live_delivered_seq, spec_delivered_seq, champion_user_id, final_played
`;

export const wlOrchestratorRepo = {
  /** All tournaments the orchestrator must look at (non-terminal). */
  async listActive(): Promise<WlOrchestratorTournament[]> {
    return sql<WlOrchestratorTournament[]>`
      SELECT ${TOURNAMENT_COLUMNS} FROM wl_tournaments
      WHERE status NOT IN ('completed', 'cancelled', 'voided')
      ORDER BY created_at ASC
    `;
  },

  /** Terminal tournaments that ended recently (wave/drain healing window). */
  async listRecentlyTerminal(hours: number): Promise<WlOrchestratorTournament[]> {
    return sql<WlOrchestratorTournament[]>`
      SELECT ${TOURNAMENT_COLUMNS} FROM wl_tournaments
      WHERE status IN ('completed', 'cancelled', 'voided')
        AND updated_at > NOW() - make_interval(hours => ${hours})
      ORDER BY updated_at DESC
    `;
  },

  /**
   * CAS transition + outbox event in one transaction. Returns true when THIS
   * call performed the transition (the loser of a race gets false).
   */
  async transition(input: {
    tournamentId: string;
    from: WlTournamentStatus;
    to: WlTournamentStatus;
    redisTimeMs: number;
    eventPayload?: Record<string, unknown>;
    setPausedFrom?: WlTournamentStatus | null;
    cancelledReason?: string;
    /** Only while no kickoff is claimed (a host's Start sets qualifier_starts_at before the phase moves). */
    onlyIfNotStarted?: boolean;
  }): Promise<boolean> {
    // The pure phase machine is the law — persistence refuses transitions it
    // does not allow (ops cannot pause/cancel a completed tournament, the
    // engine cannot skip phases).
    if (!wlCanTransition(input.from, input.to)) {
      throw new Error(`WL transition not allowed: ${input.from} -> ${input.to}`);
    }
    let performed = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const rows = await txSql`
        UPDATE wl_tournaments
        SET status = ${input.to},
            paused_from_status = ${input.setPausedFrom ?? null},
            cancelled_reason = COALESCE(${input.cancelledReason ?? null}, cancelled_reason),
            final_played = CASE WHEN ${input.eventPayload?.['final_played'] === false}
                                THEN false ELSE final_played END
        WHERE id = ${input.tournamentId} AND status = ${input.from}
          AND (${input.onlyIfNotStarted !== true} OR qualifier_starts_at IS NULL)
        RETURNING id
      `;
      if (rows.length === 0) return;
      await wlEventsRepo.append(txSql, {
        tournamentId: input.tournamentId,
        type: input.to === 'cancelled' ? 'cancellation' : 'phase',
        payload: { from: input.from, to: input.to, ...(input.eventPayload ?? {}) },
        redisTimeMs: input.redisTimeMs,
      });
      performed = true;
    });
    return performed;
  },

  /** Resume from pause back to the phase it interrupted. */
  async resume(tournamentId: string, redisTimeMs: number): Promise<boolean> {
    let performed = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const rows = await txSql<{ paused_from_status: WlTournamentStatus }[]>`
        SELECT paused_from_status FROM wl_tournaments
        WHERE id = ${tournamentId} AND status = 'paused' AND paused_from_status IS NOT NULL
        FOR UPDATE
      `;
      const target = rows[0]?.paused_from_status;
      if (!target) return;
      await txSql`
        UPDATE wl_tournaments
        SET status = ${target}, paused_from_status = NULL
        WHERE id = ${tournamentId} AND status = 'paused'
      `;
      await wlEventsRepo.append(txSql, {
        tournamentId,
        type: 'phase',
        payload: { from: 'paused', to: target, resumed: true },
        redisTimeMs,
      });
      performed = true;
    });
    return performed;
  },

  /**
   * Row + its seq-1 creation event in ONE transaction, so a crash can never
   * leave a durable tournament with an empty event stream. ON CONFLICT: the
   * weekly-creation race between replicas resolves to a single row via the
   * partial unique index on week_key (real rows only).
   */
  async createWithInitialEvent(input: {
    weekKey: string | null;
    isTest: boolean;
    config: WlTournamentConfig;
    entryOpensAt: Date;
    entryClosesAt: Date;
    /** Null only for host-run events: the host's Start sets the kickoff. */
    qualifierStartsAt: Date | null;
    finalStartsAt: Date | null;
    redisTimeMs: number;
    status?: WlTournamentStatus;
  }): Promise<WlOrchestratorTournament | null> {
    let created: WlOrchestratorTournament | null = null;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const rows = await txSql<WlOrchestratorTournament[]>`
        INSERT INTO wl_tournaments (
          week_key, is_test, status, config,
          entry_opens_at, entry_closes_at, qualifier_starts_at, final_starts_at
        )
        VALUES (
          ${input.weekKey}, ${input.isTest}, ${input.status ?? 'scheduled'},
          ${sql.json(input.config as never)},
          ${input.entryOpensAt}, ${input.entryClosesAt},
          ${input.qualifierStartsAt}, ${input.finalStartsAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING ${TOURNAMENT_COLUMNS}
      `;
      if (rows.length === 0) return;
      await wlEventsRepo.append(txSql, {
        tournamentId: rows[0]!.id,
        type: 'phase',
        payload: { from: null, to: rows[0]!.status, created: true },
        redisTimeMs: input.redisTimeMs,
      });
      created = rows[0]!;
    });
    return created;
  },

  async getById(id: string): Promise<WlOrchestratorTournament | null> {
    const [row] = await sql<WlOrchestratorTournament[]>`
      SELECT ${TOURNAMENT_COLUMNS} FROM wl_tournaments WHERE id = ${id}
    `;
    return row ?? null;
  },

  /** The weekly host-run event for a slug and Monday, whatever its status. */
  async getHostRunEvent(slug: string, eventDate: string): Promise<WlOrchestratorTournament | null> {
    const [row] = await sql<WlOrchestratorTournament[]>`
      SELECT ${TOURNAMENT_COLUMNS} FROM wl_tournaments
      WHERE is_test = true AND config->>'event_slug' = ${slug}
        AND config->>'event_date' = ${eventDate}
      LIMIT 1
    `;
    return row ?? null;
  },

  /**
   * Load a show pack into a host-run event, replacing whatever questions it
   * has — only before the show starts: the row lock serializes with the
   * host's Start (which claims qualifier_starts_at), and an event that has
   * run any question is never touched. No-op when this pack version is
   * already loaded. Returns whether the content was replaced.
   */
  async applyShowPack(input: {
    tournamentId: string;
    slots: readonly SlotInsert[];
    layout: ReadonlyArray<{ kind: string; count: number }>;
    hash: string;
  }): Promise<boolean> {
    let applied = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const [t] = await txSql<{ status: string; started: boolean; hash: string | null }[]>`
        SELECT status, qualifier_starts_at IS NOT NULL AS started, config->>'show_pack_hash' AS hash
        FROM wl_tournaments
        WHERE id = ${input.tournamentId} AND is_test = true AND config ? 'host_email'
        FOR UPDATE
      `;
      if (!t || t.started || t.hash === input.hash) return;
      if (!['scheduled', 'content_pending', 'ready', 'entry_open'].includes(t.status)) return;
      const [{ runs }] = await txSql<{ runs: number }[]>`
        SELECT COUNT(*)::int AS runs FROM wl_question_runs WHERE tournament_id = ${input.tournamentId}
      `;
      if (runs > 0) return;
      await txSql`DELETE FROM wl_questions WHERE tournament_id = ${input.tournamentId}`;
      await wlInsertTournamentSlots(txSql, input.tournamentId, input.slots);
      await txSql`
        UPDATE wl_tournaments
        SET config = config || ${sql.json({ show_rounds: input.layout, show_pack_hash: input.hash } as never)},
            updated_at = NOW()
        WHERE id = ${input.tournamentId}
      `;
      applied = true;
    });
    return applied;
  },

  /**
   * Earlier weeks' host-run events the host never started (still pre-game). Only shows dated BEFORE the one to keep
   * open: a later Monday is never "stale". (2026-11-24: during a release, the old server, which kept only this
   * week's show, and the new one, which opens the next Monday once a show is over or cancelled, ran side by side
   * for a minute. Each cancelled what the other had just opened, five Mondays in a row. With dates compared, two
   * servers that disagree can no longer cancel upcoming shows.)
   */
  async listStaleHostRun(slug: string, eventDate: string): Promise<WlOrchestratorTournament[]> {
    return sql<WlOrchestratorTournament[]>`
      SELECT ${TOURNAMENT_COLUMNS} FROM wl_tournaments
      WHERE is_test = true AND config->>'event_slug' = ${slug}
        AND config ? 'host_email'
        AND COALESCE(config->>'event_date', '') < ${eventDate}
        AND qualifier_starts_at IS NULL
        AND status IN ('scheduled', 'content_pending', 'ready', 'entry_open', 'entry_closed')
    `;
  },

  /** The real (non-test) tournament for a given week, if any. */
  async getByWeekKey(weekKey: string): Promise<WlOrchestratorTournament | null> {
    const [row] = await sql<WlOrchestratorTournament[]>`
      SELECT ${TOURNAMENT_COLUMNS} FROM wl_tournaments
      WHERE week_key = ${weekKey}::date AND is_test = false
    `;
    return row ?? null;
  },

  async checkedInCount(tournamentId: string): Promise<number> {
    const [row] = await sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM wl_entries
      WHERE tournament_id = ${tournamentId} AND checked_in_at IS NOT NULL
        AND state IN ('entered', 'playing')
    `;
    return row?.n ?? 0;
  },
};

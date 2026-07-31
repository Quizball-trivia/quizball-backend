/**
 * Engine seam between orchestration and gameplay. PR2 ships a STUB that
 * makes the full phase machine traversable end-to-end (creation → entry →
 * check-in → qualifier → finalists → final → champion) without any live
 * questions: games complete instantly and ranking is deterministic-but-
 * meaningless (entry order). PR3/PR4 replace the stub internals; the
 * orchestrator only ever talks to this interface.
 */

import { sql } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { wlEventsRepo } from './wl-events.repo.js';
import { wlOrchestratorRepo, type WlOrchestratorTournament } from './wl-orchestrator.repo.js';
import { WL_FINALISTS, wlBuildLadder } from './wl-rules.js';

export interface WlEngine {
  /** Freeze/copy content for the tournament. True = ready to open entry. */
  seedContent(t: WlOrchestratorTournament): Promise<boolean>;
  /** Freeze game-1 participants from checked-in entries. True = kickoff OK. */
  startQualifier(t: WlOrchestratorTournament, redisNow: number): Promise<boolean>;
  /** Advance live play (game_live / break / final_live). */
  advance(t: WlOrchestratorTournament, redisNow: number): Promise<void>;
  /** dns_v1 at final start: play with ≥2 checked-in finalists, else settle. */
  adjudicateFinalStart(t: WlOrchestratorTournament, redisNow: number): Promise<void>;
}

async function participants(tournamentId: string, gameIndex: number): Promise<string[]> {
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM wl_game_participants
    WHERE tournament_id = ${tournamentId} AND game_index = ${gameIndex}
    ORDER BY user_id ASC
  `;
  return rows.map((r) => r.user_id);
}

export const wlEngineStub: WlEngine = {
  async seedContent(): Promise<boolean> {
    return true; // PR3: real picker draws wl_private content + reserves.
  },

  async startQualifier(t, _redisNow): Promise<boolean> {
    const inserted = await sql<{ user_id: string }[]>`
      INSERT INTO wl_game_participants (tournament_id, game_index, user_id)
      SELECT tournament_id, 0, user_id FROM wl_entries
      WHERE tournament_id = ${t.id} AND checked_in_at IS NOT NULL AND state = 'entered'
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;
    await sql`
      UPDATE wl_entries SET state = 'playing'
      WHERE tournament_id = ${t.id} AND checked_in_at IS NOT NULL AND state = 'entered'
    `;
    const field = await participants(t.id, 0);
    await sql`
      UPDATE wl_tournaments
      SET ladder = ${sql.json({ fieldSize: field.length, advance: wlBuildLadder(field.length) } as never)}
      WHERE id = ${t.id}
    `;
    logger.info({ tournamentId: t.id, field: field.length, inserted: inserted.length }, 'WL qualifier field frozen (stub)');
    return field.length > 0;
  },

  async advance(t, redisNow): Promise<void> {
    // STUB: the qualifier resolves instantly — entry-order ranking, top
    // WL_FINALISTS become finalists, the rest eliminated in game 1.
    if (t.status === 'game_live') {
      const field = await participants(t.id, 0);
      if (field.length === 0) return;
      const finalists = field.slice(0, WL_FINALISTS);
      const eliminated = field.slice(WL_FINALISTS);
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as typeof sql;
        if (finalists.length > 0) {
          await txSql`
            UPDATE wl_entries SET state = 'finalist'
            WHERE tournament_id = ${t.id} AND user_id = ANY(${sql.array(finalists)}::uuid[])
          `;
        }
        if (eliminated.length > 0) {
          await txSql`
            UPDATE wl_entries SET state = 'eliminated', eliminated_game = 0
            WHERE tournament_id = ${t.id} AND user_id = ANY(${sql.array(eliminated)}::uuid[])
          `;
        }
        const moved = await txSql`
          UPDATE wl_tournaments SET status = 'qualifier_done'
          WHERE id = ${t.id} AND status = 'game_live'
          RETURNING id
        `;
        if (moved.length > 0) {
          await wlEventsRepo.append(txSql, {
            tournamentId: t.id,
            type: 'game_result',
            payload: { stub: true, game_index: 0, finalists: finalists.length },
            redisTimeMs: redisNow,
          });
        }
      });
      return;
    }

    if (t.status === 'final_live') {
      const finalists = await sql<{ user_id: string }[]>`
        SELECT user_id FROM wl_entries
        WHERE tournament_id = ${t.id} AND state = 'finalist' AND final_checked_in_at IS NOT NULL
        ORDER BY user_id ASC
      `;
      const champion = finalists[0]?.user_id ?? null;
      await completeTournament(t.id, redisNow, champion, true);
    }
  },

  async adjudicateFinalStart(t, redisNow): Promise<void> {
    const checkedIn = await sql<{ user_id: string }[]>`
      SELECT user_id FROM wl_entries
      WHERE tournament_id = ${t.id} AND state = 'finalist' AND final_checked_in_at IS NOT NULL
      ORDER BY user_id ASC
    `;
    await sql`
      UPDATE wl_entries SET state = 'no_show'
      WHERE tournament_id = ${t.id} AND state = 'finalist' AND final_checked_in_at IS NULL
    `;
    if (checkedIn.length >= 2) {
      await wlOrchestratorRepo.transition({
        tournamentId: t.id, from: 'final_checkin', to: 'final_live', redisTimeMs: redisNow,
        eventPayload: { checked_in: checkedIn.length },
      });
      return;
    }
    // dns_v1 walkover: final not played; champion = sole checked-in finalist
    // (or nobody). Standings settle from qualifier order in PR4's real engine.
    await completeTournament(t.id, redisNow, checkedIn[0]?.user_id ?? null, false);
  },
};

async function completeTournament(
  tournamentId: string,
  redisNow: number,
  championUserId: string | null,
  finalPlayed: boolean
): Promise<void> {
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    const moved = await txSql`
      UPDATE wl_tournaments
      SET status = 'completed', champion_user_id = ${championUserId},
          final_played = ${finalPlayed}
      WHERE id = ${tournamentId} AND status IN ('final_live', 'final_checkin')
      RETURNING id
    `;
    if (moved.length === 0) return;
    if (championUserId) {
      await txSql`
        UPDATE wl_entries SET state = 'champion', final_rank = 1
        WHERE tournament_id = ${tournamentId} AND user_id = ${championUserId}
      `;
    }
    await wlEventsRepo.append(txSql, {
      tournamentId,
      type: 'final_result',
      payload: { champion_user_id: championUserId, final_played: finalPlayed },
      redisTimeMs: redisNow,
    });
  });
}

// PR3/PR4 swap this binding for the real engine.
export const wlEngine: WlEngine = wlEngineStub;

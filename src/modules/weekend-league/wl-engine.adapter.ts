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
import { type WlOrchestratorTournament } from './wl-orchestrator.repo.js';
import { WL_FINALISTS, wlBuildLadder } from './wl-rules.js';

export interface WlEngine {
  /** Freeze/copy content for the tournament. True = ready to open entry. */
  seedContent(t: WlOrchestratorTournament): Promise<boolean>;
  /**
   * Kick off game 1 ATOMICALLY: wins the checkin→game_live CAS and, in the
   * same transaction, freezes participants, marks entries playing, stores
   * the ladder and appends the phase event. True = this call started it.
   */
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

function assertStubSafety(t: WlOrchestratorTournament): void {
  // The stub must NEVER touch a real event: it has no gameplay, so letting
  // it run a real Saturday would farce-complete it with entry-order results.
  if (!t.is_test) {
    throw new Error(`WL engine stub refuses non-test tournament ${t.id} (install the real engine)`);
  }
}

export const wlEngineStub: WlEngine = {
  async seedContent(t): Promise<boolean> {
    assertStubSafety(t);
    return true; // PR3: real picker draws wl_private content + reserves.
  },

  async startQualifier(t, redisNow): Promise<boolean> {
    assertStubSafety(t);
    let started = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      // Win the phase FIRST — a concurrent ops pause/cancel that got there
      // before us means NONE of the kickoff mutations happen.
      const moved = await txSql`
        UPDATE wl_tournaments SET status = 'game_live'
        WHERE id = ${t.id} AND status = 'checkin'
        RETURNING id
      `;
      if (moved.length === 0) return;
      const frozen = await txSql<{ user_id: string }[]>`
        INSERT INTO wl_game_participants (tournament_id, game_index, user_id)
        SELECT tournament_id, 0, user_id FROM wl_entries
        WHERE tournament_id = ${t.id} AND checked_in_at IS NOT NULL AND state = 'entered'
        ON CONFLICT DO NOTHING
        RETURNING user_id
      `;
      await txSql`
        UPDATE wl_entries SET state = 'playing'
        WHERE tournament_id = ${t.id} AND checked_in_at IS NOT NULL AND state = 'entered'
      `;
      await txSql`
        UPDATE wl_tournaments
        SET ladder = ${sql.json({ fieldSize: frozen.length, advance: wlBuildLadder(frozen.length) } as never)}
        WHERE id = ${t.id}
      `;
      await wlEventsRepo.append(txSql, {
        tournamentId: t.id,
        type: 'phase',
        payload: { from: 'checkin', to: 'game_live', field: frozen.length },
        redisTimeMs: redisNow,
      });
      started = true;
      logger.info({ tournamentId: t.id, field: frozen.length }, 'WL qualifier kicked off (stub)');
    });
    return started;
  },

  async advance(t, redisNow): Promise<void> {
    assertStubSafety(t);
    // STUB: the qualifier resolves instantly — entry-order ranking, top
    // WL_FINALISTS become finalists, the rest eliminated in game 1. The
    // status CAS is won FIRST inside the transaction; entry mutations only
    // commit alongside it, so a concurrent pause/cancel can never strand
    // half-applied results. Both the phase and the result event are emitted.
    if (t.status === 'game_live') {
      const field = await participants(t.id, 0);
      if (field.length === 0) return;
      const finalists = field.slice(0, WL_FINALISTS);
      const eliminated = field.slice(WL_FINALISTS);
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as typeof sql;
        const moved = await txSql`
          UPDATE wl_tournaments SET status = 'qualifier_done'
          WHERE id = ${t.id} AND status = 'game_live'
          RETURNING id
        `;
        if (moved.length === 0) return;
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
        await wlEventsRepo.append(txSql, {
          tournamentId: t.id,
          type: 'phase',
          payload: { from: 'game_live', to: 'qualifier_done' },
          redisTimeMs: redisNow,
        });
        await wlEventsRepo.append(txSql, {
          tournamentId: t.id,
          type: 'game_result',
          payload: { stub: true, game_index: 0, finalists: finalists.length },
          redisTimeMs: redisNow,
        });
      });
      return;
    }

    if (t.status === 'final_live') {
      assertStubSafety(t);
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
    assertStubSafety(t);
    const checkedIn = await sql<{ user_id: string }[]>`
      SELECT user_id FROM wl_entries
      WHERE tournament_id = ${t.id} AND state = 'finalist' AND final_checked_in_at IS NOT NULL
      ORDER BY user_id ASC
    `;
    if (checkedIn.length >= 2) {
      // Phase CAS first; no_show marking commits with it or not at all.
      let moved = false;
      await sql.begin(async (tx) => {
        const txSql = tx as unknown as typeof sql;
        const rows = await txSql`
          UPDATE wl_tournaments SET status = 'final_live'
          WHERE id = ${t.id} AND status = 'final_checkin'
          RETURNING id
        `;
        if (rows.length === 0) return;
        await txSql`
          UPDATE wl_entries SET state = 'no_show'
          WHERE tournament_id = ${t.id} AND state = 'finalist' AND final_checked_in_at IS NULL
        `;
        await wlEventsRepo.append(txSql, {
          tournamentId: t.id,
          type: 'phase',
          payload: { from: 'final_checkin', to: 'final_live', checked_in: checkedIn.length },
          redisTimeMs: redisNow,
        });
        moved = true;
      });
      void moved;
      return;
    }
    // dns_v1 walkover: final not played; champion = sole checked-in finalist
    // (or nobody). completeTournament wins its own CAS and carries the
    // no_show marking in the same transaction.
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
    await txSql`
      UPDATE wl_entries SET state = 'no_show'
      WHERE tournament_id = ${tournamentId} AND state = 'finalist' AND final_checked_in_at IS NULL
    `;
    if (championUserId) {
      await txSql`
        UPDATE wl_entries SET state = 'champion', final_rank = 1
        WHERE tournament_id = ${tournamentId} AND user_id = ${championUserId}
      `;
    }
    await wlEventsRepo.append(txSql, {
      tournamentId,
      type: 'phase',
      payload: { to: 'completed', final_played: finalPlayed },
      redisTimeMs: redisNow,
    });
    await wlEventsRepo.append(txSql, {
      tournamentId,
      type: 'final_result',
      payload: { champion_user_id: championUserId, final_played: finalPlayed },
      redisTimeMs: redisNow,
    });
  });
}

/**
 * The LIVE engine: real seeded content, real dispatched questions, real
 * standings. PR3 scope = one playable game (game 0) to qualifier_done; the
 * final still settles by walkover semantics ON REAL qualifier standings
 * (PR4 turns the final into a played game and adds the 3-game gauntlet).
 */
export const wlEngineLive: WlEngine = {
  async seedContent(t): Promise<boolean> {
    const { wlSeedTournamentContent } = await import('./wl-seeder.js');
    const cfg = (t.config ?? {}) as Record<string, unknown>;
    const launchEdition = cfg['launch_edition'] === true || cfg['launch_edition'] === 'true';
    const result = await wlSeedTournamentContent({
      tournamentId: t.id,
      allowPublicBank: t.is_test || launchEdition,
      deterministic: process.env.REGRESSION_DETERMINISTIC === '1',
    });
    return result.ok;
  },

  async startQualifier(t, redisNow): Promise<boolean> {
    const { wlLiveEngineInternals } = await import('./wl-live-engine.js');
    let started = false;
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const moved = await txSql`
        UPDATE wl_tournaments SET status = 'game_live'
        WHERE id = ${t.id} AND status = 'checkin'
        RETURNING id
      `;
      if (moved.length === 0) return;
      const frozen = await txSql<{ user_id: string }[]>`
        INSERT INTO wl_game_participants (tournament_id, game_index, user_id)
        SELECT tournament_id, 0, user_id FROM wl_entries
        WHERE tournament_id = ${t.id} AND checked_in_at IS NOT NULL AND state = 'entered'
        ON CONFLICT DO NOTHING
        RETURNING user_id
      `;
      await txSql`
        UPDATE wl_entries SET state = 'playing'
        WHERE tournament_id = ${t.id} AND checked_in_at IS NOT NULL AND state = 'entered'
      `;
      await txSql`
        UPDATE wl_tournaments
        SET ladder = ${sql.json({ fieldSize: frozen.length, advance: wlBuildLadder(frozen.length) } as never)}
        WHERE id = ${t.id}
      `;
      await wlEventsRepo.append(txSql, {
        tournamentId: t.id,
        type: 'phase',
        payload: { from: 'checkin', to: 'game_live', field: frozen.length },
        redisTimeMs: redisNow,
      });
      started = true;
      logger.info({ tournamentId: t.id, field: frozen.length }, 'WL qualifier kicked off');
    });
    if (started) {
      // First question of game 0 (own tx; idempotent — recovery re-appends).
      await wlLiveEngineInternals.appendDispatch(t.id, { gameIndex: 0, roundIndex: 0, questionIndex: 0 }, redisNow);
    }
    return started;
  },

  async advance(t, redisNow): Promise<void> {
    const { wlLiveEngineInternals, wlNextSlot, wlSlotSequence } = await import('./wl-live-engine.js');
    if (t.status === 'game_live' || t.status === 'final_live') {
      // Progression looks at the FRONTIER slot across ALL attempts (voided
      // included): a slot whose reserves are exhausted is resolved-by-void
      // and must advance/finalize, never be re-created from its primary.
      const [frontier] = await sql<Array<{
        attempt_id: string; tournament_id: string; game_index: number; round_index: number;
        question_index: number; question_id: string; status: string;
        playable_at_ms: string | null; deadline_at_ms: string | null;
      }>>`
        SELECT attempt_id, tournament_id, game_index, round_index, question_index,
               question_id, status, playable_at_ms::text, deadline_at_ms::text
        FROM wl_question_runs
        WHERE tournament_id = ${t.id} AND game_index = 0
        ORDER BY round_index DESC, question_index DESC,
                 (status <> 'voided') DESC, created_at DESC
        LIMIT 1
      `;
      if (!frontier) {
        await wlLiveEngineInternals.appendDispatch(t.id, { gameIndex: 0, roundIndex: 0, questionIndex: 0 }, redisNow);
        return;
      }
      const slot = {
        gameIndex: frontier.game_index,
        roundIndex: frontier.round_index,
        questionIndex: frontier.question_index,
      };
      const lastSlot = wlSlotSequence().at(-1)!;
      const isLast = slot.roundIndex === lastSlot.roundIndex
        && slot.questionIndex === lastSlot.questionIndex;

      if (frontier.status === 'dispatched') {
        const deadline = Number(frontier.deadline_at_ms);
        if (Number.isFinite(deadline) && redisNow >= deadline) {
          // Freeze ONLY a question players actually received: the dispatch
          // event must be terminally delivered. An undelivered stale
          // dispatch belongs to the deliverer, which voids it to a reserve —
          // freezing it would reveal a question nobody saw and charge every
          // participant a miss.
          const [delivered] = await sql<Array<{ ok: boolean }>>`
            SELECT (e.delivered_at IS NOT NULL) AS ok
            FROM wl_question_runs r
            JOIN wl_events e
              ON e.tournament_id = r.tournament_id AND e.seq = r.dispatched_seq
            WHERE r.attempt_id = ${frontier.attempt_id}
          `;
          if (delivered?.ok) {
            await wlLiveEngineInternals.freezeAndReveal(t.id, frontier as never, redisNow);
          }
        }
        return;
      }
      if (frontier.status === 'frozen') {
        // Crash between freeze and reveal: resume idempotently — standings
        // and the reveal re-derive from the persisted answers.
        await wlLiveEngineInternals.resumeFrozen(t.id, frontier as never, redisNow);
        return;
      }
      if (frontier.status === 'revealed' || frontier.status === 'voided') {
        // A voided frontier only progresses when its slot is exhausted (the
        // void tx would have created a reserve attempt otherwise, which
        // would BE the frontier).
        if (isLast) {
          if (t.status === 'game_live') await finalizeQualifierGame(t.id, redisNow);
          return;
        }
        const next = wlNextSlot(slot);
        if (next) await wlLiveEngineInternals.appendDispatch(t.id, next, redisNow);
      }
      return;
    }
  },

  async adjudicateFinalStart(t, redisNow): Promise<void> {
    // PR3: dns_v1 settlement on REAL qualifier standings — champion is the
    // best-ranked finalist who checked in for Sunday. PR4 replaces this with
    // a genuinely played final game.
    const ranked = await sql<Array<{ user_id: string; final_checked_in_at: string | null }>>`
      SELECT e.user_id, e.final_checked_in_at::text
      FROM wl_entries e
      JOIN wl_game_results r
        ON r.tournament_id = e.tournament_id AND r.user_id = e.user_id AND r.game_index = 0
      WHERE e.tournament_id = ${t.id} AND e.state = 'finalist'
      ORDER BY r.rank ASC
    `;
    const checkedIn = ranked.filter((r) => r.final_checked_in_at != null);
    await completeTournament(t.id, redisNow, checkedIn[0]?.user_id ?? null, false);
  },
};

async function finalizeQualifierGame(tournamentId: string, redisNow: number): Promise<void> {
  const { wlLiveEngineInternals } = await import('./wl-live-engine.js');
  const board = await wlLiveEngineInternals.topBoard(tournamentId, 0, Number.MAX_SAFE_INTEGER);
  if (board.length === 0) return;
  const finalists = board.slice(0, WL_FINALISTS).map((b) => b.user_id);
  const eliminated = board.slice(WL_FINALISTS).map((b) => b.user_id);
  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    const moved = await txSql`
      UPDATE wl_tournaments SET status = 'qualifier_done'
      WHERE id = ${tournamentId} AND status = 'game_live'
      RETURNING id
    `;
    if (moved.length === 0) return;
    {
      const userIds = board.map((b) => b.user_id);
      const scores = board.map((b) => b.points);
      const times = board.map((b) => b.time_ms_total);
      const ranks = board.map((b) => b.rank);
      await txSql`
        INSERT INTO wl_game_results (
          tournament_id, game_index, user_id, score, time_ms_total, rank, advanced
        )
        SELECT ${tournamentId}, 0, u, s, tm, r, r <= ${WL_FINALISTS}
        FROM unnest(
          ${sql.array(userIds)}::uuid[], ${sql.array(scores)}::int[],
          ${sql.array(times)}::bigint[], ${sql.array(ranks)}::int[]
        ) AS t(u, s, tm, r)
        ON CONFLICT (tournament_id, game_index, user_id) DO NOTHING
      `;
    }
    if (finalists.length > 0) {
      await txSql`
        UPDATE wl_entries SET state = 'finalist'
        WHERE tournament_id = ${tournamentId} AND user_id = ANY(${sql.array(finalists)}::uuid[])
      `;
    }
    if (eliminated.length > 0) {
      await txSql`
        UPDATE wl_entries SET state = 'eliminated', eliminated_game = 0
        WHERE tournament_id = ${tournamentId} AND user_id = ANY(${sql.array(eliminated)}::uuid[])
      `;
    }
    await wlEventsRepo.append(txSql, {
      tournamentId, type: 'phase',
      payload: { from: 'game_live', to: 'qualifier_done' },
      redisTimeMs: redisNow,
    });
    await wlEventsRepo.append(txSql, {
      tournamentId, type: 'game_result',
      payload: {
        game_index: 0,
        board: board.slice(0, WL_FINALISTS),
        finalists: finalists.length,
        field: board.length,
      },
      redisTimeMs: redisNow,
    });
  });
  logger.info({ tournamentId, field: board.length, finalists: finalists.length }, 'WL qualifier game finalized');
}

/**
 * Engine selection is a property of the TOURNAMENT (validated config field),
 * not process state: orchestration-focused tests create their tournaments
 * with engine:'stub'; everything else defaults to 'live'. The stub is
 * additionally refused for non-test tournaments by its own safety assert,
 * so a mislabeled real event can never run without gameplay.
 */
export function getWlEngine(t: WlOrchestratorTournament): WlEngine {
  const cfg = (t.config ?? {}) as Record<string, unknown>;
  return cfg['engine'] === 'stub' && t.is_test ? wlEngineStub : wlEngineLive;
}

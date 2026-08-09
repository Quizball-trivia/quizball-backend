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
import { WL_FINALISTS, WL_MONEY_DROP_REVEAL_HOLD_MS, WL_PUT_IN_ORDER_REVEAL_HOLD_MS, WL_ROUND_BREATHER_MS, WL_STEP_REVEAL_HOLD_MS, wlBuildLadder } from './wl-rules.js';
import { wlConfigFrom } from './wl-config.js';

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
    // dns_v1 walkover awards: qualifier ordering among finalists, the
    // checked-in walkover champion first.
    const ordering = await txSql<Array<{ user_id: string; rank: number }>>`
      SELECT e.user_id,
             ROW_NUMBER() OVER (
               ORDER BY (e.user_id = ${championUserId}::uuid) DESC, r.rank ASC
             )::int AS rank
      FROM wl_entries e
      JOIN wl_game_results r
        ON r.tournament_id = e.tournament_id AND r.user_id = e.user_id AND r.game_index = 2
      WHERE e.tournament_id = ${tournamentId} AND e.state IN ('champion', 'finalist', 'no_show')
    `;
    await writeAwards(txSql, tournamentId, ordering);
    const field = await txSql<{ user_id: string }[]>`
      SELECT user_id FROM wl_entries
      WHERE tournament_id = ${tournamentId}
        AND state IN ('champion', 'finalist', 'no_show', 'playing')
    `;
    const evict = field.map((f) => f.user_id);
    await wlEventsRepo.append(txSql, {
      tournamentId,
      type: 'phase',
      payload: { to: 'completed', final_played: finalPlayed, evicted_user_ids: evict },
      redisTimeMs: redisNow,
    });
    await wlEventsRepo.append(txSql, {
      tournamentId,
      type: 'final_result',
      payload: {
        champion_user_id: championUserId, final_played: finalPlayed,
        evicted_user_ids: evict,
      },
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
    if (t.status === 'break') {
      // Break ends by the clock; the next game's field was frozen when the
      // break began, so resuming is a single CAS.
      const stage = t.stage ?? {};
      const rawBreakUntil = Number(stage['break_until_ms']);
      // A missing/corrupt anchor must never strand the event in 'break' —
      // treat it as elapsed and resume (the anchor is written in the same tx
      // as the break status, so this is pure defense).
      const breakUntil = Number.isFinite(rawBreakUntil) ? rawBreakUntil : 0;
      if (redisNow >= breakUntil) {
        const nextGame = Number(stage['current_game'] ?? 0);
        await sql.begin(async (tx) => {
          const txSql = tx as unknown as typeof sql;
          const moved = await txSql`
            UPDATE wl_tournaments SET status = 'game_live'
            WHERE id = ${t.id} AND status = 'break'
            RETURNING id
          `;
          if (moved.length === 0) return;
          await wlEventsRepo.append(txSql, {
            tournamentId: t.id, type: 'phase',
            payload: { from: 'break', to: 'game_live', game_index: nextGame },
            redisTimeMs: redisNow,
          });
        });
      }
      return;
    }

    if (t.status === 'game_live' || t.status === 'final_live') {
      const gameIndex = await currentGameIndex(t);
      // Progression looks at the FRONTIER slot across ALL attempts (voided
      // included): a slot whose reserves are exhausted is resolved-by-void
      // and must advance/finalize, never be re-created from its primary.
      const [frontier] = await sql<Array<{
        attempt_id: string; tournament_id: string; game_index: number; round_index: number;
        question_index: number; question_id: string; status: string;
        playable_at_ms: string | null; deadline_at_ms: string | null;
        revealed_at_ms: string | null;
      }>>`
        SELECT attempt_id, tournament_id, game_index, round_index, question_index,
               question_id, status, playable_at_ms::text, deadline_at_ms::text,
               revealed_at_ms::text
        FROM wl_question_runs
        WHERE tournament_id = ${t.id} AND game_index = ${gameIndex}
        ORDER BY round_index DESC, question_index DESC,
                 (status <> 'voided') DESC, created_at DESC
        LIMIT 1
      `;
      if (!frontier) {
        await wlLiveEngineInternals.appendDispatch(t.id, { gameIndex, roundIndex: 0, questionIndex: 0 }, redisNow);
        return;
      }
      const slot = {
        gameIndex: frontier.game_index,
        roundIndex: frontier.round_index,
        questionIndex: frontier.question_index,
      };
      const lastSlot = wlSlotSequence(gameIndex).at(-1)!;
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
              ON e.tournament_id = r.tournament_id
             AND (
               e.seq = r.dispatched_seq
               OR (r.dispatched_seq IS NULL AND e.type = 'dispatch'
                   AND e.payload->>'attempt_id' = r.attempt_id::text)
             )
            WHERE r.attempt_id = ${frontier.attempt_id}
            ORDER BY e.seq DESC LIMIT 1
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
        const next = isLast ? null : wlNextSlot(slot);
        // Hold at any ROUND boundary — including the last round of a game,
        // where finalizeGame would otherwise replace the standings beat
        // instantly. Anchored to the durable reveal time (not the deadline) so
        // a reveal delayed by a restart still gets its full pause.
        const crossesRound = isLast || (next != null && next.roundIndex !== slot.roundIndex);
        if (frontier.status === 'revealed') {
          // Money drop's reveal is a drop animation and put-in-order's is a
          // correct-sequence comparison — both need real screen time; every
          // other kind flows straight into the next question. Capped at one
          // base question window so compressed test tournaments stay compressed.
          const kind = await wlLiveEngineInternals.kindOf(frontier.question_id);
          const kindHoldMs = kind === 'money_drop'
            ? WL_MONEY_DROP_REVEAL_HOLD_MS
            : kind === 'put_in_order'
              ? WL_PUT_IN_ORDER_REVEAL_HOLD_MS
              : WL_STEP_REVEAL_HOLD_MS;
          const cappedKindHoldMs = Math.min(kindHoldMs, wlConfigFrom(t.config).question_time_ms);
          // A round boundary takes the LONGER of the breather and the kind's
          // own hold — put-in-order's comparison must not get cut to the
          // breather on the round's last question.
          const holdMs = crossesRound
            ? Math.max(WL_ROUND_BREATHER_MS, cappedKindHoldMs)
            : cappedKindHoldMs;
          const revealedAt = Number(frontier.revealed_at_ms ?? 0);
          if (holdMs > 0 && Number.isFinite(revealedAt) && revealedAt > 0
            && redisNow - revealedAt < holdMs) {
            return;
          }
        }
        if (isLast) {
          await finalizeGame(t, gameIndex, redisNow);
          return;
        }
        if (next) await wlLiveEngineInternals.appendDispatch(t.id, next, redisNow);
      }
      return;
    }
  },

  async adjudicateFinalStart(t, redisNow): Promise<void> {
    // The final is a PLAYED game (game index 3) among checked-in finalists;
    // dns_v1: no-shows are marked and, with fewer than two present, the
    // best-qualified finalist takes the walkover.
    const ranked = await sql<Array<{ user_id: string; final_checked_in_at: string | null }>>`
      SELECT e.user_id, e.final_checked_in_at::text
      FROM wl_entries e
      JOIN wl_game_results r
        ON r.tournament_id = e.tournament_id AND r.user_id = e.user_id
      WHERE e.tournament_id = ${t.id} AND e.state = 'finalist'
        AND r.game_index = (
          SELECT MAX(game_index) FROM wl_game_results g2
          WHERE g2.tournament_id = e.tournament_id AND g2.user_id = e.user_id
            AND g2.game_index <= 2
        )
      ORDER BY r.rank ASC
    `;
    const checkedIn = ranked.filter((r) => r.final_checked_in_at != null);
    if (checkedIn.length < 2) {
      await completeTournament(t.id, redisNow, checkedIn[0]?.user_id ?? null, false);
      return;
    }
    await sql.begin(async (tx) => {
      const txSql = tx as unknown as typeof sql;
      const moved = await txSql`
        UPDATE wl_tournaments SET status = 'final_live',
          stage = COALESCE(stage, '{}'::jsonb) || jsonb_build_object('current_game', ${WL_FINAL_GAME_INDEX}::int)
        WHERE id = ${t.id} AND status = 'final_checkin'
        RETURNING id
      `;
      if (moved.length === 0) return;
      const noShows = await txSql<{ user_id: string }[]>`
        UPDATE wl_entries SET state = 'no_show'
        WHERE tournament_id = ${t.id} AND state = 'finalist' AND final_checked_in_at IS NULL
        RETURNING user_id
      `;
      const ids = checkedIn.map((c) => c.user_id);
      await txSql`
        INSERT INTO wl_game_participants (tournament_id, game_index, user_id)
        SELECT ${t.id}, ${WL_FINAL_GAME_INDEX}, u FROM unnest(${sql.array(ids)}::uuid[]) AS t(u)
        ON CONFLICT DO NOTHING
      `;
      await wlEventsRepo.append(txSql, {
        tournamentId: t.id, type: 'phase',
        payload: {
          from: 'final_checkin', to: 'final_live', checked_in: checkedIn.length,
          evicted_user_ids: noShows.map((n) => n.user_id),
        },
        redisTimeMs: redisNow,
      });
    });
  },
};

/**
 * Award settlement shared by the played final and the dns_v1 walkover:
 * bands map to the HUMANS-ONLY ordering with the full account predicate
 * (bots, seed accounts and deleted accounts can never hold entitlements),
 * cascading past excluded placements. `ordering` rows come pre-ranked.
 */
async function writeAwards(
  db: typeof sql,
  tournamentId: string,
  ordering: Array<{ user_id: string; rank: number }>
): Promise<void> {
  if (ordering.length === 0) return;
  const ids = ordering.map((o) => o.user_id);
  const ranks = ordering.map((o) => o.rank);
  await db`
    INSERT INTO wl_awards (tournament_id, user_id, final_rank, band, prize_type)
    SELECT ${tournamentId}, h.user_id, h.rank,
           CASE h.human_rank WHEN 1 THEN 'champion' WHEN 2 THEN 'second'
                             WHEN 3 THEN 'third' ELSE 'finalist' END,
           CASE h.human_rank WHEN 1 THEN 'grand' WHEN 2 THEN 'runner_up'
                             WHEN 3 THEN 'third' ELSE 'participation' END
    FROM (
      SELECT o.u AS user_id, o.r AS rank,
             ROW_NUMBER() OVER (ORDER BY o.r ASC) AS human_rank
      FROM unnest(${db.array(ids)}::uuid[], ${db.array(ranks)}::int[]) AS o(u, r)
      JOIN users usr ON usr.id = o.u
        AND usr.is_ai = false AND usr.is_seed = false
        AND usr.is_deleted = false AND usr.deleted_at IS NULL
    ) h
    ON CONFLICT (tournament_id, user_id) DO NOTHING
  `;
}

export const WL_FINAL_GAME_INDEX = 3;

async function currentGameIndex(t: WlOrchestratorTournament): Promise<number> {
  if (t.status === 'final_live') return WL_FINAL_GAME_INDEX;
  const fromStage = Number((t.stage ?? {})['current_game']);
  if (Number.isFinite(fromStage)) return fromStage;
  const [row] = await sql<Array<{ g: number | null }>>`
    SELECT MAX(game_index)::int AS g FROM wl_game_participants
    WHERE tournament_id = ${t.id} AND game_index <= 2
  `;
  return row?.g ?? 0;
}

/**
 * End-of-game settlement for any game of the gauntlet or the final:
 *  - persists the full ranking (canonical comparator) as wl_game_results;
 *  - applies the cut per the frozen ladder: qualifier games advance the
 *    ladder count (survivors stay 'playing'; game 2's survivors become
 *    finalists), the final crowns the champion;
 *  - freezes the NEXT game's participants and enters the 2-minute break, or
 *    transitions to qualifier_done / completed;
 *  - the game_result event carries the eliminated ids so the deliverer can
 *    evict them from the live room.
 * All in ONE status-CAS-first transaction.
 */
async function finalizeGame(
  t: WlOrchestratorTournament,
  gameIndex: number,
  redisNow: number
): Promise<void> {
  const { wlLiveEngineInternals } = await import('./wl-live-engine.js');
  const board = await wlLiveEngineInternals.topBoard(t.id, gameIndex, Number.MAX_SAFE_INTEGER);
  if (board.length === 0) return;

  const cfgAll = (t.config ?? {}) as Record<string, unknown>;
  // single_game test shape: game 0 IS the final — crowns the champion and
  // completes the tournament straight from game_live.
  const singleGame = t.is_test === true && cfgAll['single_game'] === true;
  const isFinal = gameIndex === WL_FINAL_GAME_INDEX || (singleGame && gameIndex === 0);
  const ladder = (t.ladder ?? {}) as { advance?: number[] };
  const advanceCount = isFinal
    ? 0
    : Math.min(board.length, ladder.advance?.[gameIndex] ?? WL_FINALISTS);
  const isLastQualifierGame = !isFinal && gameIndex >= 2;
  let survivors = board.slice(0, advanceCount).map((b) => b.user_id);
  // Final seats prefer HUMANS (owner rule, 2026-08-02): roster bots keep the
  // qualifiers lively but only occupy final seats left over when fewer than
  // advanceCount humans survive to the cut. Earlier cuts stay purely
  // score-based; prizes are separately humans-only via the award firewall.
  if (isLastQualifierGame && board.length > advanceCount) {
    const aiRows = await sql<{ id: string }[]>`
      SELECT id FROM users
      WHERE id = ANY(${sql.array(board.map((b) => b.user_id))}::uuid[]) AND is_ai = true
    `;
    const aiIds = new Set(aiRows.map((r) => r.id));
    const humans = board.filter((b) => !aiIds.has(b.user_id)).map((b) => b.user_id);
    const bots = board.filter((b) => aiIds.has(b.user_id)).map((b) => b.user_id);
    survivors = [...humans.slice(0, advanceCount), ...bots].slice(0, advanceCount);
  }
  const survivorSet = new Set(survivors);
  const eliminated = isFinal ? [] : board.filter((b) => !survivorSet.has(b.user_id)).map((b) => b.user_id);
  const cfg = (t.config ?? {}) as Record<string, unknown>;
  const breakMs = Number(cfg['break_ms']) >= 0 && Number.isFinite(Number(cfg['break_ms']))
    ? Number(cfg['break_ms']) : 120_000;

  const toStatus = isFinal ? 'completed' : (isLastQualifierGame ? 'qualifier_done' : 'break');
  const fromStatus = gameIndex === WL_FINAL_GAME_INDEX ? 'final_live' : 'game_live';

  await sql.begin(async (tx) => {
    const txSql = tx as unknown as typeof sql;
    const moved = await txSql`
      UPDATE wl_tournaments SET status = ${toStatus},
        champion_user_id = CASE WHEN ${isFinal} THEN ${board[0]?.user_id ?? null}::uuid ELSE champion_user_id END,
        final_played = CASE WHEN ${isFinal} THEN true ELSE final_played END,
        stage = COALESCE(stage, '{}'::jsonb) || ${sql.json({
          current_game: isFinal || isLastQualifierGame ? gameIndex : gameIndex + 1,
          break_until_ms: toStatus === 'break' ? redisNow + breakMs : null,
        } as never)}
      WHERE id = ${t.id} AND status = ${fromStatus}
      RETURNING id
    `;
    if (moved.length === 0) return;

    {
      const userIds = board.map((b) => b.user_id);
      const scores = board.map((b) => b.points);
      const times = board.map((b) => b.time_ms_total);
      const ranks = board.map((b) => b.rank);
      // advanced = seat membership, not rank: the human-priority final cut
      // can advance a lower-ranked human over a higher-ranked bot.
      const advancedFlags = board.map((b) => survivorSet.has(b.user_id));
      await txSql`
        INSERT INTO wl_game_results (
          tournament_id, game_index, user_id, score, time_ms_total, rank, advanced
        )
        SELECT ${t.id}, ${gameIndex}, u, s, tm, r, adv
        FROM unnest(
          ${sql.array(userIds)}::uuid[], ${sql.array(scores)}::int[],
          ${sql.array(times)}::bigint[], ${sql.array(ranks)}::int[],
          ${sql.array(advancedFlags)}::boolean[]
        ) AS t(u, s, tm, r, adv)
        ON CONFLICT (tournament_id, game_index, user_id) DO NOTHING
      `;
    }

    if (isFinal) {
      const ranksArr = board.map((b) => b.rank);
      const idsArr = board.map((b) => b.user_id);
      await txSql`
        UPDATE wl_entries e SET final_rank = t.r,
          state = CASE WHEN t.r = 1 THEN 'champion' ELSE e.state END
        FROM unnest(${sql.array(idsArr)}::uuid[], ${sql.array(ranksArr)}::int[]) AS t(u, r)
        WHERE e.tournament_id = ${t.id} AND e.user_id = t.u
      `;
      await writeAwards(txSql, t.id,
        board.map((b) => ({ user_id: b.user_id, rank: b.rank })));
    } else {
      if (isLastQualifierGame && survivors.length > 0) {
        await txSql`
          UPDATE wl_entries SET state = 'finalist'
          WHERE tournament_id = ${t.id} AND user_id = ANY(${sql.array(survivors)}::uuid[])
        `;
      }
      if (eliminated.length > 0) {
        await txSql`
          UPDATE wl_entries SET state = 'eliminated', eliminated_game = ${gameIndex}
          WHERE tournament_id = ${t.id} AND user_id = ANY(${sql.array(eliminated)}::uuid[])
        `;
      }
      if (!isLastQualifierGame && survivors.length > 0) {
        // Freeze the next game's field NOW so the break→game_live CAS is
        // a pure status flip.
        await txSql`
          INSERT INTO wl_game_participants (tournament_id, game_index, user_id)
          SELECT ${t.id}, ${gameIndex + 1}, u FROM unnest(${sql.array(survivors)}::uuid[]) AS t(u)
          ON CONFLICT DO NOTHING
        `;
      }
    }

    await wlEventsRepo.append(txSql, {
      tournamentId: t.id, type: 'phase',
      payload: { from: fromStatus, to: toStatus, game_index: gameIndex },
      redisTimeMs: redisNow,
    });
    await wlEventsRepo.append(txSql, {
      tournamentId: t.id,
      type: isFinal ? 'final_result' : 'game_result',
      payload: {
        game_index: gameIndex,
        board: board.slice(0, WL_FINALISTS),
        field: board.length,
        advanced: advanceCount,
        // The final ends the tournament: EVERYONE leaves the live room
        // (non-champions and champion alike — the room is over).
        eliminated_user_ids: isFinal ? board.map((b) => b.user_id) : eliminated,
        ...(isFinal ? { champion_user_id: board[0]?.user_id ?? null, final_played: true } : {}),
      },
      redisTimeMs: redisNow,
    });
  });
  logger.info(
    { tournamentId: t.id, gameIndex, field: board.length, advanced: advanceCount, toStatus },
    'WL game finalized'
  );
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

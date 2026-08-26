import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import postgres from 'postgres';
import '../setup.js';

process.env.FOOTBALL_GRID_COINS_ENABLED = 'true';
process.env.FOOTBALL_GRID_POINTS_ENABLED = 'true';
process.env.FOOTBALL_GRID_XP_ENABLED = 'true';
process.env.FOOTBALL_GRID_RISK_HASH_SECRET = 'integration-football-grid-risk-secret-0001';

const DB_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
const REQUIRE_DB = process.env.FOOTBALL_GRID_REQUIRE_DB === 'true';
const RELEASE_ID = '00000000-0000-4000-8000-000000990001';
const CORRECTION_RELEASE_ID = '00000000-0000-4000-8000-000000990003';
const BOARD_ID = '00000000-0000-4000-8000-000000993001';
const CORRECTION_ROW_CRITERION_ID = '00000000-0000-4000-8000-000000991201';
const CORRECTION_COLUMN_CRITERION_ID = '00000000-0000-4000-8000-000000991202';
const OUT_OF_BOARD_PLAYER_ID = '00000000-0000-4000-8000-000000992999';
const CRITERION_IDS = Array.from(
  { length: 6 },
  (_, index) => `00000000-0000-4000-8000-${String(991001 + index).padStart(12, '0')}`,
);
const PLAYER_IDS = Array.from(
  { length: 9 },
  (_, index) => `00000000-0000-4000-8000-${String(992001 + index).padStart(12, '0')}`,
);

let db: postgres.Sql;
let dbAvailable = false;
let setupError: unknown = null;
let footballGridRepo: typeof import('../../src/modules/football-grid/football-grid.repo.js').footballGridRepo;
let footballGridService: typeof import('../../src/modules/football-grid/football-grid.service.js').footballGridService;
let footballGridBotService: typeof import('../../src/modules/football-grid/football-grid-bot.service.js').footballGridBotService;
let footballGridBotGovernorService: typeof import('../../src/modules/football-grid/football-grid-bot-governor.service.js').footballGridBotGovernorService;
let footballGridSettlementService: typeof import('../../src/modules/football-grid/football-grid-settlement.service.js').footballGridSettlementService;
let footballGridAdminService: typeof import('../../src/modules/football-grid/football-grid-admin.service.js').footballGridAdminService;
let footballGridRealtimeService: typeof import('../../src/realtime/services/football-grid-realtime.service.js').footballGridRealtimeService;
let runtimeConfig: typeof import('../../src/core/config.js').config;
let lobbiesRepo: typeof import('../../src/modules/lobbies/lobbies.repo.js').lobbiesRepo;
let rebuildCacheFromDB: typeof import('../../src/realtime/match-cache.js').rebuildCacheFromDB;
let buildFinalResultsPayload: typeof import('../../src/realtime/services/match-final-results.service.js').buildFinalResultsPayload;
const runtimeUserIds: string[] = [];
const runtimeMatchIds: string[] = [];
const runtimeSeriesIds: string[] = [];
const runtimeLobbyIds: string[] = [];
const runtimeGovernorTiers = new Set<string>();

function hasRuntimeDb(context: TestContext): boolean {
  if (dbAvailable) return true;
  context.skip(setupError instanceof Error ? setupError.message : 'local integration database unavailable');
  return false;
}

async function seedImmutableContent(): Promise<void> {
  await db`
    INSERT INTO football_players (id, name, display_name, data_quality_status)
    VALUES (
      ${OUT_OF_BOARD_PLAYER_ID}, 'Grid Outsider',
      ${{ en: 'Grid Outsider', ka: 'გრიდ აუტსაიდერი' }}, 'usable'
    ) ON CONFLICT (id) DO NOTHING
  `;
  for (let index = 0; index < PLAYER_IDS.length; index += 1) {
    await db`
      INSERT INTO football_players (id, name, display_name, data_quality_status)
      VALUES (${PLAYER_IDS[index]}, ${`Grid Player ${index + 1}`}, ${{ en: `Grid Player ${index + 1}`, ka: `გრიდ მოთამაშე ${index + 1}` }}, 'usable')
      ON CONFLICT (id) DO NOTHING
    `;
  }
  await db`
    INSERT INTO football_grid_content_releases (
      id, version, status, relationship_snapshot, alias_version,
      resolver_policy_version, manifest_checksum, approved_by,
      approved_at, published_at
    ) VALUES (
      ${RELEASE_ID}, 990001, 'published', '{}', 1, 1,
      '9999999999999999999999999999999999999999999999999999999999990001',
      'integration-test', now(), now()
    ) ON CONFLICT (id) DO NOTHING
  `;
  await db`
    INSERT INTO football_grid_content_releases (
      id, version, status, relationship_snapshot, alias_version,
      resolver_policy_version, manifest_checksum, approved_by,
      approved_at, published_at
    ) VALUES (
      ${CORRECTION_RELEASE_ID}, 990003, 'published', '{}', 1, 1,
      '9999999999999999999999999999999999999999999999999999999999990003',
      'integration-test', now(), now()
    ) ON CONFLICT (id) DO NOTHING
  `;
  for (let index = 0; index < CRITERION_IDS.length; index += 1) {
    await db`
      INSERT INTO football_grid_criteria (
        id, release_id, criterion_key, family, subtype, label_en,
        label_ka, difficulty, familiarity_score
      ) VALUES (
        ${CRITERION_IDS[index]}, ${RELEASE_ID}, ${`integration-${index + 1}`},
        ${index < 3 ? 'club' : 'country'}, 'integration',
        ${`Criterion ${index + 1}`}, ${`კრიტერიუმი ${index + 1}`}, 'easy', 100
      ) ON CONFLICT (id) DO NOTHING
    `;
  }
  await db`
    INSERT INTO football_grid_criteria (
      id, release_id, criterion_key, family, subtype, label_en,
      label_ka, difficulty, familiarity_score
    ) VALUES
      (
        ${CORRECTION_ROW_CRITERION_ID}, ${CORRECTION_RELEASE_ID}, 'integration-3',
        'club', 'integration-correction', 'Corrected row', 'შესწორებული მწკრივი', 'easy', 100
      ),
      (
        ${CORRECTION_COLUMN_CRITERION_ID}, ${CORRECTION_RELEASE_ID}, 'integration-6',
        'country', 'integration-correction', 'Corrected column', 'შესწორებული სვეტი', 'easy', 100
      )
    ON CONFLICT (id) DO NOTHING
  `;
  await db`
    INSERT INTO football_grid_criterion_memberships (
      release_id, criterion_id, football_player_id, relationship_subtype,
      verified_by, reviewed_at
    ) VALUES
      (
        ${CORRECTION_RELEASE_ID}, ${CORRECTION_ROW_CRITERION_ID}, ${OUT_OF_BOARD_PLAYER_ID},
        'reviewed_correction', 'integration-test', now()
      ),
      (
        ${CORRECTION_RELEASE_ID}, ${CORRECTION_COLUMN_CRITERION_ID}, ${OUT_OF_BOARD_PLAYER_ID},
        'reviewed_correction', 'integration-test', now()
      )
    ON CONFLICT DO NOTHING
  `;
  await db`
    INSERT INTO football_grid_player_aliases (
      release_id, football_player_id, alias, normalized_alias, locale,
      alias_type, acceptance_policy, reviewed_by, reviewed_at
    ) VALUES (
      ${CORRECTION_RELEASE_ID}, ${OUT_OF_BOARD_PLAYER_ID}, 'Definitely Missing 0',
      'definitely missing 0', 'en', 'full_name', 'unique_only', 'integration-test', now()
    ) ON CONFLICT DO NOTHING
  `;
  await db`
    INSERT INTO football_grid_boards (
      id, release_id, version, row_criteria, column_criteria,
      difficulty, familiarity_score, canonical_checksum, approved_by, published_at
    ) VALUES (
      ${BOARD_ID}, ${RELEASE_ID}, 1, ${CRITERION_IDS.slice(0, 3)}, ${CRITERION_IDS.slice(3)},
      'easy', 100,
      '9999999999999999999999999999999999999999999999999999999999993001',
      'integration-test', now()
    ) ON CONFLICT (id) DO NOTHING
  `;
  for (let playerIndex = 0; playerIndex < PLAYER_IDS.length; playerIndex += 1) {
    const playerId = PLAYER_IDS[playerIndex];
    await db`
      INSERT INTO football_grid_player_aliases (
        release_id, football_player_id, alias, normalized_alias, locale,
        alias_type, acceptance_policy, reviewed_by, reviewed_at
      ) VALUES (
        ${RELEASE_ID}, ${playerId}, ${`Grid Player ${playerIndex + 1}`},
        ${`grid player ${playerIndex + 1}`}, 'en', 'full_name', 'exact',
        'integration-test', now()
      ) ON CONFLICT DO NOTHING
    `;
    await db`
      INSERT INTO football_grid_player_aliases (
        release_id, football_player_id, alias, normalized_alias, locale,
        alias_type, acceptance_policy, reviewed_by, reviewed_at
      ) VALUES (
        ${RELEASE_ID}, ${playerId}, ${`გრიდ მოთამაშე ${playerIndex + 1}`},
        ${`გრიდ მოთამაშე ${playerIndex + 1}`}, 'ka', 'georgian', 'exact',
        'integration-test', now()
      ) ON CONFLICT DO NOTHING
    `;
    for (let cellIndex = 0; cellIndex < 9; cellIndex += 1) {
      await db`
        INSERT INTO football_grid_board_answers (
          board_id, release_id, cell_index, football_player_id,
          recognizable_rank, is_sample
        ) VALUES (
          ${BOARD_ID}, ${RELEASE_ID}, ${cellIndex}, ${playerId},
          ${playerIndex + 1}, ${playerIndex < 2}
        ) ON CONFLICT DO NOTHING
      `;
    }
  }
}

async function createUsers(): Promise<[string, string]> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const rows = await db<{ id: string }[]>`
    INSERT INTO users (nickname, onboarding_complete)
    VALUES (${`grid-a-${stamp}`}, true), (${`grid-b-${stamp}`}, true)
    RETURNING id
  `;
  runtimeUserIds.push(...rows.map((row) => row.id));
  return [rows[0].id, rows[1].id];
}

async function createReadyTurn(
  origin: 'random' | 'private',
  seriesId?: string,
  existingPlayers?: [string, string],
  lobbyId?: string,
): Promise<{
  matchId: string;
  playerA: string;
  playerB: string;
  stateVersion: number;
}> {
  const [playerA, playerB] = existingPlayers ?? await createUsers();
  const pairingToken = randomUUID();
  await footballGridRepo.createPairing({
    pairingToken,
    searchAId: randomUUID(),
    searchBId: randomUUID(),
    userAId: playerA,
    userBId: playerB,
    opponentType: 'human',
  });
  let state = (await footballGridService.createMatch({
    pairingToken,
    lobbyId,
    origin,
    seriesId,
    players: [
      { userId: playerA, seat: 1 },
      { userId: playerB, seat: 2 },
    ],
    openerUserId: playerA,
  })).state;
  runtimeMatchIds.push(state.matchId);
  await Promise.all([
    footballGridRepo.recordRewardRiskObservation({
      matchId: state.matchId,
      userId: playerA,
      deviceHash: `device:${playerA}`,
      networkHash: `network:${playerA}`,
      source: 'integration-test',
    }),
    footballGridRepo.recordRewardRiskObservation({
      matchId: state.matchId,
      userId: playerB,
      deviceHash: `device:${playerB}`,
      networkHash: `network:${playerB}`,
      source: 'integration-test',
    }),
  ]);
  state = await footballGridService.acknowledgeHandoff({
    matchId: state.matchId,
    userId: playerA,
    expectedStateVersion: state.stateVersion,
  });
  state = await footballGridService.acknowledgeHandoff({
    matchId: state.matchId,
    userId: playerB,
    expectedStateVersion: state.stateVersion,
  });
  state = await footballGridService.markReady({
    matchId: state.matchId,
    userId: playerA,
    commandId: randomUUID(),
    expectedStateVersion: state.stateVersion,
  });
  state = await footballGridService.markReady({
    matchId: state.matchId,
    userId: playerB,
    commandId: randomUUID(),
    expectedStateVersion: state.stateVersion,
  });
  const readyRows = await db<Array<{ ready_command_id: string | null }>>`
    SELECT ready_command_id FROM football_grid_participants
     WHERE match_id = ${state.matchId} ORDER BY seat
  `;
  expect(readyRows).toHaveLength(2);
  expect(readyRows.every((row) => row.ready_command_id !== null)).toBe(true);
  await db`UPDATE football_grid_matches SET phase_deadline_at = now() - interval '1 second' WHERE match_id = ${state.matchId}`;
  state = (await footballGridService.handlePhaseDeadline(state.matchId, state.stateVersion, true)).state;
  return { matchId: state.matchId, playerA, playerB, stateVersion: state.stateVersion };
}

async function seedBotGovernorTier(input: {
  tier: string;
  adjustment?: number;
  scoreEma?: number | null;
  observationCount?: number;
  observationsAtAdjustment?: number;
  adjustmentUpdatedAt?: Date | null;
}): Promise<void> {
  runtimeGovernorTiers.add(input.tier);
  await db`
    INSERT INTO football_grid_bot_governor_state (
      bot_model_version, bot_config_version, bot_tier, strength_adjustment,
      score_ema, observation_count, observations_at_adjustment,
      adjustment_updated_at
    ) VALUES (
      2, 1, ${input.tier}, ${input.adjustment ?? 0},
      ${input.scoreEma ?? null}, ${input.observationCount ?? 0},
      ${input.observationsAtAdjustment ?? 0}, ${input.adjustmentUpdatedAt ?? null}
    )
    ON CONFLICT (bot_model_version, bot_config_version, bot_tier)
    DO UPDATE SET
      strength_adjustment = EXCLUDED.strength_adjustment,
      score_ema = EXCLUDED.score_ema,
      observation_count = EXCLUDED.observation_count,
      observations_at_adjustment = EXCLUDED.observations_at_adjustment,
      adjustment_updated_at = EXCLUDED.adjustment_updated_at,
      updated_at = now()
  `;
}

async function createV2BotMatch(tier: string, opener: 'human' | 'bot' = 'bot'): Promise<{
  matchId: string;
  humanUserId: string;
  botUserId: string;
  stateVersion: number;
}> {
  const [humanUserId, botUserId] = await createUsers();
  const pairingToken = randomUUID();
  await footballGridRepo.createPairing({
    pairingToken,
    searchAId: randomUUID(),
    userAId: humanUserId,
    userBId: botUserId,
    opponentType: 'bot',
  });
  const state = (await footballGridService.createMatch({
    pairingToken,
    origin: 'random',
    players: [
      { userId: humanUserId, seat: 1 },
      { userId: botUserId, seat: 2, isBot: true },
    ],
    openerUserId: opener === 'bot' ? botUserId : humanUserId,
    botReservationFence: 1,
    botRp: 1_500,
    botTier: tier,
    botModelVersion: 2,
    botConfigVersion: 1,
    botRngSeed: 123_456,
  })).state;
  runtimeMatchIds.push(state.matchId);
  return { matchId: state.matchId, humanUserId, botUserId, stateVersion: state.stateVersion };
}

async function forceCompetitiveBotWin(match: {
  matchId: string;
  botUserId: string;
}): Promise<void> {
  const rows = await db<Array<{ state_version: number; reward_schedule_version: number }>>`
    SELECT state_version, reward_schedule_version
      FROM football_grid_matches WHERE match_id = ${match.matchId}
  `;
  const terminalVersion = rows[0].state_version + 1;
  await db`
    UPDATE football_grid_matches
       SET status = 'completed', phase = 'terminal', winner_user_id = ${match.botUserId},
           current_player_user_id = null, completion_reason = 'line',
           state_version = ${terminalVersion}, ended_at = now(), updated_at = now()
     WHERE match_id = ${match.matchId}
  `;
  await db`
    UPDATE matches
       SET status = 'completed', winner_user_id = ${match.botUserId}, ended_at = now(), updated_at = now()
     WHERE id = ${match.matchId}
  `;
  await db`
    INSERT INTO football_grid_settlement_outbox (
      match_id, terminal_state_version, reward_schedule_version, payload
    ) VALUES (
      ${match.matchId}, ${terminalVersion}, ${rows[0].reward_schedule_version},
      ${{ winnerUserId: match.botUserId, reason: 'line' }}
    ) ON CONFLICT (match_id, terminal_state_version) DO NOTHING
  `;
}

async function playWinningLine(
  origin: 'random' | 'private',
  seriesId?: string,
  existingPlayers?: [string, string],
  lobbyId?: string,
) {
  const runtime = await createReadyTurn(origin, seriesId, existingPlayers, lobbyId);
  let version = runtime.stateVersion;
  let firstCommandId = '';
  for (let index = 0; index < 3; index += 1) {
    const commandId = randomUUID();
    if (index === 0) firstCommandId = commandId;
    const answer = await footballGridService.submitAnswer({
      matchId: runtime.matchId,
      userId: runtime.playerA,
      commandId,
      expectedStateVersion: version,
      cellIndex: index,
      text: index === 1 ? 'გრიდ მოთამაშე 2' : `Grid Player ${index + 1}`,
      locale: index === 1 ? 'ka' : 'en',
    });
    expect(answer.outcome).toBe('correct');
    version = answer.state.stateVersion;
    if (index === 0) {
      const duplicate = await footballGridService.submitAnswer({
        matchId: runtime.matchId,
        userId: runtime.playerA,
        commandId: firstCommandId,
        expectedStateVersion: runtime.stateVersion,
        cellIndex: 0,
        text: 'Grid Player 1',
        locale: 'en',
      });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.outcome).toBe('correct');
    }
    if (index < 2) {
      const wrong = await footballGridService.submitAnswer({
        matchId: runtime.matchId,
        userId: runtime.playerB,
        commandId: randomUUID(),
        expectedStateVersion: version,
        cellIndex: 8 - index,
        text: `Definitely Missing ${index}`,
        locale: 'en',
      });
      expect(wrong.outcome).toBe('wrong');
      version = wrong.state.stateVersion;
      expect(wrong.attemptId).toBeTruthy();
      if (index === 0) {
        const reportId = await footballGridService.reportMissingAnswer(wrong.attemptId!, runtime.playerB);
        expect(reportId).toMatch(/^[0-9a-f-]{36}$/);
      }
    }
  }
  const state = await footballGridService.getState(runtime.matchId, runtime.playerA);
  expect(state.phase).toBe('terminal');
  expect(state.winnerUserId).toBe(runtime.playerA);
  expect(state.claims.map((claim) => claim.cellIndex)).toEqual([0, 1, 2]);
  await db`UPDATE football_grid_matches SET created_at = now() - interval '60 seconds' WHERE match_id = ${runtime.matchId}`;
  return { ...runtime, state };
}

beforeAll(async () => {
  let connected = false;
  try {
    db = postgres(DB_URL, { max: 4, connect_timeout: 5 });
    await db`SELECT 1`;
    connected = true;
    const tables = await db<{ found: boolean }[]>`
      SELECT to_regclass('public.football_grid_matches') IS NOT NULL AS found
    `;
    if (!tables[0]?.found) throw new Error('football grid migration is not installed');
    await seedImmutableContent();
    ({ footballGridRepo } = await import('../../src/modules/football-grid/football-grid.repo.js'));
    ({ footballGridService } = await import('../../src/modules/football-grid/football-grid.service.js'));
    ({ footballGridBotService } = await import('../../src/modules/football-grid/football-grid-bot.service.js'));
    ({ footballGridBotGovernorService } = await import('../../src/modules/football-grid/football-grid-bot-governor.service.js'));
    ({ footballGridSettlementService } = await import('../../src/modules/football-grid/football-grid-settlement.service.js'));
    ({ footballGridAdminService } = await import('../../src/modules/football-grid/football-grid-admin.service.js'));
    ({ footballGridRealtimeService } = await import('../../src/realtime/services/football-grid-realtime.service.js'));
    ({ config: runtimeConfig } = await import('../../src/core/config.js'));
    ({ lobbiesRepo } = await import('../../src/modules/lobbies/lobbies.repo.js'));
    ({ rebuildCacheFromDB } = await import('../../src/realtime/match-cache.js'));
    ({ buildFinalResultsPayload } = await import('../../src/realtime/services/match-final-results.service.js'));
    dbAvailable = true;
  } catch (error) {
    setupError = error;
    // Only an unavailable optional local database may skip. Once connected,
    // missing migrations, schema defects, seed failures, or import failures are
    // real regressions and must fail in every environment. The repository's
    // default CI has no database, so only the explicit opt-in requires one.
    if (REQUIRE_DB || connected) throw error;
    console.warn(`\nSkipping Football Grid runtime integration: ${error instanceof Error ? error.message : String(error)}\n`);
  }
});

afterEach(async () => {
  if (!dbAvailable || runtimeUserIds.length === 0) return;
  await db`DELETE FROM football_grid_pairings WHERE user_a_id = ANY(${runtimeUserIds}::uuid[]) OR user_b_id = ANY(${runtimeUserIds}::uuid[])`;
  await db`DELETE FROM football_grid_missing_answer_reports WHERE reporting_user_id = ANY(${runtimeUserIds}::uuid[])`;
  if (runtimeMatchIds.length > 0) {
    await db`
      DELETE FROM football_grid_coin_event_audit a
       USING football_grid_coin_events e
       WHERE a.coin_event_id = e.id AND e.match_id = ANY(${runtimeMatchIds}::uuid[])
    `;
    await db`
      DELETE FROM football_grid_point_event_audit a
       USING football_grid_point_events e
       WHERE a.point_event_id = e.id AND e.match_id = ANY(${runtimeMatchIds}::uuid[])
    `;
    await db`DELETE FROM matches WHERE id = ANY(${runtimeMatchIds}::uuid[])`;
  }
  if (runtimeSeriesIds.length > 0) {
    await db`DELETE FROM football_grid_series WHERE id = ANY(${runtimeSeriesIds}::uuid[])`;
  }
  if (runtimeLobbyIds.length > 0) {
    await db`DELETE FROM lobbies WHERE id = ANY(${runtimeLobbyIds}::uuid[])`;
  }
  await db`
    DELETE FROM audit_logs
     WHERE user_id = ANY(${runtimeUserIds}::uuid[])
       AND entity_type IN ('football_grid_board', 'football_grid_release')
  `;
  await db`DELETE FROM users WHERE id = ANY(${runtimeUserIds}::uuid[])`;
  if (runtimeGovernorTiers.size > 0) {
    await db`
      DELETE FROM football_grid_bot_governor_state
       WHERE bot_model_version = 2 AND bot_config_version = 1
         AND bot_tier = ANY(${[...runtimeGovernorTiers]}::text[])
    `;
  }
  runtimeMatchIds.length = 0;
  runtimeSeriesIds.length = 0;
  runtimeLobbyIds.length = 0;
  runtimeUserIds.length = 0;
  runtimeGovernorTiers.clear();
});

afterAll(async () => {
  if (db) await db.end();
});

describe('Football Grid authoritative runtime + settlement', { timeout: 15_000 }, () => {
  it('pins v2 strength transactionally and records private action policy provenance', async (context) => {
    if (!hasRuntimeDb(context)) return;
    await seedBotGovernorTier({ tier: 'World-Class', adjustment: -0.075 });
    const match = await createV2BotMatch('World-Class');
    const runtime = await footballGridRepo.getBotRuntime(match.matchId);
    expect(runtime).toMatchObject({
      botUserId: match.botUserId,
      botTier: 'World-Class',
      modelVersion: 2,
      configVersion: 1,
      strengthAdjustment: -0.075,
    });

    let state = await footballGridService.acknowledgeHandoff({
      matchId: match.matchId,
      userId: match.humanUserId,
      expectedStateVersion: match.stateVersion,
    });
    state = await footballGridService.markReady({
      matchId: match.matchId,
      userId: match.humanUserId,
      commandId: randomUUID(),
      expectedStateVersion: state.stateVersion,
    });
    await db`UPDATE football_grid_matches SET phase_deadline_at = now() - interval '1 second' WHERE match_id = ${match.matchId}`;
    state = (await footballGridService.handlePhaseDeadline(match.matchId, state.stateVersion, true)).state;
    expect(state.currentPlayerUserId).toBe(match.botUserId);
    const schedule = await footballGridBotService.getSchedule(match.matchId, state);
    expect(schedule?.delayMs).toBeGreaterThanOrEqual(5_000);
    expect(schedule?.delayMs).toBeLessThanOrEqual(12_000);
    const turn = await footballGridBotService.performTurn({
      matchId: match.matchId,
      expectedStateVersion: schedule!.expectedStateVersion,
      turnNumber: schedule!.turnNumber,
    });
    expect(turn.changed).toBe(true);

    const audits = await db<Array<{
      candidate_count: number;
      recognizable_pool_size: number;
      base_accuracy: string;
      effective_accuracy: string;
      pinned_strength_adjustment: string;
    }>>`
      SELECT candidate_count, recognizable_pool_size, base_accuracy,
             effective_accuracy, pinned_strength_adjustment
        FROM football_grid_bot_action_audits
       WHERE match_id = ${match.matchId}
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0].candidate_count).toBe(9);
    expect(audits[0].recognizable_pool_size).toBe(5);
    expect(Number(audits[0].base_accuracy)).toBe(0.74);
    expect(Number(audits[0].effective_accuracy)).toBeCloseTo((0.74 - 0.075) * 0.85, 6);
    expect(Number(audits[0].pinned_strength_adjustment)).toBe(-0.075);
  });

  it('folds concurrent same-tier settlements once each and ignores replays', async (context) => {
    if (!hasRuntimeDb(context)) return;
    await seedBotGovernorTier({ tier: 'Captain' });
    const first = await createV2BotMatch('Captain');
    const second = await createV2BotMatch('Captain');
    await Promise.all([forceCompetitiveBotWin(first), forceCompetitiveBotWin(second)]);

    await Promise.all([
      footballGridSettlementService.settleMatch(first.matchId),
      footballGridSettlementService.settleMatch(second.matchId),
    ]);
    const beforeGovernor = await db<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM football_grid_bot_governor_observations
       WHERE match_id IN (${first.matchId}, ${second.matchId})
    `;
    expect(beforeGovernor[0].count).toBe(0);
    await Promise.all([
      footballGridBotGovernorService.observeCompletedMatch(first.matchId),
      footballGridBotGovernorService.observeCompletedMatch(second.matchId),
    ]);
    await Promise.all([
      footballGridBotGovernorService.observeCompletedMatch(first.matchId),
      footballGridBotGovernorService.observeCompletedMatch(second.matchId),
    ]);

    const governor = await db<Array<{
      observation_count: number;
      score_ema: string;
      strength_adjustment: string;
    }>>`
      SELECT observation_count, score_ema, strength_adjustment
        FROM football_grid_bot_governor_state
       WHERE bot_model_version = 2 AND bot_config_version = 1 AND bot_tier = 'Captain'
    `;
    const observations = await db<Array<{ count: number }>>`
      SELECT count(*)::int AS count
        FROM football_grid_bot_governor_observations
       WHERE match_id IN (${first.matchId}, ${second.matchId})
    `;
    expect(governor[0].observation_count).toBe(2);
    expect(Number(governor[0].score_ema)).toBe(1);
    expect(Number(governor[0].strength_adjustment)).toBe(0);
    expect(observations[0].count).toBe(2);
  });

  it('persists lifecycle, bilingual answers, idempotent commands, claims, reports, and random rewards', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    const rewards = await footballGridSettlementService.settleMatch(match.matchId);
    expect(rewards.get(match.playerA)).toMatchObject({ xp: 70, coins: 700, tp: 50, eligibilityReason: 'eligible' });
    expect(rewards.get(match.playerB)).toMatchObject({ xp: 50, coins: 250, tp: 10, eligibilityReason: 'eligible' });
    const before = await db<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${match.playerA}`;
    const replayed = await footballGridSettlementService.settleMatch(match.matchId);
    const after = await db<{ coins: number }[]>`SELECT coins FROM users WHERE id = ${match.playerA}`;
    expect(replayed.get(match.playerA)?.coins).toBe(700);
    expect(replayed.get(match.playerA)?.tp).toBe(50);
    expect(after[0].coins).toBe(before[0].coins);
    const base = await db<{ game_variant: string; status: string; winner_user_id: string; settled: boolean }[]>`
      SELECT game_variant, status, winner_user_id,
             state_payload @> '{"footballGridRewardsSettled":true}'::jsonb AS settled
        FROM matches WHERE id = ${match.matchId}
    `;
    expect(base[0]).toMatchObject({
      game_variant: 'football_grid',
      status: 'completed',
      winner_user_id: match.playerA,
      settled: true,
    });
    expect(await rebuildCacheFromDB(match.matchId)).toBeNull();
    expect(await buildFinalResultsPayload(match.matchId, 1)).toBeNull();
  });

  it('awards XP but no coins for a private friend match', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('private');
    const rewards = await footballGridSettlementService.settleMatch(match.matchId);
    expect(rewards.get(match.playerA)).toMatchObject({
      xp: 70,
      coins: 0,
      tp: 0,
      coinEligibilityReason: 'friend_match_no_coins',
      tpEligibilityReason: 'friend_match_no_points',
    });
    expect(rewards.get(match.playerB)).toMatchObject({
      xp: 50,
      coins: 0,
      tp: 0,
      coinEligibilityReason: 'friend_match_no_coins',
      tpEligibilityReason: 'friend_match_no_points',
    });
  });

  it('keeps TP progressing when coin payouts are disabled', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    const before = await db<Array<{ tic_tac_toe_points: number }>>`
      SELECT tic_tac_toe_points FROM users WHERE id = ${match.playerA}
    `;
    runtimeConfig.FOOTBALL_GRID_COINS_ENABLED = false;
    try {
      const rewards = await footballGridSettlementService.settleMatch(match.matchId);
      expect(rewards.get(match.playerA)).toMatchObject({
        coins: 0,
        tp: 50,
        coinEligibilityReason: 'coins_disabled',
        tpEligibilityReason: 'eligible',
      });
    } finally {
      runtimeConfig.FOOTBALL_GRID_COINS_ENABLED = true;
    }
    const after = await db<Array<{ tic_tac_toe_points: number }>>`
      SELECT tic_tac_toe_points FROM users WHERE id = ${match.playerA}
    `;
    expect(after[0].tic_tac_toe_points).toBe(before[0].tic_tac_toe_points + 50);
  });

  it('counts TP-only matches toward the reward-velocity risk hold', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [anchor] = await createUsers();
    runtimeConfig.FOOTBALL_GRID_COINS_ENABLED = false;
    try {
      for (let index = 0; index < 4; index += 1) {
        const [, opponent] = await createUsers();
        const prior = await playWinningLine('random', undefined, [anchor, opponent]);
        expect((await footballGridSettlementService.settleMatch(prior.matchId)).get(anchor)).toMatchObject({
          tp: 50,
          coinEligibilityReason: 'coins_disabled',
          tpEligibilityReason: 'eligible',
        });
      }
      const [, finalOpponent] = await createUsers();
      const heldMatch = await playWinningLine('random', undefined, [anchor, finalOpponent]);
      expect((await footballGridSettlementService.settleMatch(heldMatch.matchId)).get(anchor)).toMatchObject({
        coins: 0,
        tp: 0,
        coinEligibilityReason: 'coins_disabled',
        tpEligibilityReason: 'risk_hold:reward_velocity',
      });
      const [held] = await db<Array<{ status: string }>>`
        SELECT status FROM football_grid_point_events
         WHERE match_id = ${heldMatch.matchId} AND user_id = ${anchor}
      `;
      expect(held.status).toBe('held');
    } finally {
      runtimeConfig.FOOTBALL_GRID_COINS_ENABLED = true;
    }
  });

  it('replays a no-contest TP verdict without changing its reason', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [playerA, playerB] = await createUsers();
    const pairingToken = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken,
      searchAId: randomUUID(),
      searchBId: randomUUID(),
      userAId: playerA,
      userBId: playerB,
      opponentType: 'human',
    });
    const state = (await footballGridService.createMatch({
      pairingToken,
      origin: 'random',
      players: [{ userId: playerA, seat: 1 }, { userId: playerB, seat: 2 }],
      openerUserId: playerA,
    })).state;
    runtimeMatchIds.push(state.matchId);
    await db`
      UPDATE football_grid_matches
         SET phase_deadline_at = now() - interval '1 second'
       WHERE match_id = ${state.matchId}
    `;
    await footballGridService.acknowledgeHandoff({
      matchId: state.matchId,
      userId: playerA,
      expectedStateVersion: state.stateVersion,
    });
    const first = await footballGridSettlementService.settleMatch(state.matchId);
    const replay = await footballGridSettlementService.settleMatch(state.matchId);
    expect(first.get(playerA)).toMatchObject({ tp: 0, tpEligibilityReason: 'no_contest' });
    expect(replay.get(playerA)).toMatchObject({ tp: 0, tpEligibilityReason: 'no_contest' });
  });

  it('keeps TP progressing after the daily coin budget is exhausted', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    await db`
      INSERT INTO football_grid_coin_events (
        match_id, user_id, reward_type, amount, status, eligibility_reason, credited_at
      ) VALUES (
        ${match.matchId}, ${match.playerA}, 'integration_prior_daily_budget',
        3300, 'committed', 'integration_budget', now()
      )
    `;
    const rewards = await footballGridSettlementService.settleMatch(match.matchId);
    expect(rewards.get(match.playerA)).toMatchObject({
      coins: 0,
      tp: 50,
      coinEligibilityReason: 'daily_coin_cap',
      tpEligibilityReason: 'eligible',
    });
  });

  it('replays terminal delivery after transport loss until each client explicitly acknowledges it', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const seriesId = await footballGridRepo.createSeries({ origin: 'private', lobbyId: null });
    runtimeSeriesIds.push(seriesId);
    const match = await playWinningLine('private', seriesId);
    const pending = await db<Array<{ user_id: string; status: string }>>`
      SELECT user_id, status FROM football_grid_result_deliveries
       WHERE match_id = ${match.matchId} ORDER BY user_id
    `;
    expect(pending).toHaveLength(2);
    expect(pending.every((row) => row.status === 'pending')).toBe(true);

    const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
    const sockets = new Map(match.state.players.map((player) => {
      const socket = {
        id: `socket-${player.userId}`,
        data: { user: { id: player.userId }, gridMatchId: match.matchId, matchId: match.matchId },
        leave: async () => undefined,
      };
      return [player.userId, socket] as const;
    }));
    const io = {
      in: (room: string) => ({
        fetchSockets: async () => {
          const userId = room.startsWith('user:') ? room.slice(5) : '';
          const socket = sockets.get(userId);
          return socket ? [socket] : [];
        },
      }),
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => emitted.push({ room, event, payload }),
      }),
      sockets: { sockets: new Map([...sockets.values()].map((socket) => [socket.id, socket])) },
    } as unknown as Parameters<typeof footballGridRealtimeService.recoverTerminalDeliveries>[0];

    // The terminal state version is public, but it must not be sufficient to
    // suppress the richer result payload before a delivery attempt exists.
    const forgedSocket = sockets.get(match.playerA)!;
    await expect(footballGridRealtimeService.handleCompletedAck(
      forgedSocket as unknown as Parameters<typeof footballGridRealtimeService.handleCompletedAck>[0],
      {
        matchId: match.matchId,
        terminalStateVersion: match.state.stateVersion,
        ackToken: randomUUID(),
      },
    )).rejects.toMatchObject({ details: { gridCode: 'COMPLETION_ACK_INVALID' } });
    const stillPending = await db<Array<{ status: string }>>`
      SELECT status FROM football_grid_result_deliveries WHERE match_id = ${match.matchId}
    `;
    expect(stillPending.every((row) => row.status === 'pending')).toBe(true);

    expect(await footballGridRealtimeService.recoverTerminalDeliveries(io, match.matchId)).toBe(2);
    const awaitingAck = await db<Array<{ status: string }>>`
      SELECT status FROM football_grid_result_deliveries WHERE match_id = ${match.matchId}
    `;
    expect(awaitingAck.every((row) => row.status === 'awaiting_ack')).toBe(true);
    expect(emitted.filter((entry) => entry.event === 'grid:completed')).toHaveLength(2);

    // Model a transport disconnect after the server emit but before either
    // client ACK. Resync makes the durable deliveries due and must rebuild the
    // complete result payload, rather than returning only grid:state.
    await Promise.all(match.state.players.map((player) =>
      footballGridRepo.makeResultDeliveryDue(match.matchId, player.userId)));
    expect(await footballGridRealtimeService.recoverTerminalDeliveries(io, match.matchId)).toBe(2);
    expect(emitted.filter((entry) => entry.event === 'grid:completed')).toHaveLength(4);

    for (const player of match.state.players) {
      const socket = sockets.get(player.userId)!;
      const completion = emitted
        .filter((entry) => entry.room === `user:${player.userId}` && entry.event === 'grid:completed')
        .at(-1)?.payload as { terminalStateVersion: number; ackToken: string };
      expect(completion.ackToken).toMatch(/^[0-9a-f-]{36}$/);
      await footballGridRealtimeService.handleCompletedAck(
        socket as unknown as Parameters<typeof footballGridRealtimeService.handleCompletedAck>[0],
        {
          matchId: match.matchId,
          terminalStateVersion: completion.terminalStateVersion,
          ackToken: completion.ackToken,
        },
      );
    }
    const delivered = await db<Array<{ status: string }>>`
      SELECT status FROM football_grid_result_deliveries WHERE match_id = ${match.matchId}
    `;
    expect(delivered.every((row) => row.status === 'delivered')).toBe(true);
    const series = await db<Array<{ status: string; rematch_expires_at: string | null }>>`
      SELECT status, rematch_expires_at FROM football_grid_series WHERE id = ${seriesId}
    `;
    expect(series[0].status).toBe('rematch_pending');
    expect(series[0].rematch_expires_at).not.toBeNull();
  });

  it('commutes simultaneous two-client handoff acknowledgements and readiness', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [playerA, playerB] = await createUsers();
    const pairingToken = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken,
      searchAId: randomUUID(),
      searchBId: randomUUID(),
      userAId: playerA,
      userBId: playerB,
      opponentType: 'human',
    });
    const created = (await footballGridService.createMatch({
      pairingToken,
      origin: 'random',
      players: [{ userId: playerA, seat: 1 }, { userId: playerB, seat: 2 }],
      openerUserId: playerA,
    })).state;
    runtimeMatchIds.push(created.matchId);
    await Promise.all([
      footballGridService.acknowledgeHandoff({
        matchId: created.matchId, userId: playerA, expectedStateVersion: created.stateVersion,
      }),
      footballGridService.acknowledgeHandoff({
        matchId: created.matchId, userId: playerB, expectedStateVersion: created.stateVersion,
      }),
    ]);
    const loading = await footballGridService.getState(created.matchId, playerA);
    expect(loading.phase).toBe('loading');
    await Promise.all([
      footballGridService.markReady({
        matchId: created.matchId, userId: playerA, commandId: randomUUID(), expectedStateVersion: loading.stateVersion,
      }),
      footballGridService.markReady({
        matchId: created.matchId, userId: playerB, commandId: randomUUID(), expectedStateVersion: loading.stateVersion,
      }),
    ]);
    expect((await footballGridService.getState(created.matchId, playerA)).phase).toBe('countdown');
  });

  it('accepts only the exact barrier version or the single peer-advance predecessor', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [playerA, playerB] = await createUsers();
    const pairingToken = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken,
      searchAId: randomUUID(),
      searchBId: randomUUID(),
      userAId: playerA,
      userBId: playerB,
      opponentType: 'human',
    });
    const created = (await footballGridService.createMatch({
      pairingToken,
      origin: 'random',
      players: [{ userId: playerA, seat: 1 }, { userId: playerB, seat: 2 }],
      openerUserId: playerA,
    })).state;
    runtimeMatchIds.push(created.matchId);

    const afterFirstAck = await footballGridService.acknowledgeHandoff({
      matchId: created.matchId,
      userId: playerA,
      expectedStateVersion: created.stateVersion,
    });
    await expect(footballGridService.acknowledgeHandoff({
      matchId: created.matchId,
      userId: playerB,
      expectedStateVersion: afterFirstAck.stateVersion + 1,
    })).rejects.toMatchObject({ details: { gridCode: 'STALE_STATE' } });
    const loading = await footballGridService.acknowledgeHandoff({
      matchId: created.matchId,
      userId: playerB,
      expectedStateVersion: created.stateVersion,
    });
    expect(loading.phase).toBe('loading');

    const afterFirstReady = await footballGridService.markReady({
      matchId: created.matchId,
      userId: playerA,
      commandId: randomUUID(),
      expectedStateVersion: loading.stateVersion,
    });
    await expect(footballGridService.markReady({
      matchId: created.matchId,
      userId: playerB,
      commandId: randomUUID(),
      expectedStateVersion: loading.stateVersion - 1,
    })).rejects.toMatchObject({ details: { gridCode: 'STALE_STATE' } });
    const countdown = await footballGridService.markReady({
      matchId: created.matchId,
      userId: playerB,
      commandId: randomUUID(),
      expectedStateVersion: afterFirstReady.stateVersion - 1,
    });
    expect(countdown.phase).toBe('countdown');
  });

  it('does not treat a pre-ready bot as a commuting peer barrier command', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [humanId, botId] = await createUsers();
    const pairingToken = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken,
      searchAId: randomUUID(),
      userAId: humanId,
      userBId: botId,
      opponentType: 'bot',
    });
    const created = (await footballGridService.createMatch({
      pairingToken,
      origin: 'random',
      players: [{ userId: humanId, seat: 1 }, { userId: botId, seat: 2, isBot: true }],
      openerUserId: humanId,
    })).state;
    runtimeMatchIds.push(created.matchId);

    await expect(footballGridService.acknowledgeHandoff({
      matchId: created.matchId,
      userId: humanId,
      expectedStateVersion: created.stateVersion - 1,
    })).rejects.toMatchObject({ details: { gridCode: 'STALE_STATE' } });
    const loading = await footballGridService.acknowledgeHandoff({
      matchId: created.matchId,
      userId: humanId,
      expectedStateVersion: created.stateVersion,
    });
    expect(loading.phase).toBe('loading');
    await expect(footballGridService.markReady({
      matchId: created.matchId,
      userId: humanId,
      commandId: randomUUID(),
      expectedStateVersion: loading.stateVersion - 1,
    })).rejects.toMatchObject({ details: { gridCode: 'STALE_STATE' } });
    const countdown = await footballGridService.markReady({
      matchId: created.matchId,
      userId: humanId,
      commandId: randomUUID(),
      expectedStateVersion: loading.stateVersion,
    });
    expect(countdown.phase).toBe('countdown');
  });

  it('keeps the base match activity clock fresh across Grid state transitions', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    await db`UPDATE matches SET updated_at = now() - interval '20 minutes' WHERE id = ${runtime.matchId}`;
    await footballGridService.pass({
      matchId: runtime.matchId,
      userId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
    });
    const rows = await db<Array<{ fresh: boolean }>>`
      SELECT updated_at > now() - interval '1 minute' AS fresh FROM matches WHERE id = ${runtime.matchId}
    `;
    expect(rows[0].fresh).toBe(true);
  });

  it('enforces command retry backoff and replays a persisted terminal rejection', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    const inbox = await footballGridRepo.admitCommand({
      matchId: runtime.matchId,
      actorUserId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
      commandType: 'pass',
      payloadHash: 'integration-retry-backoff',
    });
    const firstFence = randomUUID();
    expect(await footballGridRepo.leaseCommand(inbox.id, firstFence)).not.toBeNull();
    await footballGridRepo.markCommandFailed({
      commandInboxId: inbox.id,
      processingFence: firstFence,
      errorMessage: 'transient resolver outage',
    });
    expect(await footballGridRepo.leaseCommand(inbox.id, randomUUID())).toBeNull();

    await db`
      UPDATE football_grid_command_inbox SET next_retry_at = now() - interval '1 second'
       WHERE id = ${inbox.id}
    `;
    await db`UPDATE football_grid_matches SET state_version = state_version + 1 WHERE match_id = ${runtime.matchId}`;
    await expect(footballGridService.recoverPendingCommand(inbox)).rejects.toMatchObject({
      details: { gridCode: 'STALE_STATE' },
    });
    const terminal = await footballGridRepo.getCommandInbox(inbox.id);
    expect(terminal).toMatchObject({ status: 'cancelled', result_code: 'STALE_STATE' });
    await expect(footballGridService.recoverPendingCommand(inbox)).rejects.toMatchObject({
      details: { gridCode: 'STALE_STATE', duplicate: true },
    });
  });

  it('holds risk-flagged random coins without crediting the wallet until an audited release', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    const before = await db<Array<{ coins: number; tic_tac_toe_points: number }>>`
      SELECT coins, tic_tac_toe_points FROM users WHERE id = ${match.playerA}
    `;
    await db`
      INSERT INTO football_grid_reward_risk_decisions (
        match_id, user_id, decision, reason, signals, source
      ) VALUES (
        ${match.matchId}, ${match.playerA}, 'held', 'linked_account_review',
        ${{ rule: 'test-linked-account' }}, 'integration-test'
      )
    `;
    const rewards = await footballGridSettlementService.settleMatch(match.matchId);
    expect(rewards.get(match.playerA)).toMatchObject({
      xp: 70,
      coins: 0,
      tp: 0,
      eligibilityReason: 'risk_hold:linked_account_review',
    });
    const held = await db<Array<{ id: string; amount: number; status: string }>>`
      SELECT id, amount, status FROM football_grid_coin_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
    `;
    expect(held[0]).toMatchObject({ amount: 700, status: 'held' });
    const heldPoints = await db<Array<{ id: string; amount: number; status: string }>>`
      SELECT id, amount, status FROM football_grid_point_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
    `;
    expect(heldPoints[0]).toMatchObject({ amount: 50, status: 'held' });
    const whileHeld = await db<Array<{ coins: number; tic_tac_toe_points: number }>>`
      SELECT coins, tic_tac_toe_points FROM users WHERE id = ${match.playerA}
    `;
    expect(whileHeld[0].coins).toBe(before[0].coins);
    expect(whileHeld[0].tic_tac_toe_points).toBe(before[0].tic_tac_toe_points);

    await footballGridAdminService.releaseHeldCoin(
      held[0].id,
      match.playerB,
      'integration release review',
    );
    await footballGridAdminService.releaseHeldPoints(
      heldPoints[0].id,
      match.playerB,
      'integration points release review',
    );
    const released = await db<Array<{ coins: number; tic_tac_toe_points: number }>>`
      SELECT coins, tic_tac_toe_points FROM users WHERE id = ${match.playerA}
    `;
    expect(released[0].coins).toBe(before[0].coins + 700);
    expect(released[0].tic_tac_toe_points).toBe(before[0].tic_tac_toe_points + 50);
    const credited = await db<Array<{ status: string; credited_at: string | null }>>`
      SELECT status, credited_at FROM football_grid_coin_events WHERE id = ${held[0].id}
    `;
    expect(credited[0].status).toBe('committed');
    expect(credited[0].credited_at).not.toBeNull();
    expect((await footballGridSettlementService.settleMatch(match.matchId)).get(match.playerA)?.tp).toBe(50);
  });

  it('automatically holds coins for linked-device opponents', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    await db`
      UPDATE football_grid_reward_risk_observations
         SET device_hash = 'shared-device'
       WHERE match_id = ${match.matchId}
    `;
    const rewards = await footballGridSettlementService.settleMatch(match.matchId);
    expect(rewards.get(match.playerA)).toMatchObject({
      coins: 0,
      eligibilityReason: 'risk_hold:linked_device',
    });
    expect(rewards.get(match.playerB)).toMatchObject({
      coins: 0,
      eligibilityReason: 'risk_hold:linked_device',
    });

    const originalWallet = await db<Array<{ coins: number }>>`
      SELECT coins FROM users WHERE id = ${match.playerA}
    `;
    const held = await db<Array<{ id: string }>>`
      SELECT id FROM football_grid_coin_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
         AND status = 'held' AND reversal_of IS NULL
    `;
    const pointEvent = await db<Array<{ id: string }>>`
      SELECT id FROM football_grid_point_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
         AND status = 'held' AND reversal_of IS NULL
    `;
    await footballGridAdminService.reverseCoin(held[0].id, match.playerB, 'deny linked-device hold');
    await footballGridAdminService.reversePoints(pointEvent[0].id, match.playerB, 'deny linked-device points hold');
    const afterDenial = await db<Array<{ coins: number }>>`
      SELECT coins FROM users WHERE id = ${match.playerA}
    `;
    expect(afterDenial[0].coins).toBe(originalWallet[0].coins);
    expect((await footballGridSettlementService.settleMatch(match.matchId)).get(match.playerA)?.coins).toBe(0);
    const eligibility = await db<Array<{
      decision: string;
      reason: string;
      points_decision: string;
      points_reason: string;
    }>>`
      SELECT decision, reason, points_decision, points_reason FROM football_grid_reward_eligibility
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
    `;
    expect(eligibility[0]).toMatchObject({
      decision: 'ineligible',
      reason: 'risk_hold_denied',
      points_decision: 'ineligible',
      points_reason: 'points_reversed',
    });
  });

  it('keeps an old unresolved hold inside the current release budget', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    await db`
      INSERT INTO football_grid_reward_risk_decisions (
        match_id, user_id, decision, reason, signals, source
      ) VALUES (
        ${match.matchId}, ${match.playerA}, 'held', 'manual_review',
        ${{ rule: 'test-old-hold' }}, 'integration-test'
      )
    `;
    await footballGridSettlementService.settleMatch(match.matchId);
    const held = await db<Array<{ id: string }>>`
      SELECT id FROM football_grid_coin_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
         AND reward_type = 'football_grid_match'
    `;
    await db`
      INSERT INTO football_grid_coin_events (
        match_id, user_id, reward_type, amount, status, eligibility_reason, created_at
      ) VALUES (
        ${match.matchId}, ${match.playerA}, 'integration_old_unresolved_hold',
        3000, 'held', 'risk_hold:manual_review', now() - interval '3 days'
      )
    `;
    await expect(footballGridAdminService.releaseHeldCoin(
      held[0].id,
      match.playerB,
      'must respect unresolved historical holds',
    )).rejects.toThrow('rolling coin cap');
  });

  it('requires an immutable correcting release before accepting a missing-answer report', async (context) => {
    if (!hasRuntimeDb(context)) return;
    await expect(footballGridAdminService.decideReport({
      reportId: randomUUID(),
      status: 'accepted',
      notes: 'accepted without a release must fail closed',
      actorUserId: randomUUID(),
    })).rejects.toThrow('correcting content release');

    const match = await playWinningLine('random');
    const reports = await db<Array<{ id: string }>>`
      SELECT id FROM football_grid_missing_answer_reports
       WHERE reporting_user_id = ${match.playerB} AND status = 'open'
       ORDER BY created_at LIMIT 1
    `;
    await expect(footballGridAdminService.decideReport({
      reportId: reports[0].id,
      status: 'accepted',
      notes: 'the pinned release is not a correction',
      decisionReleaseId: RELEASE_ID,
      actorUserId: match.playerA,
    })).rejects.toThrow('newer published release');
    await footballGridAdminService.decideReport({
      reportId: reports[0].id,
      status: 'accepted',
      notes: 'reviewed correction resolves the reported cell intersection',
      decisionReleaseId: CORRECTION_RELEASE_ID,
      actorUserId: match.playerA,
    });
    const accepted = await db<Array<{ status: string; decision_release_id: string | null }>>`
      SELECT status, decision_release_id FROM football_grid_missing_answer_reports
       WHERE id = ${reports[0].id}
    `;
    expect(accepted[0]).toMatchObject({
      status: 'accepted',
      decision_release_id: CORRECTION_RELEASE_ID,
    });
  });

  it('projects a reversed coin reward deterministically as zero', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    await footballGridSettlementService.settleMatch(match.matchId);
    const events = await db<Array<{ id: string }>>`
      SELECT id FROM football_grid_coin_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA} AND reversal_of IS NULL
    `;
    await footballGridAdminService.reverseCoin(events[0].id, match.playerB, 'integration reversal');
    const replayed = await footballGridSettlementService.settleMatch(match.matchId);
    expect(replayed.get(match.playerA)?.coins).toBe(0);
  });

  it('reverses committed TP exactly once and projects the replay as zero', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const match = await playWinningLine('random');
    await footballGridSettlementService.settleMatch(match.matchId);
    const [event] = await db<Array<{ id: string }>>`
      SELECT id FROM football_grid_point_events
       WHERE match_id = ${match.matchId} AND user_id = ${match.playerA}
         AND reversal_of IS NULL
    `;
    await footballGridAdminService.reversePoints(event.id, match.playerB, 'integration TP reversal');
    await expect(
      footballGridAdminService.reversePoints(event.id, match.playerB, 'duplicate TP reversal'),
    ).rejects.toThrow('already reversed');
    const replayed = await footballGridSettlementService.settleMatch(match.matchId);
    expect(replayed.get(match.playerA)?.tp).toBe(0);
  });

  it('keeps the handoff no-show barrier instead of entering reconnect pause', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [playerA, playerB] = await createUsers();
    const pairingToken = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken,
      searchAId: randomUUID(),
      searchBId: randomUUID(),
      userAId: playerA,
      userBId: playerB,
      opponentType: 'human',
    });
    const state = (await footballGridService.createMatch({
      pairingToken,
      origin: 'random',
      players: [{ userId: playerA, seat: 1 }, { userId: playerB, seat: 2 }],
      openerUserId: playerA,
    })).state;
    runtimeMatchIds.push(state.matchId);
    const disconnected = await footballGridService.markDisconnected(state.matchId, playerA, 0);
    expect(disconnected.phase).toBe('handoff');
    expect(String(disconnected.phaseDeadlineAt)).toBe(String(state.phaseDeadlineAt));
    let healed = await footballGridService.markReconnected(state.matchId, playerA);
    healed = await footballGridService.acknowledgeHandoff({
      matchId: state.matchId, userId: playerA, expectedStateVersion: healed.stateVersion,
    });
    healed = await footballGridService.acknowledgeHandoff({
      matchId: state.matchId, userId: playerB, expectedStateVersion: healed.stateVersion,
    });
    healed = await footballGridService.markReady({
      matchId: state.matchId, userId: playerA, commandId: randomUUID(), expectedStateVersion: healed.stateVersion,
    });
    healed = await footballGridService.markReady({
      matchId: state.matchId, userId: playerB, commandId: randomUUID(), expectedStateVersion: healed.stateVersion,
    });
    expect(healed.phase).toBe('countdown');
    const expiredAgain = await footballGridService.reconcileDisconnected(state.matchId, playerA, 2);
    expect(expiredAgain.state).toMatchObject({ phase: 'paused', pausedFromPhase: 'countdown' });
  });

  it('rejects forged claims and non-monotonic audit events at the database boundary', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    const wrong = await footballGridService.submitAnswer({
      matchId: runtime.matchId,
      userId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
      cellIndex: 0,
      text: 'Not A Published Player',
      locale: 'en',
    });
    expect(wrong.outcome).toBe('wrong');

    await expect(db`
      INSERT INTO football_grid_claims (
        match_id, cell_index, football_player_id, claimant_user_id,
        turn_number, submitted_locale
      ) VALUES (
        ${runtime.matchId}, 0, ${OUT_OF_BOARD_PLAYER_ID}, ${runtime.playerA}, 0, 'en'
      )
    `).rejects.toThrow(/pinned board cell/);

    const runtimeRow = await db<Array<{ last_event_sequence: string; state_version: number }>>`
      SELECT last_event_sequence::text, state_version
        FROM football_grid_matches WHERE match_id = ${runtime.matchId}
    `;
    await expect(db`
      INSERT INTO football_grid_events (
        match_id, event_sequence, state_version, event_type, payload
      ) VALUES (
        ${runtime.matchId}, ${Number(runtimeRow[0].last_event_sequence) + 1},
        ${runtimeRow[0].state_version}, 'forged_event', '{}'
      )
    `).rejects.toThrow(/event_sequence_mismatch/);
  });

  it('keeps a permanent quarantine active after a newer temporary disable expires', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const rollbackMarker = new Error('rollback quarantine state-machine fixture');
    await expect(db.begin(async (tx) => {
      await tx`
        INSERT INTO football_grid_content_quarantines (
          release_id, board_id, action, reason, actor, expires_at, created_at
        )
        SELECT id, null, 'disable', 'permanent integration quarantine',
               'integration-test', null, now()
          FROM football_grid_content_releases WHERE status = 'published'
      `;
      await tx`
        INSERT INTO football_grid_content_quarantines (
          release_id, board_id, action, reason, actor, expires_at, created_at
        )
        SELECT id, null, 'disable', 'later temporary integration quarantine',
               'integration-test', now() - interval '1 second', now() + interval '1 second'
          FROM football_grid_content_releases WHERE status = 'published'
      `;
      expect(await footballGridRepo.selectBoardIdForUsers(tx, [])).toBeNull();
      throw rollbackMarker;
    })).rejects.toBe(rollbackMarker);
  });

  it('records explicit quarantine disable and enable events with an admin audit trail', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [actorUserId] = await createUsers();
    const disabled = await footballGridAdminService.quarantineContent({
      releaseId: RELEASE_ID,
      boardId: BOARD_ID,
      action: 'disable',
      reason: 'integration content incident',
      actorUserId,
    }) as { id: string; action: string };
    expect(disabled.action).toBe('disable');
    const enabled = await footballGridAdminService.quarantineContent({
      releaseId: RELEASE_ID,
      boardId: BOARD_ID,
      action: 'enable',
      reason: 'integration content incident cleared',
      actorUserId,
    }) as { id: string; action: string };
    expect(enabled.action).toBe('enable');

    const history = await footballGridAdminService.listQuarantines({
      releaseId: RELEASE_ID,
      boardId: BOARD_ID,
      limit: 10,
    }) as Array<{ id: string }>;
    expect(history.map((entry) => entry.id)).toEqual(expect.arrayContaining([disabled.id, enabled.id]));
    const audits = await db<Array<{ action: string }>>`
      SELECT action FROM audit_logs
       WHERE user_id = ${actorUserId} AND entity_type = 'football_grid_board'
       ORDER BY created_at
    `;
    expect(audits.map((entry) => entry.action)).toEqual([
      'football_grid_content_disable',
      'football_grid_content_enable',
    ]);
  });

  it('deduplicates friend rematch accepts and creates exactly one alternating-opener match', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const seriesId = await footballGridRepo.createSeries({ origin: 'private', lobbyId: null });
    runtimeSeriesIds.push(seriesId);
    const firstMatch = await playWinningLine('private', seriesId);
    const info = await footballGridRepo.getRematchInfo(firstMatch.matchId);
    expect(info?.eligible).toBe(true);
    const firstCommandId = randomUUID();
    const firstPairingToken = randomUUID();
    const firstAccept = await footballGridRepo.offerRematch({
      matchId: firstMatch.matchId,
      userId: firstMatch.playerA,
      commandId: firstCommandId,
      expectedSeriesVersion: info!.seriesVersion,
      proposedPairingToken: firstPairingToken,
    });
    expect(firstAccept.readyToCreate).toBe(false);
    const replay = await footballGridRepo.offerRematch({
      matchId: firstMatch.matchId,
      userId: firstMatch.playerA,
      commandId: firstCommandId,
      expectedSeriesVersion: info!.seriesVersion,
      proposedPairingToken: randomUUID(),
    });
    expect(replay.seriesVersion).toBe(firstAccept.seriesVersion);
    expect(replay.pairingToken).toBe(firstPairingToken);

    const secondAccept = await footballGridRepo.offerRematch({
      matchId: firstMatch.matchId,
      userId: firstMatch.playerB,
      commandId: randomUUID(),
      expectedSeriesVersion: firstAccept.seriesVersion,
      proposedPairingToken: randomUUID(),
    });
    expect(secondAccept.readyToCreate).toBe(true);
    expect(secondAccept.pairingToken).toBe(firstPairingToken);
    await footballGridRepo.createPairing({
      pairingToken: secondAccept.pairingToken,
      searchAId: seriesId,
      searchBId: seriesId,
      userAId: secondAccept.players[0].userId,
      userBId: secondAccept.players[1].userId,
      opponentType: 'human',
    });
    const opener = secondAccept.players.find((player) => player.seat === secondAccept.openerSeat)!;
    const nextMatch = await footballGridService.createMatch({
      pairingToken: secondAccept.pairingToken,
      origin: secondAccept.origin,
      players: secondAccept.players,
      openerUserId: opener.userId,
      seriesId,
      rematchOfMatchId: firstMatch.matchId,
      rematchIndex: secondAccept.rematchIndex,
    });
    runtimeMatchIds.push(nextMatch.state.matchId);
    const replayedCreate = await footballGridService.createMatch({
      pairingToken: secondAccept.pairingToken,
      origin: secondAccept.origin,
      players: secondAccept.players,
      openerUserId: opener.userId,
      seriesId,
      rematchOfMatchId: firstMatch.matchId,
      rematchIndex: secondAccept.rematchIndex,
    });
    expect(nextMatch.created).toBe(true);
    expect(replayedCreate.created).toBe(false);
    expect(replayedCreate.state.matchId).toBe(nextMatch.state.matchId);
    expect(nextMatch.state.openerUserId).not.toBe(firstMatch.state.openerUserId);
  });

  it('pauses safely after the durable command retry budget is exhausted', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    const inbox = await footballGridRepo.admitCommand({
      matchId: runtime.matchId,
      actorUserId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
      commandType: 'answer',
      cellIndex: 0,
      locale: 'en',
      submittedText: 'Grid Player 1',
      payloadHash: 'integration-poisoned-resolver',
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const processingFence = randomUUID();
      const leased = await footballGridRepo.leaseCommand(inbox.id, processingFence);
      expect(leased).not.toBeNull();
      await footballGridRepo.markCommandFailed({
        commandInboxId: inbox.id,
        processingFence,
        errorMessage: 'integration resolver failure',
      });
      if (attempt < 2) {
        await db`UPDATE football_grid_command_inbox SET next_retry_at = now() - interval '1 second' WHERE id = ${inbox.id}`;
      }
    }
    const state = await footballGridService.getState(runtime.matchId, runtime.playerA);
    expect(state.phase).toBe('service_interruption');
    const heartbeat = await footballGridService.markReconnected(runtime.matchId, runtime.playerA);
    expect(heartbeat.phase).toBe('service_interruption');
    const rows = await db<Array<{ status: string; pending_command_id: string | null; retry_count: number }>>`
      SELECT i.status, gm.pending_command_id, i.retry_count
        FROM football_grid_command_inbox i
        JOIN football_grid_matches gm ON gm.match_id = i.match_id
       WHERE i.id = ${inbox.id}
    `;
    expect(rows[0]).toMatchObject({ status: 'failed', pending_command_id: null, retry_count: 3 });
  });

  it('pins one durable action deadline for a turn and clears it on transition', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    const firstDeadline = new Date(Date.now() + 5_000).toISOString();
    const secondDeadline = new Date(Date.now() + 15_000).toISOString();
    const pinned = await footballGridRepo.ensureBotActionDeadline({
      matchId: runtime.matchId,
      botUserId: runtime.playerA,
      expectedStateVersion: runtime.stateVersion,
      proposedDeadlineAt: firstDeadline,
    });
    const repeated = await footballGridRepo.ensureBotActionDeadline({
      matchId: runtime.matchId,
      botUserId: runtime.playerA,
      expectedStateVersion: runtime.stateVersion,
      proposedDeadlineAt: secondDeadline,
    });
    expect(String(repeated)).toBe(String(pinned));
    await footballGridService.pass({
      matchId: runtime.matchId,
      userId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
    });
    const rows = await db<Array<{ bot_action_deadline_at: string | null }>>`
      SELECT bot_action_deadline_at FROM football_grid_matches WHERE match_id = ${runtime.matchId}
    `;
    expect(rows[0].bot_action_deadline_at).toBeNull();
  });

  it('finalizes handoff, loading, reconnect, and bot actions against database cutoffs', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const [handoffA, handoffB] = await createUsers();
    const handoffPairing = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken: handoffPairing,
      searchAId: randomUUID(),
      searchBId: randomUUID(),
      userAId: handoffA,
      userBId: handoffB,
      opponentType: 'human',
    });
    const handoff = (await footballGridService.createMatch({
      pairingToken: handoffPairing,
      origin: 'random',
      players: [{ userId: handoffA, seat: 1 }, { userId: handoffB, seat: 2 }],
      openerUserId: handoffA,
    })).state;
    runtimeMatchIds.push(handoff.matchId);
    await db`UPDATE football_grid_matches SET phase_deadline_at = now() - interval '1 second' WHERE match_id = ${handoff.matchId}`;
    const lateHandoff = await footballGridService.acknowledgeHandoff({
      matchId: handoff.matchId,
      userId: handoffA,
      expectedStateVersion: handoff.stateVersion,
    });
    expect(lateHandoff).toMatchObject({ phase: 'terminal', completionReason: 'loading_no_show' });

    const [readyA, readyB] = await createUsers();
    const readyPairing = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken: readyPairing,
      searchAId: randomUUID(),
      searchBId: randomUUID(),
      userAId: readyA,
      userBId: readyB,
      opponentType: 'human',
    });
    let loading = (await footballGridService.createMatch({
      pairingToken: readyPairing,
      origin: 'random',
      players: [{ userId: readyA, seat: 1 }, { userId: readyB, seat: 2 }],
      openerUserId: readyA,
    })).state;
    runtimeMatchIds.push(loading.matchId);
    loading = await footballGridService.acknowledgeHandoff({
      matchId: loading.matchId, userId: readyA, expectedStateVersion: loading.stateVersion,
    });
    loading = await footballGridService.acknowledgeHandoff({
      matchId: loading.matchId, userId: readyB, expectedStateVersion: loading.stateVersion,
    });
    await db`UPDATE football_grid_matches SET phase_deadline_at = now() - interval '1 second' WHERE match_id = ${loading.matchId}`;
    const lateReady = await footballGridService.markReady({
      matchId: loading.matchId,
      userId: readyA,
      commandId: randomUUID(),
      expectedStateVersion: loading.stateVersion,
    });
    expect(lateReady).toMatchObject({ phase: 'terminal', completionReason: 'loading_no_show' });

    const reconnect = await createReadyTurn('random');
    const paused = await footballGridService.markDisconnected(reconnect.matchId, reconnect.playerA, 0);
    expect(paused.phase).toBe('paused');
    await db`
      UPDATE football_grid_matches
         SET phase_deadline_at = now() - interval '1 second',
             reconnect_deadline_at = now() - interval '1 second'
       WHERE match_id = ${reconnect.matchId}
    `;
    const lateReconnect = await footballGridService.markReconnected(reconnect.matchId, reconnect.playerA);
    expect(lateReconnect).toMatchObject({
      phase: 'terminal',
      winnerUserId: reconnect.playerB,
      completionReason: 'disconnect_timeout',
    });

    const [human, bot] = await createUsers();
    const botPairing = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken: botPairing,
      searchAId: randomUUID(),
      userAId: human,
      userBId: bot,
      opponentType: 'bot',
    });
    let botState = (await footballGridService.createMatch({
      pairingToken: botPairing,
      origin: 'random',
      players: [{ userId: human, seat: 1 }, { userId: bot, seat: 2, isBot: true }],
      openerUserId: bot,
      botReservationFence: 1,
      botRp: 500,
      botTier: 'Reserve',
      botModelVersion: 1,
      botConfigVersion: 1,
      botRngSeed: 42,
    })).state;
    runtimeMatchIds.push(botState.matchId);
    botState = await footballGridService.acknowledgeHandoff({
      matchId: botState.matchId,
      userId: human,
      expectedStateVersion: botState.stateVersion,
    });
    botState = await footballGridService.markReady({
      matchId: botState.matchId,
      userId: human,
      commandId: randomUUID(),
      expectedStateVersion: botState.stateVersion,
    });
    await db`UPDATE football_grid_matches SET phase_deadline_at = now() - interval '1 second' WHERE match_id = ${botState.matchId}`;
    botState = (await footballGridService.handlePhaseDeadline(botState.matchId, botState.stateVersion, true)).state;
    await db`
      UPDATE football_grid_matches
         SET turn_deadline_at = now() - interval '1 second',
             phase_deadline_at = now() - interval '1 second'
       WHERE match_id = ${botState.matchId}
    `;
    const lateBot = await footballGridBotService.performTurn({
      matchId: botState.matchId,
      expectedStateVersion: botState.stateVersion,
      turnNumber: botState.turnNumber,
    });
    expect(lateBot.changed).toBe(false);
    expect(lateBot.state.stateVersion).toBe(botState.stateVersion);
  });

  it('recovers a crash after the final command lease and pauses the match', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    const inbox = await footballGridRepo.admitCommand({
      matchId: runtime.matchId,
      actorUserId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
      commandType: 'answer',
      cellIndex: 0,
      locale: 'en',
      submittedText: 'Grid Player 1',
      payloadHash: 'integration-final-lease-crash',
    });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const fence = randomUUID();
      expect(await footballGridRepo.leaseCommand(inbox.id, fence)).not.toBeNull();
      await footballGridRepo.markCommandFailed({
        commandInboxId: inbox.id,
        processingFence: fence,
        errorMessage: 'retryable integration failure',
      });
      await db`UPDATE football_grid_command_inbox SET next_retry_at = now() - interval '1 second' WHERE id = ${inbox.id}`;
    }
    expect(await footballGridRepo.leaseCommand(inbox.id, randomUUID())).not.toBeNull();
    await db`
      UPDATE football_grid_command_inbox
         SET processing_lease_until = now() - interval '1 second'
       WHERE id = ${inbox.id}
    `;
    expect(await footballGridRepo.finalizeExpiredExhaustedCommands()).toContain(runtime.matchId);
    const recovered = await footballGridService.getState(runtime.matchId, runtime.playerA);
    expect(recovered.phase).toBe('service_interruption');
    const row = await db<Array<{ status: string; pending_command_id: string | null }>>`
      SELECT i.status, gm.pending_command_id
        FROM football_grid_command_inbox i
        JOIN football_grid_matches gm ON gm.match_id = i.match_id
       WHERE i.id = ${inbox.id}
    `;
    expect(row[0]).toMatchObject({ status: 'failed', pending_command_id: null });
  });

  it('defers disconnect reconciliation behind an admitted on-time command', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const runtime = await createReadyTurn('random');
    const inbox = await footballGridRepo.admitCommand({
      matchId: runtime.matchId,
      actorUserId: runtime.playerA,
      commandId: randomUUID(),
      expectedStateVersion: runtime.stateVersion,
      commandType: 'answer',
      cellIndex: 0,
      locale: 'en',
      submittedText: 'Grid Player 1',
      payloadHash: 'integration-disconnect-after-admission',
    });
    const reconciled = await footballGridService.reconcileDisconnected(runtime.matchId, runtime.playerA, 0);
    expect(reconciled.deferred).toBe(true);
    expect(reconciled.state).toMatchObject({ phase: 'turn', stateVersion: runtime.stateVersion });
    const participant = await db<Array<{ absent_since: string | null; presence_generation: string }>>`
      SELECT absent_since, presence_generation::text
        FROM football_grid_participants
       WHERE match_id = ${runtime.matchId} AND user_id = ${runtime.playerA}
    `;
    expect(participant[0]).toMatchObject({ absent_since: null, presence_generation: '0' });
    const committed = await footballGridService.recoverPendingCommand(inbox);
    expect(committed).toMatchObject({ outcome: 'correct', state: { phase: 'turn' } });
    const remainingBeforePause = Date.parse(committed.state.turnDeadlineAt ?? '') - Date.now();
    const afterCommit = await footballGridService.reconcileDisconnected(runtime.matchId, runtime.playerA, 0);
    expect(afterCommit.deferred).toBe(false);
    expect(afterCommit.state.phase).toBe('paused');
    expect(afterCommit.state.turnRemainingMs).toBeGreaterThan(15_000);
    expect(afterCommit.state.turnRemainingMs).toBeGreaterThan(remainingBeforePause - 2_500);
  });

  it('does not extend an expired rematch and reopens its friend lobby', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const players = await createUsers();
    const lobby = await lobbiesRepo.createLobbyWithMembers({
      mode: 'friendly',
      hostUserId: players[0],
      inviteCode: `G${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      gameMode: 'football_grid',
      isPublic: false,
    }, [
      { userId: players[0], isReady: true },
      { userId: players[1], isReady: true },
    ]);
    runtimeLobbyIds.push(lobby.id);
    await lobbiesRepo.setLobbyStatus(lobby.id, 'active');
    const seriesId = await footballGridRepo.createSeries({ origin: 'private', lobbyId: lobby.id });
    runtimeSeriesIds.push(seriesId);
    const match = await playWinningLine('private', seriesId, players, lobby.id);
    const window = await footballGridRepo.openRematchWindow(match.matchId);
    expect(window).not.toBeNull();
    await db`
      UPDATE football_grid_series SET rematch_expires_at = now() - interval '1 second'
       WHERE id = ${seriesId}
    `;
    await expect(footballGridRepo.offerRematch({
      matchId: match.matchId,
      userId: players[0],
      commandId: randomUUID(),
      expectedSeriesVersion: window!.seriesVersion,
      proposedPairingToken: randomUUID(),
    })).rejects.toThrow('REMATCH_EXPIRED');
    const expired = await footballGridRepo.expireRematch(seriesId, window!.seriesVersion);
    expect(expired?.lobbyId).toBe(lobby.id);
    const lobbyState = await lobbiesRepo.getById(lobby.id);
    expect(lobbyState?.status).toBe('waiting');
    expect(await lobbiesRepo.countReadyMembers(lobby.id)).toBe(0);
  });

  it('commits lobby activation with match creation and rejects a stale second start', async (context) => {
    if (!hasRuntimeDb(context)) return;
    const players = await createUsers();
    const lobby = await lobbiesRepo.createLobbyWithMembers({
      mode: 'friendly',
      hostUserId: players[0],
      inviteCode: `S${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      gameMode: 'football_grid',
      isPublic: false,
    }, [
      { userId: players[0], isReady: true },
      { userId: players[1], isReady: true },
    ]);
    runtimeLobbyIds.push(lobby.id);
    const firstPairing = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken: firstPairing,
      searchAId: lobby.id,
      searchBId: lobby.id,
      userAId: players[0],
      userBId: players[1],
      opponentType: 'human',
    });
    const created = await footballGridService.createMatch({
      pairingToken: firstPairing,
      lobbyId: lobby.id,
      origin: 'private',
      players: [{ userId: players[0], seat: 1 }, { userId: players[1], seat: 2 }],
      openerUserId: players[0],
      afterCreateInTx: async (tx) => {
        const activated = await tx.unsafe<Array<{ id: string }>>(
          `UPDATE lobbies SET status = 'active'
            WHERE id = $1 AND status = 'waiting' RETURNING id`,
          [lobby.id],
        );
        if (!activated[0]) throw new Error('GRID_LOBBY_START_STALE');
      },
    });
    runtimeMatchIds.push(created.state.matchId);
    expect((await lobbiesRepo.getById(lobby.id))?.status).toBe('active');

    const stalePairing = randomUUID();
    await footballGridRepo.createPairing({
      pairingToken: stalePairing,
      searchAId: lobby.id,
      searchBId: lobby.id,
      userAId: players[0],
      userBId: players[1],
      opponentType: 'human',
    });
    await expect(footballGridService.createMatch({
      pairingToken: stalePairing,
      lobbyId: lobby.id,
      origin: 'private',
      players: [{ userId: players[0], seat: 1 }, { userId: players[1], seat: 2 }],
      openerUserId: players[1],
      afterCreateInTx: async (tx) => {
        const activated = await tx.unsafe<Array<{ id: string }>>(
          `UPDATE lobbies SET status = 'active'
            WHERE id = $1 AND status = 'waiting' RETURNING id`,
          [lobby.id],
        );
        if (!activated[0]) throw new Error('GRID_LOBBY_START_STALE');
      },
    })).rejects.toThrow('GRID_ACTIVE_SESSION_CONFLICT');
    const rolledBack = await db<Array<{ found: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM football_grid_matches WHERE pairing_token = ${stalePairing}
      ) AS found
    `;
    expect(rolledBack[0].found).toBe(false);
  });
});

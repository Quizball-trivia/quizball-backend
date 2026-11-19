import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi, type TestContext } from 'vitest';
import postgres from 'postgres';
import '../setup.js';

vi.hoisted(() => {
  process.env.FOOTBALL_GRID_RISK_HASH_SECRET = 'integration-football-grid-judge-secret-01';
});

import { canonicalFootballGridBoardChecksum } from '../../src/modules/football-grid/football-grid.content-validator.js';

/*
 * The shared judge end to end, on an invented universe (Lumen clubs, Vesper nations, Quill footballers): the real
 * builder makes a compatibility version from three releases (an old board, a themed board, a new board), then a second
 * version from a fact file that adds one footballer once. No real football content anywhere.
 */
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test';
const REQUIRE_DB = process.env.FOOTBALL_GRID_REQUIRE_DB === 'true';
// Packs no other suite deals from, so match creation can only pick these boards.
const THEME = 'netherlands';
const THEMED = 'brazil';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RELEASES = [
  { id: uuid(996_001), version: 996_001 },
  { id: uuid(996_002), version: 996_002 },
  { id: uuid(996_003), version: 996_003 },
  { id: uuid(996_004), version: 996_004 },
];
const ROW_KEYS = ['judge-it:club:lumen-a', 'judge-it:club:lumen-b', 'judge-it:club:lumen-c'];
const COL_KEYS = ['judge-it:country:va', 'judge-it:country:vb', 'judge-it:country:vc'];
// Three footballers per (club, nation): player p of cell c plays for club ⌊c/3⌋ and nation c%3.
const playerOf = (cell: number, p: number) => uuid(997_000 + cell * 10 + p);
const PLAYER_IDS = Array.from({ length: 9 }, (_, cell) => [0, 1, 2].map((p) => playerOf(cell, p))).flat();
const ADDED_PLAYER = uuid(997_999);
// A second, unidentified record of playerOf(0, 0) (same person): only in cell 1, with its own Georgian spelling.
const TWIN_STUB = uuid(997_998);
const TWIN_STUB_KA = 'ქვილ სტაბი';
const BOARD_IDS = RELEASES.slice(0, 3).map((_, i) => uuid(998_001 + i));
// The fourth release's board, in a pack no match in this suite deals: the late-row test writes to it alone.
const LATE_BOARD_ID = uuid(998_004);
const LATE_THEME = 'georgia';
const criterionId = (release: number, axis: 'r' | 'c', i: number) => uuid(999_000 + release * 100 + (axis === 'r' ? 0 : 10) + i);

let db: postgres.Sql;
let available = false;
let setupError: unknown = null;
let compatVersion = '';
let factVersion = '';
const users: string[] = [];
const matches: string[] = [];

type Modules = {
  repo: typeof import('../../src/modules/football-grid/football-grid.repo.js').footballGridRepo;
  service: typeof import('../../src/modules/football-grid/football-grid.service.js').footballGridService;
  judge: typeof import('../../src/modules/football-grid/football-grid-judge.service.js').footballGridJudge;
  JudgeUnavailable: typeof import('../../src/modules/football-grid/football-grid-judge.service.js').FootballGridJudgeUnavailableError;
  solo: typeof import('../../src/modules/football-grid/football-grid-solo.service.js');
  builder: typeof import('../../scripts/football-grid-judge-build.js');
  eligibility: typeof import('../../src/modules/football-grid/football-grid-eligibility.repo.js').footballGridEligibilityRepo;
};
let m: Modules;

function ready(context: TestContext): boolean {
  if (available) return true;
  context.skip(setupError instanceof Error ? setupError.message : 'local integration database unavailable');
  return false;
}

async function seed(): Promise<void> {
  for (const id of [...PLAYER_IDS, ADDED_PLAYER]) {
    const name = id === ADDED_PLAYER ? 'Nova Quillfact' : `Quill Judge ${id.slice(-4)}`;
    await db`INSERT INTO football_players (id, name, display_name, data_quality_status, fame_score)
             VALUES (${id}, ${name}, ${{ en: name }}, 'usable', ${Number(id.slice(-3))}) ON CONFLICT (id) DO NOTHING`;
  }
  for (const [index, release] of RELEASES.entries()) {
    await db`
      INSERT INTO football_grid_content_releases (id, version, status, relationship_snapshot, alias_version, resolver_policy_version,
        manifest_checksum, approved_by, approved_at, published_at)
      VALUES (${release.id}, ${release.version}, 'published', '{}', 1, 1, ${`${'7'.repeat(58)}${release.version}`}, 'integration-test', now(), now())
      ON CONFLICT (id) DO NOTHING`;
    const ids: string[] = [];
    for (const [axis, keys] of [['r', ROW_KEYS], ['c', COL_KEYS]] as const) {
      for (const [i, key] of keys.entries()) {
        const id = criterionId(index, axis, i);
        ids.push(id);
        await db`
          INSERT INTO football_grid_criteria (id, release_id, criterion_key, family, subtype, label_en, label_ka, difficulty, familiarity_score)
          VALUES (${id}, ${release.id}, ${key}, ${axis === 'r' ? 'club' : 'country'}, ${axis === 'r' ? 'senior-club-appearance' : 'nationality'},
                  ${`Invented ${key}`}, ${`გამოგონილი ${i}`}, 'easy', 50)
          ON CONFLICT (id) DO NOTHING`;
        for (let cell = 0; cell < 9; cell += 1) {
          if ((axis === 'r' ? Math.floor(cell / 3) : cell % 3) !== i) continue;
          for (let p = 0; p < 3; p += 1) {
            await db`
              INSERT INTO football_grid_criterion_memberships (release_id, criterion_id, football_player_id, relationship_subtype, verified_by, reviewed_at)
              VALUES (${release.id}, ${id}, ${playerOf(cell, p)}, 'invented', 'integration-test', now()) ON CONFLICT DO NOTHING`;
          }
        }
      }
    }
    for (const id of PLAYER_IDS) {
      const name = `Quill Judge ${id.slice(-4)}`;
      await db`
        INSERT INTO football_grid_player_aliases (release_id, football_player_id, alias, normalized_alias, locale, alias_type, acceptance_policy, reviewed_by, reviewed_at)
        VALUES (${release.id}, ${id}, ${name}, ${name.toLowerCase()}, 'en', 'full_name', 'exact', 'integration-test', now()) ON CONFLICT DO NOTHING`;
    }
    const boardId = index < 3 ? BOARD_IDS[index] : LATE_BOARD_ID;
    await db`
      INSERT INTO football_grid_boards (id, release_id, version, row_criteria, column_criteria, theme, difficulty, familiarity_score,
        canonical_checksum, approved_by, published_at)
      VALUES (${boardId}, ${release.id}, 1, ${ids.slice(0, 3)}, ${ids.slice(3)}, ${index === 1 ? THEMED : index === 3 ? LATE_THEME : THEME}, 'easy', 50,
        ${canonicalFootballGridBoardChecksum(ROW_KEYS as [string, string, string], COL_KEYS as [string, string, string])}, 'integration-test', now())
      ON CONFLICT (id) DO NOTHING`;
    for (let cell = 0; cell < 9; cell += 1) {
      for (let p = 0; p < 3; p += 1) {
        await db`
          INSERT INTO football_grid_board_answers (board_id, release_id, cell_index, football_player_id, recognizable_rank, is_sample)
          VALUES (${boardId}, ${release.id}, ${cell}, ${playerOf(cell, p)}, ${p < 2 ? p + 1 : null}, ${p === 0}) ON CONFLICT DO NOTHING`;
      }
    }
  }
}

async function seedTwinStub(): Promise<void> {
  const real = playerOf(0, 0);
  const name = `Quill Judge ${real.slice(-4)}`;
  await db`INSERT INTO football_players (id, name, display_name, data_quality_status) VALUES (${TWIN_STUB}, ${name}, ${{ en: name }}, 'pending') ON CONFLICT (id) DO NOTHING`;
  for (const criterion of [criterionId(0, 'r', 0), criterionId(0, 'c', 1)]) {
    await db`INSERT INTO football_grid_criterion_memberships (release_id, criterion_id, football_player_id, relationship_subtype, verified_by, reviewed_at)
             VALUES (${RELEASES[0].id}, ${criterion}, ${TWIN_STUB}, 'invented', 'integration-test', now()) ON CONFLICT DO NOTHING`;
  }
  await db`INSERT INTO football_grid_player_aliases (release_id, football_player_id, alias, normalized_alias, locale, alias_type, acceptance_policy, reviewed_by, reviewed_at)
           VALUES (${RELEASES[0].id}, ${TWIN_STUB}, ${TWIN_STUB_KA}, ${TWIN_STUB_KA}, 'ka', 'georgian', 'exact', 'integration-test', now()) ON CONFLICT DO NOTHING`;
}

async function buildVersions(): Promise<void> {
  const stamp = `${Date.now()}`;
  compatVersion = await m.builder.build(db, { label: `it-compat-${stamp}`, compatOnly: true, wordgameKa: false, allowProduction: false });
  const facts = mkdtempSync(join(tmpdir(), 'grid-judge-facts-'));
  writeFileSync(join(facts, 'facts.jsonl'), [
    { player_id: ADDED_PLAYER, criterion_key: ROW_KEYS[0], family: 'club', origin: 'integration' },
    { player_id: ADDED_PLAYER, criterion_key: COL_KEYS[0], family: 'country', origin: 'integration' },
  ].map((fact) => JSON.stringify(fact)).join('\n'));
  writeFileSync(join(facts, 'players.jsonl'), [JSON.stringify({
    player_id: ADDED_PLAYER, name_en: 'Nova Quillfact', name_ka: 'ნოვა ქვილფაქტი',
    aliases: [{ alias: 'Nova Quillfact', locale: 'en', type: 'full_name' }, { alias: 'ნოვა ქვილფაქტი', locale: 'ka', type: 'georgian' }],
  }), JSON.stringify({
    // A curated spelling given on the stub record: it must name the canonical record after the fold.
    player_id: TWIN_STUB, name_en: 'Stub Display Name', aliases: [{ alias: 'Stubby Quillson', locale: 'en', type: 'nickname' }],
  })].join('\n'));
  writeFileSync(join(facts, 'identity.jsonl'), JSON.stringify({ stub_player_id: TWIN_STUB, identified_player_id: playerOf(0, 0) }));
  writeFileSync(join(facts, 'manifest.json'), '{}');
  factVersion = await m.builder.build(db, { label: `it-facts-${stamp}`, facts, compatOnly: false, wordgameKa: false, allowProduction: false });
}

/** Makes a built version the active one (each test sets up what it needs, so any test runs alone). */
async function activateVersion(versionId: string): Promise<void> {
  const [row] = await db<{ label: string; status: string }[]>`SELECT label, status FROM football_grid_judge_versions WHERE id = ${versionId}`;
  if (row.status !== 'active') await m.builder.activate(db, row.label);
  m.judge.resetCaches();
}

/** A sealed copy of the compatibility version, for tests that revoke one. */
async function copyOfCompatVersion(prefix: string): Promise<string> {
  const [extra] = await db<{ id: string }[]>`
    INSERT INTO football_grid_judge_versions (label) VALUES (${`${prefix}-${Date.now()}`}) RETURNING id`;
  await db`INSERT INTO football_grid_criterion_bindings (judge_version_id, criterion_id, definition_id, status, reason)
           SELECT ${extra.id}, criterion_id, definition_id, status, reason FROM football_grid_criterion_bindings WHERE judge_version_id = ${compatVersion}`;
  await db`INSERT INTO football_grid_criterion_players (judge_version_id, definition_id, football_player_id, proof_ref)
           SELECT ${extra.id}, definition_id, football_player_id, proof_ref FROM football_grid_criterion_players WHERE judge_version_id = ${compatVersion}`;
  await db`INSERT INTO football_grid_judge_players (judge_version_id, football_player_id, rank_score, name_en, name_ka, name_ru, name_el)
           SELECT ${extra.id}, football_player_id, rank_score, name_en, name_ka, name_ru, name_el FROM football_grid_judge_players WHERE judge_version_id = ${compatVersion}`;
  await db`INSERT INTO football_grid_board_certifications (judge_version_id, board_id, status, metrics)
           SELECT ${extra.id}, board_id, status, metrics FROM football_grid_board_certifications WHERE judge_version_id = ${compatVersion}`;
  await db`INSERT INTO football_grid_judge_board_hints (judge_version_id, board_id, cell_index, football_player_id, is_sample, recognizable_rank)
           SELECT ${extra.id}, board_id, cell_index, football_player_id, is_sample, recognizable_rank FROM football_grid_judge_board_hints WHERE judge_version_id = ${compatVersion}`;
  await db`UPDATE football_grid_judge_versions SET status = 'ready', ready_at = now() WHERE id = ${extra.id}`;
  return extra.id;
}

async function setRollout(percent: number): Promise<void> {
  await db`UPDATE football_grid_judge_rollout SET online_percent = ${percent}, solo_percent = ${percent}, daily_percent = ${percent}, shadow_percent = ${percent} WHERE id = 1`;
}

async function startMatch(theme = THEME): Promise<{ matchId: string; playerA: string; playerB: string; stateVersion: number; boardId: string; judgeVersionId: string | null }> {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const rows = await db<{ id: string }[]>`
    INSERT INTO users (nickname, onboarding_complete) VALUES (${`judge-a-${stamp}`}, true), (${`judge-b-${stamp}`}, true) RETURNING id`;
  const [playerA, playerB] = rows.map((row) => row.id);
  users.push(playerA, playerB);
  const pairingToken = randomUUID();
  await m.repo.createPairing({ pairingToken, searchAId: randomUUID(), searchBId: randomUUID(), userAId: playerA, userBId: playerB, opponentType: 'human' });
  let state = (await m.service.createMatch({
    seriesFormat: 'single', theme, pairingToken, origin: 'private',
    players: [{ userId: playerA, seat: 1 }, { userId: playerB, seat: 2 }], openerUserId: playerA,
  })).state;
  matches.push(state.matchId);
  for (const userId of [playerA, playerB]) {
    state = await m.service.acknowledgeHandoff({ matchId: state.matchId, userId, expectedStateVersion: state.stateVersion });
  }
  for (const userId of [playerA, playerB]) {
    state = await m.service.markReady({ matchId: state.matchId, userId, commandId: randomUUID(), expectedStateVersion: state.stateVersion });
  }
  await db`UPDATE football_grid_matches SET phase_deadline_at = now() - interval '1 second' WHERE match_id = ${state.matchId}`;
  state = (await m.service.handlePhaseDeadline(state.matchId, state.stateVersion, true)).state;
  const [pin] = await db<{ board_id: string; judge_version_id: string | null }[]>`
    SELECT board_id, judge_version_id FROM football_grid_matches WHERE match_id = ${state.matchId}`;
  return { matchId: state.matchId, playerA, playerB, stateVersion: state.stateVersion, boardId: pin.board_id, judgeVersionId: pin.judge_version_id };
}

async function answer(match: { matchId: string; playerA: string; stateVersion: number }, cellIndex: number, text: string) {
  return m.service.submitAnswer({
    matchId: match.matchId, userId: match.playerA, commandId: randomUUID(), expectedStateVersion: match.stateVersion,
    cellIndex, text, locale: 'en',
  });
}

beforeAll(async () => {
  let connected = false;
  try {
    db = postgres(DB_URL, { max: 4, connect_timeout: 5, onnotice: () => {} });
    await db`SELECT 1`;
    connected = true;
    const [found] = await db<{ ok: boolean }[]>`SELECT to_regclass('public.football_grid_judge_versions') IS NOT NULL AS ok`;
    if (!found?.ok) throw new Error('football grid judge migrations are not installed');
    const judgeModule = await import('../../src/modules/football-grid/football-grid-judge.service.js');
    m = {
      repo: (await import('../../src/modules/football-grid/football-grid.repo.js')).footballGridRepo,
      service: (await import('../../src/modules/football-grid/football-grid.service.js')).footballGridService,
      judge: judgeModule.footballGridJudge,
      JudgeUnavailable: judgeModule.FootballGridJudgeUnavailableError,
      solo: await import('../../src/modules/football-grid/football-grid-solo.service.js'),
      builder: await import('../../scripts/football-grid-judge-build.js'),
      eligibility: (await import('../../src/modules/football-grid/football-grid-eligibility.repo.js')).footballGridEligibilityRepo,
    };
    await seed();
    await seedTwinStub();
    await buildVersions();
    available = true;
  } catch (error) {
    setupError = error;
    if (REQUIRE_DB || connected) throw error;
    console.warn(`\nSkipping Football Grid judge integration: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}, 240_000);

afterAll(async () => {
  if (!db) return;
  if (available) {
    await setRollout(0);
    await db`UPDATE football_grid_judge_versions SET status = 'ready' WHERE status = 'active' AND id IN (${compatVersion}, ${factVersion})`;
    if (users.length > 0) {
      await db`DELETE FROM football_grid_pairings WHERE user_a_id = ANY(${users}::uuid[]) OR user_b_id = ANY(${users}::uuid[])`;
    }
  }
  await db.end({ timeout: 5 });
});

// Each test creates real matches (several transactions each): a loaded machine needs more than the 5 s default.
describe('Football Grid shared judge', { timeout: 30_000 }, () => {
  it('builds a compatibility version that certifies the three boards and leaves the release rows untouched', async (context) => {
    if (!ready(context)) return;
    const certified = await db<{ board_id: string; status: string; choice: boolean }[]>`
      SELECT board_id, status, (metrics->>'choiceOk')::boolean AS choice FROM football_grid_board_certifications
       WHERE judge_version_id = ${compatVersion} AND board_id = ANY(${BOARD_IDS}::uuid[])`;
    expect(certified.map((row) => [row.status, row.choice])).toEqual([['certified', true], ['certified', true], ['certified', true]]);
    const [status] = await db<{ status: string }[]>`SELECT status FROM football_grid_judge_versions WHERE id = ${compatVersion}`;
    expect(status.status).toBe('ready');
    const [answers] = await db<{ n: number }[]>`SELECT count(*)::int AS n FROM football_grid_board_answers WHERE board_id = ANY(${BOARD_IDS}::uuid[])`;
    expect(answers.n).toBe(81);
  });

  it('propagates a fact added once to the old, themed and new boards, without touching their releases', async (context) => {
    if (!ready(context)) return;
    for (const boardId of BOARD_IDS) {
      const before = await m.judge.getJudgedBoard(boardId, compatVersion);
      const after = await m.judge.getJudgedBoard(boardId, factVersion);
      expect(m.judge.resolveTyped(before, 0, 'Nova Quillfact', []).outcome).toBe('wrong');
      expect(m.judge.resolveTyped(after, 0, 'Nova Quillfact', [])).toMatchObject({ outcome: 'correct', playerId: ADDED_PLAYER });
      expect(m.judge.resolveTyped(after, 0, 'ნოვა ქვილფაქტი', [])).toMatchObject({ outcome: 'correct', playerId: ADDED_PLAYER });
      // Only the cell whose two criteria both hold.
      expect(m.judge.resolveTyped(after, 1, 'Nova Quillfact', []).outcome).toBe('wrong');
      // The board's own published order still leads the cell (a frozen, per-version ranking).
      expect(after.validPlayerIdsByCell.get(0)?.[0]).toBe(playerOf(0, 0));
    }
    const [answers] = await db<{ n: number }[]>`
      SELECT count(*)::int AS n FROM football_grid_board_answers WHERE football_player_id = ${ADDED_PLAYER} AND board_id = ANY(${BOARD_IDS}::uuid[])`;
    expect(answers.n).toBe(0);
  });

  it('pins the active version at match creation and keeps it across activation of a newer one and cache loss', async (context) => {
    if (!ready(context)) return;
    await m.builder.activate(db, (await db<{ label: string }[]>`SELECT label FROM football_grid_judge_versions WHERE id = ${compatVersion}`)[0].label);
    await setRollout(100);
    const early = await startMatch();
    expect(early.judgeVersionId).toBe(compatVersion);
    await m.builder.activate(db, (await db<{ label: string }[]>`SELECT label FROM football_grid_judge_versions WHERE id = ${factVersion}`)[0].label);
    m.judge.resetCaches();
    const late = await startMatch();
    expect(late.judgeVersionId).toBe(factVersion);
    // The early match is still judged by what it started with, after another replica (cold caches) takes over.
    const refused = await answer(early, 0, 'Nova Quillfact');
    expect(refused.outcome).toBe('wrong');
    const accepted = await answer(late, 0, 'Nova Quillfact');
    expect(accepted).toMatchObject({ outcome: 'correct', resolvedPlayerId: ADDED_PLAYER });
    const [claim] = await db<{ accepted_alias_id: string | null; accepted_judge_alias_id: string | null }[]>`
      SELECT accepted_alias_id, accepted_judge_alias_id FROM football_grid_claims WHERE match_id = ${late.matchId}`;
    expect(claim.accepted_alias_id).toBeNull();
    expect(claim.accepted_judge_alias_id).not.toBeNull();
  });

  it('validates claims on both paths in the database', async (context) => {
    if (!ready(context)) return;
    await activateVersion(factVersion);
    await setRollout(100);
    const versioned = await startMatch();
    await setRollout(0);
    const legacy = await startMatch();
    expect(versioned.judgeVersionId).toBe(factVersion);
    expect(legacy.judgeVersionId).toBeNull();
    const insertClaim = (match: typeof versioned, cell: number, playerId: string) => db.begin(async (tx) => {
      // Turn bookkeeping the engine would do, so only the answer check can refuse.
      await tx`UPDATE football_grid_matches SET turn_number = turn_number + 1, current_player_user_id = ${match.playerB} WHERE match_id = ${match.matchId}`;
      const [turn] = await tx<{ turn_number: number }[]>`SELECT turn_number FROM football_grid_matches WHERE match_id = ${match.matchId}`;
      await tx`INSERT INTO football_grid_claims (match_id, cell_index, football_player_id, claimant_user_id, turn_number, submitted_locale)
               VALUES (${match.matchId}, ${cell}, ${playerId}, ${match.playerA}, ${turn.turn_number - 1}, 'en')`;
      throw new Error('rollback');
    });
    await expect(insertClaim(versioned, 0, ADDED_PLAYER)).rejects.toThrow('rollback');
    await expect(insertClaim(versioned, 1, ADDED_PLAYER)).rejects.toThrow(/not valid for the cell under the pinned judge version/);
    await expect(insertClaim(legacy, 0, ADDED_PLAYER)).rejects.toThrow(/not valid for the pinned board cell/);
    await expect(insertClaim(legacy, 0, playerOf(0, 1))).rejects.toThrow('rollback');
  });

  it('refuses rather than falling back when a version cannot judge a board', async (context) => {
    if (!ready(context)) return;
    const [building] = await db<{ id: string }[]>`
      INSERT INTO football_grid_judge_versions (label) VALUES (${`it-building-${Date.now()}`}) RETURNING id`;
    await expect(m.judge.getJudgedBoard(BOARD_IDS[0], building.id)).rejects.toBeInstanceOf(m.JudgeUnavailable);
    // A sealed version that binds none of the board's criteria refuses too; a later call reads again (nothing cached).
    await db`UPDATE football_grid_judge_versions SET status = 'ready', ready_at = now() WHERE id = ${building.id}`;
    await expect(m.judge.getJudgedBoard(BOARD_IDS[0], building.id)).rejects.toBeInstanceOf(m.JudgeUnavailable);
    await expect(m.solo.footballGridSoloService.judge({ boardId: BOARD_IDS[0], cellIndex: 0, text: 'Nova Quillfact', usedPlayerIds: [], judgeVersionId: building.id }))
      .rejects.toBeInstanceOf(m.JudgeUnavailable);
  });

  it('gives the bot and the pick-from-four options the pinned cells only', async (context) => {
    if (!ready(context)) return;
    await activateVersion(factVersion);
    await setRollout(100);
    const match = await startMatch();
    const board = await m.judge.getJudgedBoard(match.boardId, factVersion);
    // The bot loads the pinned cells before its transaction; inside it nothing else is read from the pool.
    await expect(m.repo.runInTransaction((tx) => m.repo.getUnusedAnswersForCellsInTx(tx, match.matchId, [0, 4])))
      .rejects.toBeInstanceOf(m.JudgeUnavailable);
    const unused = await m.repo.runInTransaction((tx) => m.repo.getUnusedAnswersForCellsInTx(tx, match.matchId, [0, 4], board));
    expect(unused.get(0)).toEqual(board.validPlayerIdsByCell.get(0));
    expect(unused.get(0)).toContain(ADDED_PLAYER);
    const options = await m.solo.footballGridSoloService.options({ boardId: match.boardId, cellIndex: 0, usedPlayerIds: [], optionSeed: 'seed-1', judgeVersionId: factVersion });
    expect(options).toHaveLength(4);
    const right = options!.filter((option) => board.validPlayerIdsByCell.get(0)!.includes(option.playerId));
    expect(right).toHaveLength(1);
  });

  it('judges a same-phone game by the version its ticket pinned, and an unpinned ticket by the board', async (context) => {
    if (!ready(context)) return;
    const pinned = m.solo.assertFootballGridSoloTicket(BOARD_IDS[0], m.solo.signFootballGridSoloTicket(BOARD_IDS[0], Date.now(), factVersion), Date.now());
    const verdict = await m.solo.footballGridSoloService.judge({ boardId: BOARD_IDS[0], cellIndex: 0, text: 'Nova Quillfact', usedPlayerIds: [], ...pinned });
    expect(verdict).toMatchObject({ outcome: 'correct', player: { playerId: ADDED_PLAYER } });
    const legacy = await m.solo.footballGridSoloService.judge({ boardId: BOARD_IDS[0], cellIndex: 0, text: 'Nova Quillfact', usedPlayerIds: [], judgeVersionId: null });
    expect(legacy.outcome).toBe('wrong');
  });

  it('warms a version ahead of the first answer, sharing the load an answer would start', async (context) => {
    if (!ready(context)) return;
    m.judge.resetCaches();
    const pages = vi.spyOn(m.eligibility, 'getAliasesPage');
    await m.judge.warmVersion(factVersion);
    const afterWarm = pages.mock.calls.length;
    expect(afterWarm).toBeGreaterThan(0);
    // The first answer on any board then reuses the warmed version data: no second alias load.
    const board = await m.judge.getJudgedBoard(BOARD_IDS[0], factVersion);
    expect(m.judge.resolveTyped(board, 0, 'Nova Quillfact', [])).toMatchObject({ outcome: 'correct', playerId: ADDED_PLAYER });
    expect(pages.mock.calls.length).toBe(afterWarm);
    pages.mockRestore();
  });

  it('lets an answer that arrives mid-warm share the same load, with no verdict before it lands', async (context) => {
    if (!ready(context)) return;
    m.judge.resetCaches();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = m.eligibility.getAliasesPage.bind(m.eligibility);
    const pages = vi.spyOn(m.eligibility, 'getAliasesPage').mockImplementation(async (...args) => { await gate; return original(...args); });
    const cells = vi.spyOn(m.eligibility, 'getBoardCells');
    try {
      const warming = m.judge.warmVersion(factVersion);
      let answered = false;
      const answering = m.judge.getJudgedBoard(BOARD_IDS[1], factVersion).then((board) => { answered = true; return board; });
      // The board request has reached the version load (its cells query runs alongside it) before the gate opens.
      await vi.waitFor(() => expect(cells).toHaveBeenCalled(), { timeout: 20_000 });
      expect(answered).toBe(false);
      release();
      const [, board] = await Promise.all([warming, answering]);
      expect(m.judge.resolveTyped(board, 0, 'Nova Quillfact', []).outcome).toBe('correct');
      // One load of the version's aliases, shared: every page was read once.
      const afterIds = pages.mock.calls.map((call) => call[1]);
      expect(new Set(afterIds.map(String)).size).toBe(afterIds.length);
    } finally {
      // Whatever failed above, later tests never inherit a closed gate or a spy.
      release();
      pages.mockRestore();
      cells.mockRestore();
    }
  });

  it('keeps the warmed active version loaded while answers use two older versions', async (context) => {
    if (!ready(context)) return;
    m.judge.resetCaches();
    await m.judge.warmVersion(factVersion);
    const older = await copyOfCompatVersion('it-older');
    await m.judge.getJudgedBoard(BOARD_IDS[0], compatVersion);
    await m.judge.getJudgedBoard(BOARD_IDS[0], older);
    expect(m.judge.isVersionLoaded(factVersion)).toBe(true);
  });

  it('keeps the previous version cached while a newer one warms, even under cache pressure', async (context) => {
    if (!ready(context)) return;
    m.judge.resetCaches();
    await m.judge.warmVersion(factVersion);
    await m.judge.getJudgedBoard(BOARD_IDS[0], compatVersion);       // cache: [fact (kept), compat]
    const failing = vi.spyOn(m.eligibility, 'getAliasesPage').mockRejectedValueOnce(new Error('pooler busy'));
    await expect(m.judge.warmVersion(await copyOfCompatVersion('it-pressure'))).rejects.toThrow('pooler busy');
    failing.mockRestore();
    const pages = vi.spyOn(m.eligibility, 'getAliasesPage');
    expect(m.judge.isVersionLoaded(factVersion)).toBe(true);
    await m.judge.getJudgedBoard(BOARD_IDS[2], factVersion);         // still cached: no reload
    expect(pages).not.toHaveBeenCalled();
    pages.mockRestore();
  });

  it('keeps the previous version kept when warming a newer one fails, so a rollback stays warm', async (context) => {
    if (!ready(context)) return;
    m.judge.resetCaches();
    await m.judge.warmVersion(factVersion);
    const failing = vi.spyOn(m.eligibility, 'getAliasesPage').mockRejectedValueOnce(new Error('pooler busy'));
    await expect(m.judge.warmVersion(compatVersion)).rejects.toThrow('pooler busy');
    failing.mockRestore();
    expect(m.judge.isVersionLoaded(factVersion)).toBe(true);
    // Older versions used by answers afterwards still do not evict it.
    await m.judge.getJudgedBoard(BOARD_IDS[0], compatVersion);
    await m.judge.getJudgedBoard(BOARD_IDS[0], await copyOfCompatVersion('it-after-failure'));
    expect(m.judge.isVersionLoaded(factVersion)).toBe(true);
  });

  it('folds a duplicate record of one footballer into the identified record: never two cells for one person', async (context) => {
    if (!ready(context)) return;
    const real = playerOf(0, 0);
    // The compatibility version mirrors legacy: both records exist; the fact version folds the stub away.
    const compat = await m.judge.getJudgedBoard(BOARD_IDS[0], compatVersion);
    expect(compat.validPlayerIdsByCell.get(1)).toContain(TWIN_STUB);
    const board = await m.judge.getJudgedBoard(BOARD_IDS[0], factVersion);
    expect([...board.validPlayerIdsByCell.values()].flat()).not.toContain(TWIN_STUB);
    expect(board.validPlayerIdsByCell.get(1)).toContain(real);           // the stub's membership moved to him
    expect(m.judge.resolveTyped(board, 1, TWIN_STUB_KA, [])).toMatchObject({ outcome: 'correct', playerId: real });
    // Claimed in cell 0 under his own name, the stub's spelling cannot score him again in cell 1.
    expect(m.judge.resolveTyped(board, 1, TWIN_STUB_KA, [real]).outcome).toBe('already_used');
    // The stub's curated spelling names the canonical record; its display name never replaces his.
    expect(m.judge.resolveTyped(board, 1, 'Stubby Quillson', [])).toMatchObject({ outcome: 'correct', playerId: real });
    expect(board.playerNamesById.get(real)?.nameEn).toBe(`Quill Judge ${real.slice(-4)}`);
    // Ids recorded before the fold (a legacy claim or pick of the stub) read as the canonical record.
    const { footballGridJudgeAnswer } = await import('../../src/modules/football-grid/football-grid-judge.service.js');
    expect((await footballGridJudgeAnswer(board, 1, TWIN_STUB_KA, null, async () => [TWIN_STUB])).outcome).toBe('already_used');
    expect(await footballGridJudgeAnswer(board, 1, 'anything', TWIN_STUB, async () => [])).toMatchObject({ outcome: 'correct', playerId: real });
  });

  it('refuses an identity file with a self-map or a chain before anything is sealed', async (context) => {
    if (!ready(context)) return;
    for (const [suffix, lines] of [
      ['self', [{ stub_player_id: TWIN_STUB, identified_player_id: TWIN_STUB }]],
      ['chain', [{ stub_player_id: TWIN_STUB, identified_player_id: playerOf(0, 0) }, { stub_player_id: playerOf(0, 0), identified_player_id: playerOf(0, 1) }]],
    ] as const) {
      const dir = mkdtempSync(join(tmpdir(), 'grid-judge-bad-identity-'));
      writeFileSync(join(dir, 'facts.jsonl'), '');
      writeFileSync(join(dir, 'players.jsonl'), '');
      writeFileSync(join(dir, 'identity.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n'));
      writeFileSync(join(dir, 'manifest.json'), '{}');
      const label = `it-bad-identity-${suffix}-${Date.now()}`;
      await expect(m.builder.build(db, { label, facts: dir, compatOnly: false, wordgameKa: false, allowProduction: false })).rejects.toThrow(/itself|chains or cycles/);
      await m.builder.discard(db, label);
    }
  });

  it('stops judging with a revoked version at once, even from a warm cache', async (context) => {
    if (!ready(context)) return;
    const extra = { id: await copyOfCompatVersion('it-revoke') };
    await expect(db`INSERT INTO football_grid_judge_players (judge_version_id, football_player_id, name_en) VALUES (${extra.id}, ${ADDED_PLAYER}, 'Late')`)
      .rejects.toThrow(/immutable once built/);
    const warm = await m.judge.getJudgedBoard(BOARD_IDS[0], extra.id);
    expect(m.judge.resolveTyped(warm, 0, `Quill Judge ${playerOf(0, 0).slice(-4)}`, []).outcome).toBe('correct');
    await db`UPDATE football_grid_judge_versions SET status = 'revoked', revoked_at = now(), revoked_reason = 'integration' WHERE id = ${extra.id}`;
    await expect(m.judge.getJudgedBoard(BOARD_IDS[0], extra.id)).rejects.toBeInstanceOf(m.JudgeUnavailable);
  });

  it('keeps a sealed version\'s cell order when a board row is published after the seal', async (context) => {
    if (!ready(context)) return;
    m.judge.resetCaches();
    const before = (await m.judge.getJudgedBoard(LATE_BOARD_ID, factVersion)).validPlayerIdsByCell.get(0);
    expect(before?.[0]).toBe(playerOf(0, 0));
    // A late sample row for the fact-added footballer: read live it would lead the cell (samples sort first).
    await db`INSERT INTO football_grid_board_answers (board_id, release_id, cell_index, football_player_id, recognizable_rank, is_sample)
             VALUES (${LATE_BOARD_ID}, ${RELEASES[3].id}, 0, ${ADDED_PLAYER}, null, true) ON CONFLICT DO NOTHING`;
    m.judge.resetCaches();
    const after = (await m.judge.getJudgedBoard(LATE_BOARD_ID, factVersion)).validPlayerIdsByCell.get(0);
    expect(after).toEqual(before);
  });

  it('refuses an answer of a match whose version was revoked as retryable, without ending the match', async (context) => {
    if (!ready(context)) return;
    const versionId = await copyOfCompatVersion('it-refuse');
    await activateVersion(versionId);
    await setRollout(100);
    const match = await startMatch();
    expect(match.judgeVersionId).toBe(versionId);
    await db`UPDATE football_grid_judge_versions SET status = 'revoked', revoked_at = now(), revoked_reason = 'integration' WHERE id = ${versionId}`;
    // Three refusals: a failure would have spent the budget that ends a match in service interruption.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(answer(match, 0, `Quill Judge ${playerOf(0, 0).slice(-4)}`)).rejects.toMatchObject({ details: { gridCode: 'GRID_JUDGE_UNAVAILABLE' } });
    }
    const inbox = await db<{ status: string; result_code: string | null }[]>`
      SELECT status, result_code FROM football_grid_command_inbox WHERE match_id = ${match.matchId}`;
    expect(inbox.length).toBe(3);
    expect(inbox.every((row) => row.status === 'cancelled' && row.result_code === 'GRID_JUDGE_UNAVAILABLE')).toBe(true);
    const [state] = await db<{ phase: string }[]>`SELECT phase FROM football_grid_matches WHERE match_id = ${match.matchId}`;
    expect(state.phase).toBe('turn');
    await activateVersion(factVersion);
  });

  it('keeps TRUNCATE (which skips the immutability triggers) away from every role', async (context) => {
    if (!ready(context)) return;
    const rows = await db<{ role: string; relation: string; allowed: boolean }[]>`
      SELECT r.rolname AS role, t.relation, has_table_privilege(r.rolname, 'public.' || t.relation, 'TRUNCATE') AS allowed
        FROM pg_roles r
        CROSS JOIN unnest(ARRAY['football_grid_criterion_players', 'football_grid_judge_versions', 'football_grid_judge_aliases', 'football_grid_judge_board_hints']) AS t(relation)
       WHERE r.rolname IN ('anon', 'authenticated', 'service_role')`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.allowed)).toEqual([]);
  });

  it('shadows a legacy answer with the active version on the same pre-attempt state', async (context) => {
    if (!ready(context)) return;
    await activateVersion(factVersion);
    await setRollout(0);
    const legacy = await startMatch();
    await db`UPDATE football_grid_judge_rollout SET shadow_percent = 100 WHERE id = 1`;
    m.judge.resetCaches();
    const result = await answer(legacy, 0, 'Nova Quillfact');
    expect(result.outcome).toBe('wrong');
    let row: { legacy_outcome: string; shadow_outcome: string; shadow_player_id: string | null } | undefined;
    for (let i = 0; i < 50 && !row; i += 1) {
      [row] = await db<NonNullable<typeof row>[]>`
        SELECT legacy_outcome, shadow_outcome, shadow_player_id FROM football_grid_shadow_verdicts WHERE match_id = ${legacy.matchId}`;
      if (!row) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(row).toEqual({ legacy_outcome: 'wrong', shadow_outcome: 'correct', shadow_player_id: ADDED_PLAYER });
  });
});

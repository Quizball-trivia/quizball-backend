import { beforeEach, describe, expect, it, vi } from 'vitest';

// A match's answers (board + carried, pinned at creation) are all-or-nothing and shared between matches on the same
// board and release set. Invented footballers only.
const m = vi.hoisted(() => ({
  key: vi.fn(), board: vi.fn(), aliases: vi.fn(), carried: vi.fn(), used: vi.fn(),
  state: null as any, persisted: [] as any[], failed: [] as any[], cancelled: [] as any[],
  players: new Map<number, any[]>(),
}));
vi.mock('../../src/db/index.js', () => ({ sql: vi.fn() }));
vi.mock('../../src/core/metrics.js', () => ({ appMetrics: new Proxy({}, { get: () => ({ record() {}, add() {} }) }) }));
vi.mock('../../src/modules/content-gaps/content-gaps.recorder.js', () => ({ contentGaps: { record() {} } }));
vi.mock('../../src/modules/football-grid/football-grid-namesakes.js', () => ({ footballGridNamesakes: { holders: () => [], pending: () => false } }));
vi.mock('../../src/modules/football-grid/football-grid-carried-answers.js', () => ({
  loadFootballGridMatchCarriedAnswers: m.carried, loadFootballGridCarriedAnswers: vi.fn(),
}));
vi.mock('../../src/modules/football-grid/football-grid-options.js', async (original) => ({
  ...await original<any>(), getFootballGridBoardPlayers: async () => m.players,
}));
vi.mock('../../src/modules/football-grid/football-grid.repo.js', () => ({ footballGridRepo: {
  getMatchAnswerKey: m.key, getBoardAnswersByBoard: m.board, getAliasesForRelease: m.aliases, getClaimedPlayerIds: m.used,
  getMatchPhase: async () => 'turn', getAttemptForInbox: async () => null,
  runInTransaction: async (work: any) => work({}),
  loadStateForUpdateAtDatabaseTime: async () => ({ state: m.state, databaseNowMs: Date.now() }),
  finishCommandInTx: async (input: any) => { m.persisted.push(input); m.state = input.next; return 'attempt'; },
  loadStateForUpdate: async () => m.state,
  markCommandFailed: async (input: any) => { m.failed.push(input); },
  cancelCommand: async (input: any) => { m.cancelled.push(input); },
} }));

import { ExternalServiceError } from '../../src/core/errors.js';
import { __test } from '../../src/modules/football-grid/football-grid.service.js';
import { createFootballGridState } from '../../src/modules/football-grid/football-grid.engine.js';
import { DEFAULT_FOOTBALL_GRID_SETTINGS } from '../../src/modules/football-grid/football-grid.settings.js';

const alias = (playerId: string, name: string) => ({ id: `${playerId}:${name}`, playerId, alias: name, normalizedAlias: name.toLowerCase(), locale: 'en', acceptancePolicy: 'exact' });
const answer = (cellIndex: number, footballPlayerId: string, playerNameEn: string) => ({ cellIndex, footballPlayerId, playerNameEn, playerNameKa: null, playerNameRu: null, playerNameEl: null });
const carried = (cellIndex: number, playerId: string, nameEn: string, releaseId = 'carried') => ({ cellIndex, playerId, nameEn, releaseId, nameKa: null, nameRu: null, nameEl: null, imageUrl: null });

function keyFor(carriedReleaseIds: string[] = ['base', 'carried']) {
  return { boardId: 'board', aliasReleaseId: 'base', carriedReleaseIds, settings: DEFAULT_FOOTBALL_GRID_SETTINGS };
}

function setState(matchId: string, claims: any[] = []) {
  const s = createFootballGridState({ matchId, players: [{ userId: 'a', seat: 1 }, { userId: 'b', seat: 2 }], openerUserId: 'a', board: { boardId: 'board', rows: [], columns: [] } as any, nowMs: Date.now() });
  m.state = { ...s, status: 'active', phase: 'turn', currentPlayerUserId: 'a', turnDeadlineAt: new Date(Date.now() + 40_000).toISOString(), turnNumber: 1, stateVersion: 1, claims };
}

function judge(matchId: string, text: string, claims: any[] = []) {
  setState(matchId, claims);
  return __test.processInbox({
    id: matchId, match_id: matchId, status: 'processing', processing_fence: 'fence', command_type: 'answer',
    actor_user_id: 'a', expected_state_version: 1, cell_index: 0, locale: 'en', submitted_text: text,
  } as any, 'fence');
}

describe('Football Grid match content', () => {
  beforeEach(() => {
    __test.reset();
    vi.clearAllMocks();
    m.persisted.length = 0; m.failed.length = 0; m.cancelled.length = 0;
    m.used.mockResolvedValue([]);
    m.key.mockResolvedValue(keyFor());
    m.board.mockResolvedValue({ aliasReleaseId: 'base', answers: [answer(0, 'p', 'Talren Morve')] });
    m.aliases.mockImplementation(async (id: string) => (id === 'base' ? [alias('p', 'Talren Morve')] : [alias('q', 'Talren Morva')]));
    m.carried.mockResolvedValue([carried(1, 'q', 'Talren Morva')]);
  });

  it('never judges without the carried answers: the command fails (retried, nothing recorded) until they load', async () => {
    m.carried.mockRejectedValueOnce(new Error('lookup timeout'));
    // Board-only content would forgive this typo of the board player; with the carried namesake it is ambiguous.
    await expect(judge('typo', 'Talren Morvo')).rejects.toBeInstanceOf(ExternalServiceError);
    expect(m.persisted).toHaveLength(0);
    expect(m.cancelled).toHaveLength(0);
    expect(m.failed).toEqual([expect.objectContaining({ commandInboxId: 'typo', processingFence: 'fence' })]);
    // The failure is not cached: the retry reads again and judges with everything.
    const retried = await judge('typo', 'Talren Morvo');
    expect(retried.outcome).toBe('ambiguous');
    expect(m.persisted.map((input) => input.outcome)).toEqual(['ambiguous']);
  });

  it('a name a used and a carried unused answer share does not spend the turn as already used', async () => {
    m.board.mockResolvedValue({ aliasReleaseId: 'base', answers: [answer(0, 'p', 'Tamsin Varrow'), answer(1, 'p', 'Tamsin Varrow')] });
    m.aliases.mockImplementation(async (id: string) => [alias(id === 'base' ? 'p' : 'q', 'Varrow')]);
    m.carried.mockResolvedValue([carried(0, 'q', 'Quillon Varrow')]);
    m.used.mockResolvedValue(['p']);
    const claims = [{ cellIndex: 1, footballPlayerId: 'p', claimantUserId: 'b', turnNumber: 0 }];
    m.carried.mockRejectedValueOnce(new Error('lookup timeout'));
    await expect(judge('shared', 'Varrow', claims)).rejects.toBeInstanceOf(ExternalServiceError);
    expect(m.persisted).toHaveLength(0);
    const retried = await judge('shared', 'Varrow', claims);
    expect(retried.outcome).toBe('ambiguous');
    expect(retried.state.currentPlayerUserId).toBe('a');
  });

  it('refuses an options menu while the carried answers cannot be read, and never offers one as a wrong option', async () => {
    const row = (cellIndex: number, playerId: string) => ({ cellIndex, playerId, name: playerId, nameKa: null, nameRu: null, nameEl: null, imageUrl: null });
    m.players = new Map([[0, [row(0, 'right-a'), row(0, 'right-b')]], [1, [row(1, 'carry-a')]], [2, [row(2, 'carry-b')]], [3, [row(3, 'carry-c')]],
      [4, [row(4, 'wrong-a')]], [5, [row(5, 'wrong-b')]], [8, [row(8, 'wrong-c')]]]);
    m.board.mockResolvedValue({ aliasReleaseId: 'base', answers: [...m.players].flatMap(([cell, players]) => players.map((p) => answer(cell, p.playerId, p.name))) });
    m.carried.mockResolvedValue(['carry-a', 'carry-b', 'carry-c'].map((id) => carried(0, id, id)));
    m.carried.mockRejectedValueOnce(new Error('lookup timeout'));
    await expect(__test.turnOptions('menu', 'board', 1, 0)).rejects.toBeInstanceOf(ExternalServiceError);
    const first = (await __test.turnOptions('menu', 'board', 1, 0))!;
    const again = (await __test.turnOptions('menu', 'board', 1, 0))!;
    expect(again).toEqual(first);
    expect(first.map((option) => option.playerId).filter((id) => id.startsWith('carry-'))).toEqual([]);
  });

  it('matches on the same board and pinned releases share one content object; another release set gets its own', async () => {
    const releases = Array.from({ length: 5 }, (_, index) => `r${index}`);
    m.key.mockResolvedValue(keyFor(['base', ...releases]));
    m.carried.mockResolvedValue(releases.map((release, index) => carried(1, `q${index}`, `Orrin Vale ${index}`, release)));
    m.aliases.mockImplementation(async (id: string) => [alias(`${id}-outsider`, `${id} outsider`), alias(id.startsWith('r') ? `q${id.slice(1)}` : 'p', `${id} name`)]);
    const one = await __test.getBoardAnswerContent('match-one');
    const two = await __test.getBoardAnswerContent('match-two');
    const three = await __test.getBoardAnswerContent('match-three');
    expect(m.aliases).toHaveBeenCalledTimes(6);
    expect(m.carried).toHaveBeenCalledTimes(1);
    expect(m.board).toHaveBeenCalledTimes(1);
    expect(two.aliases).toBe(one.aliases);
    expect(three.universe).toBe(one.universe);
    expect(one.universe.holders('r0 outsider')[0]).toBe(three.universe.holders('r0 outsider')[0]);

    m.key.mockResolvedValue(keyFor(['base', 'r0']));
    const other = await __test.getBoardAnswerContent('match-other-set');
    expect(other.universe).not.toBe(one.universe);
    expect(m.carried).toHaveBeenCalledTimes(2);
  });
});

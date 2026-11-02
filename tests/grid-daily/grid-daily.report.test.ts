import { describe, expect, it, vi } from 'vitest';
import { createGridDailyService, type GridDailyDeps } from '../../src/modules/grid-daily/grid-daily.service.js';
import * as rules from '../../src/modules/grid-daily/grid-daily.rules.js';
import type { GridDailyRunRow, Player, RunState } from '../../src/modules/grid-daily/grid-daily.types.js';
import type { FootballGridBoardView, FootballGridCriterionView } from '../../src/modules/football-grid/football-grid.types.js';

const DAY = '2026-10-20';
const BOARD = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const member: Player = { kind: 'member', userId: 'user-a' };
const guest: Player = { kind: 'guest', guestId: 'guest-a' };

const criterion = (key: string): FootballGridCriterionView =>
  ({ id: key, key, family: key.startsWith('league') ? 'league' : 'club', labelEn: key, labelKa: key, assetKey: null, difficulty: 'normal' });
const board: FootballGridBoardView = {
  boardId: BOARD, boardVersion: 1, checksum: 'x'.repeat(64),
  rows: [criterion('club:as-roma'), criterion('club:sevilla-fc'), criterion('club:real-madrid-cf')],
  columns: [criterion('league:la-liga'), criterion('league:serie-a'), criterion('league:premier-league')],
};

function setup(state: RunState, refusal: Awaited<ReturnType<GridDailyDeps['refusal']>> = { recognizedPlayerId: 'baptista' }) {
  const row: GridDailyRunRow = {
    id: RUN, user_id: 'user-a', guest_id: null, day: DAY, ranked: false, content_version: 1, state, state_version: 3,
    done: state.done, score: null, speed: null, completed_at: null, closes_at: new Date('2026-10-21T03:00:00Z'), closed: false,
  };
  const file = vi.fn(async () => undefined);
  const refuse = vi.fn(async () => refusal);
  const getRun = vi.fn(async () => row);
  const service = createGridDailyService({
    repo: { getRun, clock: async () => Date.parse('2026-10-20T15:00:00Z'), rankOf: async () => null } as unknown as GridDailyDeps['repo'],
    content: async () => new Map([[DAY, { day: DAY, number: 14, contentVersion: 1, boardId: BOARD }]]),
    contentStale: () => undefined,
    now: () => new Date('2026-10-20T15:00:00Z'),
    board: async () => board,
    judge: vi.fn(),
    samples: vi.fn(),
    refusal: refuse,
    reports: { file },
  });
  return { service, file, refuse, getRun, row };
}

const started = () => rules.miss(rules.miss(rules.kickOff(rules.newState(), 0), 0, 1_000), 0, 2_000);

describe('daily grid: "think this is right?" reports', () => {
  it('stores the square\'s two clues, the board and the name, and leaves the run (and its guesses) alone', async () => {
    const state = started();
    const { service, file, refuse, row } = setup(state);
    await service.report(member, { day: DAY, cellIndex: 0, text: 'Júlio Baptista' });
    expect(refuse).toHaveBeenCalledWith({ boardId: BOARD, cellIndex: 0, text: 'Júlio Baptista' });
    expect(file).toHaveBeenCalledWith(
      { game: 'grid_daily', source: 'daily', contextId: RUN, round: 0, reporter: { userId: 'user-a' } },
      { release: BOARD, subject: 'club:as-roma|league:la-liga', resolvedPid: 'baptista' },
      'Júlio Baptista',
    );
    // Not a move: no guess spent, none given back, the version untouched.
    expect(row.state).toBe(state);
    expect(row.state.left).toBe(7);
    expect(row.state_version).toBe(3);
  });

  it('reads the square from the cell index: row, then column', async () => {
    const { service, file } = setup(started(), { recognizedPlayerId: null });
    await service.report(member, { day: DAY, cellIndex: 7, text: 'Someone' });
    expect(file).toHaveBeenCalledWith(expect.anything(), { release: BOARD, subject: 'club:real-madrid-cf|league:serie-a', resolvedPid: null }, 'Someone');
  });

  it('works after the run is over, and for guests', async () => {
    const done = rules.finish(started(), 5_000);
    const { service, file } = setup(done);
    await service.report(guest, { day: DAY, cellIndex: 0, text: 'Baptista' });
    expect(file).toHaveBeenCalledWith(expect.objectContaining({ reporter: { guestId: 'guest-a' } }), expect.anything(), 'Baptista');
  });

  it('drops a name the square accepts now, a run with no board shown yet, and a player with no run', async () => {
    const accepted = setup(started(), null);
    await accepted.service.report(member, { day: DAY, cellIndex: 0, text: 'Totti' });
    expect(accepted.file).not.toHaveBeenCalled();

    const notKickedOff = setup(rules.newState());
    await notKickedOff.service.report(member, { day: DAY, cellIndex: 0, text: 'Baptista' });
    expect(notKickedOff.refuse).not.toHaveBeenCalled();
    expect(notKickedOff.file).not.toHaveBeenCalled();

    const none = setup(started());
    none.getRun.mockResolvedValueOnce(null as unknown as GridDailyRunRow);
    await none.service.report(member, { day: DAY, cellIndex: 0, text: 'Baptista' });
    expect(none.file).not.toHaveBeenCalled();
  });

  it('stays best effort when a lookup fails: nothing is stored and nothing is thrown', async () => {
    const failing = setup(started());
    failing.refuse.mockRejectedValueOnce(new Error('db down'));
    await expect(failing.service.report(member, { day: DAY, cellIndex: 0, text: 'Baptista' })).resolves.toBeUndefined();
    expect(failing.file).not.toHaveBeenCalled();
  });

  it('accepts exactly what the report store keeps intact', async () => {
    const { reportSchema } = await import('../../src/modules/grid-daily/grid-daily.schemas.js');
    expect(reportSchema.safeParse({ day: DAY, cellIndex: 0, text: 'x'.repeat(60) }).success).toBe(true);
    expect(reportSchema.safeParse({ day: DAY, cellIndex: 0, text: 'x'.repeat(61) }).success).toBe(false);
  });
});

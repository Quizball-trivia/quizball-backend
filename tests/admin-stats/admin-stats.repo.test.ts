import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

// Renders the repo's real SQL through a recording fake of the postgres.js tag,
// so the tests assert what is sent to the database (not a re-implementation).
const db = vi.hoisted(() => {
  const queries: string[] = [];
  const params: unknown[] = [];
  class Frag {
    constructor(public text: string) {}
    then(resolve: (rows: unknown[]) => unknown) {
      queries.push(this.text.replace(/\s+/g, ' ').trim());
      return Promise.resolve([{ n: 0, dau: 0, wau: 0, mau: 0 }]).then(resolve);
    }
  }
  const render = (v: unknown): string => {
    if (v instanceof Frag) return v.text;
    if (v && typeof v === 'object' && '__ident' in v) {
      return String((v as { __ident: string }).__ident).split('.').map((p) => `"${p}"`).join('.');
    }
    params.push(v);
    return `$${params.length}`;
  };
  const sql = (first: unknown, ...rest: unknown[]) => {
    if (Array.isArray(first) && 'raw' in first) {
      let text = (first as string[])[0];
      rest.forEach((v, i) => { text += render(v) + (first as string[])[i + 1]; });
      return new Frag(text);
    }
    return { __ident: first };
  };
  return { sql, queries, params };
});

vi.mock('../../src/db/index.js', () => ({ sql: db.sql }));

const { adminStatsRepo, adminPersonsRepo, dailyRunType } = await import('../../src/modules/admin-stats/admin-stats.repo.js');

const DAILY_RUN_TABLES = [
  'ultimo_runs', 'name_chain_runs', 'buscaminas_runs', 'minuto_runs', 'pistas_runs', 'conexiones_runs',
  'dato_falso_runs', 'codenames_runs', 'tenable_runs', 'football_race_runs', 'darts501_runs',
  'grid_daily_runs', 'shared_player_runs',
];

beforeEach(() => {
  db.queries.length = 0;
  db.params.length = 0;
});

describe('Weekend League games', () => {
  it.each([
    ['gamesPerDay', () => adminStatsRepo.gamesPerDay(30)],
    ['gamesBetween', () => adminStatsRepo.gamesBetween('2026-10-01', '2026-10-31')],
  ])('%s counts one row per WL game (tournament_id, game_index) and skips test tournaments', async (_name, run) => {
    await run();
    const q = db.queries.at(-1)!;
    const wl = q.slice(q.indexOf('FROM wl_answers a'));
    expect(q).toContain("SELECT wg.at, 'weekend_league' FROM ( SELECT min(a.created_at) AS at FROM wl_answers a");
    expect(wl).toContain('JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test');
    expect(wl).toContain('GROUP BY a.tournament_id, a.game_index');
    // never one row per answer any more
    expect(q).not.toMatch(/SELECT a\.created_at, 'weekend_league' FROM wl_answers/);
  });
});

describe('WL test tournaments are not player activity', () => {
  it.each([
    ['actives', () => adminStatsRepo.actives()],
    ['dauSeries', () => adminStatsRepo.dauSeries(30)],
  ])('%s joins non-test tournaments for WL identities', async (_name, run) => {
    await run();
    const q = db.queries.at(-1)!;
    const wl = q.slice(q.indexOf('FROM wl_answers a'));
    expect(wl.slice(0, 200)).toContain('JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test');
  });
});

describe('person timelines include every daily game', () => {
  it('maps run tables to event types', () => {
    expect(dailyRunType('minuto_runs')).toBe('minuto');
    expect(dailyRunType('shared_player_runs')).toBe('shared_player');
  });

  it('registered timeline reads all 13 daily run tables by user_id', async () => {
    await adminPersonsRepo.registeredActivity('11111111-1111-4111-8111-111111111111', 50);
    const q = db.queries.at(-1)!;
    for (const table of DAILY_RUN_TABLES) {
      expect(q).toContain(`FROM "${table}" r WHERE "r"."user_id" = `);
    }
    expect(db.params).toEqual(expect.arrayContaining(DAILY_RUN_TABLES.map((t) => t.replace(/_runs$/, ''))));
  });

  it('guest timeline reads all 13 daily run tables by guest_id', async () => {
    await adminPersonsRepo.guestActivity('22222222-2222-4222-8222-222222222222', 50);
    const q = db.queries.at(-1)!;
    for (const table of DAILY_RUN_TABLES) {
      expect(q).toContain(`FROM "${table}" r WHERE "r"."guest_id" = `);
    }
    expect(q).not.toContain('"r"."user_id"');
  });
});

describe('duels count as play', () => {
  it.each([
    ['actives', () => adminStatsRepo.actives()],
    ['dauSeries', () => adminStatsRepo.dauSeries(30)],
  ])('%s includes real registered duel seats', async (_name, run) => {
    await run();
    const q = db.queries.at(-1)!;
    expect(q).toContain(
      "SELECT 'u:' || dp.user_id, dm.started_at FROM duel_matches dm JOIN duel_participants dp ON dp.match_id = dm.id JOIN real_users ru ON ru.id = dp.user_id"
    );
  });

  it.each([
    ['gamesPerDay', () => adminStatsRepo.gamesPerDay(30)],
    ['gamesBetween', () => adminStatsRepo.gamesBetween('2026-10-01', '2026-10-31')],
  ])('%s counts each started duel once (with a real human)', async (_name, run) => {
    await run();
    const q = db.queries.at(-1)!;
    expect(q).toContain("SELECT dm.started_at, 'duel' FROM duel_matches dm WHERE");
    expect(q).toContain('EXISTS (SELECT 1 FROM duel_participants dp JOIN real_users ru ON ru.id = dp.user_id WHERE dp.match_id = dm.id)');
  });
});

describe('registered timeline: Weekend League per game, duels', () => {
  it('groups WL answers into one entry per (tournament_id, game_index), non-test only', async () => {
    await adminPersonsRepo.registeredActivity('11111111-1111-4111-8111-111111111111', 50);
    const q = db.queries.at(-1)!;
    const wl = q.slice(q.indexOf("'weekend_league'") - 40, q.indexOf('GROUP BY a.tournament_id, a.game_index') + 40);
    expect(wl).toContain("SELECT min(a.created_at), 'weekend_league'");
    expect(wl).toContain('JOIN wl_tournaments wt ON wt.id = a.tournament_id AND NOT wt.is_test');
    expect(wl).toContain('WHERE a.user_id = $');
    expect(wl).toContain('GROUP BY a.tournament_id, a.game_index');
    expect(q).toContain("SELECT dm.started_at, 'duel'");
  });

  it('guest timeline has no WL or duel rows (WL needs an account; duel guests are guest-flag users, not guest sessions)', async () => {
    await adminPersonsRepo.guestActivity('22222222-2222-4222-8222-222222222222', 50);
    const q = db.queries.at(-1)!;
    expect(q).not.toContain('wl_answers');
    expect(q).not.toContain('duel_');
  });
});

describe('friend-room play counts', () => {
  it.each([
    ['actives', () => adminStatsRepo.actives()],
    ['dauSeries', () => adminStatsRepo.dauSeries(30)],
  ])('%s includes admitted real registered room seats', async (_name, run) => {
    await run();
    expect(db.queries.at(-1)!).toContain(
      "SELECT 'u:' || rs.user_id, rm.started_at FROM room_matches rm JOIN room_seats rs ON rs.match_id = rm.id AND rs.admitted JOIN real_users ru ON ru.id = rs.user_id"
    );
  });

  it.each([
    ['gamesPerDay', () => adminStatsRepo.gamesPerDay(30)],
    ['gamesBetween', () => adminStatsRepo.gamesBetween('2026-10-01', '2026-10-31')],
  ])('%s counts each started room match once, per room game, with an admitted real human', async (_name, run) => {
    await run();
    const q = db.queries.at(-1)!;
    expect(q).toContain("SELECT rm.started_at, 'room_' || rm.game FROM room_matches rm WHERE");
    expect(q).toContain(
      'EXISTS (SELECT 1 FROM room_seats rs JOIN real_users ru ON ru.id = rs.user_id WHERE rs.match_id = rm.id AND rs.admitted)'
    );
  });

  it('registered timeline lists room games the person was admitted to', async () => {
    await adminPersonsRepo.registeredActivity('11111111-1111-4111-8111-111111111111', 50);
    expect(db.queries.at(-1)!).toContain("SELECT rm.started_at, 'room', jsonb_build_object( 'game', rm.game, 'place', rs.place, 'points', rs.points)");
    expect(db.queries.at(-1)!).toContain('rs.admitted AND rm.started_at IS NOT NULL');
  });
});

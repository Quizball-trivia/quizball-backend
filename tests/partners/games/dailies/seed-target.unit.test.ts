import { describe, expect, it } from 'vitest';
import { parseSeedDatabaseUrl } from '../../../../src/modules/partners/games/dailies/seed-target.js';
import { resolvePistasSeedTarget } from '../../../../src/modules/pistas/pistas.seed.js';

describe('content-pool seeder connection guard', () => {
  it('refuses a host list that a URL parser would read as local (review finding)', () => {
    const sneaky = 'postgresql://test:pw@remote.invalid,unused@localhost:5432/quizball_local';
    expect(() => parseSeedDatabaseUrl(sneaky)).toThrow(/exactly one host/);
  });

  it.each([
    ['two @', 'postgresql://a@b@localhost:5432/db'],
    ['query parameter', 'postgresql://u:p@localhost:5432/db?host=remote.invalid'],
    ['fragment', 'postgresql://u:p@localhost:5432/db#x'],
    ['no user', 'postgresql://localhost:5432/db'],
    ['no database', 'postgresql://u:p@localhost:5432/'],
    ['not postgres', 'mysql://u:p@localhost/db'],
  ])('refuses %s', (_name, url) => {
    expect(() => parseSeedDatabaseUrl(url)).toThrow();
  });

  it('builds the connection from validated fields', () => {
    expect(parseSeedDatabaseUrl('postgresql://postgres:p%40ss@localhost:5432/quizball_fc_g2')).toEqual({
      host: '127.0.0.1', port: 5432, user: 'postgres', password: 'p@ss', database: 'quizball_fc_g2', local: true,
    });
    const remote = parseSeedDatabaseUrl('postgresql://postgres.abc:pw@aws-1-eu-central-1.pooler.supabase.com:6543/postgres');
    expect(remote).toMatchObject({ host: 'aws-1-eu-central-1.pooler.supabase.com', port: 6543, local: false });
  });

  it('a validated local URL is the one the target guard calls local', () => {
    const url = 'postgresql://postgres:postgres@127.0.0.1:5432/quizball_fc_g2';
    expect(parseSeedDatabaseUrl(url).local).toBe(true);
    expect(resolvePistasSeedTarget(url, 'local').kind).toBe('local');
  });
});

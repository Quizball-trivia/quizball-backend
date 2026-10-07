import { describe, expect, it } from 'vitest';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from './test-db.js';

describe('partner core test database guard (runs before anything connects)', () => {
  it('builds options from validated fields only, on any local port', () => {
    expect(testDbOptions('postgresql://postgres:postgres@127.0.0.1:55439/postgres', ADMIN_DATABASE)).toEqual({
      host: '127.0.0.1', port: 55439, user: 'postgres', password: 'postgres', database: 'postgres',
    });
    expect(testDbOptions('postgresql://postgres:postgres@localhost/quizball_partner_test_1', ISOLATED_DATABASE).port).toBe(5432);
  });

  it.each([
    ['remote host', 'postgresql://u:p@db.example.com:5432/quizball_partner_test_1'],
    ['host list', 'postgresql://u:p@localhost:5432,remote.example:5432/quizball_partner_test_1'],
    ['query override', 'postgresql://u:p@127.0.0.1:5432/quizball_partner_test_1?host=remote.example'],
    ['another database', 'postgresql://u:p@127.0.0.1:5432/quizball_prod'],
  ])('rejects a %s', (_label, url) => {
    expect(() => testDbOptions(url, ISOLATED_DATABASE)).toThrow();
  });
});

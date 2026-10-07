import { describe, expect, it } from 'vitest';
import { ADMIN_DATABASE, ISOLATED_DATABASE, testDbOptions } from './test-db.js';

describe('delivery test database guard (runs before anything connects)', () => {
  it('builds options from validated fields only', () => {
    expect(testDbOptions('postgresql://postgres:postgres@127.0.0.1:55439/postgres', ADMIN_DATABASE)).toEqual({
      host: '127.0.0.1', port: 55439, user: 'postgres', password: 'postgres', database: 'postgres',
    });
    expect(testDbOptions('postgres://u:p%40ss@localhost/quizball_partner_delivery_test_1', ISOLATED_DATABASE)).toEqual({
      host: '127.0.0.1', port: 5432, user: 'u', password: 'p@ss', database: 'quizball_partner_delivery_test_1',
    });
    expect(testDbOptions('postgresql://u:p@[::1]:5433/quizball_partner_delivery_test_x', ISOLATED_DATABASE).host).toBe('::1');
  });

  it.each([
    ['multihost authority', 'postgresql://u:p@remote.example,x@localhost:55439/postgres'],
    ['host list', 'postgresql://u:p@localhost:5432,remote.example:5432/postgres'],
    ['two @', 'postgresql://u:p@remote.example@localhost/postgres'],
    ['remote host', 'postgresql://u:p@db.example.com:5432/postgres'],
    ['query database override', 'postgresql://u:p@127.0.0.1:55439/postgres?database=important'],
    ['query host override', 'postgresql://u:p@127.0.0.1:55439/postgres?host=remote.example'],
    ['bare query', 'postgresql://u:p@127.0.0.1:55439/postgres?'],
    ['fragment', 'postgresql://u:p@127.0.0.1:55439/postgres#x'],
    ['non-numeric port', 'postgresql://u:p@127.0.0.1:abc/postgres'],
    ['no user', 'postgresql://127.0.0.1:55439/postgres'],
    ['not postgres', 'mysql://u:p@127.0.0.1/postgres'],
  ])('rejects a %s', (_label, url) => {
    expect(() => testDbOptions(url, ADMIN_DATABASE)).toThrow();
  });

  it('only wipes a database named for these tests', () => {
    expect(() => testDbOptions('postgresql://u:p@127.0.0.1:5432/quizball_prod', ISOLATED_DATABASE)).toThrow(/name/);
    expect(() => testDbOptions('postgresql://u:p@127.0.0.1:5432/', ISOLATED_DATABASE)).toThrow(/name/);
  });
});

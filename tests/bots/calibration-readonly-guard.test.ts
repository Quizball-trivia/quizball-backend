import { describe, it, expect } from 'vitest';
import { assertSelectOnly } from '../../scripts/bot-calibration/readonly-db.js';

describe('assertSelectOnly (offline script read-only screen)', () => {
  it('allows SELECT and WITH … SELECT', () => {
    expect(() => assertSelectOnly('SELECT 1')).not.toThrow();
    expect(() => assertSelectOnly('  select id from users')).not.toThrow();
    expect(() => assertSelectOnly('WITH x AS (SELECT 1) SELECT * FROM x')).not.toThrow();
    expect(() => assertSelectOnly('(SELECT 1)')).not.toThrow();
  });

  it('rejects data-modifying statements', () => {
    expect(() => assertSelectOnly('INSERT INTO users (id) VALUES (1)')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('UPDATE users SET x = 1')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('DELETE FROM users')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('DROP TABLE users')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('TRUNCATE users')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('CREATE TABLE t (id int)')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('ALTER TABLE t ADD COLUMN c int')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('GRANT ALL ON t TO r')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('COPY t FROM STDIN')).toThrow(/read-only/i);
  });

  it('rejects a write hidden after a comment', () => {
    expect(() => assertSelectOnly('-- harmless\nDELETE FROM users')).toThrow(/read-only/i);
    expect(() => assertSelectOnly('/* SELECT */ UPDATE users SET x=1')).toThrow(/read-only/i);
  });

  it('rejects a CTE that performs a write (data-modifying WITH)', () => {
    expect(() => assertSelectOnly('WITH d AS (DELETE FROM users RETURNING id) SELECT * FROM d')).toThrow(/read-only/i);
  });
});

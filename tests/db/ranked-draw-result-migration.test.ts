import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The draw migration widens two CHECK constraints on hot ranked tables. A
// plain DROP + ADD CHECK scans every row under ACCESS EXCLUSIVE and blocks
// ranked settlement writes during deploy. Repo rule (see the stat-sniper /
// missing-xi pairs): ADD ... NOT VALID in the forward file (instant swap), and
// VALIDATE CONSTRAINT in a SEPARATE follow-up file that runs outside the DDL
// transaction (SHARE UPDATE EXCLUSIVE only, writes keep flowing).

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations');
const FORWARD = '20260917150000_ranked_draw_result.sql';

function read(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8');
}

describe('ranked draw result migration is non-blocking', () => {
  it('the forward migration adds both widened CHECKs as NOT VALID and never validates inline', () => {
    const body = read(FORWARD);
    const adds = [...body.matchAll(/ADD CONSTRAINT (\w+)[\s\S]*?CHECK \(([\s\S]*?)\)\s*(NOT VALID)?\s*;/g)];
    const byName = new Map(adds.map((m) => [m[1], { check: m[2], notValid: m[3] === 'NOT VALID' }]));
    expect(byName.get('ranked_rp_changes_result_check')).toMatchObject({ notValid: true });
    expect(byName.get('ranked_rp_changes_result_check')?.check).toContain("'draw'");
    expect(byName.get('wl_qp_awards_result_check')).toMatchObject({ notValid: true });
    expect(byName.get('wl_qp_awards_result_check')?.check).toContain("'draw'");
    expect(body).not.toMatch(/VALIDATE CONSTRAINT/i);
    // Idempotent on a database that already carries the constraint (staging).
    expect(body).toMatch(/DROP CONSTRAINT IF EXISTS ranked_rp_changes_result_check/);
    expect(body).toMatch(/DROP CONSTRAINT IF EXISTS wl_qp_awards_result_check/);
  });

  it('a separate later migration validates both constraints outside the DDL transaction', () => {
    const validate = readdirSync(MIGRATIONS)
      .filter((f) => f > FORWARD && /validate.*ranked_draw|ranked_draw.*validate/i.test(f))
      .sort()[0];
    expect(validate, 'follow-up VALIDATE migration file').toBeDefined();
    const body = read(validate!);
    expect(body).toMatch(/^\s*--\s*migrate:no-transaction\b/im);
    expect(body).toMatch(/ALTER TABLE public\.ranked_rp_changes VALIDATE CONSTRAINT ranked_rp_changes_result_check;/);
    expect(body).toMatch(/ALTER TABLE public\.wl_qp_awards VALIDATE CONSTRAINT wl_qp_awards_result_check;/);
    // The follow-up only validates; it must not re-scan by re-adding a VALID constraint.
    expect(body).not.toMatch(/ADD CONSTRAINT[\s\S]*?CHECK[\s\S]*?\)\s*;/);
  });
});

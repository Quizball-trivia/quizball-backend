import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, describe, expect, it, type TestContext } from 'vitest';

const migration = readFileSync(new URL('../../supabase/migrations/20261107120200_football_grid_label_fr.sql', import.meta.url), 'utf8');

/** The trigger function as a temporary one: this test touches no real table. */
const functionSql = /CREATE OR REPLACE FUNCTION[\s\S]*?\$\$;/.exec(migration)![0]
  .replace('public.football_grid_reject_mutation_except_locale_labels', 'pg_temp.fr_label_guard');

describe('French grid label migration', () => {
  it('extends the append-only allow-list with label_fr and nothing else', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '2s'");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS label_fr text');
    expect(migration).toContain('CHECK (label_fr IS NULL OR length(label_fr) BETWEEN 1 AND 160) NOT VALID');
    expect(readFileSync(new URL('../../supabase/migrations/20261107120210_football_grid_label_fr_validate.sql', import.meta.url), 'utf8')).toContain('VALIDATE CONSTRAINT football_grid_criteria_label_fr_check');
    const allowed = [...functionSql.matchAll(/to_jsonb\((NEW|OLD)\)((?: - '\w+')+)/g)].map((m) => m[2].match(/'\w+'/g));
    const expected = ["'label_es'", "'label_tr'", "'label_ru'", "'label_pt'", "'label_de'", "'label_fr'"];
    expect(allowed).toEqual([expected, expected]);
  });

  const db = postgres(process.env.DATABASE_URL ?? 'postgresql://test:test@localhost:5432/test', { max: 1, onnotice: () => undefined, connect_timeout: 3 });
  afterAll(() => db.end({ timeout: 2 }));

  it('lets a French label through and still refuses every other change to a published row', async (ctx: TestContext) => {
    try { await db`SELECT 1`; } catch { ctx.skip(); return; }
    class Rollback extends Error {}
    await expect(db.begin(async (raw) => {
      const tx = raw as unknown as postgres.Sql;
      await tx.unsafe(functionSql);
      await tx.unsafe(`CREATE TEMP TABLE published (id int PRIMARY KEY, label_en text, family text, label_es text, label_tr text, label_ru text, label_pt text, label_de text, label_fr text) ON COMMIT DROP`);
      await tx.unsafe(`INSERT INTO published (id, label_en, family) VALUES (1, 'Invented FC', 'club')`);
      await tx.unsafe(`CREATE TRIGGER guard BEFORE UPDATE OR DELETE ON published FOR EACH ROW EXECUTE FUNCTION pg_temp.fr_label_guard()`);

      await tx.unsafe(`UPDATE published SET label_fr = 'Invented FC' WHERE id = 1`);
      for (const change of [
        `UPDATE published SET label_en = 'Changed' WHERE id = 1`,
        `UPDATE published SET family = 'league' WHERE id = 1`,
        `UPDATE published SET label_fr = 'x', label_en = 'Changed' WHERE id = 1`,
        `DELETE FROM published WHERE id = 1`,
      ]) {
        await tx.unsafe('SAVEPOINT attempt');
        await expect(tx.unsafe(change)).rejects.toThrow(/append-only/);
        await tx.unsafe('ROLLBACK TO SAVEPOINT attempt');
      }
      const [row] = await tx.unsafe<Array<{ label_fr: string; label_en: string }>>(`SELECT label_fr, label_en FROM published WHERE id = 1`);
      expect(row).toEqual({ label_fr: 'Invented FC', label_en: 'Invented FC' });
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });
});

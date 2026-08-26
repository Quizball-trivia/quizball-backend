import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SUPPORTED_ISO_COUNTRY_CODES } from '../../src/core/country.js';

function migration(name: string): string {
  return readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8');
}

const expansion = migration('20260826192844_normalize_user_country_codes.sql');
const validation = migration('20260826192845_validate_user_country_codes.sql');

describe('users country-code constraint migrations', () => {
  it('adds the hot-table constraint idempotently without validating under the DDL lock', () => {
    expect(expansion).toContain("SET LOCAL lock_timeout = '5s'");
    expect(expansion).toContain("conname = 'users_country_iso2_check'");
    const migrationCodes = [...expansion.matchAll(/'([A-Z]{2})'/g)].map((match) => match[1]);
    expect(migrationCodes).toEqual([...SUPPORTED_ISO_COUNTRY_CODES]);
    expect(expansion).toContain('country = ANY (ARRAY[');
    expect(expansion).toContain('NOT VALID');
    expect(expansion).not.toContain('VALIDATE CONSTRAINT');
    expect(expansion).not.toContain('UPDATE public.users');
  });

  it('validates in a separate bounded migration', () => {
    expect(validation).toContain("SET LOCAL lock_timeout = '5s'");
    expect(validation).toContain("SET LOCAL statement_timeout = '30s'");
    expect(validation).toContain('VALIDATE CONSTRAINT users_country_iso2_check');
  });
});

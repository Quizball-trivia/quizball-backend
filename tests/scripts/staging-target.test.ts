import { describe, expect, it } from 'vitest';
import { stagingTarget } from '../../scripts/staging-target.js';

// Placeholder credentials; only the URL shape is checked, nothing connects.
const pooler = (rest = '') => `postgresql://postgres.nsdfiprfmhdqhbfxfwpv:x@aws-1-eu-central-1.pooler.supabase.com:5432/postgres${rest}`;

describe('the staging guard of the content scripts', () => {
  it('accepts the staging pooler user and direct host', () => {
    expect(stagingTarget(pooler())).toBe('staging');
    expect(stagingTarget(pooler('?sslmode=require'))).toBe('staging');
    expect(stagingTarget('postgresql://postgres:x@db.nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres')).toBe('staging');
  });

  it('refuses a query parameter that would connect as another project, encoded or not', () => {
    expect(() => stagingTarget(pooler('?user=postgres.%6cfbwhxvwubzeqkztghok'))).toThrow();
    expect(() => stagingTarget(pooler('?user=postgres.other'))).toThrow(/connection parameters/);
    expect(() => stagingTarget(pooler('?options=-c%20search_path%3Dx'))).toThrow(/connection parameters/);
  });

  it('refuses production anywhere, and local unless allowed', () => {
    expect(() => stagingTarget('postgresql://postgres.lfbwhxvwubzeqkztghok:x@aws-1-eu-central-1.pooler.supabase.com:5432/postgres')).toThrow(/production/);
    expect(() => stagingTarget('postgresql://postgres:postgres@127.0.0.1:5432/x')).toThrow();
    expect(stagingTarget('postgresql://postgres:postgres@127.0.0.1:5432/x', { allowLocal: true })).toBe('local');
  });
});

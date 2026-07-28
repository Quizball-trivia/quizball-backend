/**
 * Pure unit tests for the DB target guard (finding 10). No DB.
 */
import { describe, it, expect } from 'vitest';
import { assertDbTarget, resolveTarget } from '../../scripts/bot-burnin/target-guard.js';

const LOCAL = 'postgresql://postgres:pw@localhost:54322/postgres';
const STAGING_POOLER = 'postgresql://postgres.nsdfiprfmhdqhbfxfwpv:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres';
const DIRECT_SUPABASE = 'postgresql://postgres:pw@nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres';
const OTHER_REMOTE = 'postgresql://user:pw@db.example.com:5432/postgres';

describe('resolveTarget', () => {
  it('detects local hosts', () => {
    expect(resolveTarget(LOCAL).isLocal).toBe(true);
  });
  it('parses the Supabase project ref from the pooler user (case-insensitive)', () => {
    const t = resolveTarget(STAGING_POOLER.replace('pooler.supabase.com', 'POOLER.SUPABASE.COM'));
    expect(t.isSupabase).toBe(true);
    expect(t.confirmToken).toBe('nsdfiprfmhdqhbfxfwpv');
  });
  it('parses the project ref from a direct supabase.co subdomain', () => {
    const t = resolveTarget(DIRECT_SUPABASE);
    expect(t.isSupabase).toBe(true);
    expect(t.confirmToken).toBe('nsdfiprfmhdqhbfxfwpv');
  });
  it('uses the hostname as the token for a non-Supabase remote', () => {
    const t = resolveTarget(OTHER_REMOTE);
    expect(t.isSupabase).toBe(false);
    expect(t.confirmToken).toBe('db.example.com');
  });
});

describe('assertDbTarget', () => {
  const clearEnv = () => { delete process.env.BURNIN_CONFIRM_ENV; };

  it('allows localhost with no confirmation', () => {
    clearEnv();
    expect(() => assertDbTarget(LOCAL, { allowRemote: false })).not.toThrow();
  });

  it('refuses a remote without --allow-remote', () => {
    clearEnv();
    expect(() => assertDbTarget(STAGING_POOLER, { allowRemote: false })).toThrow(/non-local/i);
  });

  it('refuses --allow-remote with an EMPTY confirmation', () => {
    clearEnv();
    expect(() => assertDbTarget(STAGING_POOLER, { allowRemote: true })).toThrow(/BURNIN_CONFIRM_ENV/);
  });

  it('refuses when the confirmation does not MATCH the target ref (finding 10 core)', () => {
    process.env.BURNIN_CONFIRM_ENV = 'prod-project-ref'; // wrong ref
    expect(() => assertDbTarget(STAGING_POOLER, { allowRemote: true })).toThrow(/does not match/i);
    clearEnv();
  });

  it('allows --allow-remote when the confirmation matches the ref (case-insensitive)', () => {
    process.env.BURNIN_CONFIRM_ENV = 'NSDFIPRFMHDQHBFXFWPV';
    expect(() => assertDbTarget(STAGING_POOLER, { allowRemote: true })).not.toThrow();
    clearEnv();
  });

  it('a non-Supabase remote also requires a matching confirmation', () => {
    clearEnv();
    expect(() => assertDbTarget(OTHER_REMOTE, { allowRemote: true })).toThrow(/BURNIN_CONFIRM_ENV/);
    process.env.BURNIN_CONFIRM_ENV = 'db.example.com';
    expect(() => assertDbTarget(OTHER_REMOTE, { allowRemote: true })).not.toThrow();
    clearEnv();
  });
});

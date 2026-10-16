import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.hoisted(() => vi.fn(async (_event: unknown) => undefined));
vi.mock('../../src/core/analytics.js', () => ({
  getPostHogClient: () => ({ captureImmediate: capture }),
  stableAnalyticsEventUuid: (key: string) => `stable:${key}`,
}));
// No credentials, analytics events, Supabase changes, or shared test DB access.
// tests/setup.ts validates this exact loopback host/port and database prefix.
const rehearsalUrl = process.env.RELEASE_TEST_DATABASE_URL;
describe.skipIf(!rehearsalUrl)('signup attribution: isolated real PostgreSQL rehearsal', () => {
  let sql: typeof import('../../src/db/index.js').sql;
  let repo: typeof import('../../src/modules/users/users.repo.js').usersRepo;
  let config: typeof import('../../src/core/config.js').config;
  let publish: typeof import('../../src/modules/analytics/registered-members.worker.js').publishRegisteredMemberCountSnapshot;
  beforeAll(async () => {
    const target = new URL(rehearsalUrl!);
    if (target.hostname !== '127.0.0.1' || target.port !== '55519' || target.pathname !== '/rehearsal_analytics') {
      throw Error('Refusing non-isolated attribution rehearsal');
    }
    ({ sql } = await import('../../src/db/index.js'));
    ({ usersRepo: repo } = await import('../../src/modules/users/users.repo.js'));
    ({ config } = await import('../../src/core/config.js'));
    ({ publishRegisteredMemberCountSnapshot: publish } = await import('../../src/modules/analytics/registered-members.worker.js'));
  });
  beforeEach(async () => {
    config.NODE_ENV = 'local';
    capture.mockClear();
    await sql`TRUNCATE users CASCADE`;
    await sql`TRUNCATE guest_sessions, guest_journeys CASCADE`;
  });
  afterAll(async () => { config.NODE_ENV = 'local'; await sql.end(); });
  const identity = (subject: string) => ({ provider: 'supabase', subject });

  it('counts played guests once by immutable first-play platform, excluding opened-only and linked journeys', async () => {
    const { guestJourneyRepo, guestTokenHash } = await import('../../src/modules/guest/guest-journey.repo.js');
    const { randomUUID } = await import('node:crypto');
    const mint = async (c: string) => {
      const [s] = await sql`INSERT INTO guest_sessions (token_hash, locale) VALUES (${guestTokenHash(c.repeat(64))}, 'en') RETURNING id`;
      return s.id as string;
    };
    const android = await mint('a'), ios = await mint('b'), web = await mint('c');
    await mint('d'); // No play: not another user.
    await Promise.all([
      guestJourneyRepo.activity(android, null, randomUUID(), 'play_started', 'auction', 'android'),
      guestJourneyRepo.activity(android, null, randomUUID(), 'play_started', 'countdown', 'android'),
    ]);
    await guestJourneyRepo.activity(android, null, randomUUID(), 'play_started', 'auction', 'ios');
    await guestJourneyRepo.activity(ios, null, randomUUID(), 'play_started', 'countdown', 'ios');
    await guestJourneyRepo.activity(web, null, randomUUID(), 'play_started', 'countdown', 'web');
    expect((await sql`SELECT first_play_platform FROM guest_journeys WHERE guest_id = ${android}`)[0].first_play_platform).toBe('android');
    // Legacy rows stay explicitly unknown, not guessed from a later visit.
    await sql`UPDATE guest_journeys SET first_play_platform = NULL WHERE guest_id = ${web}`;
    await guestJourneyRepo.activity(web, null, randomUUID(), 'play_started', 'auction', 'ios');
    expect((await sql`SELECT first_play_platform FROM guest_journeys WHERE guest_id = ${web}`)[0].first_play_platform).toBeNull();
    config.NODE_ENV = 'prod'; await publish();
    const properties = () => (capture.mock.calls.at(-1)![0] as { properties: Record<string, unknown> }).properties;
    expect(properties()).toMatchObject({ registered_members: 0, unlinked_played_guest_journeys: 3,
      users_including_played_guests: 3, played_guests_by_first_platform: { android: 1, ios: 1, unknown: 1 } });
    // Signup replaces the played guest with one member in the same transaction.
    config.NODE_ENV = 'local';
    const signed = await repo.createWithIdentity({ signupPlatform: 'android' }, identity('guest-signup'), 'a'.repeat(64));
    config.NODE_ENV = 'prod'; await publish();
    expect(properties()).toMatchObject({ registered_members: 1, unlinked_played_guest_journeys: 2, users_including_played_guests: 3 });
    expect((await sql`SELECT link_type FROM guest_journeys WHERE guest_id = ${android}`)[0].link_type).toBe('signup');
    // An existing member on another platform is not a second account.
    await guestJourneyRepo.link(guestTokenHash('b'.repeat(64))!, signed.user.id);
    await publish();
    expect(properties()).toMatchObject({ registered_members: 1, unlinked_played_guest_journeys: 1, users_including_played_guests: 2 });
    expect((await sql`SELECT count(*)::int AS n FROM users`)[0].n).toBe(1);
    for (const role of ['anon', 'authenticated']) {
      expect((await sql`SELECT has_table_privilege(${role}, 'guest_journeys', 'SELECT,INSERT,UPDATE,DELETE') AS allowed`)[0].allowed).toBe(false);
    }
    await expect(sql`UPDATE guest_journeys SET first_play_platform = 'guessed'`).rejects.toMatchObject({ code: '23514' });
  });

  it('records Android once, never relabels it on iOS login or counts another account', async () => {
    const first = await repo.createWithIdentity({ signupPlatform: 'android' }, identity('one-account'));
    const repeat = await repo.createWithIdentity({ signupPlatform: 'ios' }, identity('one-account'));
    expect(first.created).toBe(true);
    expect(repeat.created).toBe(false);
    expect(repeat.user.id).toBe(first.user.id);
    expect(await sql`SELECT platform FROM user_signup_attribution`).toEqual([{ platform: 'android' }]);
    expect(await sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 1 }]);
  });

  it('allows only one winning creation and one source under simultaneous web/app provisioning', async () => {
    const results = await Promise.all([
      repo.createWithIdentity({ signupPlatform: 'web' }, identity('race-account')),
      repo.createWithIdentity({ signupPlatform: 'android' }, identity('race-account')),
    ]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    const rows = await sql`SELECT platform FROM user_signup_attribution`;
    expect(rows).toHaveLength(1);
    expect(['web', 'android']).toContain(rows[0].platform);
  });

  it('keeps missing declarations unknown and does not backfill an existing legacy web user from an app login', async () => {
    const first = await repo.createWithIdentity({}, identity('legacy'));
    expect(await sql`SELECT platform FROM user_signup_attribution`).toEqual([{ platform: 'unknown' }]);
    await sql`DELETE FROM user_signup_attribution WHERE user_id = ${first.user.id}`;
    await repo.createWithIdentity({ signupPlatform: 'android' }, identity('legacy'));
    expect(await sql`SELECT * FROM user_signup_attribution`).toHaveLength(0);
  });

  it('rolls back the account and identity if the atomic source insert fails', async () => {
    await sql.unsafe(`CREATE FUNCTION fail_attribution() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'isolated attribution failure'; END $$`);
    await sql.unsafe('CREATE TRIGGER fail_attribution BEFORE INSERT ON user_signup_attribution FOR EACH ROW EXECUTE FUNCTION fail_attribution()');
    try {
      await expect(repo.createWithIdentity({ signupPlatform: 'ios' }, identity('rollback'))).rejects.toThrow('isolated attribution failure');
      expect(await sql`SELECT count(*)::int AS n FROM users`).toEqual([{ n: 0 }]);
      expect(await sql`SELECT count(*)::int AS n FROM user_identities`).toEqual([{ n: 0 }]);
    } finally {
      await sql.unsafe('DROP TRIGGER fail_attribution ON user_signup_attribution');
      await sql.unsafe('DROP FUNCTION fail_attribution()');
    }
  });

  it('denies anonymous/authenticated table access, validates platform, and deletes attribution with the account', async () => {
    const { user } = await repo.createWithIdentity({ signupPlatform: 'ios' }, identity('privacy'));
    const [rights] = await sql`SELECT relrowsecurity AS rls FROM pg_class WHERE oid = 'user_signup_attribution'::regclass`;
    expect(rights.rls).toBe(true);
    for (const role of ['anon', 'authenticated']) {
      const [permissions] = await sql`SELECT has_table_privilege(${role}, 'user_signup_attribution', 'SELECT,INSERT,UPDATE,DELETE') AS allowed`;
      expect(permissions.allowed).toBe(false);
    }
    await expect(sql`UPDATE user_signup_attribution SET platform = 'guessed' WHERE user_id = ${user.id}`).rejects.toMatchObject({ code: '23514' });
    await sql`DELETE FROM users WHERE id = ${user.id}`;
    expect(await sql`SELECT * FROM user_signup_attribution`).toHaveLength(0);
  });

  it('reconciles platform buckets exactly to registered total, keeping legacy/partner/test populations separate', async () => {
    await repo.createWithIdentity({ signupPlatform: 'android' }, identity('android'));
    await repo.createWithIdentity({ signupPlatform: 'ios' }, identity('ios'));
    await repo.createWithIdentity({ signupPlatform: 'web' }, identity('web'));
    await repo.createWithIdentity({}, identity('unknown'));
    await sql`INSERT INTO users (nickname) VALUES ('legacy-without-origin')`;
    for (const predicate of ['is_ai', 'is_seed', 'is_guest', 'is_deleted']) {
      await sql.unsafe(`INSERT INTO users (${predicate}) VALUES (true)`);
    }
    await sql`INSERT INTO users (deleted_at) VALUES (now())`;
    await sql`INSERT INTO users (role) VALUES ('partner_staff')`;
    await sql`INSERT INTO users (partner_slug) VALUES ('partner-one')`;
    config.NODE_ENV = 'prod';
    await publish();
    expect(capture).toHaveBeenCalledOnce();
    const { properties: p } = capture.mock.calls[0][0] as { properties: {
      registered_members: number; registered_members_by_signup_platform: Record<string, number>;
      partner_players: number; users_including_partners: number;
      signup_platform_daily_30d: Array<{ accounts: number }>; $process_person_profile: boolean;
    } };
    expect(p.registered_members).toBe(5);
    expect(p.registered_members_by_signup_platform).toEqual({ android: 1, ios: 1, web: 1, unknown: 2 });
    expect(Object.values(p.registered_members_by_signup_platform).reduce((a: number, b) => a + Number(b), 0)).toBe(p.registered_members);
    expect(p.partner_players).toBe(1);
    expect(p.users_including_partners).toBe(6);
    expect(p.signup_platform_daily_30d).toHaveLength(4);
    expect(p.signup_platform_daily_30d.reduce((n: number, r: { accounts: number }) => n + r.accounts, 0)).toBe(4);
    expect(p.$process_person_profile).toBe(false);
  });
});

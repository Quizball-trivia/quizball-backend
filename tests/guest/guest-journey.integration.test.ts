import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
const db = vi.hoisted(() => ({ sql: null as unknown as ReturnType<typeof postgres> }));
vi.mock('../../src/db/index.js', () => ({ get sql() { return db.sql; } }));
const { guestJourneyRepo, guestTokenHash, linkGuestInTx } = await import('../../src/modules/guest/guest-journey.repo.js');
const url = process.env.GUEST_JOURNEY_TEST_DATABASE_URL;
if (url && !/^postgresql:\/\/[^@]+@127\.0\.0\.1:5432\/quizball_guest_journey_[a-z0-9_]+$/.test(url)) throw new Error('Isolated local guest test database required');
describe.skipIf(!url)('guest journey durable attribution (real Postgres)', () => {
  db.sql = postgres(url!, { max: 5, onnotice: () => undefined });
  beforeEach(async () => { await db.sql`TRUNCATE guest_journey_events, guest_journeys, guest_sessions, users CASCADE`; });
  afterAll(async () => { await db.sql.end(); });
  async function fixture() {
    const token = randomBytes(32).toString('hex');
    const [session] = await db.sql`INSERT INTO guest_sessions(token_hash, locale) VALUES (${guestTokenHash(token)}, 'ka') RETURNING id`;
    const [member] = await db.sql`INSERT INTO users DEFAULT VALUES RETURNING id`;
    return { token, guest: session.id as string, member: member.id as string };
  }
  it('connects the actual account insert atomically and does not repeat on existing identity', async () => {
    const { usersRepo } = await import('../../src/modules/users/users.repo.js');
    const x = await fixture();
    await guestJourneyRepo.activity(x.guest, 'GE', randomUUID(), 'play_started', 'trueFalse');
    const identity = { provider: 'supabase', subject: randomUUID() };
    const first = await usersRepo.createWithIdentity({}, identity, x.token);
    const again = await usersRepo.createWithIdentity({}, identity, x.token);
    expect(first.created).toBe(true); expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);
    expect((await db.sql`SELECT linked_user_id FROM guest_journeys`)[0].linked_user_id).toBe(first.user.id);
    expect(await db.sql`SELECT * FROM guest_journey_events WHERE event = 'guest_converted'`).toHaveLength(1);
  });
  it('fills country on queued play and conversion without changing the identity', async () => {
    const x = await fixture();
    await guestJourneyRepo.activity(x.guest, null, randomUUID(), 'play_started', 'ranked');
    await db.sql.begin(tx => linkGuestInTx(tx, guestTokenHash(x.token)!, x.member, true));
    await guestJourneyRepo.setCountry(x.guest, 'GE');
    await guestJourneyRepo.setCountry(x.guest, 'US');
    expect((await db.sql`SELECT properties FROM guest_journey_events`).every(e => e.properties.guest_country === 'GE')).toBe(true);
  });
  it('persists first-play country, links real signup and retries exactly once', async () => {
    const x = await fixture(); const event = randomUUID();
    await guestJourneyRepo.activity(x.guest, 'GE', event, 'play_started', 'ticTacToe');
    await guestJourneyRepo.activity(x.guest, 'US', event, 'play_started', 'ticTacToe');
    await db.sql.begin(tx => linkGuestInTx(tx, guestTokenHash(x.token)!, x.member, true));
    await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member);
    const [j] = await db.sql`SELECT * FROM guest_journeys`;
    expect(j).toMatchObject({ country: 'GE', first_mode: 'ticTacToe', linked_user_id: x.member, link_type: 'signup' });
    expect((await db.sql`SELECT linked_user_id FROM guest_sessions`)[0].linked_user_id).toBe(x.member);
    const events = await db.sql`SELECT event FROM guest_journey_events ORDER BY occurred_at`;
    expect(events.map(e => e.event)).toEqual(['guest_play_started', 'guest_converted']);
  });
  it('classifies existing-member authentication separately', async () => {
    const x = await fixture();
    await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member);
    expect((await db.sql`SELECT event FROM guest_journey_events`)[0].event).toBe('guest_returning_member_linked');
  });
  it('cannot move a guest between members, even with simultaneous replicas', async () => {
    const x = await fixture(); const [other] = await db.sql`INSERT INTO users DEFAULT VALUES RETURNING id`;
    const linked = await Promise.all([guestJourneyRepo.link(guestTokenHash(x.token)!, x.member), guestJourneyRepo.link(guestTokenHash(x.token)!, other.id)]);
    expect(linked.filter(Boolean)).toHaveLength(1);
    expect(await db.sql`SELECT * FROM guest_journey_events`).toHaveLength(1);
  });
  it('does not link expired tokens or guest/bot/deleted targets', async () => {
    const x = await fixture();
    await db.sql`UPDATE users SET is_guest = true WHERE id = ${x.member}`;
    expect(await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member)).toBeNull();
    await db.sql`UPDATE users SET is_guest = false, is_ai = true WHERE id = ${x.member}`;
    expect(await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member)).toBeNull();
    await db.sql`UPDATE users SET is_ai = false, is_deleted = true WHERE id = ${x.member}`;
    expect(await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member)).toBeNull();
    await db.sql`UPDATE users SET is_deleted = false WHERE id = ${x.member}`;
    await db.sql`UPDATE guest_sessions SET last_seen_at = now() - interval '31 days'`;
    expect(await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member)).toBeNull();
  });
  it('rolls account and attribution back together on failed signup', async () => {
    const x = await fixture();
    await expect(db.sql.begin(async tx => { await linkGuestInTx(tx, guestTokenHash(x.token)!, x.member, true); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(await db.sql`SELECT * FROM guest_journeys`).toHaveLength(0);
    expect((await db.sql`SELECT linked_user_id FROM guest_sessions`)[0].linked_user_id).toBeNull();
  });
  it('preserves the multiplayer guest user mapping after its login identity is retired', async () => {
    const x = await fixture();
    const [guestUser] = await db.sql`INSERT INTO users (is_guest) VALUES (true) RETURNING id`;
    await db.sql`INSERT INTO user_identities (id, user_id, provider, subject) VALUES (${randomUUID()}, ${guestUser.id}, 'guest', ${x.guest})`;
    await db.sql.begin(tx => linkGuestInTx(tx, guestTokenHash(x.token)!, x.member, true));
    await db.sql`DELETE FROM user_identities WHERE user_id = ${guestUser.id}`;
    await db.sql`DELETE FROM guest_sessions WHERE id = ${x.guest}`;
    const [journey] = await db.sql`SELECT * FROM guest_journeys`;
    expect(journey.guest_user_id).toBe(guestUser.id);
    expect(journey.linked_user_id).toBe(x.member);
  });
  it('retains attribution after guest cleanup and follows member play across devices', async () => {
    const x = await fixture();
    await db.sql.begin(tx => linkGuestInTx(tx, guestTokenHash(x.token)!, x.member, true));
    await db.sql`DELETE FROM guest_sessions WHERE id = ${x.guest}`;
    await guestJourneyRepo.memberActivity(x.member, randomUUID(), 'play_started', 'ranked');
    expect(await db.sql`SELECT * FROM guest_journeys`).toHaveLength(1);
    expect((await db.sql`SELECT event FROM guest_journey_events ORDER BY occurred_at`).map(x => x.event)).toEqual(['guest_converted', 'guest_member_play_started']);
  });
  it('does not let guest play continue into a claimed journey', async () => {
    const x = await fixture();
    await guestJourneyRepo.link(guestTokenHash(x.token)!, x.member);
    await guestJourneyRepo.activity(x.guest, 'GE', randomUUID(), 'play_started', 'ranked');
    expect(await db.sql`SELECT * FROM guest_journey_events`).toHaveLength(1);
  });
  it('protects both tables from direct client reads and writes', async () => {
    const grants = await db.sql`SELECT has_table_privilege('anon','guest_journeys','SELECT') AS anon_read,
      has_table_privilege('authenticated','guest_journeys','UPDATE') AS member_write,
      has_table_privilege('authenticated','guest_journey_events','INSERT') AS member_insert`;
    expect(grants[0]).toEqual({ anon_read: false, member_write: false, member_insert: false });
    const flags = await db.sql`SELECT relrowsecurity FROM pg_class WHERE oid IN ('guest_journeys'::regclass,'guest_journey_events'::regclass)`;
    expect(flags.every(f => f.relrowsecurity)).toBe(true);
  });
});

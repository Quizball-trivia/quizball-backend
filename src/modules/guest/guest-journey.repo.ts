import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import type { Json } from '../../db/types.js';
import { sql } from '../../db/index.js';

export function guestTokenHash(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
    ? createHash('sha256').update(value).digest('hex') : null;
}
export interface Journey {
  guest_id: string; guest_user_id: string | null; created_at: string; country: string | null; locale: string | null;
  first_play_at: string | null; first_mode: string | null;
  linked_user_id: string | null; linked_at: string | null; link_type: 'signup' | 'existing_member' | null;
}
async function ensureJourney(tx: TransactionSql, guestId: string, country: string | null = null): Promise<Journey | undefined> {
  await tx.unsafe(`INSERT INTO guest_journeys (guest_id, created_at, locale, country)
    SELECT id, created_at, locale, $2 FROM guest_sessions WHERE id = $1
    ON CONFLICT (guest_id) DO NOTHING`, [guestId, country]);
  const [journey] = await tx.unsafe<Journey[]>('SELECT * FROM guest_journeys WHERE guest_id = $1 FOR UPDATE', [guestId]);
  return journey;
}
export async function enqueueJourneyEvent(tx: TransactionSql, j: Journey, key: string, event: string, extra: Record<string, unknown> = {}): Promise<void> {
  await tx.unsafe(`INSERT INTO guest_journey_events (guest_id, dedupe_key, event, properties, next_attempt_at)
    VALUES ($1, $2, $3, $4::jsonb, now() + interval '5 seconds') ON CONFLICT (guest_id, dedupe_key) DO NOTHING`,
  [j.guest_id, key, event, {
    guest_id: j.guest_id, guest_country: j.country ?? 'Unknown', guest_locale: j.locale ?? 'Unknown',
    first_mode: j.first_mode, first_play_at: j.first_play_at, link_type: j.link_type,
    tracking_version: 1, ...extra,
  } as Json]);
}
/** Called inside the transaction that really inserts the member. A login cannot set signup=true. */
export async function linkGuestInTx(tx: TransactionSql, tokenHash: string, userId: string, signup: boolean): Promise<Journey | null> {
  const [session] = await tx.unsafe<{ id: string }[]>(`SELECT id FROM guest_sessions
    WHERE token_hash = $1 AND last_seen_at > now() - interval '30 days' FOR UPDATE`, [tokenHash]);
  if (!session) return null;
  const j = await ensureJourney(tx, session.id);
  if (!j || j.linked_at) return j?.linked_user_id === userId ? j : null;
  const [member] = await tx.unsafe<{ id: string }[]>(`SELECT id FROM users WHERE id = $1
    AND is_guest = false AND is_ai = false AND is_seed = false AND is_deleted = false
    AND deleted_at IS NULL AND pending_deletion_at IS NULL`, [userId]);
  if (!member) return null;
  const [linked] = await tx.unsafe<Journey[]>(`UPDATE guest_journeys SET linked_user_id = $2,
    guest_user_id = (SELECT user_id FROM user_identities WHERE provider = 'guest' AND subject = guest_journeys.guest_id::text),
    linked_at = now(), link_type = $3 WHERE guest_id = $1 RETURNING *`, [session.id, userId, signup ? 'signup' : 'existing_member']);
  await tx.unsafe('UPDATE guest_sessions SET linked_user_id = $2 WHERE id = $1', [session.id, userId]);
  await enqueueJourneyEvent(tx, linked, 'link', signup ? 'guest_converted' : 'guest_returning_member_linked', {
    member_id: userId, had_guest_play: Boolean(linked.first_play_at), access_type: 'member',
  });
  return linked;
}
export const guestJourneyRepo = {
  async setCountry(guestId: string, country: string): Promise<void> {
    await sql.begin(async tx => {
      const [j] = await tx.unsafe<Journey[]>(`UPDATE guest_journeys SET country = $2
        WHERE guest_id = $1 AND country IS NULL RETURNING *`, [guestId, country]);
      if (j) await tx.unsafe(`UPDATE guest_journey_events SET properties = jsonb_set(properties, '{guest_country}', to_jsonb($2::text))
        WHERE guest_id = $1 AND delivered_at IS NULL AND lease_until IS NULL`, [guestId, country]);
    });
  },
  async hasCountry(guestId: string): Promise<boolean> {
    const [row] = await sql`SELECT country FROM guest_journeys WHERE guest_id = ${guestId}`;
    return Boolean(row?.country);
  },
  async link(tokenHash: string, userId: string): Promise<Journey | null> {
    return sql.begin(tx => linkGuestInTx(tx, tokenHash, userId, false));
  },
  async activity(guestId: string, country: string | null, eventId: string, step: string, mode: string): Promise<void> {
    await sql.begin(async tx => {
      // Same lock order as signup; first-play and signup are serialized across replicas.
      const [session] = await tx.unsafe(`SELECT id FROM guest_sessions WHERE id = $1 FOR UPDATE`, [guestId]);
      if (!session) return;
      let j = await ensureJourney(tx, guestId, country);
      if (!j || j.linked_at) return; // Shared browsers cannot add guest activity to an already claimed journey.
      if (step === 'play_started' && !j.first_play_at) {
        [j] = await tx.unsafe<Journey[]>(`UPDATE guest_journeys SET first_play_at = now(), first_mode = $2,
          country = coalesce(country, $3) WHERE guest_id = $1 RETURNING *`, [guestId, mode, country]);
      }
      await enqueueJourneyEvent(tx, j, eventId, `guest_${step}`, { mode, access_type: 'guest' });
    });
  },
  async memberActivity(userId: string, eventId: string, step: string, mode: string): Promise<void> {
    await sql.begin(async tx => {
      const [j] = await tx.unsafe<Journey[]>(`SELECT j.* FROM guest_journeys j JOIN users u ON u.id = j.linked_user_id
        WHERE j.linked_user_id = $1 AND j.link_type = 'signup' AND u.is_deleted = false AND u.deleted_at IS NULL`, [userId]);
      if (j) await enqueueJourneyEvent(tx, j, eventId, `guest_member_${step}`, { mode, member_id: userId, access_type: 'member' });
    });
  },
};

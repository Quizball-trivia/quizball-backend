/**
 * One locale's auction clue cards for PRODUCTION, copied from staging, where clue-cards-pt.ts inserted them: one row per
 * published English card, a mirror of that card (family, variant, difficulty, status, evidence) with translated clues.
 *
 * Card ids and football_player ids differ between environments, so a production English card is matched to a staging
 * English card on its content: player (name + Transfermarkt id), variant, difficulty and the three English clues, which
 * must be unique on both sides. The staging translation is the row whose review_notes reads "<note><staging card id>".
 * The production row is built the way the staging script built it, from the PRODUCTION English card (its ids, family
 * and evidence), with staging's clues. A card that already has a row in the locale (same note, family or published
 * variant slot) is left alone. Cards with no match are listed: they need translating on production.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/clue-cards-locale-from-staging.ts --locale=pt [--write]
 *
 * Writes: inserts in chunks (lock 2 s, statement 15 s); the new ids are snapshotted first (undo: DELETE … WHERE id = ANY(ids)
 * AND locale = '<locale>'); inside the transaction the English source is re-read FOR SHARE and skipped if it changed.
 */
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { banner, connect, pause, readOnly, requireLocale, sample, snapshot, uniqueBy, WRITE, writeTx } from './locale-copy-common.js';

const NOTES: Record<string, string> = { pt: 'Brazilian Portuguese translation of ', ru: 'Russian translation of ', de: 'German translation of ', fr: 'French translation of ' };
const LOCALE = requireLocale(Object.keys(NOTES));
const NOTE = NOTES[LOCALE];
const CHUNK = 100;
const { prod, staging } = connect();

type English = { id: string; player: string; tm: string | null; variant_key: string | null; difficulty: string; clue_1: string; clue_2: string; clue_3: string; has_locale: boolean };
type Translation = { source_id: string; clue_1: string; clue_2: string; clue_3: string; generation_provider: string | null; generation_model: string | null };

const fingerprint = (c: { clue_1: unknown; clue_2: unknown; clue_3: unknown }) => createHash('sha256').update(JSON.stringify([c.clue_1, c.clue_2, c.clue_3])).digest('hex');
const matchKey = (c: English) => JSON.stringify([c.player, c.tm, c.variant_key, c.difficulty, c.clue_1, c.clue_2, c.clue_3]);

/** Whether a row in the locale already stands for the English card `c` (the staging script's own test). */
const hasLocale = (tx: postgres.Sql) => tx`EXISTS (SELECT 1 FROM player_clue_cards r WHERE r.locale = ${LOCALE} AND (
    r.review_notes = ${NOTE} || c.id::text
    OR (c.card_family_id IS NOT NULL AND r.card_family_id = c.card_family_id)
    OR (c.variant_key IS NOT NULL AND r.football_player_id = c.football_player_id AND r.variant_key = c.variant_key AND r.status = 'published')))`;

async function englishCards(sql: postgres.Sql): Promise<English[]> {
  return readOnly(sql, (tx) => tx<English[]>`
    SELECT c.id::text, fp.name AS player, fp.transfermarkt_id::text AS tm, c.variant_key, c.difficulty, c.clue_1, c.clue_2, c.clue_3,
           ${hasLocale(tx)} AS has_locale
      FROM player_clue_cards c JOIN football_players fp ON fp.id = c.football_player_id
     WHERE c.locale = 'en' AND c.status = 'published'`);
}

async function main() {
  banner('player_clue_cards', LOCALE);
  const [target, source, translations] = await Promise.all([
    englishCards(prod),
    englishCards(staging),
    readOnly(staging, (tx) => tx<Translation[]>`
      SELECT substr(review_notes, ${NOTE.length + 1}) AS source_id, clue_1, clue_2, clue_3, generation_provider, generation_model
        FROM player_clue_cards WHERE locale = ${LOCALE} AND status = 'published' AND starts_with(review_notes, ${NOTE})`),
  ]);
  const bySource = uniqueBy(translations, (t) => t.source_id);
  const stagingByKey = uniqueBy(source, matchKey);
  const prodByKey = uniqueBy(target, matchKey);
  const stats = { prodEnglish: target.length, alreadyLocale: 0, ambiguous: 0, noStagingMatch: 0, stagingUntranslated: 0, toInsert: 0 };
  const unmatched: string[] = [];
  const plan: Array<{ english: English; translation: Translation }> = [];
  for (const card of target) {
    if (card.has_locale) { stats.alreadyLocale += 1; continue; }
    const key = matchKey(card);
    const twin = stagingByKey.get(key);
    if (prodByKey.get(key) === null || twin === null) { stats.ambiguous += 1; unmatched.push(card.id); continue; }
    if (twin === undefined) { stats.noStagingMatch += 1; unmatched.push(card.id); continue; }
    const translation = bySource.get(twin.id);
    if (!translation) { stats.stagingUntranslated += 1; unmatched.push(card.id); continue; }
    plan.push({ english: card, translation });
  }
  stats.toInsert = plan.length;
  console.log(stats);
  if (unmatched.length) console.log(`production English cards that stay without ${LOCALE} (translate on production): ${unmatched.length}${sample(unmatched)}`);
  if (!WRITE || plan.length === 0) return;

  let inserted = 0, changed = 0, conflicts = 0;
  for (let c = 0; c < plan.length; c += CHUNK) {
    const chunk = plan.slice(c, c + CHUNK).map((p) => ({ ...p, id: randomUUID() }));
    console.log(`  new ids ${snapshot(`clue-cards-${LOCALE}`, chunk.map((p) => ({ id: p.id, english: p.english.id })))}`);
    const result = await writeTx(prod, async (tx) => {
      // The English sources as they are now, locked: a card edited, unpublished or translated since the read is left out.
      const now = await tx<Array<Record<string, unknown> & { id: string; has_locale: boolean }>>`
        SELECT c.*, ${hasLocale(tx)} AS has_locale FROM player_clue_cards c
         WHERE c.id = ANY(${chunk.map((p) => p.english.id)}::uuid[]) FOR SHARE`;
      const current = new Map(now.map((r) => [r.id, r]));
      const rows = chunk.flatMap(({ id, english, translation }) => {
        const r = current.get(english.id);
        if (!r || r.has_locale || r.status !== 'published' || r.locale !== 'en' || fingerprint(r as never) !== fingerprint(english)) return [];
        const { has_locale: _ignored, created_at: _c, updated_at: _u, ...card } = r;
        return [{
          ...card, id, locale: LOCALE, clue_1: translation.clue_1, clue_2: translation.clue_2, clue_3: translation.clue_3,
          source: 'imported', generation_provider: translation.generation_provider, generation_model: translation.generation_model,
          review_notes: `${NOTE}${english.id}`, rejection_reason: null,
        }];
      });
      if (rows.length === 0) return { inserted: 0, changed: chunk.length, conflicts: 0 };
      const columns = Object.keys(rows[0]);
      // ON CONFLICT: a row the partial unique indexes (family / published variant per locale) already hold is kept.
      const done = await tx`INSERT INTO player_clue_cards ${tx(rows as never, columns as never)} ON CONFLICT DO NOTHING RETURNING id`;
      return { inserted: done.length, changed: chunk.length - rows.length, conflicts: rows.length - done.length };
    });
    inserted += result.inserted; changed += result.changed; conflicts += result.conflicts;
    console.log(`cards ${Math.min(c + CHUNK, plan.length)}/${plan.length} · inserted ${inserted} · source changed meanwhile ${changed} · already held ${conflicts}`);
    await pause();
  }
  console.log(`inserted ${inserted} ${LOCALE} clue cards`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all([prod.end(), staging.end()]));

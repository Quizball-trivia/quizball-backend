#!/usr/bin/env npx tsx
/**
 * One script's accepted names for FIFA Cards / Card Detective on PRODUCTION, copied from staging: the names in that
 * script (Greek for el, Cyrillic for ru) that a staging card's `accepted` holds and the production card with the same
 * source_key and the same English name lacks. Only appends, in staging's order. The game shows the Greek name with the
 * most words (the full name, not a surname alone). Run --write only with the owner's go.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/fifa-cards-locale-from-staging.ts --locale=el           # dry run
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/fifa-cards-locale-from-staging.ts --locale=el --write
 */
import { banner, connect, readOnly, requireLocale, sample, snapshot, WRITE, writeTx } from './locale-copy-common.js';

const LOCALE = requireLocale(['el', 'ru']);
// A name in the script: every letter in it (marks, spaces, dots, apostrophes and hyphens allowed between).
const SCRIPT = LOCALE === 'el' ? /^[\p{Script=Greek}\p{M}\s.'’-]+$/u : /^[\p{Script=Cyrillic}\p{M}\s.'’-]+$/u;
const { prod, staging } = connect();

type Card = { id: string; source_key: string; name: string; accepted: string[] };
const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/ς/g, 'σ').replace(/\s+/g, ' ').trim();

async function main() {
  banner('FIFA cards accepted names', LOCALE);
  const read = (sql: typeof prod) => readOnly(sql, (tx) => tx<Card[]>`SELECT id, source_key, name, accepted FROM fifa_cards`);
  const [target, source] = await Promise.all([read(prod), read(staging)]);
  const bySource = new Map(source.map((c) => [c.source_key, c]));
  const stats = { productionCards: target.length, noSource: 0, nameDiffers: 0, alreadyHas: 0, toWrite: 0, names: 0 };
  const plan: Array<{ id: string; name: string; before: string[]; add: string[] }> = [];
  for (const card of target) {
    const src = bySource.get(card.source_key);
    if (!src) { stats.noSource += 1; continue; }
    if (src.name !== card.name) { stats.nameDiffers += 1; continue; }
    const have = new Set(card.accepted.map(fold));
    const add = src.accepted.filter((a) => /\p{L}/u.test(a) && SCRIPT.test(a) && !have.has(fold(a)));
    if (add.length === 0) { stats.alreadyHas += 1; continue; }
    plan.push({ id: card.id, name: card.name, before: card.accepted, add });
    stats.toWrite += 1; stats.names += add.length;
  }
  console.log(stats);
  if (stats.noSource) console.log(`  production cards with no staging card${sample(target.filter((c) => !bySource.has(c.source_key)).map((c) => c.source_key))}`);
  if (!WRITE) { console.log('\nnothing written'); return; }
  const pre = snapshot(`fifa_cards-${LOCALE}-preimage`, target.filter((c) => plan.some((p) => p.id === c.id)).map((c) => ({ id: c.id, accepted: c.accepted })));
  console.log(`pre-image ${pre}`);
  let written = 0;
  let changed = 0;
  for (let i = 0; i < plan.length; i += 100) {
    const batch = plan.slice(i, i + 100);
    await writeTx(prod, async (tx) => {
      for (const p of batch) {
        // Only a card still exactly as read (name and accepted list): an edit or another run in between is left alone.
        const result = await tx`UPDATE fifa_cards SET accepted = accepted || ${p.add}::text[], updated_at = now()
                                 WHERE id = ${p.id} AND name = ${p.name} AND accepted = ${p.before}::text[]`;
        if (result.count === 1) written += 1; else changed += 1;
      }
    });
  }
  console.log(`written ${written} cards, skipped (changed since read) ${changed}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all([prod.end(), staging.end()]));

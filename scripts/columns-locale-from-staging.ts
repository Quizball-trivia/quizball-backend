/**
 * One locale's own columns for PRODUCTION, copied from staging: campaign quiz page copy (<locale>_*, from
 * campaign-quizzes-pt.ts), Squad Spin criterion labels (label_<locale>, squad-spin-pt.ts), Squad Spin player names
 * (name_<locale>; Russian only, pt has none) and Football Grid / Tic Tac Toe criterion labels (label_<locale>,
 * football-grid-label-pt.ts).
 *
 * Rows match on a natural key, never on a generated id: a page's slug, a Squad Spin criterion's key, a grid criterion's
 * (criterion_key, label_en). Grid criteria are per content release and production has its own releases, so one staging
 * label can fill many production rows; staging rows that share a key must agree on the English and the locale text,
 * or the key is ambiguous and skipped. A production row is written only when every English counterpart is identical
 * on both sides and every locale column of the row is still empty; nothing else changes (the grid's append-only
 * trigger lets exactly these label columns through). A table whose locale columns do not exist is skipped.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/columns-locale-from-staging.ts --locale=pt [--tables=a,b] [--write]
 *
 * Grid labels: the backend caches board views for 60 minutes (football-grid.repo.ts) — restart it after the write.
 */
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { banner, blank, connect, opt, pause, readOnly, requireLocale, sample, snapshot, WRITE, writeTx } from './locale-copy-common.js';

const LOCALE = requireLocale();
type Row = Record<string, unknown>;
interface Spec {
  table: string;
  /** Unique column the UPDATE targets. */
  pk: string;
  /** Natural key shared by both environments. */
  key: string[];
  /** Further English (or identity) columns that must be equal on both sides. */
  english: string[];
  /** The locale's columns: filled together, only where all are empty. */
  locale: string[];
  json?: string[];
  /** Locale columns the source must have filled (a page without them is not an edition). */
  required?: string[];
  campaignGuard?: boolean;
}
const CAMPAIGN = ['title', 'h1', 'seo_title', 'meta_description', 'breadcrumb_label', 'lede', 'about_heading', 'about_blocks', 'hero_image_alt', 'og_image_alt', 'score_cta', 'footer_banner_text', 'footer_button_label'];
const SPECS: Spec[] = [
  { table: 'campaign_quizzes', pk: 'slug', key: ['slug'], english: CAMPAIGN, locale: CAMPAIGN.map((f) => `${LOCALE}_${f}`), json: ['about_blocks', `${LOCALE}_about_blocks`], required: ['h1', 'seo_title', 'meta_description'].map((f) => `${LOCALE}_${f}`), campaignGuard: true },
  { table: 'squad_spin_criteria', pk: 'id', key: ['criterion_key'], english: ['family', 'label_en'], locale: [`label_${LOCALE}`] },
  { table: 'squad_spin_players', pk: 'id', key: ['id'], english: ['name_en'], locale: [`name_${LOCALE}`] },
  { table: 'football_grid_criteria', pk: 'id', key: ['criterion_key', 'label_en'], english: ['family'], locale: [`label_${LOCALE}`] },
];
const wanted = opt('tables')?.split(',').filter(Boolean) ?? [];
for (const t of wanted) if (!SPECS.some((s) => s.table === t)) { console.error(`ABORT: unknown table ${t}`); process.exit(1); }
const specs = wanted.length ? SPECS.filter((s) => wanted.includes(s.table)) : SPECS;
const CHUNK = 100;
const { prod, staging } = connect();

const missingColumns = async (sql: postgres.Sql, spec: Spec): Promise<string[]> => {
  const present = await readOnly(sql, (tx) => tx<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${spec.table}`);
  const have = new Set(present.map((c) => c.column_name));
  return [spec.pk, ...spec.key, ...spec.english, ...spec.locale].filter((c) => !have.has(c));
};
const keyOf = (spec: Spec, r: Row) => JSON.stringify(spec.key.map((k) => r[k]));
const localeEmpty = (spec: Spec, r: Row) => spec.locale.every((c) => blank(r[c]));

async function copy(spec: Spec) {
  const [prodMissing, stagingMissing] = await Promise.all([missingColumns(prod, spec), missingColumns(staging, spec)]);
  if (stagingMissing.length) { console.log(`${spec.table}: skipped — staging has no ${stagingMissing.join(', ')}`); return; }
  if (prodMissing.length) { console.log(`${spec.table}: SKIPPED — production lacks ${prodMissing.join(', ')} (deploy the backend with its migrations first)`); return; }
  const cols = [...new Set([`${spec.pk}::text AS ${spec.pk}`, ...spec.key, ...spec.english, ...spec.locale])];
  const read = (sql: postgres.Sql) => readOnly(sql, (tx) => tx.unsafe<Row[]>(`SELECT ${cols.join(', ')} FROM ${spec.table}`));
  const [target, sourceRows] = await Promise.all([read(prod), read(staging)]);

  // One staging answer per key: every row of the key has the same English, and those with the locale agree on it.
  const source = new Map<string, Row | null>();
  const groups = new Map<string, Row[]>();
  for (const r of sourceRows) groups.set(keyOf(spec, r), [...(groups.get(keyOf(spec, r)) ?? []), r]);
  for (const [key, rows] of groups) {
    const sameEnglish = rows.every((r) => spec.english.every((c) => isDeepStrictEqual(r[c], rows[0][c])));
    const filled = rows.filter((r) => !localeEmpty(spec, r));
    const agree = filled.every((r) => spec.locale.every((c) => isDeepStrictEqual(r[c], filled[0][c])));
    source.set(key, !sameEnglish || !agree ? null : filled[0] ?? rows[0]);
  }

  const stats = { rows: target.length, alreadyLocale: 0, noSource: 0, ambiguousKey: 0, sourceNoLocale: 0, partialSource: 0, englishDiffers: 0, toWrite: 0 };
  const left: string[] = [];
  const plan: Array<{ row: Row; values: Row }> = [];
  for (const row of target) {
    if (!localeEmpty(spec, row)) { stats.alreadyLocale += 1; continue; }
    const key = keyOf(spec, row);
    const s = source.get(key);
    if (s === undefined) { stats.noSource += 1; left.push(key); continue; }
    if (s === null) { stats.ambiguousKey += 1; left.push(key); continue; }
    if (localeEmpty(spec, s)) { stats.sourceNoLocale += 1; left.push(key); continue; }
    if ((spec.required ?? []).some((c) => blank(s[c]))) { stats.partialSource += 1; left.push(key); continue; }
    if (!spec.english.every((c) => isDeepStrictEqual(row[c], s[c]))) { stats.englishDiffers += 1; left.push(key); continue; }
    plan.push({ row, values: Object.fromEntries(spec.locale.map((c) => [c, s[c]])) });
  }
  stats.toWrite = plan.length;
  console.log(spec.table, stats);
  if (left.length) console.log(`  production rows that stay without ${LOCALE} (need translating on production): ${left.length}${sample(left)}`);
  if (spec.table === 'campaign_quizzes') for (const p of plan) console.log(`  ${WRITE ? 'write' : 'would write'}  ${String(p.row.slug)}: ${String(p.values[`${LOCALE}_seo_title`] ?? '(no seo title)')}`);
  if (!WRITE || plan.length === 0) return;

  console.log(`  plan ${snapshot(`${spec.table}-${LOCALE}-plan`, plan.map((p) => ({ [spec.pk]: p.row[spec.pk], ...p.values })))}`);
  const json = new Set(spec.json ?? []);
  const guarded = [...new Set([...spec.key, ...spec.english])];
  const recordCols = [`pk text`, ...spec.locale.map((c) => `${c} ${json.has(c) ? 'jsonb' : 'text'}`), ...guarded.map((c) => `en__${c} ${json.has(c) ? 'jsonb' : 'text'}`)].join(', ');
  const emptyNow = spec.locale.map((c) => (json.has(c) ? `(t.${c} IS NULL OR t.${c} = 'null'::jsonb)` : `coalesce(btrim(t.${c}), '') = ''`)).join(' AND ');
  const englishNow = guarded.map((c) => `${json.has(c) ? `t.${c}` : `t.${c}::text`} IS NOT DISTINCT FROM v.en__${c}`).join(' AND ');
  let written = 0, failed = 0;
  for (let c = 0; c < plan.length; c += CHUNK) {
    const records = plan.slice(c, c + CHUNK).map(({ row, values }) => ({ pk: String(row[spec.pk]), ...values, ...Object.fromEntries(guarded.map((g) => [`en__${g}`, row[g]])) }));
    try {
      const done = await writeTx(prod, async (tx) => {
        // Only rows whose locale is still empty and whose English is still what was compared.
        return tx.unsafe(`UPDATE ${spec.table} t SET ${spec.locale.map((l) => `${l} = v.${l}`).join(', ')}
          FROM jsonb_to_recordset($1::jsonb) AS v(${recordCols})
          WHERE t.${spec.pk}::text = v.pk AND ${emptyNow} AND ${englishNow} RETURNING 1`, [records] as never[]);
      }, { campaignGuard: spec.campaignGuard });
      written += done.length;
    } catch (e) {
      failed += records.length;
      console.error(`  ${spec.table} chunk ${c / CHUNK + 1} rolled back: ${(e as Error).message}`);
    }
    await pause();
  }
  console.log(`  ${spec.table}: written ${written} of ${plan.length}, failed ${failed}`);
  if (failed > 0) process.exitCode = 1;
}

async function main() {
  banner(`locale columns · tables ${specs.map((s) => s.table).join(',')}`, LOCALE);
  for (const spec of specs) await copy(spec);
  if (WRITE && specs.some((s) => s.table === 'football_grid_criteria')) console.log('\nGrid labels: restart the production backend (board views are cached in-process for 60 minutes).');
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all([prod.end(), staging.end()]));

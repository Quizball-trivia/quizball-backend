#!/usr/bin/env npx tsx
/**
 * One full-copy language's campaign quiz page text for PRODUCTION, copied from staging, where
 * scripts/campaign-quizzes-<locale>.ts applied it. Georgian's locale_mode='en_ka' is set here too, on complete pages only.
 *
 * A page is written only when, on production, it is complete by the service's own rule. So run
 * questions-locale-from-staging.ts first: a page whose production questions are not all translated is left untouched,
 * and running this again later picks it up. Pages match by slug, and every English field must be identical on both
 * sides. The staging copy must be complete, and existing production copy is never overwritten.
 *
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/campaign-quiz-edition-to-prod.ts --locale=ka [--slugs=a,b]           # dry run
 *   PROD_DATABASE_URL=… STAGING_DATABASE_URL=… npx tsx scripts/campaign-quiz-edition-to-prod.ts --locale=ka [--slugs=a,b] --write   # write
 *
 * Both URLs must be Supabase pooler URLs naming their project. A dry run only issues plain SELECTs, and works before the
 * migration (it then reports what would block the copy). A write re-checks everything with the page and question rows locked, snapshots
 * them first under scripts/.snapshots, and rolls back unless about_blocks was stored as an array.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import postgres from 'postgres';
import { PROD_REF, STAGING_REF } from './staging-target.js';
import { EDITION_TEXT_FIELDS, FULL_COPY_LOCALES, hasEdition, missingEditionCopy, type EditionLocale } from '../src/modules/campaign-quizzes/campaign-quizzes.editions.js';
import { missingLocaleSlots, questionsHaveLocale } from '../src/modules/campaign-quizzes/campaign-quizzes.questions.js';
import type { CampaignQuizQuestionRow } from '../src/modules/campaign-quizzes/campaign-quizzes.repo.js';

type Row = Record<string, unknown>;
const ENGLISH_COLUMNS = [...EDITION_TEXT_FIELDS, 'about_blocks'];
const localeColumns = (locale: string) => ENGLISH_COLUMNS.map((field) => `${locale}_${field}`);
const blank = (value: unknown) => value === null || value === undefined || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

export type PageDecision =
  | { action: 'write' | 'activate' | 'nothing' }
  | { action: 'skip'; reason: 'no_staging_page' | 'english_differs' | 'staging_copy_incomplete' | 'production_copy_differs' | 'production_copy_incomplete' | 'questions_incomplete'; detail?: string[] };

/** What to do with one production page. `activate` sets locale_mode; `write` also copies the text. */
export function decidePage(input: {
  locale: EditionLocale;
  /** Georgian's per-page switch. */
  activatesLocaleMode: boolean;
  target: Row;
  source: Row | undefined;
  questions: CampaignQuizQuestionRow[];
}): PageDecision {
  const { locale, target, source, questions, activatesLocaleMode } = input;
  if (!source) return { action: 'skip', reason: 'no_staging_page' };
  const differs = ENGLISH_COLUMNS.filter((column) => !isDeepStrictEqual(target[column] ?? null, source[column] ?? null));
  if (differs.length) return { action: 'skip', reason: 'english_differs', detail: differs };
  const stagingMissing = missingEditionCopy(source as never, locale);
  if (stagingMissing.length) return { action: 'skip', reason: 'staging_copy_incomplete', detail: stagingMissing };
  if (!questionsHaveLocale(questions, locale)) return { action: 'skip', reason: 'questions_incomplete' };

  const columns = localeColumns(locale);
  const conflicts = columns.filter((column) => !blank(target[column]) && !isDeepStrictEqual(target[column], source[column] ?? null));
  if (conflicts.length) {
    const productionMissing = missingEditionCopy(target as never, locale);
    if (productionMissing.length) return { action: 'skip', reason: 'production_copy_incomplete', detail: productionMissing };
    // Complete copy someone wrote on production stays, and can still open.
    if (!activatesLocaleMode || target.locale_mode === 'en_ka') return { action: 'skip', reason: 'production_copy_differs', detail: conflicts };
    return { action: 'activate' };
  }
  // Every existing value agrees with staging (the four older ka_* fields, say), so the empty ones can be filled.
  if (columns.some((column) => blank(target[column]) && !blank(source[column]))) return { action: 'write' };
  return activatesLocaleMode && target.locale_mode !== 'en_ka' ? { action: 'activate' } : { action: 'nothing' };
}

function poolerUrl(name: string, expectedUser: string): string {
  const raw = process.env[name] ?? '';
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} is not set or not a valid URL`); }
  if ([...url.searchParams.keys()].some((key) => key !== 'sslmode')) throw new Error(`${name} may not carry connection parameters`);
  if (!url.hostname.endsWith('.pooler.supabase.com')) throw new Error(`${name} must use the Supabase pooler host`);
  if (decodeURIComponent(url.username) !== expectedUser) throw new Error(`${name} must be the pooler user ${expectedUser}`);
  url.port = '6543';
  return url.href;
}

async function main() {
  const opt = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const WRITE = process.argv.includes('--write');
  const locale = opt('locale') as EditionLocale | undefined;
  if (!locale || !FULL_COPY_LOCALES.includes(locale)) throw new Error(`--locale=<${FULL_COPY_LOCALES.join('|')}> is required`);
  const only = new Set((opt('slugs') ?? '').split(',').filter(Boolean));
  const activatesLocaleMode = locale === 'ka';
  const options = { prepare: false, max: 1, ssl: 'require' as const, onnotice: () => {}, connect_timeout: 20, idle_timeout: 20 };
  const stagingUrl = poolerUrl('STAGING_DATABASE_URL', `postgres.${STAGING_REF}`);
  if (decodeURIComponent(stagingUrl).includes(PROD_REF)) throw new Error('STAGING_DATABASE_URL names the production project');
  const prod = postgres(poolerUrl('PROD_DATABASE_URL', `postgres.${PROD_REF}`), options);
  const staging = postgres(stagingUrl, options);
  const columns = localeColumns(locale);

  /** Plain SELECTs: a BEGIN READ ONLY pipelined with its query through the :6543 pooler has dropped connections here. */
  const absentColumns = async (sql: postgres.Sql) => {
    const present = new Set((await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'campaign_quizzes' AND column_name = ANY(${columns})`).map((c) => c.column_name));
    return columns.filter((column) => !present.has(column));
  };
  const readPages = async (sql: postgres.Sql, have: string[], lock = false) => {
    const rows = await sql.unsafe(`
      SELECT slug, question_set_slug, locale_mode, ${[...ENGLISH_COLUMNS, ...have].join(', ')}
      FROM campaign_quizzes
      WHERE status = 'published' AND COALESCE(scheduled_publish_at, published_at, '-infinity'::timestamptz) <= NOW()
      ORDER BY slug ${lock ? 'FOR UPDATE' : ''}`) as unknown as Row[];
    return rows.filter((row) => !only.size || only.has(row.slug as string));
  };
  const readSets = async (sql: postgres.Sql, pages: Row[], lock = false) => {
    const rows = await sql<Array<CampaignQuizQuestionRow & { set_slug: string }>>`
      SELECT cqq.quiz_slug AS set_slug, q.id::text AS id, cqq.display_order, cqq.difficulty, q.prompt, qp.payload, q.explanation
      FROM campaign_quiz_questions cqq
      JOIN questions q ON q.id = cqq.question_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE cqq.quiz_slug = ANY(${[...new Set(pages.map((page) => page.question_set_slug as string))]})
        AND q.status = 'published' AND q.visibility = 'public' AND q.ranked_eligible = false
      ORDER BY cqq.quiz_slug, cqq.display_order
      ${lock ? sql`FOR SHARE OF cqq, q, qp` : sql``}`;
    const sets = new Map<string, CampaignQuizQuestionRow[]>();
    for (const { set_slug, ...row } of rows) sets.set(set_slug, [...(sets.get(set_slug) ?? []), row]);
    return sets;
  };
  const decide = (target: Row, source: Row | undefined, sets: Map<string, CampaignQuizQuestionRow[]>) =>
    decidePage({ locale, activatesLocaleMode, target, source, questions: sets.get(target.question_set_slug as string) ?? [] });

  try {
    console.log(`PRODUCTION ${PROD_REF} ← staging ${STAGING_REF} · campaign quiz pages · locale ${locale} · ${WRITE ? 'WRITE' : 'dry run (add --write to write)'}\n`);
    const [prodAbsent, stagingAbsent] = [await absentColumns(prod), await absentColumns(staging)];
    if (prodAbsent.length) console.log(`production lacks ${prodAbsent.length}/${columns.length} ${locale}_* columns (deploy the backend first)`);
    if (stagingAbsent.length) console.log(`staging lacks ${stagingAbsent.length}/${columns.length} ${locale}_* columns (deploy the backend and apply there first)`);
    const present = (absent: string[]) => columns.filter((column) => !absent.includes(column));
    const target = await readPages(prod, present(prodAbsent));
    const source = new Map((await readPages(staging, present(stagingAbsent))).map((row) => [row.slug as string, row]));
    const sets = await readSets(prod, target);

    const tally: Record<string, string[]> = {};
    for (const page of target) {
      const decision = decide(page, source.get(page.slug as string), sets);
      const key = decision.action === 'skip' ? `skip: ${decision.reason}` : decision.action;
      (tally[key] ??= []).push(page.slug as string);
      const set = sets.get(page.question_set_slug as string) ?? [];
      const slots = set.reduce((n, row) => n + missingLocaleSlots(row, locale), 0);
      const detail = decision.action === 'skip' && decision.detail ? ` [${decision.detail.join(', ')}]` : '';
      console.log(`  ${String(page.slug).padEnd(20)} ${key}${detail} · production questions ${set.length}, empty ${locale} slots ${slots}`);
    }
    console.log(`\npages: ${target.length}`);
    for (const [key, slugs] of Object.entries(tally)) console.log(`  ${key}: ${slugs.length}`);
    if (!WRITE) { console.log('\nnothing written'); return; }
    if (prodAbsent.length || stagingAbsent.length) throw new Error('columns are missing; nothing written');

    await prod.begin(async (transaction) => {
      const tx = transaction as unknown as postgres.Sql;
      // The production role also ends a transaction idle for 15 s: this stays a few quick statements.
      await tx`SELECT set_config('lock_timeout', '2s', true), set_config('statement_timeout', '15s', true)`;
      // Locked first: a CMS save holds this row while it rewrites the English and the question set. The Questions editor
      // does not, so the assigned questions are share-locked too: none can lose its text before this commits.
      const locked = await readPages(tx, columns, true);
      const lockedSets = await readSets(tx, locked, true);
      const decisions = locked.map((page) => ({ page, decision: decide(page, source.get(page.slug as string), lockedSets) }));
      const writes = decisions.filter((d) => d.decision.action === 'write').map((d) => d.page);
      const activates = activatesLocaleMode ? decisions.filter((d) => d.decision.action === 'write' || d.decision.action === 'activate').map((d) => d.page.slug as string) : [];
      const touched = decisions.filter((d) => d.decision.action === 'write' || d.decision.action === 'activate').map((d) => d.page);
      if (!touched.length) { console.log('nothing to write'); return; }

      mkdirSync('scripts/.snapshots', { recursive: true });
      const file = `scripts/.snapshots/prod-campaign-quizzes-${locale}-${Date.now()}.json`;
      writeFileSync(file, JSON.stringify(touched.map((page) => ({ slug: page.slug, locale_mode: page.locale_mode, ...Object.fromEntries(columns.map((c) => [c, page[c] ?? null])) }))));
      console.log(`pre-image ${file}`);

      const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(', ');
      for (const page of writes) {
        const values = source.get(page.slug as string)!;
        await tx.unsafe(`UPDATE campaign_quizzes SET ${assignments} WHERE slug = $1`, [
          page.slug,
          ...columns.map((column) => (column.endsWith('_about_blocks') && values[column] ? tx.json(values[column] as never) : values[column] ?? null)),
        ] as never[]);
      }
      if (activates.length) await tx`UPDATE campaign_quizzes SET locale_mode = 'en_ka' WHERE slug = ANY(${activates}) AND locale_mode = 'en_only'`;

      // Still inside the transaction: anything but a page the service would serve rolls the whole write back.
      const after = await readPages(tx, columns);
      const touchedSlugs = new Set(touched.map((page) => page.slug));
      const closed = after.filter((page) => touchedSlugs.has(page.slug) && !(hasEdition(page as never, locale) && questionsHaveLocale(lockedSets.get(page.question_set_slug as string) ?? [], locale)));
      if (closed.length) throw new Error(`would not open after the write: ${closed.map((page) => page.slug).join(', ')}; rolled back`);
      console.log(`written ${writes.length}${activatesLocaleMode ? ` · locale_mode en_ka on ${activates.length}` : ''}`);
    });
  } finally {
    await Promise.all([prod.end({ timeout: 5 }), staging.end({ timeout: 5 })]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`ABORT: ${(error as Error).message}`); process.exitCode = 1; });
}

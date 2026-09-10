#!/usr/bin/env npx tsx

// One-way content sync PROD → STAGING: questions (with payloads) and the
// categories they need. Never users, matches, wallets or anything player-made.
//   PROD_DATABASE_URL=... npx tsx scripts/sync-content-from-prod.ts           # dry run
//   PROD_DATABASE_URL=... npx tsx scripts/sync-content-from-prod.ts --apply
//   --rollback=<backup.json>   deletes the rows a previous apply inserted
// A question is copied when neither its id nor its English prompt exists on
// staging; rows already present are left alone, so the script is re-runnable.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';
import postgres from 'postgres';

const PROD_REF = 'lfbwhxvwubzeqkztghok';
const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';

type Backup = {
  version: 1;
  createdAt: string;
  applied: boolean;
  categoryIds: string[];
  questionIds: string[];
};

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().replaceAll(/\s+/g, ' ').toLowerCase() : '';
}
function chunks<T>(values: T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}
function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

async function sharedColumns(prod: postgres.Sql, staging: postgres.Sql, table: string): Promise<string[]> {
  const query = (sql: postgres.Sql) => sql<{ column_name: string; data_type: string }[]>`
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND is_generated = 'NEVER'
    ORDER BY ordinal_position`;
  const [p, s] = await Promise.all([query(prod), query(staging)]);
  const stagingTypes = new Map(s.map((row) => [row.column_name, row.data_type]));
  const columns = p.filter((row) => stagingTypes.get(row.column_name) === row.data_type).map((row) => row.column_name);
  const dropped = p.filter((row) => stagingTypes.get(row.column_name) !== row.data_type)
    .map((row) => `${row.column_name}${stagingTypes.has(row.column_name) ? ` (${row.data_type} vs ${stagingTypes.get(row.column_name)})` : ''}`);
  if (dropped.length) console.log(`${table}: columns not copied: ${dropped.join(', ')}`);
  return columns;
}

async function fetchRows(sql: postgres.Sql, table: string, key: string, columns: string[], ids: string[]) {
  const rows: Record<string, unknown>[] = [];
  for (const batch of chunks(ids, 500)) {
    rows.push(...await sql.unsafe<Record<string, unknown>[]>(
      `SELECT ${columns.map(quote).join(', ')} FROM public.${quote(table)} WHERE ${quote(key)}::text = ANY($1::text[])`,
      [batch],
    ));
  }
  return rows;
}

async function insertRows(tx: postgres.TransactionSql, table: string, columns: string[], rows: Record<string, unknown>[], jsonColumns: Set<string>) {
  for (const batch of chunks(rows, 100)) {
    const values: unknown[] = [];
    const tuples = batch.map((row) => `(${columns.map((column) => {
      const value = row[column];
      // JSON columns travel as text and are parsed server-side (`::text::jsonb`);
      // handing the driver an object or a pre-serialised string with a jsonb
      // parameter type would make it JSON-encode the value a second time.
      // Array columns (text[]) take the JS array as-is.
      const isJson = jsonColumns.has(column);
      values.push(isJson && value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
      return `$${values.length}${isJson ? '::text::jsonb' : ''}`;
    }).join(', ')})`);
    await tx.unsafe(
      `INSERT INTO public.${quote(table)} (${columns.map(quote).join(', ')}) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

async function jsonColumnsOf(sql: postgres.Sql, table: string): Promise<Set<string>> {
  const rows = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND data_type IN ('json', 'jsonb')`;
  return new Set(rows.map((row) => row.column_name));
}

async function rollback(staging: postgres.Sql, backupPath: string) {
  const backup = JSON.parse(await fs.readFile(backupPath, 'utf8')) as Backup;
  if (!backup.applied) throw new Error('Backup was never applied');
  await staging.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`);
    await tx.unsafe(`DELETE FROM public.question_payloads WHERE question_id::text = ANY($1::text[])`, [backup.questionIds]);
    await tx.unsafe(`DELETE FROM public.questions WHERE id::text = ANY($1::text[])`, [backup.questionIds]);
    await tx.unsafe(`DELETE FROM public.categories WHERE id::text = ANY($1::text[])`, [backup.categoryIds]);
  });
  console.log(JSON.stringify({ rolledBack: true, questions: backup.questionIds.length, categories: backup.categoryIds.length }));
}

async function main() {
  const prodUrl = process.env.PROD_DATABASE_URL;
  const stagingUrl = process.env.STAGING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!prodUrl?.includes(PROD_REF)) throw new Error(`PROD_DATABASE_URL must point at ${PROD_REF}`);
  if (!stagingUrl?.includes(STAGING_REF)) throw new Error(`DATABASE_URL must point at staging ${STAGING_REF}`);
  const prod = postgres(prodUrl, { max: 2, prepare: false, idle_timeout: 10 });
  const staging = postgres(stagingUrl, { max: 2, prepare: false, idle_timeout: 10 });
  try {
    const rollbackPath = argValue('rollback');
    if (rollbackPath) {
      await rollback(staging, path.resolve(rollbackPath));
      return;
    }
    const apply = hasArg('apply');

    const prodQuestions = await prod<{ id: string; category_id: string | null; en: string | null; status: string; visibility: string }[]>`
      SELECT id::text AS id, category_id::text AS category_id, prompt->>'en' AS en, status, visibility FROM questions`;
    const stagingQuestions = await staging<{ id: string; en: string | null }[]>`
      SELECT id::text AS id, prompt->>'en' AS en FROM questions`;
    const stagingIds = new Set(stagingQuestions.map((row) => row.id));
    const stagingPrompts = new Set(stagingQuestions.map((row) => normalized(row.en)).filter(Boolean));
    const missingById = prodQuestions.filter((row) => !stagingIds.has(row.id));
    const samePrompt = missingById.filter((row) => stagingPrompts.has(normalized(row.en)));
    const toCopy = missingById.filter((row) => !stagingPrompts.has(normalized(row.en)));

    // Categories were created on each environment separately, so the same
    // club category can exist under different ids. Match by slug: questions are
    // re-pointed at staging's id, and only slugs staging lacks are created.
    const stagingCategories = await staging<{ id: string; slug: string }[]>`SELECT id::text AS id, slug FROM categories`;
    const stagingCategoryIds = new Set(stagingCategories.map((row) => row.id));
    const stagingIdBySlug = new Map(stagingCategories.map((row) => [row.slug, row.id]));
    const neededCategoryIds = [...new Set(toCopy.map((row) => row.category_id).filter((id): id is string => Boolean(id)))]
      .filter((id) => !stagingCategoryIds.has(id));
    const prodCategories = neededCategoryIds.length
      ? await prod<{ id: string; slug: string }[]>`SELECT id::text AS id, slug FROM categories WHERE id::text = ANY(${neededCategoryIds})`
      : [];
    const categoryRemap = new Map<string, string>();
    const categoryIds: string[] = [];
    for (const category of prodCategories) {
      const stagingId = stagingIdBySlug.get(category.slug);
      if (stagingId) categoryRemap.set(category.id, stagingId);
      else categoryIds.push(category.id);
    }

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      prodQuestions: prodQuestions.length,
      stagingQuestions: stagingQuestions.length,
      missingById: missingById.length,
      skippedSamePrompt: samePrompt.length,
      questionsToCopy: toCopy.length,
      categoriesToCopy: categoryIds.length,
      categoriesRemappedBySlug: categoryRemap.size,
      byStatus: toCopy.reduce<Record<string, number>>((acc, row) => { acc[row.status] = (acc[row.status] ?? 0) + 1; return acc; }, {}),
      byVisibility: toCopy.reduce<Record<string, number>>((acc, row) => { acc[row.visibility] = (acc[row.visibility] ?? 0) + 1; return acc; }, {}),
    };
    console.log(JSON.stringify(report, null, 2));
    if (!apply) return;

    const questionColumns = await sharedColumns(prod, staging, 'questions');
    const payloadColumns = await sharedColumns(prod, staging, 'question_payloads');
    const categoryColumns = await sharedColumns(prod, staging, 'categories');
    const [questionJson, payloadJson, categoryJson] = await Promise.all([
      jsonColumnsOf(staging, 'questions'), jsonColumnsOf(staging, 'question_payloads'), jsonColumnsOf(staging, 'categories'),
    ]);
    const questionIds = toCopy.map((row) => row.id);
    const [categoryRows, questionRows, payloadRows] = await Promise.all([
      fetchRows(prod, 'categories', 'id', categoryColumns, categoryIds),
      fetchRows(prod, 'questions', 'id', questionColumns, questionIds),
      fetchRows(prod, 'question_payloads', 'question_id', payloadColumns, questionIds),
    ]);
    const stagingUserIds = new Set((await staging<{ id: string }[]>`SELECT id::text AS id FROM users`).map((row) => row.id));
    const stagingCategoryIdSet = new Set(stagingCategories.map((row) => row.id));
    for (const row of categoryRows) {
      // Attribution and hierarchy are environment-specific; keep them only when they resolve on staging.
      if (row.created_by && !stagingUserIds.has(String(row.created_by))) row.created_by = null;
      if (row.parent_id && !stagingCategoryIdSet.has(String(row.parent_id))) {
        row.parent_id = categoryRemap.get(String(row.parent_id)) ?? null;
      }
    }
    // Weekend League exposure counters are prod play history, not content.
    for (const row of questionRows) {
      if (row.created_by && !stagingUserIds.has(String(row.created_by))) row.created_by = null;
      const remapped = categoryRemap.get(String(row.category_id));
      if (remapped) row.category_id = remapped;
      if ('wl_seen_at' in row) row.wl_seen_at = null;
      if ('wl_seen_count' in row) row.wl_seen_count = 0;
      if ('wl_seen_tournaments' in row) row.wl_seen_tournaments = Array.isArray(row.wl_seen_tournaments) ? [] : row.wl_seen_tournaments;
    }

    const backupPath = path.resolve(argValue('backup') ?? `tmp/content-sync-backups/staging-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
    const backup: Backup = { version: 1, createdAt: new Date().toISOString(), applied: false, categoryIds, questionIds };
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, `${JSON.stringify(backup)}\n`, { flag: 'wx' });

    await staging.begin(async (tx) => {
      await tx.unsafe(`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`);
      await insertRows(tx, 'categories', categoryColumns, categoryRows, categoryJson);
      await insertRows(tx, 'questions', questionColumns, questionRows, questionJson);
      await insertRows(tx, 'question_payloads', payloadColumns, payloadRows, payloadJson);
    });
    backup.applied = true;
    await fs.writeFile(`${backupPath}.tmp`, `${JSON.stringify(backup)}\n`);
    await fs.rename(`${backupPath}.tmp`, backupPath);
    console.log(JSON.stringify({ applied: true, categories: categoryRows.length, questions: questionRows.length, payloads: payloadRows.length, backupPath }, null, 2));
  } finally {
    await Promise.all([prod.end(), staging.end()]);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

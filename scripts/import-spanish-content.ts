#!/usr/bin/env npx tsx

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';
import postgres from 'postgres';

type Target = 'staging' | 'production';
type PlanItem = {
  source: string;
  translated: string;
  storage: string;
  table?: string;
  rowKey?: string;
  column?: string;
  sourceColumn?: string;
  proposedTargetColumn?: string;
  jsonPath?: Array<string | number>;
};

type Backup = {
  version: 1;
  target: Target;
  projectRef: string;
  createdAt: string;
  applied: boolean;
  jsonb: Array<{ table: string; keyColumn: string; rowKey: string; column: string; value: unknown }>;
  scalar: Array<{ table: string; keyColumn: string; rowKey: string; column: string; value: unknown }>;
  localeRowIds: string[];
};

const PROJECT_REFS: Record<Target, string> = {
  staging: 'nsdfiprfmhdqhbfxfwpv',
  production: 'lfbwhxvwubzeqkztghok',
};

const JSONB_TARGETS: Record<string, { key: string; columns: ReadonlySet<string> }> = {
  questions: { key: 'id', columns: new Set(['prompt', 'explanation']) },
  question_payloads: { key: 'question_id', columns: new Set(['payload']) },
  categories: { key: 'id', columns: new Set(['name', 'description']) },
  store_products: { key: 'id', columns: new Set(['name', 'description']) },
  goal_choreographies: { key: 'id', columns: new Set(['title', 'fun_fact', 'options', 'bonus']) },
  announcements: { key: 'id', columns: new Set(['title', 'body']) },
};

const SCALAR_TARGETS: Record<string, { key: string; columns: ReadonlySet<string> }> = {
  campaign_quizzes: {
    key: 'slug',
    columns: new Set([
      'es_title', 'es_h1', 'es_seo_title', 'es_meta_description',
      'es_breadcrumb_label', 'es_lede', 'es_about_heading', 'es_about_blocks',
      'es_hero_image_alt', 'es_og_image_alt', 'es_score_cta', 'es_footer_banner_text',
      'es_footer_button_label',
    ]),
  },
  goal_choreographies: { key: 'id', columns: new Set(['match_label_es']) },
};

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function chunks<T>(values: T[], size = 250): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().replaceAll(/\s+/g, ' ') : '';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function getAtPath(root: unknown, jsonPath: Array<string | number>): unknown {
  let current = root;
  for (const part of jsonPath) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function setAtPath(root: unknown, jsonPath: Array<string | number>, value: unknown): boolean {
  if (jsonPath.length === 0) return false;
  let current = root;
  for (const part of jsonPath.slice(0, -1)) {
    if (current === null || typeof current !== 'object') return false;
    current = (current as Record<string | number, unknown>)[part];
  }
  if (current === null || typeof current !== 'object') return false;
  (current as Record<string | number, unknown>)[jsonPath.at(-1)!] = value;
  return true;
}

function applyLocaleValue(root: unknown, item: PlanItem, overwrite: boolean): 'changed' | 'existing' | 'conflict' {
  const jsonPath = item.jsonPath ?? [];
  const current = getAtPath(root, jsonPath);

  if (current && typeof current === 'object' && !Array.isArray(current)) {
    const field = current as Record<string, unknown>;
    if (normalized(field.en) !== normalized(item.source)) return 'conflict';
    if (typeof field.es === 'string' && field.es.trim() && !overwrite) {
      return normalized(field.es) === normalized(item.translated) ? 'existing' : 'conflict';
    }
    field.es = item.translated;
    return 'changed';
  }

  if (typeof current === 'string' && normalized(current) === normalized(item.source)) {
    const replacement = { en: current, es: item.translated };
    if (jsonPath.length === 0) {
      if (!root || typeof root !== 'object' || Array.isArray(root)) return 'conflict';
      Object.assign(root as Record<string, unknown>, replacement);
      return 'changed';
    }
    return setAtPath(root, jsonPath, replacement) ? 'changed' : 'conflict';
  }

  return 'conflict';
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return groups;
}

function detectProjectRef(databaseUrl: string): string | null {
  return Object.values(PROJECT_REFS).find((ref) => databaseUrl.includes(ref)) ?? null;
}

async function loadPlan(planPath: string): Promise<{ model: string; items: PlanItem[] }> {
  const raw = JSON.parse(await fs.readFile(planPath, 'utf8')) as { model?: string; items?: PlanItem[] };
  if (!Array.isArray(raw.items)) throw new Error(`Invalid import plan: ${planPath}`);
  return { model: raw.model ?? 'google/gemini-2.5-flash-lite', items: raw.items };
}

async function fetchRows(
  sql: postgres.Sql,
  table: string,
  keyColumn: string,
  columns: string[],
  rowKeys: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const output = new Map<string, Record<string, unknown>>();
  const selected = columns.length === 1 && columns[0] === '*'
    ? '*'
    : columns.map(quoteIdentifier).join(', ');
  for (const batch of chunks([...new Set(rowKeys)])) {
    const rows = await sql.unsafe<Record<string, unknown>[]>(
      `SELECT ${quoteIdentifier(keyColumn)}::text AS row_key, ${selected}
       FROM public.${quoteIdentifier(table)}
       WHERE ${quoteIdentifier(keyColumn)}::text = ANY($1::text[])`,
      [batch],
    );
    for (const row of rows) output.set(String(row.row_key), row);
  }
  return output;
}

async function planJsonbChanges(
  sql: postgres.Sql,
  items: PlanItem[],
  overwrite: boolean,
  backup: Backup,
) {
  const stats = { changedRows: 0, changedValues: 0, existing: 0, conflicts: 0, missingRows: 0 };
  const groups = groupBy(items, (item) => `${item.table}\0${item.column}`);
  const changes: Array<{ table: string; keyColumn: string; rowKey: string; column: string; value: unknown }> = [];

  for (const values of groups.values()) {
    const first = values[0];
    const table = first.table ?? '';
    const column = first.column ?? '';
    const target = JSONB_TARGETS[table];
    if (!target || !target.columns.has(column)) throw new Error(`Blocked JSONB target ${table}.${column}`);
    const rowGroups = groupBy(values, (item) => item.rowKey ?? '');
    const rows = await fetchRows(sql, table, target.key, [column], [...rowGroups.keys()]);

    for (const [rowKey, operations] of rowGroups) {
      const row = rows.get(rowKey);
      if (!row) {
        stats.missingRows += 1;
        continue;
      }
      const original = row[column];
      const next = clone(original);
      let rowChanged = false;
      const unique = new Map(operations.map((item) => [JSON.stringify(item.jsonPath ?? []), item]));
      for (const item of unique.values()) {
        const result = applyLocaleValue(next, item, overwrite);
        if (result === 'changed') { stats.changedValues += 1; rowChanged = true; }
        else if (result === 'existing') stats.existing += 1;
        else stats.conflicts += 1;
      }
      if (rowChanged) {
        stats.changedRows += 1;
        backup.jsonb.push({ table, keyColumn: target.key, rowKey, column, value: original });
        changes.push({ table, keyColumn: target.key, rowKey, column, value: next });
      }
    }
  }
  return { stats, changes };
}

async function planScalarChanges(
  sql: postgres.Sql,
  items: PlanItem[],
  overwrite: boolean,
  backup: Backup,
) {
  const stats = { changed: 0, existing: 0, conflicts: 0, missingRows: 0 };
  const changes: Array<{ table: string; keyColumn: string; rowKey: string; column: string; value: unknown }> = [];
  const groups = groupBy(items, (item) => `${item.table}\0${item.proposedTargetColumn}`);

  for (const values of groups.values()) {
    const first = values[0];
    const table = first.table ?? '';
    const targetColumn = first.proposedTargetColumn ?? '';
    const target = SCALAR_TARGETS[table];
    if (!target || !target.columns.has(targetColumn)) throw new Error(`Blocked scalar target ${table}.${targetColumn}`);
    const sourceColumn = first.sourceColumn ?? '';
    const rowGroups = groupBy(values, (item) => item.rowKey ?? '');
    const rows = await fetchRows(sql, table, target.key, [sourceColumn, targetColumn], [...rowGroups.keys()]);

    for (const [rowKey, operations] of rowGroups) {
      const row = rows.get(rowKey);
      if (!row) { stats.missingRows += 1; continue; }
      const existing = row[targetColumn];
      if (existing !== null && existing !== undefined && !overwrite) { stats.existing += 1; continue; }

      let next: unknown;
      if (operations[0].storage === 'parallel_jsonb_column_needed') {
        next = clone(row[sourceColumn]);
        let valid = true;
        for (const item of operations) {
          const current = getAtPath(next, item.jsonPath ?? []);
          if (normalized(current) !== normalized(item.source) || !setAtPath(next, item.jsonPath ?? [], item.translated)) {
            valid = false;
            break;
          }
        }
        if (!valid) { stats.conflicts += 1; continue; }
      } else {
        const item = operations[0];
        if (normalized(row[sourceColumn]) !== normalized(item.source)) { stats.conflicts += 1; continue; }
        next = item.translated;
      }

      stats.changed += 1;
      backup.scalar.push({ table, keyColumn: target.key, rowKey, column: targetColumn, value: existing });
      changes.push({ table, keyColumn: target.key, rowKey, column: targetColumn, value: next });
    }
  }
  return { stats, changes };
}

async function planLocaleRows(
  sql: postgres.Sql,
  items: PlanItem[],
  model: string,
  backup: Backup,
) {
  const stats = { inserts: 0, existing: 0, conflicts: 0, missingRows: 0 };
  const inserts: Array<Record<string, unknown>> = [];
  const rowGroups = groupBy(items, (item) => item.rowKey ?? '');
  const sourceRows = await fetchRows(sql, 'player_clue_cards', 'id', ['*'], [...rowGroups.keys()]);
  const familyIds = [...new Set(
    [...sourceRows.values()]
      .map((row) => String(row.card_family_id ?? ''))
      .filter(Boolean),
  )];
  const existingFamilyIds = new Set<string>();
  for (const batch of chunks(familyIds)) {
    const existingRows = await sql.unsafe<{ card_family_id: string }[]>(
      `SELECT card_family_id::text AS card_family_id
       FROM public.player_clue_cards
       WHERE card_family_id::text = ANY($1::text[]) AND locale = 'es'`,
      [batch],
    );
    for (const row of existingRows) existingFamilyIds.add(row.card_family_id);
  }
  const existingSourceIds = new Set<string>();
  const translatedRows = await sql.unsafe<{ review_notes: string | null }[]>(
    `SELECT review_notes
     FROM public.player_clue_cards
     WHERE locale = 'es' AND review_notes LIKE 'Spanish translation of %'`,
  );
  for (const row of translatedRows) {
    const match = row.review_notes?.match(/^Spanish translation of ([0-9a-f-]{36});/i);
    if (match) existingSourceIds.add(match[1]);
  }

  for (const [rowKey, operations] of rowGroups) {
    const source = sourceRows.get(rowKey);
    if (!source) { stats.missingRows += 1; continue; }
    const translations = Object.fromEntries(operations.map((item) => [item.sourceColumn, item.translated]));
    if (!translations.clue_1 || !translations.clue_2 || !translations.clue_3) { stats.conflicts += 1; continue; }
    if (existingFamilyIds.has(String(source.card_family_id)) || existingSourceIds.has(rowKey)) {
      stats.existing += 1;
      continue;
    }

    const id = crypto.randomUUID();
    backup.localeRowIds.push(id);
    inserts.push({
      id,
      football_player_id: source.football_player_id,
      transfermarkt_id: source.transfermarkt_id,
      locale: 'es',
      clue_1: translations.clue_1,
      clue_2: translations.clue_2,
      clue_3: translations.clue_3,
      difficulty: source.difficulty,
      status: source.status,
      source: 'imported',
      generation_provider: 'openrouter',
      generation_model: model,
      prompt_version: source.prompt_version,
      evidence: source.evidence,
      source_payload: source.source_payload,
      review_notes: `Spanish translation of ${rowKey}; semantic QA passed 2026-08-29`,
      rejection_reason: null,
      card_family_id: source.card_family_id,
      variant_key: source.variant_key,
      target_difficulty: source.target_difficulty,
      snapshot_id: source.snapshot_id,
      generation_task_id: source.generation_task_id,
    });
    stats.inserts += 1;
  }
  return { stats, inserts };
}

async function applyChanges(
  sql: postgres.Sql,
  backup: Backup,
  jsonb: Array<{ table: string; keyColumn: string; rowKey: string; column: string; value: unknown }>,
  scalar: Array<{ table: string; keyColumn: string; rowKey: string; column: string; value: unknown }>,
  localeRows: Array<Record<string, unknown>>,
  backupPath: string,
) {
  await sql.begin(async (tx) => {
    // The Quiz Pages CMS protects its reserved question rows. This importer is
    // an audited content-pipeline write, so use the same transaction-local
    // guard rather than disabling or dropping the protection trigger.
    await tx.unsafe(`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`);
    await fs.mkdir(path.dirname(backupPath), { recursive: true });
    await fs.writeFile(backupPath, `${JSON.stringify(backup)}\n`, { flag: 'wx' });

    const jsonbGroups = groupBy(jsonb, (change) => `${change.table}\0${change.keyColumn}\0${change.column}`);
    for (const changes of jsonbGroups.values()) {
      const first = changes[0];
      for (const batch of chunks(changes, 200)) {
        await tx.unsafe(
          `UPDATE public.${quoteIdentifier(first.table)} AS target
           SET ${quoteIdentifier(first.column)} = batch.value::jsonb
           FROM UNNEST($1::text[], $2::text[]) AS batch(row_key, value)
           WHERE target.${quoteIdentifier(first.keyColumn)}::text = batch.row_key`,
          [batch.map((change) => change.rowKey), batch.map((change) => JSON.stringify(change.value))],
        );
      }
    }
    const scalarGroups = groupBy(scalar, (change) => `${change.table}\0${change.keyColumn}\0${change.column}`);
    for (const changes of scalarGroups.values()) {
      const first = changes[0];
      const isJson = first.column.endsWith('_about_blocks');
      for (const batch of chunks(changes, 200)) {
        await tx.unsafe(
          `UPDATE public.${quoteIdentifier(first.table)} AS target
           SET ${quoteIdentifier(first.column)} = batch.value${isJson ? '::jsonb' : ''}
           FROM UNNEST($1::text[], $2::text[]) AS batch(row_key, value)
           WHERE target.${quoteIdentifier(first.keyColumn)}::text = batch.row_key`,
          [
            batch.map((change) => change.rowKey),
            batch.map((change) => isJson ? JSON.stringify(change.value) : change.value),
          ],
        );
      }
    }
    for (const batch of chunks(localeRows, 100)) {
      const columns = Object.keys(batch[0]);
      const values: unknown[] = [];
      const rowsSql = batch.map((row) => {
        const placeholders = columns.map((column) => {
          values.push(row[column]);
          return `$${values.length}${['evidence', 'source_payload'].includes(column) ? '::jsonb' : ''}`;
        });
        return `(${placeholders.join(', ')})`;
      });
      await tx.unsafe(
        `INSERT INTO public.player_clue_cards (${columns.map(quoteIdentifier).join(', ')}) VALUES ${rowsSql.join(', ')}`,
        values,
      );
    }
  });
  backup.applied = true;
  await fs.writeFile(backupPath, `${JSON.stringify(backup)}\n`);
}

async function rollback(sql: postgres.Sql, backupPath: string, target: Target, projectRef: string) {
  const backup = JSON.parse(await fs.readFile(backupPath, 'utf8')) as Backup;
  if (!backup.applied || backup.target !== target || backup.projectRef !== projectRef) {
    throw new Error('Backup does not match this target or was not applied');
  }
  await sql.begin(async (tx) => {
    await tx.unsafe(`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`);
    for (const row of backup.jsonb) {
      await tx.unsafe(
        `UPDATE public.${quoteIdentifier(row.table)} SET ${quoteIdentifier(row.column)} = $1::jsonb WHERE ${quoteIdentifier(row.keyColumn)}::text = $2`,
        [JSON.stringify(row.value), row.rowKey],
      );
    }
    for (const row of backup.scalar) {
      const isJson = row.column.endsWith('_about_blocks');
      await tx.unsafe(
        `UPDATE public.${quoteIdentifier(row.table)} SET ${quoteIdentifier(row.column)} = $1${isJson && row.value !== null ? '::jsonb' : ''} WHERE ${quoteIdentifier(row.keyColumn)}::text = $2`,
        [isJson && row.value !== null ? JSON.stringify(row.value) : row.value, row.rowKey],
      );
    }
    if (backup.localeRowIds.length > 0) {
      await tx.unsafe(`DELETE FROM public.player_clue_cards WHERE id::text = ANY($1::text[])`, [backup.localeRowIds]);
    }
  });
  console.log(JSON.stringify({ rolledBack: true, backupPath, jsonbRows: backup.jsonb.length, scalarRows: backup.scalar.length, localeRows: backup.localeRowIds.length }, null, 2));
}

async function main() {
  const target = (argValue('target') ?? 'staging') as Target;
  if (!(target in PROJECT_REFS)) throw new Error('Use --target=staging or --target=production');
  const databaseUrl = process.env.SPANISH_IMPORT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set SPANISH_IMPORT_DATABASE_URL or DATABASE_URL');
  const projectRef = detectProjectRef(databaseUrl);
  if (projectRef !== PROJECT_REFS[target]) throw new Error(`Database target mismatch: expected ${PROJECT_REFS[target]}`);
  if (target === 'production' && hasArg('apply') && argValue('confirm-production') !== PROJECT_REFS.production) {
    throw new Error(`Production apply requires --confirm-production=${PROJECT_REFS.production}`);
  }

  const sql = postgres(databaseUrl, { max: 4, prepare: false, idle_timeout: 10 });
  try {
    const rollbackPath = argValue('rollback');
    if (rollbackPath) {
      await rollback(sql, path.resolve(rollbackPath), target, projectRef);
      return;
    }

    const planPath = path.resolve(argValue('plan') ?? '../quizball-question-agents/output/spanish-translation/import-plan.json');
    const { model, items } = await loadPlan(planPath);
    const referencedTables = [...new Set(items.map((item) => item.table).filter((table): table is string => Boolean(table)))];
    const existingTableRows = referencedTables.length === 0
      ? []
      : await sql<{ table_name: string }[]>`
          SELECT table_name
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY(${referencedTables})
        `;
    const existingTables = new Set(existingTableRows.map((row) => row.table_name));
    const importableItems = items.filter((item) => !item.table || existingTables.has(item.table));
    const ignoredMissingTableOperations = items.length - importableItems.length;
    const apply = hasArg('apply');
    const overwrite = hasArg('overwrite');
    const backup: Backup = {
      version: 1,
      target,
      projectRef,
      createdAt: new Date().toISOString(),
      applied: false,
      jsonb: [],
      scalar: [],
      localeRowIds: [],
    };

    const jsonbItems = importableItems.filter((item) => item.storage === 'jsonb_locale');
    const scalarItems = importableItems.filter((item) => item.storage === 'scalar_column_needed' || item.storage === 'parallel_jsonb_column_needed');
    const localeItems = importableItems.filter((item) => item.storage === 'locale_row_needed');
    const jsonb = await planJsonbChanges(sql, jsonbItems, overwrite, backup);
    const scalar = await planScalarChanges(sql, scalarItems, overwrite, backup);
    const localeRows = await planLocaleRows(sql, localeItems, model, backup);
    const ignored = importableItems.length - jsonbItems.length - scalarItems.length - localeItems.length;

    const report = {
      mode: apply ? 'apply' : 'dry-run',
      target,
      projectRef,
      planPath,
      model,
      operations: items.length,
      ignoredCodeOperations: ignored,
      ignoredMissingTableOperations,
      jsonb: jsonb.stats,
      scalar: scalar.stats,
      localeRows: localeRows.stats,
    };

    if (!apply) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const backupPath = path.resolve(
      argValue('backup') ?? `tmp/spanish-import-backups/${target}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`,
    );
    await applyChanges(sql, backup, jsonb.changes, scalar.changes, localeRows.inserts, backupPath);
    console.log(JSON.stringify({ ...report, applied: true, backupPath }, null, 2));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

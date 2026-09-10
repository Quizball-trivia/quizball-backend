#!/usr/bin/env npx tsx

// Spanish + Turkish labels for football_grid_criteria.
//   npx tsx scripts/football-grid-label-locales.ts --build          # fixture from DB + OpenRouter (cached)
//   npx tsx scripts/football-grid-label-locales.ts --apply           # write label_es/label_tr from the fixture
//   --target=production --confirm-production=lfbwhxvwubzeqkztghok    # for prod
// Clubs and managers keep their English label; "Played with X" follows a fixed
// pattern; countries, leagues, trophies and wildcards are machine-translated once
// into scripts/football-grid-label-locales.json (committed) and reviewed there.

import fs from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import 'dotenv/config';
import postgres from 'postgres';

type Locale = 'es' | 'tr';
type Family = 'club' | 'country' | 'league' | 'manager' | 'teammate' | 'trophy_award' | 'wildcard';
type Row = { criterion_key: string; family: Family; label_en: string };
type Fixture = { version: 1; model: string; labels: Record<string, { en: string; es: string; tr: string }> };

const FIXTURE_PATH = path.resolve('scripts/football-grid-label-locales.json');
const PROJECT_REFS = { staging: 'nsdfiprfmhdqhbfxfwpv', production: 'lfbwhxvwubzeqkztghok' } as const;
const MODEL = process.env.GRID_LABEL_TRANSLATION_MODEL ?? 'google/gemini-2.5-flash-lite';
const TEAMMATE = /^Played with (.+)$/;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}
function hasArg(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function ruleBased(row: Row): { es: string; tr: string } | null {
  if (row.family === 'club' || row.family === 'manager') return { es: row.label_en, tr: row.label_en };
  const teammate = row.label_en.match(TEAMMATE);
  if (row.family === 'teammate' && teammate) {
    return { es: `Jugó con ${teammate[1]}`, tr: `${teammate[1]} ile oynadı` };
  }
  return null;
}

function postJson(payload: unknown, apiKey: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        family: 4,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://quizball.io',
          'X-Title': 'QuizBall grid labels',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((response.statusCode ?? 500) >= 300) reject(new Error(`OpenRouter ${response.statusCode}: ${text.slice(0, 300)}`));
          else resolve(text);
        });
      },
    );
    request.setTimeout(120_000, () => request.destroy(new Error('OpenRouter timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

async function translateBatch(items: Array<{ key: string; family: Family; en: string }>, locale: Locale, apiKey: string) {
  const language = locale === 'es' ? 'Spanish (neutral, international)' : 'Turkish';
  const prompt = `Translate these short football category labels into ${language}. They are grid headers in a football trivia game (countries, leagues, trophies, awards, career facts). Keep proper names, keep it short, use the form a football fan in that language would write on a chart. Return ONLY JSON: {"translations":[{"n":<same number>,"text":"translation"}]} with exactly one entry per input, same order.`;
  const raw = await postJson(
    {
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: JSON.stringify({ labels: items.map((item, index) => ({ n: index + 1, family: item.family, text: item.en })) }) },
      ],
      temperature: 0.1,
      max_tokens: 6000,
      response_format: { type: 'json_object' },
    },
    apiKey,
  );
  const content = JSON.parse(raw).choices?.[0]?.message?.content ?? '';
  const parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')) as { translations?: Array<{ n: number; text: string }> };
  const translations = parsed.translations ?? [];
  if (translations.length !== items.length) throw new Error(`Expected ${items.length} translations, got ${translations.length}`);
  const out = new Map<string, string>();
  translations.forEach((translation, index) => {
    const item = items[Number(translation.n) - 1] ?? items[index];
    if (typeof translation.text === 'string' && translation.text.trim()) out.set(item.key, translation.text.trim());
  });
  return out;
}

async function build(sql: postgres.Sql) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for --build');
  let fixture: Fixture = { version: 1, model: MODEL, labels: {} };
  try {
    fixture = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8')) as Fixture;
  } catch {
    // first run
  }
  const rows = await sql<Row[]>`SELECT criterion_key, family, label_en FROM football_grid_criteria ORDER BY family, label_en`;
  const pending: Array<{ key: string; family: Family; en: string }> = [];
  for (const row of rows) {
    const existing = fixture.labels[row.criterion_key];
    if (existing && existing.en === row.label_en && existing.es && existing.tr) continue;
    const rule = ruleBased(row);
    if (rule) {
      fixture.labels[row.criterion_key] = { en: row.label_en, ...rule };
    } else {
      pending.push({ key: row.criterion_key, family: row.family, en: row.label_en });
    }
  }
  console.log(`criteria ${rows.length}, rule-based/cached ${rows.length - pending.length}, to translate ${pending.length}`);
  await fs.writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
  for (const locale of ['es', 'tr'] as const) {
    const todo = pending.filter((item) => !fixture.labels[item.key]?.[locale]);
    for (let offset = 0; offset < todo.length; offset += 20) {
      const batch = todo.slice(offset, offset + 20);
      let translated = new Map<string, string>();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          translated = await translateBatch(batch, locale, apiKey);
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
        }
      }
      for (const item of batch) {
        const text = translated.get(item.key);
        if (!text) throw new Error(`Missing ${locale} translation for ${item.key} (got ${translated.size}/${batch.length}: ${[...translated.keys()].slice(0, 5).join(', ')})`);
        fixture.labels[item.key] = { en: item.en, es: fixture.labels[item.key]?.es ?? '', tr: fixture.labels[item.key]?.tr ?? '', [locale]: text };
      }
      await fs.writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`);
      console.log(`${locale}: ${Math.min(offset + 20, todo.length)}/${todo.length}`);
    }
  }
  const incomplete = Object.entries(fixture.labels).filter(([, value]) => !value.es || !value.tr);
  if (incomplete.length) throw new Error(`${incomplete.length} labels still incomplete`);
  console.log(`fixture written: ${Object.keys(fixture.labels).length} labels`);
}

async function apply(sql: postgres.Sql, dryRun: boolean) {
  const fixture = JSON.parse(await fs.readFile(FIXTURE_PATH, 'utf8')) as Fixture;
  const rows = await sql<Row[]>`SELECT criterion_key, family, label_en FROM football_grid_criteria`;
  const updates: Array<{ key: string; es: string; tr: string }> = [];
  let stale = 0;
  let missing = 0;
  for (const row of rows) {
    const entry = fixture.labels[row.criterion_key];
    if (!entry) { missing += 1; continue; }
    if (entry.en !== row.label_en) { stale += 1; continue; }
    updates.push({ key: row.criterion_key, es: entry.es, tr: entry.tr });
  }
  console.log(JSON.stringify({ mode: dryRun ? 'dry-run' : 'apply', criteria: rows.length, updates: updates.length, missingFromFixture: missing, englishChangedSinceFixture: stale }));
  if (dryRun) return;
  await sql.begin(async (tx) => {
    for (let offset = 0; offset < updates.length; offset += 500) {
      const batch = updates.slice(offset, offset + 500);
      await tx.unsafe(
        `UPDATE football_grid_criteria AS c
           SET label_es = u.es, label_tr = u.tr
          FROM UNNEST($1::text[], $2::text[], $3::text[]) AS u(key, es, tr)
         WHERE c.criterion_key = u.key`,
        [batch.map((u) => u.key), batch.map((u) => u.es), batch.map((u) => u.tr)],
      );
    }
  });
  console.log(`applied ${updates.length} rows`);
}

async function main() {
  const target = (argValue('target') ?? 'staging') as keyof typeof PROJECT_REFS;
  const databaseUrl = process.env.GRID_LABELS_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL');
  if (!databaseUrl.includes(PROJECT_REFS[target])) throw new Error(`Database target mismatch: expected ${PROJECT_REFS[target]}`);
  if (target === 'production' && hasArg('apply') && argValue('confirm-production') !== PROJECT_REFS.production) {
    throw new Error(`Production apply requires --confirm-production=${PROJECT_REFS.production}`);
  }
  const sql = postgres(databaseUrl, { max: 2, prepare: false, idle_timeout: 10 });
  try {
    if (hasArg('build')) await build(sql);
    else await apply(sql, !hasArg('apply'));
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

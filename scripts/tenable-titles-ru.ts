#!/usr/bin/env npx tsx

// Russian titles and notes of Football Tenable's lists (days and room pool). Reads STAGING only; writes the gitignored
// scripts/.snapshots/tenable-titles-ru.json: list id → { src, title, note }, where src is the hash of the English it was
// translated from. Written to the database by scripts/tenable-ru-seed.ts titles.
//   npx tsx scripts/tenable-titles-ru.ts [--batch=30] [--env-file=.env]

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { NOTE_MAX_LENGTH, russianTextSource, tenableListSchema, TITLE_MAX_LENGTH, type TenableList } from '../src/modules/tenable/tenable.content.js';
import { POOLER_SAFE, requireStagingTarget } from './staging-target.js';

const MODEL = 'gpt-6-luna';
const OUT = path.resolve('scripts/.snapshots/tenable-titles-ru.json');
const opt = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const BATCH = Number(opt('batch', '30'));
const dbUrl = readFileSync(opt('env-file', '.env'), 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m)?.[1] ?? '';
requireStagingTarget(dbUrl);
const sql = postgres(dbUrl, { ...POOLER_SAFE, ssl: 'require', max: 1, connect_timeout: 20, idle_timeout: 20 });

type Entry = { src: string; title: string; note: string | null };
const russian = (t: unknown, max: number): t is string => typeof t === 'string' && t.trim().length > 0 && t.trim().length <= max && /\p{Script=Cyrillic}/u.test(t);

function translate(lists: TenableList[]): Promise<Record<string, Entry>> {
  const dir = mkdtempSync(path.join(tmpdir(), 'tenable-titles-ru-'));
  const out = path.join(dir, 'out.json');
  const schemaFile = path.join(dir, 'schema.json');
  const keys = lists.map((_, i) => String(i));
  const item = { type: 'object', properties: { title: { type: 'string' }, note: { type: ['string', 'null'] } }, required: ['title', 'note'], additionalProperties: false };
  writeFileSync(schemaFile, JSON.stringify({ type: 'object', properties: Object.fromEntries(keys.map((k) => [k, item])), required: keys, additionalProperties: false }));
  const prompt = `Translate football quiz list titles and their small-print notes into natural Russian, the way a Russian football site would write them (сезон 2023/24, АПЛ, Лига чемпионов, ЧМ, тренер, сборная). Each title is the question of a "name the top 10" game; the note is the ranking rule. Keep every number, year, season and rule exactly; keep club and competition names in their usual Russian form. Title at most ${TITLE_MAX_LENGTH - 10} characters, note at most ${NOTE_MAX_LENGTH - 15} (count them: a longer one is refused; say it more tightly, abbreviate competitions, but never drop a rule); a null note stays null. Informal "ты" if you address the player. No tools.
Return a JSON object mapping each key to {"title", "note"}.
${JSON.stringify(Object.fromEntries(lists.map((l, i) => [String(i), { title: l.title.en, note: l.note?.en ?? null }])))}`;
  const args = ['exec', '-m', MODEL, '-c', 'model_reasoning_effort="medium"', '--skip-git-repo-check', '--ephemeral', '-C', dir, '--output-schema', schemaFile, '-o', out, prompt];
  return new Promise((resolve, reject) => {
    const child = execFile(path.join(homedir(), '.local/bin/codex'), args, { timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 }, (error, _o, stderr) => {
      if (error || !existsSync(out)) return reject(new Error(`codex: ${String(stderr).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
      const parsed = JSON.parse(readFileSync(out, 'utf8')) as Record<string, { title?: unknown; note?: unknown }>;
      const found: Record<string, Entry> = {};
      lists.forEach((l, i) => {
        const t = parsed[String(i)];
        const noteOk = l.note === null ? t?.note === null : russian(t?.note, NOTE_MAX_LENGTH);
        if (!(t && russian(t.title, TITLE_MAX_LENGTH) && noteOk)) console.log(`refused ${l.id}: title ${typeof t?.title === 'string' ? t.title.length : '-'}, note ${typeof t?.note === 'string' ? t.note.length : String(t?.note)}`);
        if (t && russian(t.title, TITLE_MAX_LENGTH) && noteOk) found[l.id] = { src: russianTextSource(l), title: t.title.trim(), note: l.note === null ? null : (t.note as string).trim() };
      });
      resolve(found);
    });
    child.stdin?.end();
  });
}

async function main() {
  const raw = await sql.begin('read only', (tx) => tx<Array<{ list: unknown }>>`SELECT list FROM tenable_days UNION ALL SELECT payload FROM room_pool WHERE game = 'tenable'`);
  const lists = [...new Map(raw.flatMap((r) => { const p = tenableListSchema.safeParse(r.list); return p.success ? [[p.data.id, p.data] as const] : []; })).values()];
  const done = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, Entry> : {};
  const todo = lists.filter((l) => done[l.id]?.src !== russianTextSource(l));
  console.log(`${lists.length} lists, ${lists.length - todo.length} translated, ${todo.length} to translate`);
  for (let i = 0; i < todo.length; i += BATCH) {
    try {
      const found = await translate(todo.slice(i, i + BATCH));
      const merged = { ...(existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, Entry> : {}), ...found };
      mkdirSync(path.dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(merged, null, 1));
      console.log(`batch ${i / BATCH + 1}: ${Object.keys(found).length}/${Math.min(BATCH, todo.length - i)}`);
    } catch (e) {
      console.error(`batch failed: ${(e as Error).message}`);
    }
  }
  const final = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) as Record<string, Entry> : {};
  const missing = lists.filter((l) => final[l.id]?.src !== russianTextSource(l)).map((l) => l.id);
  console.log(`done: ${lists.length - missing.length}/${lists.length}${missing.length ? `; missing ${missing.slice(0, 20).join(', ')}` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => sql.end());

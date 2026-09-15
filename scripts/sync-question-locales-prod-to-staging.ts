#!/usr/bin/env npx tsx
/**
 * Fill MISSING locale texts on STAGING from PROD, locale by locale (ka / es / tr).
 *
 * Unlike sync-question-translations-prod-to-staging.ts (which replaces the whole
 * prompt/payload when ka is missing), this merges only the missing locale keys
 * into staging's own JSON, node by node, and only where the English text at that
 * node is identical on both sides — so staging content is never replaced, only
 * completed. Never inserts, never deletes.
 *
 * Usage: npx tsx scripts/sync-question-locales-prod-to-staging.ts [--execute] [--locales=ka,es,tr]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import postgres from 'postgres';

const PROD_REF = 'lfbwhxvwubzeqkztghok';
const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
const EXECUTE = process.argv.includes('--execute');
const LOCALES = (process.argv.find((a) => a.startsWith('--locales='))?.slice('--locales='.length) ?? 'ka,es,tr').split(',');

function databaseUrlFrom(file: string): string {
  const match = readFileSync(file, 'utf8').match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (!match) throw new Error(`No DATABASE_URL found in ${file}`);
  return match[1];
}
const sourceUrl = databaseUrlFrom('.env.prod.bak');
const targetUrl = databaseUrlFrom('.env');
function projectOf(url: string): string {
  try { const u = new URL(url); return `${u.hostname} ${decodeURIComponent(u.username)}`; } catch { return ''; }
}
if (!projectOf(sourceUrl).includes(PROD_REF) || !projectOf(targetUrl).includes(STAGING_REF) || targetUrl.includes(PROD_REF)) {
  console.error('ABORT: source must be the prod project and target the staging project (checked on host/user, not substrings).');
  process.exit(1);
}
const source = postgres(sourceUrl, { ssl: 'require', max: 1, connect_timeout: 20 });
const target = postgres(targetUrl, { ssl: 'require', max: 1, connect_timeout: 20 });

type Json = unknown;
const isTextNode = (v: Json): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Record<string, unknown>).en === 'string';
const empty = (v: unknown) => typeof v !== 'string' || v.trim() === '';

/** Merge missing locales from `from` into `into` at matching paths; returns the number of filled slots. */
function merge(into: Json, from: Json, locales: string[]): number {
  if (isTextNode(into)) {
    if (!isTextNode(from) || from.en !== into.en) return 0;
    let filled = 0;
    for (const l of locales) if (empty(into[l]) && !empty(from[l])) { into[l] = from[l]; filled += 1; }
    return filled;
  }
  if (Array.isArray(into)) {
    if (!Array.isArray(from) || from.length !== into.length) return 0;
    return into.reduce<number>((n, item, i) => n + merge(item, from[i], locales), 0);
  }
  if (into && typeof into === 'object') {
    if (!from || typeof from !== 'object' || Array.isArray(from)) return 0;
    const f = from as Record<string, Json>;
    return Object.keys(into as Record<string, Json>).reduce((n, k) => n + merge((into as Record<string, Json>)[k], f[k], locales), 0);
  }
  return 0;
}

async function main() {
  console.log(`SOURCE prod ${PROD_REF} → TARGET staging ${STAGING_REF} · locales ${LOCALES.join(',')} · ${EXECUTE ? 'EXECUTE' : 'DRY RUN'}\n`);
  const rows = await target<Array<{ id: string; type: string; prompt: Json; payload: Json }>>`
    SELECT q.id, q.type, q.prompt, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id WHERE q.status = 'published'`;
  const lacks = (v: Json) => JSON.stringify(v).length > 0 && LOCALES.some((l) => (function walk(x: Json): boolean {
    if (isTextNode(x)) return empty(x[l]);
    if (Array.isArray(x)) return x.some(walk);
    if (x && typeof x === 'object') return Object.values(x as Record<string, Json>).some(walk);
    return false;
  })(v));
  const stale = rows.filter((r) => lacks(r.prompt) || lacks(r.payload));
  console.log(`staging published: ${rows.length}; rows missing some locale: ${stale.length}`);
  const ids = stale.map((r) => r.id);
  const prodQ = new Map((await source<Array<{ id: string; prompt: Json }>>`SELECT id, prompt FROM questions WHERE id = ANY(${ids})`).map((r) => [r.id, r.prompt]));
  const prodP = new Map((await source<Array<{ question_id: string; payload: Json }>>`SELECT question_id, payload FROM question_payloads WHERE question_id = ANY(${ids})`).map((r) => [r.question_id, r.payload]));
  const plans: Array<{ id: string; type: string; prompt: Json; payload: Json; filled: number }> = [];
  const snapshot: Array<{ id: string; prompt: Json; payload: Json }> = [];
  for (const r of stale) {
    const pp = prodQ.get(r.id); const pl = prodP.get(r.id);
    if (pp === undefined && pl === undefined) continue;
    const before = { id: r.id, prompt: JSON.parse(JSON.stringify(r.prompt)), payload: JSON.parse(JSON.stringify(r.payload)) };
    const filled = (pp !== undefined ? merge(r.prompt, pp, LOCALES) : 0) + (pl !== undefined ? merge(r.payload, pl, LOCALES) : 0);
    if (filled > 0) { plans.push({ id: r.id, type: r.type, prompt: r.prompt, payload: r.payload, filled }); snapshot.push(before); }
  }
  const byType = new Map<string, number>();
  for (const p of plans) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  console.log(`rows completable from prod: ${plans.length}; locale slots to fill: ${plans.reduce((n, p) => n + p.filled, 0)}`);
  for (const [t, c] of [...byType.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${t}: ${c}`);
  if (!EXECUTE) { console.log('\nDry run — re-run with --execute to apply.'); return; }
  mkdirSync('scripts/.snapshots', { recursive: true });
  const snapFile = `scripts/.snapshots/locale-sync-${Date.now()}.json`;
  writeFileSync(snapFile, JSON.stringify(snapshot));
  console.log(`snapshot of touched rows: ${snapFile}`);
  let done = 0;
  await target.begin(async (tx) => {
    for (const p of plans) {
      await tx`UPDATE questions SET prompt = ${tx.json(p.prompt as never)}, updated_at = now() WHERE id = ${p.id}`;
      await tx`UPDATE question_payloads SET payload = ${tx.json(p.payload as never)} WHERE question_id = ${p.id}`;
      done += 1;
    }
  });
  console.log(`updated ${done} rows on staging.`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(async () => { await source.end(); await target.end(); });

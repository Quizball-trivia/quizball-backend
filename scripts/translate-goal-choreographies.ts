#!/usr/bin/env npx tsx
/**
 * Fill missing es / tr on STAGING goal_choreographies (Guess the Goal) with Gemini via OpenRouter:
 * jsonb title / options / fun_fact / bonus ({en,ka,es,tr} nodes) plus match_label → match_label_es / match_label_tr.
 * Guarded like translate-missing-locales.ts: only empty slots, snapshot first, never prod.
 * Usage: npx tsx scripts/translate-goal-choreographies.ts count|sample|apply [--locales=es,tr] [--limit=N]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import postgres from 'postgres';

const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
const PROD_REF = 'lfbwhxvwubzeqkztghok';
const MODES = ['count', 'sample', 'apply'] as const;
const [modeArg = 'count'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!(MODES as readonly string[]).includes(modeArg)) { console.error(`ABORT: mode must be one of ${MODES.join(' | ')}`); process.exit(1); }
const mode = modeArg as (typeof MODES)[number];
const opt = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const LOCALES = opt('locales', 'es,tr').split(',');
const LIMIT = Number(opt('limit', '0'));
const env = readFileSync('.env', 'utf8');
const envVar = (k: string) => env.match(new RegExp(`^${k}\\s*=\\s*"?([^"\\n]+)"?`, 'm'))?.[1];
/** Strict target check: the staging project must be the connection's user or host, and the prod ref must not appear anywhere. */
function assertStagingUrl(url: string, prodRef: string, stagingRef: string): void {
  let host = '', user = '';
  try { const u = new URL(url); host = u.hostname; user = decodeURIComponent(u.username); } catch { console.error('ABORT: DATABASE_URL is not a valid URL'); process.exit(1); }
  const targetsStaging = host.startsWith(`db.${stagingRef}.`) || user.endsWith(`.${stagingRef}`) || user === `postgres.${stagingRef}`;
  if (!targetsStaging || url.includes(prodRef)) { console.error(`ABORT: DATABASE_URL must target the staging project ${stagingRef} (host or pooler user), never ${prodRef}`); process.exit(1); }
}
const dbUrl = envVar('DATABASE_URL') ?? '';
assertStagingUrl(dbUrl, PROD_REF, STAGING_REF);
const API_KEY = envVar('OPENROUTER_API_KEY'); const MODEL = envVar('OPENROUTER_MODEL') ?? 'google/gemini-3-flash-preview';
const sql = postgres(dbUrl, { ssl: 'require', max: 1, connect_timeout: 20 });
const LANG: Record<string, string> = { tr: 'Turkish', es: 'Spanish' };
for (const l of LOCALES) if (!LANG[l]) { console.error(`ABORT: unsupported locale ${l}`); process.exit(1); }
type Node = Record<string, unknown>;
const isTextNode = (v: unknown): v is Node => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Node).en === 'string';
const empty = (v: unknown) => typeof v !== 'string' || v.trim() === '';
function nodes(v: unknown, out: Node[] = []): Node[] {
  if (isTextNode(v)) out.push(v); else if (Array.isArray(v)) v.forEach((x) => nodes(x, out)); else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => nodes(x, out));
  return out;
}
async function translateBatch(locale: string, items: Array<{ key: string; en: string }>): Promise<Map<string, string>> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
    model: MODEL, temperature: 0.2, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `You translate short football (soccer) texts about famous goals from English to ${LANG[locale]} for a "Guess the Goal" quiz: goal titles ("Scorer — Team vs Team, competition year"), answer options, fun facts and bonus questions. Keep player, club and stadium names in Latin script as written (do not translate them); write countries / national teams and competitions the way a ${LANG[locale]} fan says them (e.g. Spanish "Checoslovaquia", "Alemania Occidental", "Mundial 2006"; Turkish "Çekoslovakya", "Batı Almanya", "2006 Dünya Kupası"); "vs" becomes the natural ${LANG[locale]} form; keep years, scores and punctuation; natural fan phrasing, about as short as the English; no explanations. Return ONLY a JSON object mapping each input key to its translation.` },
      { role: 'user', content: JSON.stringify(Object.fromEntries(items.map((i) => [i.key, i.en]))) },
    ] }) });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const parsed = JSON.parse((data.choices[0]?.message?.content ?? '{}').replace(/^```json\s*|```$/g, '')) as Record<string, string>;
  return new Map(items.flatMap((i) => (typeof parsed[i.key] === 'string' && parsed[i.key].trim() ? [[i.key, parsed[i.key].trim()] as const] : [])));
}
async function main() {
  console.log(`STAGING goal_choreographies · mode ${mode} · locales ${LOCALES.join(',')} · model ${MODEL}\n`);
  type Row = { id: string; status: string; title: unknown; options: unknown; fun_fact: unknown; bonus: unknown; match_label: string | null; match_label_es: string | null; match_label_tr: string | null };
  const rows = await sql<Row[]>`SELECT id, status, title, options, fun_fact, bonus, match_label, match_label_es, match_label_tr FROM goal_choreographies ORDER BY status, id`;
  // match_label lives in text columns: model it as a node so the same walker fills it.
  const labelNode = new Map<string, Node>();
  for (const r of rows) if (r.match_label) labelNode.set(r.id, { en: r.match_label, es: r.match_label_es ?? '', tr: r.match_label_tr ?? '' });
  type Item = { key: string; row: Row; node: Node; locale: string; en: string };
  const items: Item[] = [];
  for (const r of rows) {
    const all = [...nodes(r.title), ...nodes(r.options), ...nodes(r.fun_fact), ...nodes(r.bonus), ...(labelNode.has(r.id) ? [labelNode.get(r.id)!] : [])];
    for (const [i, n] of all.entries()) for (const l of LOCALES) if (empty(n[l])) items.push({ key: `${r.id}#${i}#${l}`, row: r, node: n, locale: l, en: n.en as string });
  }
  const by = new Map<string, number>();
  for (const it of items) { const k = `${it.row.status} ${it.locale}`; by.set(k, (by.get(k) ?? 0) + 1); }
  console.log(`empty slots: ${items.length} across ${new Set(items.map((i) => i.row.id)).size} goals`);
  for (const [k, c] of [...by.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${c}`);
  if (mode === 'count') return;
  const work = LIMIT > 0 ? items.slice(0, LIMIT) : items;
  const touched = new Map<string, Row>(); const snapshot: Row[] = []; let filled = 0, failed = 0;
  for (const locale of LOCALES) {
    const mine = work.filter((w) => w.locale === locale);
    for (let i = 0; i < mine.length; i += 40) {
      const batch = mine.slice(i, i + 40);
      const uniq = [...new Map(batch.map((b) => [b.en, b])).values()].map((b) => ({ key: b.key, en: b.en }));
      let t: Map<string, string>;
      try { t = await translateBatch(locale, uniq); } catch (e) { failed += batch.length; console.error(`batch failed: ${(e as Error).message}`); continue; }
      const byEn = new Map(uniq.map((u) => [u.en, t.get(u.key)]));
      for (const b of batch) {
        const tr = byEn.get(b.en); if (!tr) { failed += 1; continue; }
        if (mode === 'sample') { console.log(`[${locale}] ${b.en}\n   → ${tr}`); continue; }
        if (!touched.has(b.row.id)) { touched.set(b.row.id, b.row); snapshot.push(JSON.parse(JSON.stringify(b.row))); }
        if (empty(b.node[locale])) { b.node[locale] = tr; filled += 1; }
      }
    }
  }
  if (mode === 'sample') { console.log(`\nsample only — nothing written (failed: ${failed})`); return; }
  mkdirSync('scripts/.snapshots', { recursive: true });
  const snap = `scripts/.snapshots/goal-choreographies-${LOCALES.join('-')}-${Date.now()}.json`; writeFileSync(snap, JSON.stringify(snapshot));
  let updated = 0;
  await sql.begin(async (tx) => {
    for (const r of touched.values()) {
      const label = labelNode.get(r.id);
      await tx`UPDATE goal_choreographies SET title = ${tx.json(r.title as never)}, options = ${tx.json(r.options as never)}, fun_fact = ${tx.json(r.fun_fact as never)}, bonus = ${tx.json(r.bonus as never)},
        match_label_es = ${label && !empty(label.es) ? (label.es as string) : r.match_label_es}, match_label_tr = ${label && !empty(label.tr) ? (label.tr as string) : r.match_label_tr}, updated_at = now() WHERE id = ${r.id}`;
      updated += 1;
    }
  });
  console.log(`filled ${filled} slots in ${updated} goals (failed: ${failed}); snapshot ${snap}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => sql.end());

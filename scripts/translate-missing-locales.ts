#!/usr/bin/env npx tsx
/**
 * Fill missing question locales on STAGING with Gemini (via OpenRouter), guarded:
 * only empty slots are written, English is the source, proper nouns stay verbatim,
 * every touched row is snapshotted first. Never runs against prod.
 *
 * Usage:
 *   npx tsx scripts/translate-missing-locales.ts count  [--locales=tr,es,ka] [--types=a,b]
 *   npx tsx scripts/translate-missing-locales.ts sample --locales=tr [--types=…] [--limit=8]   # live call, no writes
 *   npx tsx scripts/translate-missing-locales.ts apply  --locales=tr [--types=…] [--limit=N]   # writes staging
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import postgres from 'postgres';

const STAGING_REF = 'nsdfiprfmhdqhbfxfwpv';
const PROD_REF = 'lfbwhxvwubzeqkztghok';
const MODES = ['count', 'sample', 'apply', 'recheck-copies'] as const;
const [modeArg = 'count'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!(MODES as readonly string[]).includes(modeArg)) { console.error(`ABORT: mode must be one of ${MODES.join(' | ')}`); process.exit(1); }
const mode = modeArg as (typeof MODES)[number];
const opt = (name: string, def: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? def;
const LOCALES = opt('locales', 'tr,es,ka').split(',');
const TYPES = opt('types', '').split(',').filter(Boolean);
const LIMIT = Number(opt('limit', '0'));
const BATCH = 40;

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

const LANG: Record<string, string> = { tr: 'Turkish', es: 'Spanish', ka: 'Georgian' };
for (const l of LOCALES) if (!LANG[l]) { console.error(`ABORT: unsupported locale ${l}`); process.exit(1); }
type Json = unknown;
type Node = Record<string, unknown>;
const isTextNode = (v: Json): v is Node => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Node).en === 'string';
const empty = (v: unknown) => typeof v !== 'string' || v.trim() === '';

/** Every {en,…} node under a JSON value (by reference, so fills land in place). */
function nodes(v: Json, out: Node[] = []): Node[] {
  if (isTextNode(v)) out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => nodes(x, out));
  else if (v && typeof v === 'object') Object.values(v as Record<string, Json>).forEach((x) => nodes(x, out));
  return out;
}

async function translateBatch(locale: string, items: Array<{ key: string; en: string }>): Promise<Map<string, string>> {
  const body = {
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: locale === 'ka'
        ? `You translate football (soccer) trivia UI strings from English to Georgian for a Georgian football app. Rules: write EVERYTHING in Georgian script — transliterate player, club, stadium, competition and person names into Georgian the way Georgian sports media do (Messi → მესი, Brighton → ბრაიტონი, Arsenal → არსენალი, Manchester United → მანჩესტერ იუნაიტედი, Premier League → პრემიერ ლიგა); never leave Latin letters except abbreviations like AC, FC, PSG, VAR, UEFA; keep numbers, seasons like 18/19, arrows (→), currency symbols and punctuation; use the terminology a Georgian fan would use; keep each translation about as short as the English; no explanations. Return ONLY a JSON object mapping each input key to its translation.`
        : `You translate football (soccer) trivia UI strings from English to ${LANG[locale]}. Rules: keep player, club, stadium, competition and person names exactly as written in Latin script (do not translate or localise them); keep numbers, seasons like 18/19, arrows (→), currency symbols and punctuation; use the football terminology a native ${LANG[locale]} fan would use; keep each translation about as short as the English; no explanations. Return ONLY a JSON object mapping each input key to its translation.` },
      { role: 'system', content: 'Some inputs are just proper nouns (players, clubs, stadiums, competitions) that must stay exactly as written — return those unchanged. Translate everything else, including short labels such as positions, body parts, outcomes and units.' },
      { role: 'user', content: JSON.stringify(Object.fromEntries(items.map((i) => [i.key, i.en]))) },
    ],
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { choices: Array<{ message: { content: string } }> };
  const text = data.choices[0]?.message?.content ?? '{}';
  const parsed = JSON.parse(text.replace(/^```json\s*|```$/g, '')) as Record<string, string>;
  const out = new Map<string, string>();
  for (const i of items) { const t = parsed[i.key]; if (typeof t === 'string' && t.trim()) out.set(i.key, t.trim()); }
  return out;
}

async function main() {
  console.log(`STAGING ${STAGING_REF} · mode ${mode} · locales ${LOCALES.join(',')}${TYPES.length ? ` · types ${TYPES.join(',')}` : ''} · model ${MODEL}\n`);
  const rows = await sql<Array<{ id: string; type: string; prompt: Json; payload: Json }>>`
    SELECT q.id, q.type, q.prompt, qp.payload FROM questions q JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.status = 'published' ${TYPES.length ? sql`AND q.type = ANY(${TYPES})` : sql``} ORDER BY q.type, q.id`;
  // Work items: one per (row, node, locale) with an empty slot.
  type Item = { key: string; row: typeof rows[number]; node: Node; locale: string; en: string };
  const items: Item[] = [];
  for (const r of rows) for (const [i, n] of [...nodes(r.prompt), ...nodes(r.payload)].entries()) for (const l of LOCALES) {
    if (empty(n[l])) items.push({ key: `${r.id}#${i}#${l}`, row: r, node: n, locale: l, en: n.en as string });
  }
  // recheck-copies: slots that equal their English (copied earlier, or never localised) go to the model, which returns
  // proper nouns unchanged and translates everything else. Existing values stay intact until a translation succeeds.
  if (mode === 'recheck-copies') {
    items.length = 0;
    for (const r of rows) for (const [i, n] of [...nodes(r.prompt), ...nodes(r.payload)].entries()) for (const l of LOCALES) {
      if (l === 'ka' || typeof n[l] !== 'string' || n[l] !== n.en) continue;
      items.push({ key: `${r.id}#${i}#${l}`, row: r, node: n, locale: l, en: n.en as string });
    }
    console.log(`slots equal to English to re-check with the model: ${items.length}`);
  }
  const byTypeLocale = new Map<string, number>();
  for (const it of items) { const k = `${it.row.type} ${it.locale}`; byTypeLocale.set(k, (byTypeLocale.get(k) ?? 0) + 1); }
  console.log(`${mode === 'recheck-copies' ? 'slots to re-check' : 'empty locale slots'}: ${items.length} across ${new Set(items.map((i) => i.row.id)).size} rows`);
  for (const [k, c] of [...byTypeLocale.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${c}`);
  if (mode === 'count') return;
  if (!API_KEY) { console.error('ABORT: OPENROUTER_API_KEY missing in .env'); process.exit(1); }
  const work = LIMIT > 0 ? items.slice(0, LIMIT) : items;
  const touched = new Map<string, typeof rows[number]>();
  const snapshot: Array<{ id: string; prompt: Json; payload: Json }> = [];
  let filled = 0, failed = 0;
  for (const locale of LOCALES) {
    const mine = work.filter((w) => w.locale === locale);
    for (let i = 0; i < mine.length; i += BATCH) {
      const batch = mine.slice(i, i + BATCH);
      // Identical English strings translate once per batch.
      const uniq = [...new Map(batch.map((b) => [b.en, b])).values()].map((b) => ({ key: b.key, en: b.en }));
      let translated: Map<string, string>;
      try { translated = await translateBatch(locale, uniq); } catch (e) { failed += batch.length; console.error(`batch failed: ${(e as Error).message}`); continue; }
      const byEn = new Map(uniq.map((u) => [u.en, translated.get(u.key)]));
      for (const b of batch) {
        const t = byEn.get(b.en);
        if (!t) { failed += 1; continue; }
        if (mode === 'sample') { console.log(`[${locale}] ${b.en}\n   → ${t}`); continue; }
        if (!touched.has(b.row.id)) { touched.set(b.row.id, b.row); snapshot.push({ id: b.row.id, prompt: JSON.parse(JSON.stringify(b.row.prompt)), payload: JSON.parse(JSON.stringify(b.row.payload)) }); }
        if (mode === 'recheck-copies' ? b.node[locale] === b.en : empty(b.node[locale])) { b.node[locale] = t; filled += 1; }
      }
      process.stdout.write(`\r${locale}: ${Math.min(i + BATCH, mine.length)}/${mine.length}   `);
    }
    console.log();
  }
  if (mode === 'sample') { console.log(`\nsample only — nothing written (failed: ${failed})`); return; }
  mkdirSync('scripts/.snapshots', { recursive: true });
  // Snapshot before writing: the pre-fill JSON of every row about to change.
  const snapFile = `scripts/.snapshots/translate-${LOCALES.join('-')}-${Date.now()}.json`;
  writeFileSync(snapFile, JSON.stringify(snapshot));
  let updated = 0;
  await sql.begin(async (tx) => {
    for (const r of touched.values()) {
      await tx`UPDATE questions SET prompt = ${tx.json(r.prompt as never)}, updated_at = now() WHERE id = ${r.id}`;
      await tx`UPDATE question_payloads SET payload = ${tx.json(r.payload as never)} WHERE question_id = ${r.id}`;
      updated += 1;
    }
  });
  console.log(`filled ${filled} slots in ${updated} rows (failed: ${failed}); snapshot ${snapFile}`);
}
main().catch((e) => { console.error(e); process.exit(1); }).finally(() => sql.end());

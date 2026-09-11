// Restores the `verified` record on Missing XI payloads that were inserted by
// xi_insert.mjs before it wrote that field. Source of truth: squads.json (the
// UEFA / Wikipedia checks already done) + the per-database inserted-ids file,
// which lists question ids in squads.json order. Dry run by default; pass
// --apply to write. Usage: DATABASE_URL=... node xi_backfill_verified.mjs [--apply]
import fs from 'node:fs';
import postgres from 'postgres';

const HERE = new URL('.', import.meta.url).pathname;
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error('DATABASE_URL required'); process.exit(1); }
const apply = process.argv.includes('--apply');
const idsFile = `${HERE}/inserted-ids.${dbUrl.split('/').pop().split('?')[0]}.json`;
if (!fs.existsSync(idsFile)) { console.error('no inserted-ids file for this database:', idsFile); process.exit(1); }
const squads = JSON.parse(fs.readFileSync(`${HERE}/squads.json`, 'utf8'));
const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
if (ids.length !== squads.length) { console.error(`id count ${ids.length} != squads ${squads.length}`); process.exit(1); }

const sql = postgres(dbUrl, { max: 2, ssl: dbUrl.includes('localhost') ? false : 'require' });
const rows = await sql`select question_id, payload->'team'->>'en' as team, payload->'match_label'->>'en' as label, payload->>'season' as season, jsonb_typeof(payload->'verified') = 'object' as has_verified from question_payloads where question_id = any(${ids})`;
const byId = new Map(rows.map((r) => [r.question_id, r]));

const updates = [];
let mismatched = 0, missing = 0, already = 0, unverified = 0;
squads.forEach((s, i) => {
  const row = byId.get(ids[i]);
  if (!row) { missing += 1; return; }
  if (row.team !== s.team.en || row.label !== s.match_label.en || String(row.season) !== String(s.season)) { mismatched += 1; return; }
  if (!s.verified) { unverified += 1; return; }
  if (row.has_verified) { already += 1; return; }
  updates.push({ id: ids[i], verified: s.verified });
});
console.log({ squads: squads.length, toUpdate: updates.length, already, unverified, mismatched, missing, mode: apply ? 'APPLY' : 'dry-run' });
if (mismatched || missing) { console.error('refusing: alignment problems'); await sql.end(); process.exit(1); }
if (apply && updates.length) {
  await sql.begin(async (tx) => {
    for (const u of updates) await tx`update question_payloads set payload = payload || ${tx.json({ verified: u.verified })} where question_id = ${u.id}`;
  });
  const [{ n }] = await sql`select count(*)::int as n from question_payloads where question_id = any(${ids}) and jsonb_typeof(payload->'verified') = 'object'`;
  console.log('verified records now present:', n);
}
await sql.end();

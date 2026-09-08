// Insert Missing XI squads as published missing_xi questions and configure the daily.
// Node port of xi_insert.py (the local Python has no psycopg). Usage: node scripts/missing-xi-content/xi_insert.mjs <db_url>
// Idempotent per database: skips when the inserted-ids file for that DB exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = process.argv[2]; if (!dbUrl) throw new Error('db url required');
const squads = JSON.parse(fs.readFileSync(`${HERE}/squads.json`, 'utf8'));
const idsFile = `${HERE}/inserted-ids.${dbUrl.split('/').pop().split('?')[0]}.json`;
if (fs.existsSync(idsFile)) { console.log('already inserted:', idsFile); process.exit(0); }
const sql = postgres(dbUrl, { prepare: false, max: 2 });
try {
  let cat = (await sql`select id from categories where slug = 'missing-xi'`)[0]?.id;
  if (!cat) {
    cat = randomUUID();
    await sql`insert into categories (id, slug, name, description, is_active) values (${cat}, 'missing-xi', ${sql.json({ en: 'Missing XI', ka: 'დაკარგული XI', es: 'XI perdido' })}, ${sql.json({ en: 'Famous starting line-ups', ka: 'ცნობილი შემადგენლობები', es: 'Alineaciones famosas' })}, true)`;
  }
  const ids = [];
  await sql.begin(async (tx) => {
    for (const s of squads) {
      const qid = randomUUID(); ids.push(qid);
      const prompt = { en: `${s.team.en} – ${s.match_label.en}`, ka: `${s.team.ka} – ${s.match_label.ka}`, es: `${s.team.es} – ${s.match_label.es}` };
      const payload = { type: 'missing_xi', team: s.team, opponent: s.opponent, match_label: s.match_label, formation: s.formation, score: s.score, season: s.season,
        slots: s.slots.map((sl) => ({ id: sl.id, position: sl.position, number: sl.number, x: sl.x, y: sl.y, name: sl.name, accepted_answers: sl.accepted_answers, tm_id: sl.tm_id })) };
      await tx`insert into questions (id, category_id, type, difficulty, status, prompt, explanation, ranked_eligible, visibility) values (${qid}, ${cat}, 'missing_xi', ${s.difficulty}, 'published', ${tx.json(prompt)}, null, true, 'public')`;
      await tx`insert into question_payloads (question_id, payload) values (${qid}, ${tx.json(payload)})`;
    }
    const settings = { challengeType: 'missingXi', categoryIds: [cat], squadCount: 3, secondsPerSquad: 120 };
    const existing = await tx`select 1 from daily_challenge_configs where challenge_type = 'missingXi'`;
    if (existing.length) await tx`update daily_challenge_configs set settings = ${tx.json(settings)}, is_active = true, updated_at = now() where challenge_type = 'missingXi'`;
    else await tx`insert into daily_challenge_configs (challenge_type, is_active, sort_order, show_on_home, coin_reward, xp_reward, settings) values ('missingXi', true, 11, false, 30, 90, ${tx.json(settings)})`;
  });
  fs.writeFileSync(idsFile, JSON.stringify(ids));
  const [{ count }] = await sql`select count(*)::int as count from questions where type = 'missing_xi' and status = 'published'`;
  console.log('published missing_xi:', count, 'category', cat);
} finally { await sql.end(); }

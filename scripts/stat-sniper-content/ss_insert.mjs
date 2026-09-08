// Insert Stat Sniper questions and configure the daily.
// Usage: node scripts/stat-sniper-content/ss_insert.mjs <db_url>   (skips when the ids file for that DB exists)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = process.argv[2]; if (!dbUrl) throw new Error('db url required');
const questions = JSON.parse(fs.readFileSync(`${HERE}/questions.json`, 'utf8'));
const idsFile = `${HERE}/inserted-ids.${dbUrl.split('/').pop().split('?')[0]}.json`;
const sql = postgres(dbUrl, { prepare: false });
try {
  let cat = (await sql`select id from categories where slug = 'stat-sniper'`)[0]?.id;
  if (!cat) {
    cat = randomUUID();
    await sql`insert into categories (id, slug, name, description, is_active) values (${cat}, 'stat-sniper', ${sql.json({ en: 'Stat Sniper', ka: 'სტატ-სნაიპერი', es: 'Francotirador de datos' })}, ${sql.json({ en: 'Closest-guess football numbers', ka: 'ფეხბურთის რიცხვები — მიახლოებითი ვარაუდი', es: 'Cifras del fútbol: acierta lo más cerca' })}, true)`;
  }
  let inserted = 0;
  if (fs.existsSync(idsFile)) console.log('already inserted:', idsFile);
  else {
    const ids = [];
    for (const q of questions) {
      const qid = randomUUID(); ids.push(qid);
      const payload = { type: 'stat_sniper', kind: q.kind, prompt: q.prompt, unit: q.unit, value: q.value, min: q.min, max: q.max, step: q.step, source: q.source };
      await sql`insert into questions (id, category_id, type, difficulty, status, prompt, explanation, ranked_eligible, visibility) values (${qid}, ${cat}, 'stat_sniper', ${q.difficulty}, 'published', ${sql.json(q.prompt)}, null, true, 'public')`;
      await sql`insert into question_payloads (question_id, payload) values (${qid}, ${sql.json(payload)})`;
      inserted++;
    }
    fs.writeFileSync(idsFile, JSON.stringify(ids));
  }
  const settings = { challengeType: 'statSniper', categoryIds: [cat], questionCount: 10, secondsPerQuestion: 30 };
  const existing = await sql`select 1 from daily_challenge_configs where challenge_type = 'statSniper'`;
  if (existing.length) await sql`update daily_challenge_configs set settings = ${sql.json(settings)}, is_active = true, updated_at = now() where challenge_type = 'statSniper'`;
  else await sql`insert into daily_challenge_configs (challenge_type, is_active, sort_order, show_on_home, coin_reward, xp_reward, settings) values ('statSniper', true, 13, false, 3, 90, ${sql.json(settings)})`;
  const [{ count }] = await sql`select count(*)::int as count from questions where type = 'stat_sniper' and status = 'published'`;
  console.log({ inserted, published: count, category: cat });
} finally { await sql.end(); }

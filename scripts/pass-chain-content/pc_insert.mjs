// Insert the Pass Chain universe + puzzles and configure the daily.
// Usage: node scripts/pass-chain-content/pc_insert.mjs <db_url>   (idempotent: players upserted, puzzles skipped when already inserted)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = process.argv[2]; if (!dbUrl) throw new Error('db url required');
const universe = JSON.parse(fs.readFileSync(`${HERE}/universe.json`, 'utf8'));
const puzzles = JSON.parse(fs.readFileSync(`${HERE}/puzzles.json`, 'utf8'));
const idsFile = `${HERE}/inserted-ids.${dbUrl.split('/').pop().split('?')[0]}.json`;
const normalize = (v) => v.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const sql = postgres(dbUrl, { prepare: false });
try {
  let players = 0;
  for (const p of Object.values(universe)) {
    const aliases = Array.from(new Set([...p.aliases, p.name.en, p.name.ka].filter(Boolean)));
    const normalized = Array.from(new Set(aliases.map(normalize).filter(Boolean)));
    await sql`insert into pass_chain_players (id, tm_id, name, aliases, normalized_aliases, clubs, managers, image_url)
              values (${p.id}, ${p.tm_id}, ${sql.json(p.name)}, ${aliases}, ${normalized}, ${sql.json(p.clubs)}, ${sql.json(p.managers ?? [])}, ${p.image_url})
              on conflict (tm_id) do update set name = excluded.name, aliases = excluded.aliases, normalized_aliases = excluded.normalized_aliases, clubs = excluded.clubs, managers = excluded.managers, image_url = excluded.image_url, updated_at = now()`;
    players++;
  }
  let cat = (await sql`select id from categories where slug = 'pass-chain'`)[0]?.id;
  if (!cat) {
    cat = randomUUID();
    await sql`insert into categories (id, slug, name, description, is_active) values (${cat}, 'pass-chain', ${sql.json({ en: 'Pass Chain', ka: 'პასების ჯაჭვი', es: 'Cadena de pases' })}, ${sql.json({ en: 'Link players through shared clubs', ka: 'დააკავშირე ფეხბურთელები საერთო კლუბებით', es: 'Conecta jugadores por clubes compartidos' })}, true)`;
  }
  let inserted = 0;
  if (fs.existsSync(idsFile)) console.log('puzzles already inserted:', idsFile);
  else {
    const ids = [];
    for (const z of puzzles) {
      const start = universe[String(z.start)], target = universe[String(z.target)];
      const qid = randomUUID(); ids.push(qid);
      const prompt = Object.fromEntries(['en', 'ka', 'es'].map((l) => [l, `${start.name[l] ?? start.name.en} → ${target.name[l] ?? target.name.en}`]));
      const solution = z.solution.map((s) => ({ tm_id: s.tm_id, kind: s.via.kind, via: { en: s.via.en, ka: s.via.ka, es: s.via.es } }));
      const payload = { type: 'pass_chain', start_tm_id: z.start, target_tm_id: z.target, par: z.par, bridges: z.bridges, solution };
      await sql`insert into questions (id, category_id, type, difficulty, status, prompt, explanation, ranked_eligible, visibility) values (${qid}, ${cat}, 'pass_chain', ${z.difficulty}, 'published', ${sql.json(prompt)}, null, true, 'public')`;
      await sql`insert into question_payloads (question_id, payload) values (${qid}, ${sql.json(payload)})`;
      inserted++;
    }
    fs.writeFileSync(idsFile, JSON.stringify(ids));
  }
  const settings = { challengeType: 'passChain', categoryIds: [cat], puzzleCount: 2, secondsPerPuzzle: 120 };
  const existing = await sql`select 1 from daily_challenge_configs where challenge_type = 'passChain'`;
  if (existing.length) await sql`update daily_challenge_configs set settings = ${sql.json(settings)}, is_active = true, updated_at = now() where challenge_type = 'passChain'`;
  else await sql`insert into daily_challenge_configs (challenge_type, is_active, sort_order, show_on_home, coin_reward, xp_reward, settings) values ('passChain', true, 12, false, 150, 90, ${sql.json(settings)})`;
  const [{ count }] = await sql`select count(*)::int as count from questions where type = 'pass_chain' and status = 'published'`;
  console.log({ players, puzzlesInserted: inserted, publishedPuzzles: count, category: cat });
} finally { await sql.end(); }

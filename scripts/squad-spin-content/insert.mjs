// Load the Squad Spin content snapshot into a target database (idempotent upserts).
// Usage: node scripts/squad-spin-content/insert.mjs <target_db_url> [--version N]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = process.argv[2];
if (!dbUrl) throw new Error('target db url required');
const versionArg = process.argv.indexOf('--version');
const version = versionArg > 0 ? Number(process.argv[versionArg + 1]) : 1;
const content = JSON.parse(fs.readFileSync(`${HERE}/content.json`, 'utf8'));
const sql = postgres(dbUrl, { prepare: false, max: 4 });
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, (i + 1) * n));

try {
  await sql.begin(async (tx) => {
    for (const batch of chunk(content.criteria, 200)) {
      await tx`INSERT INTO squad_spin_criteria ${tx(batch.map((c) => ({ id: c.id, family: c.family, criterion_key: c.criterion_key, label_en: c.label_en, label_ka: c.label_ka, asset_key: c.asset_key, content_version: version })))}
        ON CONFLICT (id) DO UPDATE SET family = excluded.family, criterion_key = excluded.criterion_key, label_en = excluded.label_en, label_ka = excluded.label_ka, asset_key = excluded.asset_key, content_version = excluded.content_version`;
    }
    for (const batch of chunk(content.players, 500)) {
      await tx`INSERT INTO squad_spin_players ${tx(batch.map((p) => ({ ...p, content_version: version })))}
        ON CONFLICT (id) DO UPDATE SET name_en = excluded.name_en, name_ka = excluded.name_ka, image_url = excluded.image_url, position_group = excluded.position_group, nationality_code = excluded.nationality_code, peak_value_eur = excluded.peak_value_eur, content_version = excluded.content_version`;
    }
    await tx`DELETE FROM squad_spin_player_aliases WHERE player_id = ANY(${content.players.map((p) => p.id)}::uuid[])`;
    const seen = new Set();
    const aliases = content.aliases.filter((a) => { const k = `${a.player_id}|${a.normalized_alias}|${a.locale}`; if (seen.has(k)) return false; seen.add(k); return true; });
    for (const batch of chunk(aliases, 1000)) await tx`INSERT INTO squad_spin_player_aliases ${tx(batch)}`;
    // Combos: upsert on the natural key; anything not in this snapshot is deactivated (never deleted — rounds reference it).
    await tx`UPDATE squad_spin_combos SET active = false WHERE content_version <> ${version}`;
    for (const batch of chunk(content.combos, 500)) {
      await tx`INSERT INTO squad_spin_combos ${tx(batch.map((c) => ({ reels: c.reels, club_id: c.club_id, nation_id: c.nation_id, position_group: c.position_group, extra_ids: c.extra_ids, answer_ids: c.answer_ids, n_answers: c.n_answers, tier: c.tier, active: true, content_version: version })))}
        ON CONFLICT (club_id, nation_id, position_group, extra_ids) DO UPDATE SET answer_ids = excluded.answer_ids, n_answers = excluded.n_answers, tier = excluded.tier, active = true, content_version = excluded.content_version`;
    }
  });
  const [counts] = await sql`SELECT (SELECT count(*) FROM squad_spin_combos WHERE active) AS combos, (SELECT count(*) FROM squad_spin_players) AS players, (SELECT count(*) FROM squad_spin_player_aliases) AS aliases`;
  console.log('inserted', counts);
} finally {
  await sql.end();
}

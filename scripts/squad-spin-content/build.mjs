// Build the Squad Spin content snapshot from a Grid content release (read-only).
// Usage: node scripts/squad-spin-content/build.mjs <source_db_url> [release_id]
// Writes content.json next to this file: criteria, players (+aliases) and combos.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = process.argv[2];
if (!dbUrl) throw new Error('source db url required');
const sql = postgres(dbUrl, { prepare: false, max: 2 });

const EXTRA_FAMILIES = ['league', 'manager', 'trophy_award'];
const MAX_4REEL_PER_BASE = 6;
const MAX_5REEL_PER_BASE = 4;
/** A 3-reel combo needs two answers and at least one recognisable one (peak value). */
const MIN_STAR_VALUE_EUR = Number(process.env.MIN_STAR_VALUE_EUR ?? 10_000_000);

const seededSort = (items, key) => items
  .map((item) => ({ item, h: createHash('sha1').update(`${key}:${item.id}`).digest('hex') }))
  .sort((a, b) => (a.h < b.h ? -1 : 1))
  .map((x) => x.item);

try {
  const releaseId = process.argv[3] ?? (await sql`
    SELECT r.id FROM football_grid_content_releases r
    WHERE r.status = 'published'
    ORDER BY r.created_at DESC LIMIT 1`)[0]?.id;
  if (!releaseId) throw new Error('no published grid release');
  console.log('release', releaseId);

  const criteria = await sql`
    SELECT id, family, criterion_key, label_en, label_ka, asset_key
    FROM football_grid_criteria WHERE release_id = ${releaseId}
      AND family IN ('club', 'country', 'league', 'manager', 'trophy_award')`;
  const memberships = await sql`
    SELECT m.criterion_id, m.football_player_id AS player_id
    FROM football_grid_criterion_memberships m
    JOIN football_grid_criteria c ON c.id = m.criterion_id
    WHERE m.release_id = ${releaseId} AND c.family IN ('club', 'country', 'league', 'manager', 'trophy_award')`;
  const players = await sql`
    SELECT DISTINCT p.id, p.name, p.image_url, p.position_group, p.nationality_code, p.peak_value_eur
    FROM football_players p
    JOIN football_grid_criterion_memberships m ON m.football_player_id = p.id AND m.release_id = ${releaseId}
    WHERE p.position_group IS NOT NULL`;
  const aliases = await sql`
    SELECT a.football_player_id AS player_id, a.normalized_alias, a.locale, a.acceptance_policy, a.alias, a.alias_type
    FROM football_grid_player_aliases a WHERE a.release_id = ${releaseId}`;
  const kaNames = await sql`SELECT football_player_id AS player_id, name FROM football_player_name_translations WHERE locale = 'ka'`;

  const critById = new Map(criteria.map((c) => [c.id, c]));
  const playerById = new Map(players.map((p) => [p.id, p]));
  const membersOf = new Map(); // criterion -> Set(player)
  const critsOf = new Map(); // player -> criteria ids
  for (const m of memberships) {
    if (!playerById.has(m.player_id)) continue;
    if (!membersOf.has(m.criterion_id)) membersOf.set(m.criterion_id, new Set());
    membersOf.get(m.criterion_id).add(m.player_id);
    if (!critsOf.has(m.player_id)) critsOf.set(m.player_id, []);
    critsOf.get(m.player_id).push(m.criterion_id);
  }

  // Base combos: club × nation × position from each player's own memberships.
  const base = new Map(); // key -> { club, nation, pos, answers:Set }
  for (const [pid, cids] of critsOf) {
    const p = playerById.get(pid);
    const clubs = cids.filter((id) => critById.get(id)?.family === 'club');
    const nations = cids.filter((id) => critById.get(id)?.family === 'country');
    for (const club of clubs) for (const nation of nations) {
      const key = `${club}|${nation}|${p.position_group}`;
      if (!base.has(key)) base.set(key, { id: key, club, nation, pos: p.position_group, answers: new Set() });
      base.get(key).answers.add(pid);
    }
  }
  const extras = criteria.filter((c) => EXTRA_FAMILIES.includes(c.family));
  const starValue = (ids) => Math.max(0, ...ids.map((id) => Number(playerById.get(id)?.peak_value_eur ?? 0)));
  const tierFor = (reels, n) => (reels >= 5 ? 't5' : reels === 4 ? 't4' : n >= 3 ? 't3e' : 't3m');

  const combos = [];
  const usedPlayers = new Set();
  const push = (reels, b, extraIds, answers) => {
    combos.push({ reels, club_id: b.club, nation_id: b.nation, position_group: b.pos, extra_ids: extraIds, answer_ids: answers, n_answers: answers.length, tier: tierFor(reels, answers.length) });
    answers.forEach((id) => usedPlayers.add(id));
  };
  let stats = { base: base.size, base3: 0, four: 0, five: 0 };
  for (const b of base.values()) {
    const answers = [...b.answers];
    if (answers.length >= 2 && starValue(answers) >= MIN_STAR_VALUE_EUR) { push(3, b, [], answers); stats.base3 += 1; }
    // Extra reels must intersect the base answers; prefer ones that narrow the set.
    const narrowing = extras
      .map((e) => ({ id: e.id, answers: answers.filter((pid) => membersOf.get(e.id)?.has(pid)) }))
      .filter((e) => e.answers.length >= 1);
    const fours = seededSort(narrowing, `${b.id}:4`).slice(0, MAX_4REEL_PER_BASE);
    for (const e of fours) { push(4, b, [e.id], e.answers); stats.four += 1; }
    const pairs = [];
    for (let i = 0; i < narrowing.length; i += 1) for (let j = i + 1; j < narrowing.length; j += 1) {
      const a = narrowing[i], c = narrowing[j];
      if (critById.get(a.id).family === critById.get(c.id).family && critById.get(a.id).family !== 'trophy_award') continue;
      const both = a.answers.filter((pid) => c.answers.includes(pid));
      if (both.length >= 1) pairs.push({ id: `${a.id}+${c.id}`, ids: [a.id, c.id].sort(), answers: both });
    }
    for (const e of seededSort(pairs, `${b.id}:5`).slice(0, MAX_5REEL_PER_BASE)) { push(5, b, e.ids, e.answers); stats.five += 1; }
  }

  const usedCriteria = new Set(combos.flatMap((c) => [c.club_id, c.nation_id, ...c.extra_ids]));
  const kaById = new Map(kaNames.map((k) => [k.player_id, k.name]));
  for (const a of aliases) if (a.locale === 'ka' && a.alias_type === 'georgian' && !kaById.has(a.player_id)) kaById.set(a.player_id, a.alias);
  const out = {
    release_id: releaseId,
    built_at: new Date().toISOString(),
    criteria: criteria.filter((c) => usedCriteria.has(c.id)),
    players: players.filter((p) => usedPlayers.has(p.id)).map((p) => ({ id: p.id, name_en: p.name, name_ka: kaById.get(p.id) ?? null, image_url: p.image_url, position_group: p.position_group, nationality_code: p.nationality_code, peak_value_eur: p.peak_value_eur == null ? null : Number(p.peak_value_eur) })),
    aliases: aliases.filter((a) => usedPlayers.has(a.player_id)).map((a) => ({ player_id: a.player_id, normalized_alias: a.normalized_alias, locale: a.locale, acceptance_policy: a.acceptance_policy })),
    combos,
  };
  fs.writeFileSync(`${HERE}/content.json`, JSON.stringify(out));
  const byTier = combos.reduce((acc, c) => ((acc[c.tier] = (acc[c.tier] ?? 0) + 1), acc), {});
  console.log({ ...stats, players: out.players.length, aliases: out.aliases.length, criteria: out.criteria.length, byTier });
} finally {
  await sql.end();
}

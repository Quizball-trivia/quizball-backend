#!/usr/bin/env npx tsx

/**
 * Seed the goal_choreographies library with the hand-authored launch pool.
 * Every goal is validated against choreographyContentSchema (the same gate the
 * agent pipeline will use) before anything is written; one invalid goal aborts
 * the whole run. Upserts by slug so re-running is safe and edits propagate.
 *
 * Dry-run by default. Pass --apply to write, --draft to seed as drafts.
 *
 *   npx tsx scripts/guess-the-goal/seed.ts            # validate + preview
 *   npx tsx scripts/guess-the-goal/seed.ts --apply    # publish to DATABASE_URL
 */

import { config as loadEnv } from 'dotenv';
import postgres from 'postgres';
import { choreographyContentSchema } from '../../src/modules/guess-the-goal/guess-the-goal.schemas.js';
import { buildTimings } from '../../src/modules/guess-the-goal/guess-the-goal.timing.js';
import { CLASSIC_GOALS } from './goals-classics.data.js';
import { MODERN_GOALS } from './goals-modern.data.js';

loadEnv({ path: '.env.local' });
loadEnv();

const shouldApply = process.argv.includes('--apply');
const asDraft = process.argv.includes('--draft');

const ALL_GOALS = [...CLASSIC_GOALS, ...MODERN_GOALS];

let failed = 0;
for (const goal of ALL_GOALS) {
  const parsed = choreographyContentSchema.safeParse(goal);
  if (!parsed.success) {
    failed += 1;
    console.error(`✗ ${goal.slug}`);
    for (const issue of parsed.error.issues) {
      console.error(`    ${issue.path.join('.')}: ${issue.message}`);
    }
    continue;
  }
  const timings = buildTimings(goal.steps);
  console.log(
    `✓ ${goal.slug} — ${timings.mainStarts.length} moves, ${timings.duration.toFixed(1)}s, ${goal.difficulty}`
  );
}

const slugs = new Set(ALL_GOALS.map((g) => g.slug));
if (slugs.size !== ALL_GOALS.length) {
  console.error('✗ duplicate slugs in seed data');
  failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} goal(s) failed validation — nothing written.`);
  process.exit(1);
}

console.log(`\n${ALL_GOALS.length} goals valid.`);

if (!shouldApply) {
  console.log('Dry run (pass --apply to write).');
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1, prepare: false });

try {
  const status = asDraft ? 'draft' : 'published';
  let inserted = 0;
  let updated = 0;
  for (const goal of ALL_GOALS) {
    const rows = await sql`
      INSERT INTO goal_choreographies (
        slug, status, difficulty, title, options, fun_fact, bonus,
        players, steps, scorer, match_label, year, goal_ordinal,
        schema_version, source
      ) VALUES (
        ${goal.slug}, ${status}, ${goal.difficulty},
        ${sql.json(goal.title)}, ${sql.json(goal.options)},
        ${goal.fun_fact ? sql.json(goal.fun_fact) : null},
        ${goal.bonus ? sql.json(goal.bonus) : null},
        ${sql.json(goal.players)}, ${sql.json(goal.steps)},
        ${goal.scorer}, ${goal.match_label}, ${goal.year}, ${goal.goal_ordinal},
        ${goal.schema_version}, 'seed'
      )
      ON CONFLICT (slug) DO UPDATE SET
        difficulty = EXCLUDED.difficulty,
        title = EXCLUDED.title,
        options = EXCLUDED.options,
        fun_fact = EXCLUDED.fun_fact,
        bonus = EXCLUDED.bonus,
        players = EXCLUDED.players,
        steps = EXCLUDED.steps,
        scorer = EXCLUDED.scorer,
        match_label = EXCLUDED.match_label,
        year = EXCLUDED.year,
        goal_ordinal = EXCLUDED.goal_ordinal,
        schema_version = EXCLUDED.schema_version
      RETURNING (xmax = 0) AS inserted
    `;
    if (rows[0]?.inserted) inserted += 1;
    else updated += 1;
  }
  console.log(
    `Done: ${inserted} inserted (status='${status}'), ${updated} updated (existing status preserved).`
  );
} finally {
  await sql.end();
}

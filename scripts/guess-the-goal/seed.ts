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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CLASSIC_GOALS } from './goals-classics.data.js';
import { MODERN_GOALS } from './goals-modern.data.js';

// Researched YouTube links (optional file, slug -> url|null); goals without an
// entry seed with video_url NULL and the UI simply hides the watch button.
// A MISSING file is fine; a present-but-unreadable one aborts — a swallowed
// parse error here would silently NULL every stored link on the next --apply.
const VIDEO_LINKS: Record<string, string | null> = (() => {
  const path = join(dirname(fileURLToPath(import.meta.url)), 'goal-videos.json');
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    console.error(`✗ ${path} exists but could not be read/parsed: ${(error as Error).message}`);
    process.exit(1);
  }
})();

loadEnv({ path: '.env.local' });
loadEnv();

const shouldApply = process.argv.includes('--apply');
const asDraft = process.argv.includes('--draft');

// Merge the links BEFORE validation so a bad URL fails the dry run, not the
// row-by-row writes.
const ALL_GOALS = [...CLASSIC_GOALS, ...MODERN_GOALS].map((goal) => ({
  ...goal,
  video_url: VIDEO_LINKS[goal.slug] ?? null,
}));

let failed = 0;
for (const slug of Object.keys(VIDEO_LINKS)) {
  if (!ALL_GOALS.some((g) => g.slug === slug)) {
    console.error(`✗ goal-videos.json entry '${slug}' matches no seed goal`);
    failed += 1;
  }
}
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
  await sql.begin(async (sql) => {
    for (const goal of ALL_GOALS) {
      const rows = await sql`
        INSERT INTO goal_choreographies (
          slug, status, difficulty, title, options, fun_fact, bonus,
          players, steps, scorer, match_label, year, goal_ordinal,
          schema_version, video_url, source, clip_start_s, clip_end_s
        ) VALUES (
          ${goal.slug}, ${status}, ${goal.difficulty},
          ${sql.json(goal.title)}, ${sql.json(goal.options)},
          ${goal.fun_fact ? sql.json(goal.fun_fact) : null},
          ${goal.bonus ? sql.json(goal.bonus) : null},
          ${sql.json(goal.players)}, ${sql.json(goal.steps)},
          ${goal.scorer}, ${goal.match_label}, ${goal.year}, ${goal.goal_ordinal},
          ${goal.schema_version}, ${goal.video_url}, 'seed',
          ${goal.clip_start_s ?? null}, ${goal.clip_end_s ?? null}
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
          schema_version = EXCLUDED.schema_version,
          video_url = EXCLUDED.video_url,
          clip_start_s = EXCLUDED.clip_start_s,
          clip_end_s = EXCLUDED.clip_end_s
        RETURNING (xmax = 0) AS inserted
      `;
      if (rows[0]?.inserted) inserted += 1;
      else updated += 1;
    }
  });
  console.log(
    `Done: ${inserted} inserted (status='${status}'), ${updated} updated (existing status preserved).`
  );
} finally {
  await sql.end();
}

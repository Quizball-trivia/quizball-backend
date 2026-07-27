/**
 * Roster CREATION script — approval-gated. NOT run in PR5; runs on STAGING first
 * after a human approves the dry-run report.
 *
 * Refusals (all hard):
 *   - without --approved-report <sha256> matching the sha256 of the report file
 *   - without --seed matching the seed embedded in the report's manifest
 *   - if the frozen exclusion set in patterns.json fails a live collision check
 *     (a separate post-pass; the frozen set drives the deterministic sequence,
 *     but we still verify no name became taken since measurement)
 *
 * Writes (batched, idempotent by nickname):
 *   - users            is_ai=true, ai_kind='persistent', coins=0, tickets=0,
 *                      tickets_refill_started_at=NULL (neutralized refill)
 *   - ranked_profiles  rp=450, tier='Youth Prospect', placement_status='unplaced'
 *                      (matches ranked.repo.ensureProfile defaults exactly)
 *   - synthetic_player_profiles  all fields incl. schedule/daily_cap/
 *                      rename_propensity/personality_seed + generation batch tag
 *
 * A generation batch tag is stored in synthetic_player_profiles.schedule.batch so
 * the rollback script can delete exactly this batch.
 *
 * Usage:
 *   DATABASE_URL=postgres://... tsx scripts/persistent-bot-roster/create.ts \
 *     --approved-report <sha256> --seed <int> \
 *     --patterns scripts/persistent-bot-roster/patterns.json \
 *     --report scripts/persistent-bot-roster/out/REPORT.md \
 *     --batch roster-2026-07-27 [--count 1000] [--batch-size 100] [--dry]
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import postgres from 'postgres';

import type { RosterPatterns } from './patterns.js';
import type { SqlLike, Tx } from './db-types.js';
import { generateRoster, normalizeForExclusion, type GeneratedBot } from './roster.js';

function argVal(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export interface CreateConfig {
  seed: number;
  count: number;
  batch: string;
  batchSize: number;
  patternsPath: string;
  reportPath?: string;
  approvedReport?: string;
  dry: boolean;
}

export function parseConfig(): CreateConfig {
  const seedRaw = argVal('--seed');
  if (!seedRaw) throw new Error('--seed is required');
  const seed = Number(seedRaw);
  if (!Number.isInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
    throw new Error('--seed must be a non-negative safe integer');
  }
  const batch = argVal('--batch');
  if (!batch) throw new Error('--batch <tag> is required (used by the rollback script)');
  const patternsPath = path.resolve(process.cwd(), argVal('--patterns') ?? '');
  if (!argVal('--patterns')) throw new Error('--patterns <patterns.json> is required');
  return {
    seed,
    count: Number(argVal('--count', '1000')),
    batch,
    batchSize: Number(argVal('--batch-size', '100')),
    patternsPath,
    reportPath: argVal('--report'),
    approvedReport: argVal('--approved-report'),
    dry: hasFlag('--dry'),
  };
}

/** Verify the approval gate. Throws on any mismatch. */
export function verifyApproval(cfg: CreateConfig): void {
  if (!cfg.reportPath) throw new Error('--report <REPORT.md> is required to verify --approved-report');
  if (!cfg.approvedReport) throw new Error('--approved-report <sha256> is required');
  const report = readFileSync(path.resolve(process.cwd(), cfg.reportPath), 'utf8');
  const actualSha = createHash('sha256').update(report).digest('hex');
  if (actualSha !== cfg.approvedReport) {
    throw new Error(
      `Approval mismatch: --approved-report ${cfg.approvedReport} != actual report sha256 ${actualSha}. ` +
        'Refusing to create the roster.',
    );
  }
  // The report embeds the seed on a line "- **Seed:** `<n>`".
  const m = report.match(/\*\*Seed:\*\*\s*`(\d+)`/);
  if (!m) throw new Error('Could not find the embedded seed in the report; refusing.');
  if (Number(m[1]) !== cfg.seed) {
    throw new Error(`--seed ${cfg.seed} does not match the report's embedded seed ${m[1]}; refusing.`);
  }
}

export interface InvariantResult {
  ok: boolean;
  problems: string[];
  counts: Record<string, number>;
}

/** Post-write invariant check. Exported for the integration test. */
export async function checkInvariants(
  sql: SqlLike,
  batch: string,
  expectedCount: number,
): Promise<InvariantResult> {
  const problems: string[] = [];
  const [row] = await sql<{
    users: number; persistent: number; wrong_kind: number; nonzero_bal: number;
    with_identity: number; profiles: number; unplaced: number; synth: number;
  }[]>`
    WITH batch_users AS (
      SELECT spp.user_id
      FROM synthetic_player_profiles spp
      WHERE spp.schedule->>'batch' = ${batch}
    )
    SELECT
      (SELECT count(*)::int FROM batch_users) AS synth,
      (SELECT count(*)::int FROM users u JOIN batch_users b ON b.user_id = u.id) AS users,
      (SELECT count(*)::int FROM users u JOIN batch_users b ON b.user_id = u.id WHERE u.is_ai = true AND u.ai_kind = 'persistent') AS persistent,
      (SELECT count(*)::int FROM users u JOIN batch_users b ON b.user_id = u.id WHERE NOT (u.is_ai = true AND u.ai_kind = 'persistent')) AS wrong_kind,
      (SELECT count(*)::int FROM users u JOIN batch_users b ON b.user_id = u.id WHERE u.coins <> 0 OR u.tickets <> 0 OR u.tickets_refill_started_at IS NOT NULL) AS nonzero_bal,
      (SELECT count(*)::int FROM user_identities ui JOIN batch_users b ON b.user_id = ui.user_id) AS with_identity,
      (SELECT count(*)::int FROM ranked_profiles rp JOIN batch_users b ON b.user_id = rp.user_id) AS profiles,
      (SELECT count(*)::int FROM ranked_profiles rp JOIN batch_users b ON b.user_id = rp.user_id WHERE rp.placement_status = 'unplaced' AND rp.rp = 450) AS unplaced
  `;
  const c = row!;
  if (c.synth !== expectedCount) problems.push(`synthetic_player_profiles count ${c.synth} != ${expectedCount}`);
  if (c.users !== expectedCount) problems.push(`users count ${c.users} != ${expectedCount}`);
  if (c.persistent !== expectedCount) problems.push(`persistent-classified users ${c.persistent} != ${expectedCount}`);
  if (c.wrong_kind !== 0) problems.push(`${c.wrong_kind} users are not is_ai/persistent`);
  if (c.nonzero_bal !== 0) problems.push(`${c.nonzero_bal} users have non-zero balances or a live refill anchor`);
  if (c.with_identity !== 0) problems.push(`${c.with_identity} users have auth identities (must be zero)`);
  if (c.profiles !== expectedCount) problems.push(`ranked_profiles count ${c.profiles} != ${expectedCount}`);
  if (c.unplaced !== expectedCount) problems.push(`unplaced/rp=450 profiles ${c.unplaced} != ${expectedCount}`);
  return {
    ok: problems.length === 0,
    problems,
    counts: {
      synth: c.synth, users: c.users, persistent: c.persistent, wrongKind: c.wrong_kind,
      nonzeroBalances: c.nonzero_bal, withIdentity: c.with_identity, profiles: c.profiles, unplaced: c.unplaced,
    },
  };
}

/** Insert one batch of bots idempotently (skip nicknames that already exist). */
export async function insertBatch(
  sql: SqlLike,
  bots: GeneratedBot[],
  batch: string,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    for (const b of bots) {
      // Idempotency: skip if this nickname already exists (case-insensitive).
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM users WHERE lower(nickname) = ${normalizeForExclusion(b.nickname)} LIMIT 1
      `;
      if (existing) {
        skipped++;
        continue;
      }
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (
          id, email, nickname, country, avatar_url, avatar_customization,
          onboarding_complete, is_ai, ai_kind, coins, tickets, tickets_refill_started_at,
          favorite_club
        ) VALUES (
          gen_random_uuid(), NULL, ${b.nickname}, ${b.country}, NULL,
          ${b.avatarCustomization ? tx.json(b.avatarCustomization as unknown as postgres.JSONValue) : null},
          true, true, 'persistent', 0, 0, NULL, ${b.favoriteClub}
        )
        RETURNING id
      `;
      const userId = user!.id;

      // ranked_profiles: byte-for-byte the ensureProfile unplaced defaults.
      await tx`
        INSERT INTO ranked_profiles (
          user_id, rp, tier, placement_status, placement_required, placement_played,
          placement_wins, placement_seed_rp, placement_perf_sum, placement_points_for_sum,
          placement_points_against_sum, current_win_streak, last_ranked_match_at
        ) VALUES (
          ${userId}, 450, 'Youth Prospect', 'unplaced', 3, 0, 0, NULL, 0, 0, 0, 0, NULL
        )
        ON CONFLICT (user_id) DO NOTHING
      `;

      // synthetic_player_profiles: batch tag lives in schedule.batch for rollback.
      await tx`
        INSERT INTO synthetic_player_profiles (
          user_id, status, base_skill, consistency, speed_offset, category_affinities,
          schedule, daily_cap, home_city, home_lat, home_lng, favorite_club,
          rename_propensity, personality_seed
        ) VALUES (
          ${userId}, 'active', ${b.baseSkill}, ${b.consistency}, ${b.speedOffset},
          ${tx.json(b.categoryAffinities as unknown as postgres.JSONValue)},
          ${tx.json({ ...b.schedule, batch, band: b.skillBand, willRename: b.willRename } as unknown as postgres.JSONValue)},
          ${b.dailyCap}, ${b.homeCity}, ${b.homeLat}, ${b.homeLng}, ${b.favoriteClub},
          ${b.renamePropensity}, ${b.personalitySeed}
        )
        ON CONFLICT (user_id) DO NOTHING
      `;
      inserted++;
    }
  });
  return { inserted, skipped };
}

async function main() {
  const cfg = parseConfig();
  verifyApproval(cfg);

  const patternsRaw = readFileSync(cfg.patternsPath, 'utf8');
  const patterns = JSON.parse(patternsRaw) as RosterPatterns;
  const bots = generateRoster({ seed: cfg.seed, count: cfg.count, patterns });

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (staging first)');
  const sql = postgres(databaseUrl, { max: 4 });
  try {
    // Live final-collision check (separate pass; frozen set already drove gen).
    const keys = bots.map((b) => normalizeForExclusion(b.nickname));
    const live = await sql<{ x: string }[]>`
      SELECT lower(nickname) x FROM users WHERE lower(nickname) = ANY(${keys})
      UNION SELECT lower(old_nickname) FROM nickname_history WHERE lower(old_nickname) = ANY(${keys})
      UNION SELECT lower(new_nickname) FROM nickname_history WHERE lower(new_nickname) = ANY(${keys})
    `;
    if (live.length > 0) {
      process.stderr.write(
        `WARNING: ${live.length} generated names became taken since measurement: ${live.map((r) => r.x).slice(0, 10).join(', ')}\n` +
          'These will be SKIPPED by the idempotent insert; re-measure + re-approve to fill the gap.\n',
      );
    }

    if (cfg.dry) {
      process.stdout.write(`[--dry] Approval verified. Would create ${bots.length} bots in batch "${cfg.batch}".\n`);
      return;
    }

    let inserted = 0;
    let skipped = 0;
    for (let i = 0; i < bots.length; i += cfg.batchSize) {
      const slice = bots.slice(i, i + cfg.batchSize);
      const r = await insertBatch(sql, slice, cfg.batch);
      inserted += r.inserted;
      skipped += r.skipped;
      process.stdout.write(`  batch ${i / cfg.batchSize + 1}: +${r.inserted} inserted, ${r.skipped} skipped\n`);
    }
    process.stdout.write(`\nDone: ${inserted} inserted, ${skipped} skipped.\n`);

    const inv = await checkInvariants(sql, cfg.batch, cfg.count - skipped);
    process.stdout.write(`Invariant check: ${JSON.stringify(inv.counts)}\n`);
    if (!inv.ok) {
      process.stderr.write(`INVARIANT FAILURES:\n - ${inv.problems.join('\n - ')}\n`);
      process.exit(2);
    }
    process.stdout.write('All invariants passed.\n');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// Only run when invoked directly (not when imported by the integration test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`create failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

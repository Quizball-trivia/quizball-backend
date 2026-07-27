/**
 * Roster CREATION script — manifest-gated, atomic. NOT run in PR5; runs on
 * STAGING first after a human approves the dry-run report.
 *
 * Single source of truth: the MANIFEST (finding #1). It binds report sha256,
 * patterns sha256, seed, count, exclusion snapshot, and a digest of ALL rows.
 * There are no independent --patterns/--count inputs that determine identities.
 *
 * Refusals (all fail-closed):
 *   - report bytes must hash to --approved-report AND to manifest.reportSha256
 *   - the supplied patterns.json must hash to manifest.patternsSha256
 *   - regenerating from (manifest.seed, manifest.count, patterns) must reproduce
 *     manifest.rosterSha256 and manifest.exclusionSha256
 *   - the app's nickname moderator must pass for every one of the 1,000 names
 *   - inside ONE transaction (findings #2/#3): any foreign collision against
 *     current users.nickname OR nickname_history aborts the WHOLE roster, listing
 *     the colliding names. No warn-and-skip, no partial roster.
 *
 * Rerun semantics (finding #3): creation is atomic, so the only legitimate
 * "already exists" state is a fully-created roster.
 *   - all manifest nicknames already exist as this batch's persistent bots → no-op success
 *   - some exist → abort with the diff (that state implies manual tampering)
 *
 * Writes (finding #4 provenance): each bot's synthetic_player_profiles.schedule
 * carries {batch, manifestDigest}. After commit, a RECEIPT file lists the created
 * user ids + the manifest digest, so rollback deletes exactly those ids.
 *
 * Connection: prepare:false + the app's pooler-safe settings (finding #10).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import postgres from 'postgres';

import type { RosterPatterns } from './patterns.js';
import type { SqlLike, Tx } from './db-types.js';
import { rosterDigest, sha256, type RosterManifest } from './manifest.js';
import { generateRoster, normalizeForExclusion, type GeneratedBot } from './roster.js';
import { isNicknameAllowed } from '../../src/modules/moderation/text-moderation.js';

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

export interface CreateConfig {
  manifestPath: string;
  reportPath: string;
  patternsPath: string;
  approvedReport: string;
  batch: string;
  receiptPath: string;
  dry: boolean;
}

export function parseConfig(): CreateConfig {
  const manifestPath = argVal('--manifest');
  const reportPath = argVal('--report');
  const patternsPath = argVal('--patterns');
  const approvedReport = argVal('--approved-report');
  const batch = argVal('--batch');
  if (!manifestPath) throw new Error('--manifest <roster.manifest.json> is required');
  if (!reportPath) throw new Error('--report <REPORT.md> is required');
  if (!patternsPath) throw new Error('--patterns <patterns.json> is required');
  if (!approvedReport) throw new Error('--approved-report <sha256> is required');
  if (!batch) throw new Error('--batch <unique-id> is required');
  const resolvedManifest = path.resolve(process.cwd(), manifestPath);
  return {
    manifestPath: resolvedManifest,
    reportPath: path.resolve(process.cwd(), reportPath),
    patternsPath: path.resolve(process.cwd(), patternsPath),
    approvedReport,
    batch,
    receiptPath: path.resolve(
      process.cwd(),
      argVal('--receipt') ?? path.join(path.dirname(resolvedManifest), `receipt-${batch}.json`),
    ),
    dry: hasFlag('--dry'),
  };
}

export interface VerifiedPlan {
  manifest: RosterManifest;
  bots: GeneratedBot[];
  manifestDigest: string;
}

/**
 * Verify the full approval chain and regenerate the roster. Throws on any
 * mismatch. Returns the verified bots + a digest of the manifest itself (the
 * receipt/rollback provenance key).
 */
export function verifyAndRegenerate(cfg: {
  manifestPath: string;
  reportPath: string;
  patternsPath: string;
  approvedReport: string;
}): VerifiedPlan {
  const manifestRaw = readFileSync(cfg.manifestPath, 'utf8');
  const manifest = JSON.parse(manifestRaw) as RosterManifest;
  if (manifest.schemaVersion !== 2) {
    throw new Error(`Unsupported manifest schemaVersion ${manifest.schemaVersion}; expected 2`);
  }

  // (a) report bytes must hash to --approved-report AND manifest.reportSha256.
  const report = readFileSync(cfg.reportPath, 'utf8');
  const reportSha = sha256(report);
  if (reportSha !== cfg.approvedReport) {
    throw new Error(`Approval mismatch: --approved-report != actual report sha256 ${reportSha}. Refusing.`);
  }
  if (reportSha !== manifest.reportSha256) {
    throw new Error(`Report/manifest mismatch: report sha256 ${reportSha} != manifest.reportSha256 ${manifest.reportSha256}. Refusing.`);
  }

  // (b) supplied patterns.json must hash to manifest.patternsSha256.
  const patternsRaw = readFileSync(cfg.patternsPath, 'utf8');
  const patternsSha = sha256(patternsRaw);
  if (patternsSha !== manifest.patternsSha256) {
    throw new Error(`Patterns mismatch: patterns.json sha256 ${patternsSha} != manifest.patternsSha256 ${manifest.patternsSha256}. Refusing.`);
  }
  const patterns = JSON.parse(patternsRaw) as RosterPatterns;
  if (patterns.exclusion.sha256 !== manifest.exclusionSha256) {
    throw new Error('Exclusion snapshot mismatch between patterns.json and manifest. Refusing.');
  }

  // (c) regenerate and match the roster digest bit-for-bit.
  const bots = generateRoster({ seed: manifest.seed, count: manifest.count, patterns });
  if (bots.length !== manifest.count) {
    throw new Error(`Regenerated ${bots.length} bots but manifest.count is ${manifest.count}. Refusing.`);
  }
  const regenDigest = rosterDigest(bots);
  if (regenDigest !== manifest.rosterSha256) {
    throw new Error(`Roster digest mismatch: regenerated ${regenDigest} != manifest.rosterSha256 ${manifest.rosterSha256}. Refusing.`);
  }

  // (d) moderator gate over every name (finding #8).
  const flagged = bots.filter((b) => !isNicknameAllowed(b.nickname)).map((b) => b.nickname);
  if (flagged.length > 0) {
    throw new Error(`Nickname moderator flagged ${flagged.length} names: ${flagged.slice(0, 20).join(', ')}. Refusing.`);
  }

  return { manifest, bots, manifestDigest: sha256(manifestRaw) };
}

export class RosterCollisionError extends Error {
  constructor(public readonly collisions: string[]) {
    super(`Roster aborted: ${collisions.length} foreign nickname collision(s): ${collisions.slice(0, 20).join(', ')}`);
    this.name = 'RosterCollisionError';
  }
}

export interface InvariantResult {
  ok: boolean;
  problems: string[];
  counts: Record<string, number>;
}

/** Post-write invariant check. Always requires the manifest count exactly. */
export async function checkInvariants(
  sql: SqlLike,
  batch: string,
  manifestCount: number,
): Promise<InvariantResult> {
  const problems: string[] = [];
  const [row] = await sql<{
    synth: number; users: number; persistent: number; wrong_kind: number; nonzero_bal: number;
    with_identity: number; profiles: number; unplaced: number;
  }[]>`
    WITH batch_users AS (
      SELECT spp.user_id FROM synthetic_player_profiles spp WHERE spp.schedule->>'batch' = ${batch}
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
  if (c.synth !== manifestCount) problems.push(`synthetic_player_profiles count ${c.synth} != ${manifestCount}`);
  if (c.users !== manifestCount) problems.push(`users count ${c.users} != ${manifestCount}`);
  if (c.persistent !== manifestCount) problems.push(`persistent-classified users ${c.persistent} != ${manifestCount}`);
  if (c.wrong_kind !== 0) problems.push(`${c.wrong_kind} users are not is_ai/persistent`);
  if (c.nonzero_bal !== 0) problems.push(`${c.nonzero_bal} users have non-zero balances or a live refill anchor`);
  if (c.with_identity !== 0) problems.push(`${c.with_identity} users have auth identities (must be zero)`);
  if (c.profiles !== manifestCount) problems.push(`ranked_profiles count ${c.profiles} != ${manifestCount}`);
  if (c.unplaced !== manifestCount) problems.push(`unplaced/rp=450 profiles ${c.unplaced} != ${manifestCount}`);
  return {
    ok: problems.length === 0,
    problems,
    counts: {
      synth: c.synth, users: c.users, persistent: c.persistent, wrongKind: c.wrong_kind,
      nonzeroBalances: c.nonzero_bal, withIdentity: c.with_identity, profiles: c.profiles, unplaced: c.unplaced,
    },
  };
}

export interface CreateOutcome {
  status: 'created' | 'already-created';
  createdIds: string[];
  manifestDigest: string;
}

/**
 * Insert the entire roster in ONE transaction (findings #2/#3), fail-closed on
 * any foreign collision (current users.nickname OR nickname_history). Returns the
 * created user ids for the receipt. If the roster already fully exists as this
 * batch's persistent bots, it is a no-op success; a partial pre-existing state
 * aborts (throws RosterCollisionError).
 */
export async function createRoster(sql: SqlLike, plan: VerifiedPlan, batch: string): Promise<CreateOutcome> {
  const { bots, manifestDigest } = plan;
  const keys = bots.map((b) => normalizeForExclusion(b.nickname));

  return (await sql.begin(async (rawTx) => {
    const tx = rawTx as unknown as Tx;

    // Classify pre-existing current names: which of ours already exist, as what.
    const existing = await tx<{ x: string; is_ai: boolean; ai_kind: string | null; batch: string | null }[]>`
      SELECT lower(u.nickname) x, u.is_ai, u.ai_kind, spp.schedule->>'batch' AS batch
      FROM users u
      LEFT JOIN synthetic_player_profiles spp ON spp.user_id = u.id
      WHERE lower(u.nickname) = ANY(${keys})
    `;

    // Rerun semantics: if ALL our names exist as THIS batch's persistent bots
    // and the batch is complete → no-op success.
    const oursThisBatch = existing.filter((e) => e.is_ai && e.ai_kind === 'persistent' && e.batch === batch);
    if (existing.length === bots.length && oursThisBatch.length === bots.length) {
      const ids = (await tx<{ id: string }[]>`
        SELECT u.id FROM users u JOIN synthetic_player_profiles spp ON spp.user_id = u.id
        WHERE spp.schedule->>'batch' = ${batch}
      `).map((r) => r.id);
      return { status: 'already-created' as const, createdIds: ids, manifestDigest };
    }

    // Any pre-existing current name that is NOT ours-this-batch is a foreign
    // collision. History-reservation collisions (a name freed within retention)
    // are also foreign. Fail closed with the full sorted list.
    const foreign = existing
      .filter((e) => !(e.is_ai && e.ai_kind === 'persistent' && e.batch === batch))
      .map((e) => e.x);
    const history = (await tx<{ x: string }[]>`
      SELECT DISTINCT lower(nickname) x FROM (
        SELECT old_nickname AS nickname FROM nickname_history WHERE old_nickname IS NOT NULL
        UNION SELECT new_nickname FROM nickname_history WHERE new_nickname IS NOT NULL
      ) h WHERE lower(nickname) = ANY(${keys})
    `).map((r) => r.x);
    const collisions = [...new Set([...foreign, ...history])].sort();
    if (collisions.length > 0) {
      throw new RosterCollisionError(collisions);
    }

    // Clean state → insert every row inside this one transaction.
    const createdIds: string[] = [];
    for (const b of bots) {
      const [user] = await tx<{ id: string }[]>`
        INSERT INTO users (
          id, email, nickname, country, avatar_url, avatar_customization,
          onboarding_complete, is_ai, ai_kind, coins, tickets, tickets_refill_started_at, favorite_club
        ) VALUES (
          gen_random_uuid(), NULL, ${b.nickname}, ${b.country}, NULL,
          ${b.avatarCustomization ? tx.json(b.avatarCustomization as unknown as postgres.JSONValue) : null},
          true, true, 'persistent', 0, 0, NULL, ${b.favoriteClub}
        )
        RETURNING id
      `;
      const userId = user!.id;
      await tx`
        INSERT INTO ranked_profiles (
          user_id, rp, tier, placement_status, placement_required, placement_played,
          placement_wins, placement_seed_rp, placement_perf_sum, placement_points_for_sum,
          placement_points_against_sum, current_win_streak, last_ranked_match_at
        ) VALUES (${userId}, 450, 'Youth Prospect', 'unplaced', 3, 0, 0, NULL, 0, 0, 0, 0, NULL)
      `;
      await tx`
        INSERT INTO synthetic_player_profiles (
          user_id, status, base_skill, consistency, speed_offset, category_affinities,
          schedule, daily_cap, home_city, home_lat, home_lng, favorite_club,
          rename_propensity, personality_seed
        ) VALUES (
          ${userId}, 'active', ${b.baseSkill}, ${b.consistency}, ${b.speedOffset},
          ${tx.json(b.categoryAffinities as unknown as postgres.JSONValue)},
          ${tx.json({ ...b.schedule, batch, manifestDigest, band: b.skillBand, willRename: b.willRename } as unknown as postgres.JSONValue)},
          ${b.dailyCap}, ${b.homeCity}, ${b.homeLat}, ${b.homeLng}, ${b.favoriteClub},
          ${b.renamePropensity}, ${b.personalitySeed}
        )
      `;
      createdIds.push(userId);
    }
    return { status: 'created' as const, createdIds, manifestDigest };
  })) as CreateOutcome;
}

/** Pooler-safe connection, matching the app's settings for the same topology. */
function openWriteDb(): postgres.Sql {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (staging first)');
  return postgres(databaseUrl, {
    max: 4,
    prepare: false, // Supavisor pooler cache-invalidates prepared statements.
    onnotice: () => {},
    connection: { application_name: 'roster-create', statement_timeout: 120_000 },
  });
}

async function main() {
  const cfg = parseConfig();
  const plan = verifyAndRegenerate(cfg);
  process.stdout.write(`Approval verified: ${plan.bots.length} bots, roster digest matches manifest.\n`);

  if (cfg.dry) {
    process.stdout.write(`[--dry] Would create ${plan.bots.length} bots in batch "${cfg.batch}" (atomic).\n`);
    return;
  }

  const sql = openWriteDb();
  try {
    let outcome: CreateOutcome;
    try {
      outcome = await createRoster(sql, plan, cfg.batch);
    } catch (err) {
      if (err instanceof RosterCollisionError) {
        process.stderr.write(`ABORTED (fail-closed): ${err.collisions.length} foreign nickname collision(s).\n`);
        process.stderr.write(`Colliding names: ${err.collisions.join(', ')}\n`);
        process.stderr.write('No rows were written (single transaction rolled back). Re-measure + re-approve.\n');
        process.exit(3);
      }
      throw err;
    }

    if (outcome.status === 'already-created') {
      process.stdout.write(`No-op: all ${outcome.createdIds.length} bots already exist as batch "${cfg.batch}".\n`);
    } else {
      process.stdout.write(`Created ${outcome.createdIds.length} bots in batch "${cfg.batch}".\n`);
    }

    const inv = await checkInvariants(sql, cfg.batch, plan.manifest.count);
    process.stdout.write(`Invariant check: ${JSON.stringify(inv.counts)}\n`);
    if (!inv.ok) {
      process.stderr.write(`INVARIANT FAILURES:\n - ${inv.problems.join('\n - ')}\n`);
      process.exit(2);
    }

    // Receipt (finding #4): per-environment provenance for rollback.
    const receipt = {
      schemaVersion: 1,
      batch: cfg.batch,
      manifestDigest: plan.manifestDigest,
      rosterSha256: plan.manifest.rosterSha256,
      count: plan.manifest.count,
      createdAt: new Date().toISOString(),
      userIds: outcome.createdIds.slice().sort(),
    };
    writeFileSync(cfg.receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    process.stdout.write(`All invariants passed. Receipt written: ${cfg.receiptPath}\n`);
    process.stdout.write('NOTE: the receipt is a PER-ENVIRONMENT artifact — keep staging and prod receipts separate.\n');
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`create failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}

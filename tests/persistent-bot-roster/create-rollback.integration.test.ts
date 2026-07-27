/**
 * Integration test for the manifest-gated roster creation + receipt-driven
 * rollback against the test DB (postgresql://test:test@localhost:5432/test, set
 * by tests/setup.ts).
 *
 * Flow (20-bot sample): build patterns/report/manifest on disk -> verify the
 * approval chain -> create atomically -> invariants -> rerun (no-op idempotency)
 * -> receipt-driven rollback -> assert exactly the batch is gone. Plus fail-closed
 * collision and gameplay-reference-refusal checks. Guarded to skip when the DB is
 * unavailable. Unique batch per run so shared-DB parallel runs don't collide
 * (re-run solo before investigating a flake).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';

import { generateRoster, normalizeForExclusion } from '../../scripts/persistent-bot-roster/roster.js';
import {
  verifyAndRegenerate,
  createRoster,
  checkInvariants,
  RosterCollisionError,
} from '../../scripts/persistent-bot-roster/create.js';
import { rollbackReceipt, type RosterReceipt } from '../../scripts/persistent-bot-roster/rollback.js';
import { rosterDigest, sha256, type RosterManifest } from '../../scripts/persistent-bot-roster/manifest.js';
import { renderReport } from '../../scripts/persistent-bot-roster/report.js';
import { makePatterns } from './fixtures.js';

let sql: postgres.Sql;
let dbAvailable = false;
const BATCH = `test-roster-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SEED = 4242;
const COUNT = 20;

// Build the approval artifacts (patterns/report/manifest) on disk for this run.
const tmp = mkdtempSync(path.join(tmpdir(), 'roster-it-'));
const patterns = makePatterns();
const patternsPath = path.join(tmp, 'patterns.json');
const reportPath = path.join(tmp, 'REPORT.md');
const manifestPath = path.join(tmp, 'manifest.json');

const bots = generateRoster({ seed: SEED, count: COUNT, patterns });
const patternsRaw = JSON.stringify(patterns, null, 2);
writeFileSync(patternsPath, patternsRaw);
const rosterSha = rosterDigest(bots);
const report = renderReport({ seed: SEED, count: COUNT, patterns, bots, rosterSha });
writeFileSync(reportPath, report);
const reportSha = sha256(report);
const manifest: RosterManifest = {
  schemaVersion: 2,
  seed: SEED,
  count: COUNT,
  reportSha256: reportSha,
  patternsSha256: sha256(patternsRaw),
  exclusionSha256: patterns.exclusion.sha256,
  rosterSha256: rosterSha,
  generatedAt: new Date().toISOString(),
  maxNameAttempts: Math.max(...bots.map((b) => b.nameAttempts)),
};
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const verifyCfg = { manifestPath, reportPath, patternsPath, approvedReport: reportSha };

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql as unknown as postgres.Sql;
    await sql`SELECT 1`;
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping roster create/rollback integration tests: DB unavailable. Run `npm run docker:start`.\n');
  }
});

afterAll(async () => {
  if (dbAvailable) {
    try {
      // Clean up any rows this run created, by batch tag.
      const ids = (await sql<{ id: string }[]>`
        SELECT u.id FROM users u JOIN synthetic_player_profiles spp ON spp.user_id = u.id
        WHERE spp.schedule->>'batch' = ${BATCH}
      `).map((r) => r.id);
      if (ids.length > 0) {
        await sql`UPDATE matches SET winner_user_id = NULL WHERE winner_user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM lobbies WHERE host_user_id = ANY(${ids}::uuid[])`;
        await sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
      }
    } catch {
      /* ignore */
    }
    await sql.end();
  }
});

describe('approval gate (verifyAndRegenerate)', () => {
  it('accepts the matching report+manifest+patterns and regenerates the roster', () => {
    const plan = verifyAndRegenerate(verifyCfg);
    expect(plan.bots.length).toBe(COUNT);
    expect(plan.manifest.rosterSha256).toBe(rosterSha);
  });

  it('refuses a wrong --approved-report', () => {
    expect(() => verifyAndRegenerate({ ...verifyCfg, approvedReport: 'deadbeef' })).toThrow(/Approval mismatch/);
  });

  it('refuses a tampered manifest count', () => {
    const bad = path.join(tmp, 'manifest-badcount.json');
    writeFileSync(bad, JSON.stringify({ ...manifest, count: COUNT + 1 }));
    // count change makes the regenerated digest differ from rosterSha256.
    expect(() => verifyAndRegenerate({ ...verifyCfg, manifestPath: bad })).toThrow(/digest mismatch|count/);
  });
});

describe('roster create + rollback (test DB)', () => {
  it('creates 20 bots atomically with correct rows and passing invariants', async ({ skip }) => {
    if (!dbAvailable) return skip();
    const plan = verifyAndRegenerate(verifyCfg);
    const outcome = await createRoster(sql, plan, BATCH);
    expect(outcome.status).toBe('created');
    expect(outcome.createdIds.length).toBe(COUNT);

    const [row] = await sql<{
      is_ai: boolean; ai_kind: string; coins: number; tickets: number; refill: string | null;
      rp: number; placement_status: string; batch: string; identities: number; affinity_key: string | null;
    }[]>`
      SELECT u.is_ai, u.ai_kind, u.coins, u.tickets, u.tickets_refill_started_at AS refill,
             rp.rp, rp.placement_status, spp.schedule->>'batch' AS batch,
             (SELECT count(*)::int FROM user_identities ui WHERE ui.user_id = u.id) AS identities,
             (SELECT jsonb_object_keys(spp.category_affinities) LIMIT 1) AS affinity_key
      FROM synthetic_player_profiles spp
      JOIN users u ON u.id = spp.user_id
      JOIN ranked_profiles rp ON rp.user_id = u.id
      WHERE spp.schedule->>'batch' = ${BATCH}
      LIMIT 1
    `;
    expect(row!.is_ai).toBe(true);
    expect(row!.ai_kind).toBe('persistent');
    expect(row!.coins).toBe(0);
    expect(row!.tickets).toBe(0);
    expect(row!.refill).toBeNull();
    expect(row!.rp).toBe(450);
    expect(row!.placement_status).toBe('unplaced');
    expect(row!.identities).toBe(0);
    // Affinity keys are real hyphenated slugs (finding #5).
    if (row!.affinity_key) expect(row!.affinity_key.includes('_')).toBe(false);

    const inv = await checkInvariants(sql, BATCH, COUNT);
    expect(inv.problems).toEqual([]);
    expect(inv.ok).toBe(true);
  });

  it('rerun is a no-op when the whole batch already exists (finding #3)', async ({ skip }) => {
    if (!dbAvailable) return skip();
    const plan = verifyAndRegenerate(verifyCfg);
    const outcome = await createRoster(sql, plan, BATCH);
    expect(outcome.status).toBe('already-created');
    expect(outcome.createdIds.length).toBe(COUNT);
    const inv = await checkInvariants(sql, BATCH, COUNT);
    expect(inv.ok).toBe(true);
  });

  it('fails closed on a foreign nickname collision (finding #2)', async ({ skip }) => {
    if (!dbAvailable) return skip();
    // Self-contained: a DIFFERENT roster (fresh seed → distinct names), with one
    // of its names squatted by a real user, so that name is a FOREIGN collision.
    const seed2 = SEED + 1;
    const bots2 = generateRoster({ seed: seed2, count: COUNT, patterns });
    const rosterSha2 = rosterDigest(bots2);
    const report2 = renderReport({ seed: seed2, count: COUNT, patterns, bots: bots2, rosterSha: rosterSha2 });
    const reportSha2 = sha256(report2);
    const dir2 = mkdtempSync(path.join(tmpdir(), 'roster-it2-'));
    const pPath = path.join(dir2, 'patterns.json');
    const rPath = path.join(dir2, 'REPORT.md');
    const mPath = path.join(dir2, 'manifest.json');
    writeFileSync(pPath, patternsRaw);
    writeFileSync(rPath, report2);
    writeFileSync(mPath, JSON.stringify({
      schemaVersion: 2, seed: seed2, count: COUNT, reportSha256: reportSha2,
      patternsSha256: sha256(patternsRaw), exclusionSha256: patterns.exclusion.sha256,
      rosterSha256: rosterSha2, generatedAt: new Date().toISOString(),
      maxNameAttempts: Math.max(...bots2.map((b) => b.nameAttempts)),
    } satisfies RosterManifest));

    const [squatter] = await sql<{ id: string }[]>`
      INSERT INTO users (id, nickname, is_ai, onboarding_complete)
      VALUES (gen_random_uuid(), ${bots2[0]!.nickname}, false, true)
      RETURNING id
    `;
    try {
      const plan2 = verifyAndRegenerate({ manifestPath: mPath, reportPath: rPath, patternsPath: pPath, approvedReport: reportSha2 });
      await expect(createRoster(sql, plan2, `${BATCH}-foreign`)).rejects.toBeInstanceOf(RosterCollisionError);
      const [{ n }] = await sql<{ n: number }[]>`
        SELECT count(*)::int n FROM synthetic_player_profiles WHERE schedule->>'batch' = ${`${BATCH}-foreign`}
      `;
      expect(n).toBe(0);
    } finally {
      await sql`DELETE FROM users WHERE id = ${squatter!.id}`;
    }
  });

  it('rollback via receipt removes exactly the batch', async ({ skip }) => {
    if (!dbAvailable) return skip();
    const plan = verifyAndRegenerate(verifyCfg);
    const ids = (await sql<{ id: string }[]>`
      SELECT u.id FROM users u JOIN synthetic_player_profiles spp ON spp.user_id = u.id
      WHERE spp.schedule->>'batch' = ${BATCH}
    `).map((r) => r.id);
    const receipt: RosterReceipt = {
      schemaVersion: 1,
      batch: BATCH,
      manifestDigest: plan.manifestDigest,
      rosterSha256: manifest.rosterSha256,
      count: COUNT,
      createdAt: new Date().toISOString(),
      userIds: ids.slice().sort(),
    };
    const expected = new Set(bots.map((b) => normalizeForExclusion(b.nickname)));

    const result = await rollbackReceipt(sql, { receipt, expectedNickByAny: expected, force: false, dry: false });
    expect(result.refusedReason).toBeUndefined();
    expect(result.deleted).toBe(COUNT);

    const [{ users, synth, profiles }] = await sql<{ users: number; synth: number; profiles: number }[]>`
      WITH b AS (SELECT user_id FROM synthetic_player_profiles WHERE schedule->>'batch' = ${BATCH})
      SELECT
        (SELECT count(*)::int FROM b) AS synth,
        (SELECT count(*)::int FROM users u JOIN b ON b.user_id = u.id) AS users,
        (SELECT count(*)::int FROM ranked_profiles rp JOIN b ON b.user_id = rp.user_id) AS profiles
    `;
    expect(synth).toBe(0);
    expect(users).toBe(0);
    expect(profiles).toBe(0);
  });

  it('rollback refuses a receipt id whose nickname does not match the manifest', async ({ skip }) => {
    if (!dbAvailable) return skip();
    // Create a lone persistent bot NOT in the manifest, then try to roll it back
    // with a receipt that references it — must refuse.
    const [rogue] = await sql<{ id: string }[]>`
      INSERT INTO users (id, nickname, is_ai, ai_kind, coins, tickets, onboarding_complete)
      VALUES (gen_random_uuid(), ${`rogue_${Date.now()}`}, true, 'persistent', 0, 0, true)
      RETURNING id
    `;
    await sql`
      INSERT INTO synthetic_player_profiles (user_id, base_skill, personality_seed, schedule)
      VALUES (${rogue!.id}, 0.5, 12345, ${sql.json({ batch: BATCH } as never)})
    `;
    try {
      const receipt: RosterReceipt = {
        schemaVersion: 1, batch: BATCH, manifestDigest: 'x', rosterSha256: manifest.rosterSha256,
        count: 1, createdAt: new Date().toISOString(), userIds: [rogue!.id],
      };
      const expected = new Set(bots.map((b) => normalizeForExclusion(b.nickname)));
      const result = await rollbackReceipt(sql, { receipt, expectedNickByAny: expected, force: false, dry: false });
      expect(result.refusedReason).toMatch(/nickname matches the manifest/);
      expect(result.deleted).toBe(0);
    } finally {
      await sql`DELETE FROM users WHERE id = ${rogue!.id}`;
    }
  });
});

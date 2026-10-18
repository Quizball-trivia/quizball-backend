// Staging DB only. No server/device startup, accounts, gameplay, analytics or
// persistent writes. Reproduce edits in pg_temp copies and always roll back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node --import tsx scripts/verify-road-to-goal-calibration-staging.mjs --env-file <private-env-file>');
assert.equal(args[0], '--env-file');
const env = dotenv.parse(readFileSync(args[1]));
const targetUrl = env.STAGING_DATABASE_URL ?? env.DATABASE_URL;
assert.ok(targetUrl, 'Staging connection is required');
const target = new URL(targetUrl);
const project = 'nsdfiprfmhdqhbfxfwpv';
assert.ok(target.protocol === 'postgres:' || target.protocol === 'postgresql:');
assert.ok(
  target.hostname === `db.${project}.supabase.co`
    || (target.hostname.endsWith('.pooler.supabase.com') && target.username === `postgres.${project}`),
  'Refusing any connection except the verified Quizball staging project',
);
Object.assign(process.env, {
  DATABASE_URL: targetUrl, NODE_ENV: 'local', LOG_LEVEL: 'silent',
  DB_POOL_MAX: '1', DB_INFLIGHT_LIMIT: '1',
});
delete process.env.POSTHOG_API_KEY;

const { sql } = await import('../src/db/index.ts');
const { roadToGoalRepo: repo } = await import('../src/modules/road-to-goal/road-to-goal.repo.ts');
const { buildCalibratedQuestionSet } = await import('../src/modules/road-to-goal/road-to-goal.service.ts');
const { ROAD_TO_GOAL_ZONE_ACCURACY_PRIORS_BP: priors } = await import('../src/modules/road-to-goal/road-to-goal.constants.ts');
const { roadToGoalQuestionSetHash } = await import('../src/modules/road-to-goal/road-to-goal.fairness.ts');
const rollback = new Error('EXPECTED_STAGING_REHEARSAL_ROLLBACK');
const evidence = { project: 'Quizball staging', productionTouched: false, persistentWrites: 0, simulatorTesting: 'PAUSED', cases: [] };

try {
  await sql.begin(async (tx) => {
    const day = await repo.getDatabasePublicationDay(tx);
    const version = await repo.getCalibrationVersionForDay(tx, day);
    assert.ok(version, 'Staging must already have its daily calibration');
    const started = performance.now();
    const live = await buildCalibratedQuestionSet(tx, randomUUID(), version.id, { logSelection: false });
    assert.equal(live.questions.length, 11);
    const liveHash = roadToGoalQuestionSetHash(live.questions);
    evidence.cases.push({ case: 'live_staging_pool', questions: 11, elapsedMs: Math.round(performance.now() - started) });

    await tx`CREATE TEMP TABLE questions ON COMMIT DROP AS SELECT * FROM public.questions WHERE false`;
    for (const difficulty of ['easy', 'medium', 'hard']) {
      await tx`INSERT INTO pg_temp.questions
        SELECT q.* FROM public.questions q
        JOIN public.categories c ON c.id=q.category_id AND c.is_active=true
        JOIN public.question_payloads p ON p.question_id=q.id
        WHERE q.status='published' AND q.type='mcq_single' AND q.ranked_eligible=true
          AND q.visibility='public' AND q.difficulty=${difficulty}
          AND CASE WHEN jsonb_typeof(p.payload->'options')='array'
            THEN jsonb_array_length(p.payload->'options') ELSE 0 END=4
        ORDER BY q.id LIMIT 32`;
    }
    await tx`CREATE TEMP TABLE question_payloads ON COMMIT DROP AS
      SELECT p.* FROM public.question_payloads p JOIN pg_temp.questions q ON q.id=p.question_id`;
    await tx`CREATE TEMP TABLE road_to_goal_calibration_versions ON COMMIT DROP AS
      SELECT * FROM public.road_to_goal_calibration_versions WHERE id=${version.id}`;
    await tx`CREATE TEMP TABLE road_to_goal_zone_question_calibrations ON COMMIT DROP AS
      SELECT z.* FROM public.road_to_goal_zone_question_calibrations z
      JOIN pg_temp.questions q ON q.id=z.question_id WHERE z.version_id=${version.id}`;

    for (const table of ['questions', 'question_payloads']) {
      await tx`UPDATE pg_temp.questions SET updated_at=(SELECT created_at-interval '1 millisecond' FROM pg_temp.road_to_goal_calibration_versions)`;
      await tx`UPDATE pg_temp.question_payloads SET updated_at=(SELECT created_at-interval '1 millisecond' FROM pg_temp.road_to_goal_calibration_versions)`;
      if (table === 'questions') {
        await tx`UPDATE pg_temp.questions SET updated_at=clock_timestamp()+interval '1 second'`;
      } else {
        await tx`UPDATE pg_temp.question_payloads SET updated_at=clock_timestamp()+interval '1 second'`;
      }
      const [old] = await tx`SELECT count(*)::int AS n
        FROM pg_temp.questions q JOIN pg_temp.question_payloads p ON p.question_id=q.id
        JOIN pg_temp.road_to_goal_calibration_versions v ON v.id=${version.id}
        WHERE q.updated_at<=v.created_at AND p.updated_at<=v.created_at`;
      assert.equal(old.n, 0, 'The former timestamp gate must reproduce the empty pool');
      const result = await buildCalibratedQuestionSet(tx, randomUUID(), version.id, { logSelection: false });
      assert.equal(result.questions.length, 11);
      assert.deepEqual(result.questions.map((q) => q.expected_accuracy_bp), [...priors]);
      assert.ok(result.questions.every((q) => q.calibration_source === 'difficulty_prior'));
      assert.equal(roadToGoalQuestionSetHash(live.questions), liveHash);
      evidence.cases.push({ case: `bulk_${table}_edits`, formerEligible: 0, fixedQuestions: 11, priorZones: 11, existingSnapshotUnchanged: true });
    }
    await tx`DELETE FROM pg_temp.road_to_goal_zone_question_calibrations`;
    const newlyPublished = await buildCalibratedQuestionSet(tx, randomUUID(), version.id, { logSelection: false });
    assert.deepEqual(newlyPublished.questions.map((q) => q.expected_accuracy_bp), [...priors]);
    evidence.cases.push({ case: 'no_question_calibration_rows', fixedQuestions: 11, priorZones: 11 });
    const [writes] = await tx`SELECT coalesce(sum(n_tup_ins+n_tup_upd+n_tup_del),0)::int AS n
      FROM pg_stat_xact_user_tables WHERE schemaname='public'`;
    assert.equal(writes.n, 0, 'No persistent staging rows may change');
    throw rollback;
  });
  throw new Error('Rehearsal unexpectedly committed');
} catch (error) {
  if (error !== rollback) throw error;
  const [leaks] = await sql`SELECT count(*)::int AS n FROM pg_class
    WHERE relnamespace=pg_my_temp_schema() AND relname IN (
      'questions','question_payloads','road_to_goal_calibration_versions','road_to_goal_zone_question_calibrations')`;
  assert.equal(leaks.n, 0);
  console.log(JSON.stringify({ ...evidence, rolledBack: true, temporaryTablesRemaining: leaks.n }));
} finally {
  await sql.end({ timeout: 5 });
}

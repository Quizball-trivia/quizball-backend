/**
 * Bot believability monitor — read-only. Compares persistent-bot behavior with
 * real humans IN THE SAME RP BAND on the signals players notice (the Shavski
 * report):
 *
 *   1. clue solve rate on HARD questions (measured cluesSolveRate < 0.35)
 *   2. 5-in-a-row correct-answer streak share (all sides, incl. zero-correct)
 *   3. clue index-0 answer share + answer-time percentiles
 *
 * Population matches the calibration aggregation: ranked, completed, non-dev
 * matches; seed/deleted users excluded; clue attempts require a real
 * answer_payload.clueIndex (excludes resolver backfills).
 *
 * Run: DATABASE_URL=... npx tsx scripts/monitors/bot-believability.ts [--days 7]
 */
import postgres from 'postgres';

const days = Number(process.argv[process.argv.indexOf('--days') + 1] || 7);
const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false });

const bandSql = `
  CASE
    WHEN rp.rp IS NULL THEN 'unplaced'
    WHEN rp.rp < 800 THEN '<800'
    WHEN rp.rp < 1200 THEN '800-1199'
    ELSE '1200+'
  END`;
const kindSql = `CASE WHEN u.is_ai AND u.ai_kind = 'persistent' THEN 'bot' ELSE 'human' END`;
const eligibility = `
    m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
    AND (u.is_ai = false OR u.ai_kind = 'persistent')
    AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL`;

const flagBands = (rows: any[], metric: string, ratio: number) => {
  for (const bot of rows.filter((r) => r.kind === 'bot')) {
    const human = rows.find((r) => r.kind === 'human' && r.band === bot.band);
    if (!human) continue;
    if (Number(bot[metric]) > Number(human[metric]) * ratio) {
      console.log(`FLAG: band ${bot.band} bot ${metric}=${bot[metric]} vs human ${human[metric]}`);
    }
  }
};

console.log(`=== bot believability, last ${days}d ===\n`);

console.log('--- 1. clue solve rate on HARD questions (cluesSolveRate < 0.35) ---');
const hardClue = await sql.unsafe(`
  SELECT ${kindSql} AS kind, ${bandSql} AS band,
    count(*) AS attempts,
    round(avg(CASE WHEN ma.is_correct THEN 1 ELSE 0 END)::numeric, 3) AS solve_rate
  FROM match_answers ma
  JOIN matches m ON m.id = ma.match_id
  JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
  JOIN questions q ON q.id = mq.question_id
  JOIN question_stats qs ON qs.question_id = q.id
  JOIN users u ON u.id = ma.user_id
  LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
  WHERE ${eligibility}
    AND q.type = 'clue_chain'
    AND (qs.format_stats->>'cluesSolveRate')::numeric < 0.35
    AND ma.answered_at > now() - interval '${days} days'
    AND ma.answer_payload ? 'clueIndex'
  GROUP BY 1, 2 ORDER BY 2, 1`);
console.table(hardClue);
flagBands(hardClue as any[], 'solve_rate', 1.5);

console.log('\n--- 2. 5-in-a-row correct streak share of ALL match-sides ---');
const streaks = await sql.unsafe(`
  WITH sides AS (
    SELECT ma.match_id, ma.user_id, ${kindSql} AS kind, ${bandSql} AS band
    FROM match_answers ma
    JOIN matches m ON m.id = ma.match_id
    JOIN users u ON u.id = ma.user_id
    LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
    WHERE ${eligibility}
      AND ma.answered_at > now() - interval '${days} days'
      AND ma.phase_kind IS DISTINCT FROM 'penalty'
    GROUP BY 1, 2, 3, 4
  ), runs AS (
    SELECT ma.match_id, ma.user_id,
      ma.q_index - row_number() OVER (PARTITION BY ma.match_id, ma.user_id ORDER BY ma.q_index) AS grp
    FROM match_answers ma
    JOIN matches m ON m.id = ma.match_id
    WHERE m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
      AND ma.answered_at > now() - interval '${days} days'
      AND ma.phase_kind IS DISTINCT FROM 'penalty'
      AND ma.is_correct
  ), best AS (
    SELECT match_id, user_id, max(cnt) AS best_run
    FROM (SELECT match_id, user_id, grp, count(*) AS cnt FROM runs GROUP BY 1, 2, 3) r
    GROUP BY 1, 2
  )
  SELECT s.kind, s.band, count(*) AS sides,
    round(avg(CASE WHEN coalesce(b.best_run, 0) >= 5 THEN 1 ELSE 0 END)::numeric, 3) AS streak5_share
  FROM sides s LEFT JOIN best b ON b.match_id = s.match_id AND b.user_id = s.user_id
  GROUP BY 1, 2 ORDER BY 2, 1`);
console.table(streaks);
flagBands(streaks as any[], 'streak5_share', 1.5);

console.log('\n--- 3. clue index-0 share + answer-time percentiles ---');
const timing = await sql.unsafe(`
  SELECT ${kindSql} AS kind, ${bandSql} AS band,
    count(*) AS clue_answers,
    round(avg(CASE WHEN (ma.answer_payload->>'clueIndex')::int = 0 THEN 1 ELSE 0 END)::numeric, 3) AS index0_share,
    percentile_cont(0.1) WITHIN GROUP (ORDER BY ma.time_ms)::int AS p10_ms,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY ma.time_ms)::int AS p50_ms
  FROM match_answers ma
  JOIN matches m ON m.id = ma.match_id
  JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
  JOIN questions q ON q.id = mq.question_id
  JOIN users u ON u.id = ma.user_id
  LEFT JOIN ranked_profiles rp ON rp.user_id = u.id
  WHERE ${eligibility}
    AND q.type = 'clue_chain'
    AND ma.answer_payload ? 'clueIndex'
    AND ma.answered_at > now() - interval '${days} days'
  GROUP BY 1, 2 ORDER BY 2, 1`);
console.table(timing);
for (const bot of (timing as any[]).filter((r) => r.kind === 'bot')) {
  const human = (timing as any[]).find((r) => r.kind === 'human' && r.band === bot.band);
  if (human && Number(bot.p10_ms) < Number(human.p10_ms) * 0.7) {
    console.log(`FLAG: band ${bot.band} bot p10 ${bot.p10_ms}ms far below human p10 ${human.p10_ms}ms`);
  }
}

await sql.end();

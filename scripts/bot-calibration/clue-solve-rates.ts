/**
 * Clue solve-rate calibration. Two jobs:
 *
 *   --fit    Fit the clue difficulty link (theta-scale beta from a question's
 *            smoothed solve rate) with leave-one-out predictors and a held-out
 *            question fold; prints calibration by theta band AND by question
 *            solve-rate band (tail check). Constants are FROZEN into
 *            CLUE_DIFFICULTY_LINK in persistent-bot-gameplay.ts.
 *   --write  Merge { cluesSolveRate, cluesSolveSamples } into
 *            question_stats.format_stats (additive jsonb merge).
 *
 * Attempt population: match_answers, SAME eligibility as the calibration
 * aggregation (ranked + completed + non-dev matches, real humans only) — a
 * complete denominator, so no capture-sampling reweighting is needed. A row
 * without answer_payload.clueIndex is a shown-but-never-answered question and
 * counts as a failure (the bot must imitate P(solve | question shown)).
 *
 * Rejection-bug correction: a wrong (is_correct=false) attempt whose rejected
 * raw guesses (clue_guess_evaluations logs rejects in FULL) match the
 * question's CURRENT accepted answers under the live matcher was a
 * misgraded solve — counted as solved. Accept-side sampling in the capture is
 * irrelevant here: accepted attempts are already is_correct in match_answers.
 *
 * Skill at attempt time: ranked_rp_changes.old_rp for that (match, user).
 *
 * Run (fit, read-only): DATABASE_URL=... npx tsx scripts/bot-calibration/clue-solve-rates.ts --fit
 * Run (write):          DATABASE_URL=... npx tsx scripts/bot-calibration/clue-solve-rates.ts --write
 */
import postgres from 'postgres';
import { fuzzyMatchesAnswer } from '../../src/realtime/possession-answer-matching.js';
import { evalFCurve, logit, sigmoid } from '../../src/modules/bots/calibration/math.js';

const SMOOTH_PRIOR_N = 15;
const MODE = process.argv.includes('--write') ? 'write' : 'fit';

const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false });

interface AttemptRow {
  question_id: string;
  match_id: string;
  user_id: string;
  q_index: number;
  is_correct: boolean;
  answered: boolean;
  old_rp: number | null;
}

const WINDOW_DAYS = 60;
const PAGE_DAYS = 5;
const attempts: AttemptRow[] = [];
for (let start = WINDOW_DAYS; start > 0; start -= PAGE_DAYS) {
  const page = await sql<AttemptRow[]>`
    SELECT q.id AS question_id, ma.match_id, ma.user_id, ma.q_index, ma.is_correct,
      (ma.answer_payload ? 'clueIndex') AS answered,
      rc.old_rp
    FROM match_answers ma
    JOIN matches m          ON m.id = ma.match_id
    JOIN match_questions mq ON mq.match_id = ma.match_id AND mq.q_index = ma.q_index
    JOIN questions q        ON q.id = mq.question_id
    JOIN users u            ON u.id = ma.user_id
    LEFT JOIN ranked_rp_changes rc ON rc.match_id = ma.match_id AND rc.user_id = ma.user_id
    WHERE q.type = 'clue_chain'
      AND ma.answered_at >  now() - make_interval(days => ${start})
      AND ma.answered_at <= now() - make_interval(days => ${start - PAGE_DAYS})
      AND m.mode = 'ranked' AND m.status = 'completed' AND m.is_dev = false
      AND u.is_ai = false AND u.is_seed = false AND u.is_deleted = false AND u.deleted_at IS NULL`;
  attempts.push(...page);
}
console.log(`eligible clue attempts (${WINDOW_DAYS}d): ${attempts.length}`);

// Rejected guesses for the misgrade correction, keyed by attempt.
const rejects = await sql<{ match_id: string; user_id: string; q_index: number; question_id: string; raw_guess: string | null }[]>`
  SELECT match_id, user_id, q_index, question_id, raw_guess
  FROM clue_guess_evaluations
  WHERE is_ai = false AND is_correct = false AND give_up = false AND raw_guess IS NOT NULL`;
const rejectsByAttempt = new Map<string, { questionId: string; guesses: string[] }>();
for (const r of rejects) {
  const key = `${r.match_id}:${r.user_id}:${r.q_index}`;
  let entry = rejectsByAttempt.get(key);
  if (!entry) {
    entry = { questionId: r.question_id, guesses: [] };
    rejectsByAttempt.set(key, entry);
  }
  if (r.raw_guess && r.raw_guess.trim()) entry.guesses.push(r.raw_guess);
}

const questionIds = [...new Set(attempts.map((a) => a.question_id))];
const payloadRows = await sql<{ question_id: string; payload: Record<string, unknown> }[]>`
  SELECT question_id,
    CASE WHEN jsonb_typeof(payload) = 'string' THEN (payload #>> '{}')::jsonb ELSE payload END AS payload
  FROM question_payloads WHERE question_id = ANY(${questionIds})`;
const acceptedByQuestion = new Map<string, string[]>();
for (const row of payloadRows) {
  const payload = row.payload ?? {};
  const accepted = Array.isArray(payload.accepted_answers)
    ? payload.accepted_answers.filter((a): a is string => typeof a === 'string')
    : [];
  const display = payload.display_answer;
  if (display && typeof display === 'object') {
    for (const value of Object.values(display)) {
      if (typeof value === 'string' && value.trim()) accepted.push(value);
    }
  }
  acceptedByQuestion.set(row.question_id, accepted);
}

interface Attempt {
  questionId: string;
  solved: boolean;
  oldRp: number | null;
}
const resolved: Attempt[] = [];
let corrected = 0;
for (const a of attempts) {
  let solved = a.is_correct;
  if (!solved) {
    const entry = rejectsByAttempt.get(`${a.match_id}:${a.user_id}:${a.q_index}`);
    if (entry) {
      const accepted = acceptedByQuestion.get(a.question_id);
      if (accepted && accepted.length > 0
        && entry.guesses.some((guess) => fuzzyMatchesAnswer(guess, accepted))) {
        solved = true;
        corrected += 1;
      }
    }
  }
  resolved.push({ questionId: a.question_id, solved, oldRp: a.old_rp });
}
console.log(`misgrade-corrected attempts: ${corrected}`);

const perQuestion = new Map<string, { n: number; k: number }>();
for (const attempt of resolved) {
  const agg = perQuestion.get(attempt.questionId) ?? { n: 0, k: 0 };
  agg.n += 1;
  if (attempt.solved) agg.k += 1;
  perQuestion.set(attempt.questionId, agg);
}
const totalN = resolved.length;
const totalK = resolved.filter((a) => a.solved).length;
const globalRate = totalN > 0 ? totalK / totalN : 0.5;
console.log(`attempts=${totalN} solves=${totalK} globalRate=${globalRate.toFixed(4)} questions=${perQuestion.size}`);

const smoothed = (n: number, k: number): number => (k + SMOOTH_PRIOR_N * globalRate) / (n + SMOOTH_PRIOR_N);

if (MODE === 'fit') {
  const [paramsRow] = await sql<{ params: Record<string, unknown> }[]>`
    SELECT params FROM bot_model_params WHERE active = true LIMIT 1`;
  const fCurve = (paramsRow?.params as { fCurve?: { rp: number; skill: number }[] })?.fCurve;
  if (!fCurve) throw new Error('no active bot_model_params fCurve');

  // Question-fold split for a held-out calibration table (deterministic by id hash).
  const holdout = (questionId: string): boolean =>
    (parseInt(questionId.replaceAll('-', '').slice(0, 8), 16) % 5) === 0; // ~20%

  interface FitSample { theta: number; x: number; rate: number; solved: boolean; held: boolean }
  const samples: FitSample[] = [];
  for (const attempt of resolved) {
    if (attempt.oldRp === null) continue;
    const agg = perQuestion.get(attempt.questionId)!;
    if (agg.n < 5) continue;
    // Leave-one-out predictor: this attempt is removed from its question's rate.
    const looRate = smoothed(agg.n - 1, agg.k - (attempt.solved ? 1 : 0));
    samples.push({
      theta: evalFCurve(fCurve, attempt.oldRp),
      x: logit(Math.min(0.98, Math.max(0.02, looRate))),
      rate: looRate,
      solved: attempt.solved,
      held: holdout(attempt.questionId),
    });
  }
  const train = samples.filter((s) => !s.held);
  const held = samples.filter((s) => s.held);
  console.log(`fit samples: train=${train.length} holdout=${held.length}`);

  let best = { a: 0, b: 1, loss: Infinity };
  for (let a = -3; a <= 3.001; a += 0.05) {
    for (let b = 0.1; b <= 3.001; b += 0.05) {
      let loss = 0;
      for (const s of train) {
        const p = Math.min(1 - 1e-6, Math.max(1e-6, sigmoid(s.theta - (a - b * s.x))));
        loss -= s.solved ? Math.log(p) : Math.log(1 - p);
      }
      if (loss < best.loss) best = { a, b, loss };
    }
  }
  console.log(`fit: CLUE_DIFFICULTY_LINK = { intercept: ${best.a.toFixed(2)}, slope: ${(-best.b).toFixed(2)} }  (train logloss/n=${(best.loss / train.length).toFixed(4)})`);

  const table = (rows: FitSample[], label: string) => {
    console.log(`-- ${label} --`);
    const thetaBands = [-Infinity, -1, -0.5, 0, 0.5, 1, Infinity];
    for (let i = 0; i < thetaBands.length - 1; i += 1) {
      const band = rows.filter((s) => s.theta > thetaBands[i] && s.theta <= thetaBands[i + 1]);
      if (band.length < 30) continue;
      const actual = band.filter((r) => r.solved).length / band.length;
      const predicted = band.reduce((sum, r) => sum + sigmoid(r.theta - (best.a - best.b * r.x)), 0) / band.length;
      console.log(`  theta (${thetaBands[i]}, ${thetaBands[i + 1]}]: n=${band.length} actual=${actual.toFixed(3)} predicted=${predicted.toFixed(3)}`);
    }
    const rateBands = [0, 0.25, 0.45, 0.65, 0.85, 1.0001];
    for (let i = 0; i < rateBands.length - 1; i += 1) {
      const band = rows.filter((s) => s.rate >= rateBands[i] && s.rate < rateBands[i + 1]);
      if (band.length < 30) continue;
      const actual = band.filter((r) => r.solved).length / band.length;
      const predicted = band.reduce((sum, r) => sum + sigmoid(r.theta - (best.a - best.b * r.x)), 0) / band.length;
      console.log(`  rate [${rateBands[i]}, ${rateBands[i + 1]}): n=${band.length} actual=${actual.toFixed(3)} predicted=${predicted.toFixed(3)}`);
    }
  };
  table(held, 'HELD-OUT questions');
  table(train, 'train (reference)');
} else {
  let written = 0;
  for (const [questionId, agg] of perQuestion) {
    const rate = Number(smoothed(agg.n, agg.k).toFixed(4));
    const result = await sql`
      UPDATE question_stats
      SET format_stats = coalesce(format_stats, '{}'::jsonb)
        || jsonb_build_object('cluesSolveRate', ${rate}::numeric, 'cluesSolveSamples', ${agg.n}::int)
      WHERE question_id = ${questionId}`;
    written += result.count;
  }
  console.log(`updated question_stats rows: ${written} of ${perQuestion.size} measured questions`);
}
await sql.end();

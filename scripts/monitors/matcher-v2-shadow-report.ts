/**
 * Matcher v2 shadow report — replays captured clue guesses (clue_guess_evaluations
 * stores every reject in full plus sampled accepts) through BOTH matcher versions
 * and reports the verdict flips v2 would cause, by kind, with samples. Run before
 * flipping ANSWER_MATCHER_V2 to 'on' and again afterwards to confirm the live
 * effect matches the prediction.
 *
 * Run: DATABASE_URL=... npx tsx scripts/monitors/matcher-v2-shadow-report.ts [--days 60] [--samples 15]
 */
import postgres from 'postgres';
import { fuzzyMatchesAnswer, matchAnswerV2 } from '../../src/realtime/possession-answer-matching.js';

const arg = (name: string, fallback: number): number => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const days = arg('days', 60);
const sampleLimit = arg('samples', 15);

const sql = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false });

const rows = await sql<{ raw_guess: string; accepted_answers: string[]; is_correct: boolean; is_ai: boolean }[]>`
  SELECT raw_guess, accepted_answers, is_correct, is_ai
  FROM clue_guess_evaluations
  WHERE raw_guess IS NOT NULL AND created_at > now() - make_interval(days => ${days})`;

let total = 0;
const flips = new Map<string, { count: number; samples: string[] }>();
let v1Correct = 0;
let v2Correct = 0;

for (const row of rows) {
  if (row.is_ai || !row.raw_guess.trim()) continue;
  total += 1;
  const v1 = fuzzyMatchesAnswer(row.raw_guess, row.accepted_answers);
  const v2 = matchAnswerV2(row.raw_guess, row.accepted_answers);
  if (v1) v1Correct += 1;
  if (v2) v2Correct += 1;
  if (v1 === (v2 !== null)) continue;
  const key = v2 ? `reject->accept (${v2.kind})` : 'accept->reject (guard)';
  const bucket = flips.get(key) ?? { count: 0, samples: [] };
  bucket.count += 1;
  if (bucket.samples.length < sampleLimit) {
    bucket.samples.push(`"${row.raw_guess}" vs [${row.accepted_answers.slice(0, 3).join(' | ')}${row.accepted_answers.length > 3 ? ' …' : ''}]`);
  }
  flips.set(key, bucket);
}

console.log(`replayed ${total} human guesses (${days}d): v1 accepts ${v1Correct}, v2 accepts ${v2Correct}`);
for (const [key, bucket] of [...flips.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`\n${key}: ${bucket.count}`);
  for (const sample of bucket.samples) console.log(`  ${sample}`);
}
if (flips.size === 0) console.log('no verdict flips');
await sql.end();

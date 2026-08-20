#!/usr/bin/env npx tsx

/**
 * Manual end-to-end smoke against a REAL database (point DATABASE_URL at local
 * Supabase — never staging/prod): creates a throwaway user, plays a full
 * session through the service layer (start → guess → bonus), asserts the
 * public payload leaks nothing, rewards land exactly once, and a replayed
 * guess is idempotent. Exits non-zero on any violation.
 *
 *   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx tsx scripts/guess-the-goal/smoke.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from '../../src/db/index.js';
import { guessTheGoalService } from '../../src/modules/guess-the-goal/guess-the-goal.service.js';

function assert(cond: unknown, msg: string): asserts cond {
  // Throw (never process.exit): the finally-block cleanup must run even — and
  // especially — when an assertion fails.
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
  console.log(`✓ ${msg}`);
}

const hostname = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
  console.error('Refusing to run: DATABASE_URL must point at a local database.');
  process.exit(1);
}

const userId = randomUUID();
const email = `smoke-${userId.slice(0, 8)}@test.local`;
await sql`
  INSERT INTO users (id, email, nickname, coins)
  VALUES (${userId}, ${email}, ${`smoke_${userId.slice(0, 6)}`}, 0)
`;

try {
  const nonce = randomUUID();
  const session = await guessTheGoalService.startSession(userId, nonce);
  assert(session.session_id, 'session created');
  assert(session.max_points === 100, 'fresh goal serves max_points 100');
  assert(session.goal.options.length === 4, '4 options served');
  const raw = JSON.stringify(session);
  assert(!raw.includes('is_correct'), 'no is_correct in public payload');
  assert(!raw.includes('title'), 'no title in public payload');
  assert(
    session.goal.players.every((p) => /^p\d+$/.test(p.id)),
    'player ids anonymized'
  );

  const retry = await guessTheGoalService.startSession(userId, nonce);
  assert(retry.session_id === session.session_id, 'nonce retry returns same session');

  // Find the correct option by brute force against the DB (test-only).
  const [row] = await sql<Array<{ goal_snapshot: { options: Array<{ id: string; is_correct: boolean }> } }>>`
    SELECT goal_snapshot FROM guess_the_goal_sessions WHERE id = ${session.session_id}
  `;
  const correctId = row.goal_snapshot.options.find((o) => o.is_correct)!.id;

  const outcome = await guessTheGoalService.guess(userId, session.session_id, correctId);
  assert(outcome.correct, 'correct guess accepted');
  assert(outcome.points === 100, `instant guess scores 100 (got ${outcome.points})`);
  assert(outcome.awards.first_solve, 'first solve detected');
  assert(outcome.awards.coins === 25 && outcome.awards.xp === 50, 'rewards 25c/50xp');

  const replay = await guessTheGoalService.guess(userId, session.session_id, correctId);
  assert(replay.points === outcome.points, 'guess replay is idempotent');

  const [wallet] = await sql<Array<{ coins: number; total_xp: string | number }>>`
    SELECT coins, total_xp FROM users WHERE id = ${userId}
  `;
  assert(Number(wallet.coins) === 25, `wallet has exactly 25 coins (got ${wallet.coins})`);
  assert(Number(wallet.total_xp) === 50, `total_xp exactly 50 (got ${wallet.total_xp})`);

  if (outcome.bonus) {
    const [snap] = await sql<Array<{ goal_snapshot: { bonus: { options: Array<{ id: string; is_correct: boolean }> } } }>>`
      SELECT goal_snapshot FROM guess_the_goal_sessions WHERE id = ${session.session_id}
    `;
    const bId = snap.goal_snapshot.bonus.options.find((o) => o.is_correct)!.id;
    const bonus = await guessTheGoalService.answerBonus(userId, session.session_id, bId);
    assert(bonus.correct && bonus.bonus_points === 40, 'bonus scored 40');
    assert(bonus.awards.coins === 10 && bonus.awards.xp === 20, 'bonus rewards 10c/20xp');
    const [w2] = await sql<Array<{ coins: number }>>`SELECT coins FROM users WHERE id = ${userId}`;
    assert(Number(w2.coins) === 35, `wallet 35 after bonus (got ${w2.coins})`);
  }

  const stats = await guessTheGoalService.getStats(userId);
  assert(stats.solved === 1, 'stats count 1 solve');
  console.log(`pool: ${stats.solved}/${stats.total}, coins today ${stats.coins_today}`);

  // Repeat play of the SAME goal (forced): clamped to the floor and never paid
  // again — the two core anti-farm invariants.
  const [replayRow] = await sql<Array<{ id: string }>>`
    INSERT INTO guess_the_goal_sessions (user_id, goal_id, goal_snapshot, max_points)
    SELECT user_id, goal_id, goal_snapshot, 40 FROM guess_the_goal_sessions
    WHERE id = ${session.session_id}
    RETURNING id
  `;
  const replaySession = replayRow.id;
  const replayOutcome = await guessTheGoalService.guess(userId, replaySession, correctId);
  assert(replayOutcome.correct, 'repeat solve recognized as correct');
  assert(replayOutcome.points === 40, `repeat view clamped to floor (got ${replayOutcome.points})`);
  assert(!replayOutcome.awards.first_solve, 'repeat solve is not a first solve');
  assert(replayOutcome.awards.coins === 0 && replayOutcome.awards.xp === 0, 'repeat solve pays nothing');
  const [wallet3] = await sql<Array<{ coins: number }>>`SELECT coins FROM users WHERE id = ${userId}`;
  assert(Number(wallet3.coins) === 35, `wallet unchanged after repeat solve (got ${wallet3.coins})`);

  console.log('\nSMOKE PASSED');
} finally {
  await sql`DELETE FROM guess_the_goal_solves WHERE user_id = ${userId}`;
  await sql`DELETE FROM guess_the_goal_sessions WHERE user_id = ${userId}`;
  await sql`DELETE FROM user_xp_events WHERE user_id = ${userId}`;
  await sql`DELETE FROM store_transaction_logs WHERE user_id = ${userId}`;
  await sql`DELETE FROM users WHERE id = ${userId}`;
  await sql.end();
}

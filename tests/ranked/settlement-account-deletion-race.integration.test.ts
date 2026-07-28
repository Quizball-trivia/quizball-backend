/**
 * Integration tests for ranked settlement vs ACCOUNT-DELETION FINALIZATION
 * against the real test DB.
 *
 * finalize_pending_account_deletions() anonymizes an expired account and resets
 * its ranked_profiles row to zero (migration 20260728130100). It takes
 * `SELECT ... FOR UPDATE` on public.users while doing so. Settlement took no such
 * lock and never inspected the deletion columns, so a delayed or replayed
 * settlement landing after finalization restored RP/tier/placement (and coins)
 * onto a deleted row — a ranked ghost.
 *
 * Proven here:
 *   - a settlement replayed AFTER finalization leaves the deleted account zeroed
 *     and writes no ledger row for it
 *   - the surviving opponent still settles normally (one bad participant must
 *     never abort the whole settlement)
 *   - an account merely PENDING deletion still settles (it can still cancel)
 *
 * Run with:
 *   npm run docker:start
 *   npx vitest run tests/ranked/settlement-account-deletion-race.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import '../setup.js';

let sql: typeof import('../../src/db/index.js').sql;
let rankedService: typeof import('../../src/modules/ranked/ranked.service.js').rankedService;
let dbAvailable = false;

const testUserIds: string[] = [];
const testMatchIds: string[] = [];

async function seedUser(nickname: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO users (nickname, is_ai, ai_kind, coins, onboarding_complete)
    VALUES (${nickname}, false, null, 0, true)
    RETURNING id
  `;
  testUserIds.push(row.id);
  return row.id;
}

async function seedProfile(userId: string, rp: number): Promise<void> {
  await sql`
    INSERT INTO ranked_profiles (user_id, rp, tier, placement_status, placement_required, placement_played, placement_wins)
    VALUES (${userId}, ${rp}, 'Bench', 'placed', 3, 3, 2)
    ON CONFLICT (user_id) DO UPDATE SET rp = EXCLUDED.rp, tier = EXCLUDED.tier
  `;
}

async function seedCompletedRankedMatch(opts: {
  winner: string;
  loser: string;
}): Promise<string> {
  const [match] = await sql<{ id: string }[]>`
    INSERT INTO matches (
      mode, status, current_q_index, total_questions,
      state_payload, ranked_context, winner_user_id, started_at, ended_at
    )
    VALUES (
      'ranked', 'completed', 12, 12,
      ${sql.json({ winnerDecisionMethod: 'goals' })},
      ${sql.json({ isPlacement: false })},
      ${opts.winner}, NOW(), NOW()
    )
    RETURNING id
  `;
  testMatchIds.push(match.id);
  await sql`
    INSERT INTO match_players (match_id, user_id, seat, total_points, correct_answers, goals, penalty_goals)
    VALUES
      (${match.id}, ${opts.winner}, 1, 900, 6, 3, 0),
      (${match.id}, ${opts.loser}, 2, 400, 3, 1, 0)
  `;
  return match.id;
}

/** Expire the grace window and run the real finalization function. */
async function finalizeDeletion(userId: string): Promise<void> {
  await sql`
    UPDATE users
    SET deletion_requested_at = NOW() - INTERVAL '31 days',
        pending_deletion_at = NOW() - INTERVAL '1 day'
    WHERE id = ${userId}
  `;
  await sql`SELECT finalize_pending_account_deletions()`;
}

beforeAll(async () => {
  try {
    const dbModule = await import('../../src/db/index.js');
    sql = dbModule.sql;
    await sql`SELECT 1`;
    dbAvailable = true;
    rankedService = (await import('../../src/modules/ranked/ranked.service.js')).rankedService;
  } catch {
    console.warn(
      '\n⚠️  Skipping settlement/account-deletion race tests: DB unavailable.\n' +
        '   Run `npm run docker:start` to start the test database.\n'
    );
  }
});

afterAll(async () => {
  if (!dbAvailable) return;
  if (testMatchIds.length > 0) {
    await sql`DELETE FROM ranked_rp_changes WHERE match_id = ANY(${testMatchIds}::uuid[])`;
    await sql`DELETE FROM matches WHERE id = ANY(${testMatchIds}::uuid[])`;
  }
  if (testUserIds.length > 0) {
    await sql`DELETE FROM user_xp_events WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM user_mode_match_stats WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM ranked_profiles WHERE user_id = ANY(${testUserIds}::uuid[])`;
    await sql`DELETE FROM users WHERE id = ANY(${testUserIds}::uuid[])`;
  }
});

describe('ranked settlement vs account-deletion finalization', () => {
  it('does not restore RP onto an account finalized before the settlement lands', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const winner = await seedUser('race-winner-1');
    const loser = await seedUser('race-loser-1');
    await seedProfile(winner, 900);
    await seedProfile(loser, 800);
    const matchId = await seedCompletedRankedMatch({ winner, loser });

    // The winner deletes their account and the cron finalizes it BEFORE the
    // (delayed / replayed) settlement for their last match runs.
    await finalizeDeletion(winner);

    const [zeroed] = await sql<{ rp: number; tier: string }[]>`
      SELECT rp, tier FROM ranked_profiles WHERE user_id = ${winner}
    `;
    expect(zeroed?.rp).toBe(0);

    await rankedService.settleCompletedRankedMatch(matchId);

    const [afterSettle] = await sql<{ rp: number; tier: string; placement_status: string }[]>`
      SELECT rp, tier, placement_status FROM ranked_profiles WHERE user_id = ${winner}
    `;
    expect(afterSettle?.rp).toBe(0);
    expect(afterSettle?.tier).toBe('Academy');
    expect(afterSettle?.placement_status).toBe('unplaced');

    const ledger = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${winner}
    `;
    expect(ledger.length).toBe(0);
  });

  it('still settles the surviving opponent when the other side was finalized', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const winner = await seedUser('race-winner-2');
    const loser = await seedUser('race-loser-2');
    await seedProfile(winner, 900);
    await seedProfile(loser, 800);
    const matchId = await seedCompletedRankedMatch({ winner, loser });

    await finalizeDeletion(winner);
    await rankedService.settleCompletedRankedMatch(matchId);

    // The deleted winner is skipped, but the live loser must still take their loss.
    const loserLedger = await sql<{ user_id: string; delta_rp: number }[]>`
      SELECT user_id, delta_rp FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${loser}
    `;
    expect(loserLedger.length).toBe(1);

    const [loserProfile] = await sql<{ rp: number }[]>`
      SELECT rp FROM ranked_profiles WHERE user_id = ${loser}
    `;
    expect(loserProfile?.rp).not.toBe(800);
  });

  it('leaves no ghost profile when the finalized account had none to reset', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const winner = await seedUser('race-winner-5');
    const loser = await seedUser('race-loser-5');
    // NOTE: deliberately NO ranked_profiles row for the winner. Finalization's
    // reset then updates zero rows, and settlement's own ensureProfile would
    // create a fresh 450-RP "Youth Prospect" profile for a deleted account.
    await seedProfile(loser, 800);
    const matchId = await seedCompletedRankedMatch({ winner, loser });

    await finalizeDeletion(winner);
    await rankedService.settleCompletedRankedMatch(matchId);

    const [ghost] = await sql<{ rp: number; tier: string; placement_status: string }[]>`
      SELECT rp, tier, placement_status FROM ranked_profiles WHERE user_id = ${winner}
    `;
    // Either no row at all, or a row that carries no standing whatsoever.
    if (ghost) {
      expect(ghost.rp).toBe(0);
      expect(ghost.tier).toBe('Academy');
      expect(ghost.placement_status).toBe('unplaced');
    }

    const ledger = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${winner}
    `;
    expect(ledger.length).toBe(0);
  });

  it('settles exactly once when finalization and settlement run concurrently', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const winner = await seedUser('race-winner-4');
    const loser = await seedUser('race-loser-4');
    await seedProfile(winner, 900);
    await seedProfile(loser, 800);
    const matchId = await seedCompletedRankedMatch({ winner, loser });

    // Arm the deletion but let the cron fire AT THE SAME TIME as the settlement.
    // The users-row lock is the only thing that orders them; whichever wins, the
    // end state must be self-consistent — never a half-reset profile carrying RP.
    await sql`
      UPDATE users
      SET deletion_requested_at = NOW() - INTERVAL '31 days',
          pending_deletion_at = NOW() - INTERVAL '1 day'
      WHERE id = ${winner}
    `;

    await Promise.all([
      sql`SELECT finalize_pending_account_deletions()`,
      rankedService.settleCompletedRankedMatch(matchId),
    ]);

    const [winnerUser] = await sql<{ is_deleted: boolean }[]>`
      SELECT is_deleted FROM users WHERE id = ${winner}
    `;
    const [winnerProfile] = await sql<{ rp: number; tier: string }[]>`
      SELECT rp, tier FROM ranked_profiles WHERE user_id = ${winner}
    `;

    // Finalization always wins the race in the end-state sense: once the account
    // is finalized its ranked standing must be zero, never resurrected RP.
    if (winnerUser?.is_deleted) {
      expect(winnerProfile?.rp).toBe(0);
      expect(winnerProfile?.tier).toBe('Academy');
    }

    // The live opponent settles regardless of how the race resolved.
    const loserLedger = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${loser}
    `;
    expect(loserLedger.length).toBe(1);
  });

  it('still settles an account that is only PENDING deletion (it can still cancel)', async (ctx) => {
    if (!dbAvailable) return ctx.skip();
    const winner = await seedUser('race-winner-3');
    const loser = await seedUser('race-loser-3');
    await seedProfile(winner, 900);
    await seedProfile(loser, 800);
    const matchId = await seedCompletedRankedMatch({ winner, loser });

    // Requested deletion, grace window still open — NOT finalized.
    await sql`
      UPDATE users
      SET deletion_requested_at = NOW(),
          pending_deletion_at = NOW() + INTERVAL '30 days'
      WHERE id = ${winner}
    `;

    await rankedService.settleCompletedRankedMatch(matchId);

    const winnerLedger = await sql<{ user_id: string }[]>`
      SELECT user_id FROM ranked_rp_changes WHERE match_id = ${matchId} AND user_id = ${winner}
    `;
    expect(winnerLedger.length).toBe(1);

    const [winnerProfile] = await sql<{ rp: number }[]>`
      SELECT rp FROM ranked_profiles WHERE user_id = ${winner}
    `;
    expect(winnerProfile?.rp).toBeGreaterThan(900);
  });
});

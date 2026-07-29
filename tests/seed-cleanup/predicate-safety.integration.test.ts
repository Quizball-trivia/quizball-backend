/**
 * Predicate-safety tests for the legacy fake-account cleanup (PR11).
 *
 * This is the test that matters. The script HARD-deletes users, so the only
 * thing standing between it and a real account is the predicate in
 * scripts/seed-cleanup/predicate.ts. Each case below plants one row that MUST
 * survive, runs the real selection query, and asserts it was spared — plus the
 * positive control (a plain seed) to prove the query deletes anything at all.
 *
 * A guard is only tested if its row would be deleted with that guard removed,
 * so every case pins a specific clause rather than passing incidentally.
 *
 * Run: npm run test:seed-cleanup   (needs the local Supabase DB: npm run db:start)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import postgres from 'postgres';

import type { SqlLike } from '../../scripts/persistent-bot-roster/db-types.js';
import { assertDrainSafe, deleteScope } from '../../scripts/seed-cleanup/engine.js';
import { selectBatchSql } from '../../scripts/seed-cleanup/predicate.js';

const DSN = process.env.SEED_CLEANUP_TEST_DSN
  ?? 'postgresql://postgres:postgres@localhost:54322/postgres';
const RECENT_WINDOW = 10;
const TAG = `seedcleanup_${Date.now()}`;

let sql: SqlLike;
let dbAvailable = false;

/** Ids planted by a single test case, torn down after it. */
let planted: string[] = [];
let plantedMatches: string[] = [];
let categoryId: string;

async function newUser(fields: Record<string, unknown>): Promise<string> {
  const base = {
    nickname: `${TAG}_${Math.random().toString(36).slice(2, 10)}`,
    email: `${TAG}_${Math.random().toString(36).slice(2, 10)}@gmail.com`,
    is_ai: false,
    is_seed: false,
    role: 'user',
    onboarding_complete: true,
    // Inside the legacy batch window by default, so a fixture is in scope
    // unless a test deliberately moves it out.
    created_at: '2026-02-20T00:00:00Z',
    ...fields,
  };
  const cols = Object.keys(base);
  const vals = Object.values(base);
  const [row] = await sql.unsafe<{ id: string }[]>(
    `INSERT INTO public.users (${cols.join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
    vals,
  );
  planted.push(row.id);
  return row.id;
}

/** A completed non-dev match between two users, backdated by `daysAgo`. */
async function playMatch(a: string, b: string, daysAgo: number): Promise<string> {
  const when = new Date(Date.now() - daysAgo * 86_400_000);
  const [m] = await sql.unsafe<{ id: string }[]>(
    `INSERT INTO public.matches (mode, status, is_dev, started_at, ended_at, category_a_id, category_b_id)
     VALUES ('ranked','completed',false,$1,$1,$2,$2) RETURNING id`,
    [when.toISOString(), categoryId],
  );
  plantedMatches.push(m.id);
  for (const [i, uid] of [a, b].entries()) {
    await sql.unsafe(
      `INSERT INTO public.match_players (match_id, user_id, seat, goals, penalty_goals)
       VALUES ($1,$2,$3,0,0)`,
      [m.id, uid, i + 1],
    );
  }
  return m.id;
}

/**
 * Runs the REAL predicate and returns which PLANTED ids it would delete.
 *
 * The predicate text is taken verbatim from selectBatchSql (so the tests pin the
 * shipped clauses, not a paraphrase) but is restricted to this test's own rows.
 * A plain `LIMIT n` selection is not usable here: the shared local DB already
 * holds ~24k load-test seeds, which would fill any batch before the planted row
 * was reached and make every assertion vacuously false.
 */
async function selectDeletable(scope: 'legacy' | 'loadtest'): Promise<Set<string>> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`DROP TABLE IF EXISTS _seed_protected_match_ids`);
    const { protectedMatchesSql, deletablePredicate } = await import(
      '../../scripts/seed-cleanup/predicate.js'
    );
    await tx.unsafe(protectedMatchesSql(RECENT_WINDOW));
    const rows = await tx.unsafe<{ id: string }[]>(
      `SELECT u.id FROM public.users u
       WHERE u.id = ANY($1::uuid[]) AND ${deletablePredicate(scope)}`,
      [planted],
    );
    return new Set(rows.map((r) => r.id));
  })) as Set<string>;
}

beforeAll(async () => {
  try {
    sql = postgres(DSN, { max: 2, idle_timeout: 10 }) as unknown as SqlLike;
    await sql.unsafe('SELECT 1');
    const [cat] = await sql.unsafe<{ id: string }[]>(`SELECT id FROM public.categories LIMIT 1`);
    categoryId = cat?.id ?? (await sql.unsafe<{ id: string }[]>(
      `INSERT INTO public.categories (slug, name, is_active) VALUES ($1,'SC',true) RETURNING id`,
      [`sc_${TAG}`],
    ))[0].id;
    // Set LAST, only once every piece of setup has succeeded. Setting it right
    // after the connectivity probe would leave it true if the category step
    // threw, and every case would then run without a categoryId.
    dbAvailable = true;
  } catch {
    console.warn('\n⚠️  Skipping seed-cleanup predicate tests: DB unavailable. Run `npm run db:start`.\n');
  }
});

beforeEach(() => {
  planted = [];
  plantedMatches = [];
});

afterEach(async () => {
  if (!dbAvailable) return;
  if (plantedMatches.length > 0) {
    await sql.unsafe(`DELETE FROM public.matches WHERE id = ANY($1::uuid[])`, [plantedMatches]);
  }
  if (planted.length > 0) {
    await sql.unsafe(`UPDATE public.matches SET winner_user_id = NULL WHERE winner_user_id = ANY($1::uuid[])`, [planted]);
    await sql.unsafe(`DELETE FROM public.lobbies WHERE host_user_id = ANY($1::uuid[])`, [planted]);
    await sql.unsafe(`DELETE FROM public.users WHERE id = ANY($1::uuid[])`, [planted]);
  }
});

afterAll(async () => {
  if (dbAvailable) await sql.end({ timeout: 5 });
});

/**
 * Skips cleanly when no local DB is present. The timeout is generous because
 * these cases plant a dozen-plus rows each against a shared local database.
 */
const dbIt: typeof it = ((name: string, fn: () => Promise<void>) =>
  it(
    name,
    async () => {
      if (!dbAvailable) return;
      await fn();
    },
    30_000,
  )) as typeof it;

describe('seed-cleanup deletion predicate', () => {
  dbIt('deletes a plain legacy seed (positive control)', async () => {
    const seed = await newUser({ is_seed: true });
    expect((await selectDeletable('legacy')).has(seed)).toBe(true);
  });

  dbIt('spares a real user — the flag, not the absence of it, is what selects', async () => {
    const real = await newUser({ is_seed: false });
    expect((await selectDeletable('legacy')).has(real)).toBe(false);
  });

  dbIt('spares a persistent bot', async () => {
    const bot = await newUser({ is_ai: true, ai_kind: 'persistent', is_seed: true });
    expect((await selectDeletable('legacy')).has(bot)).toBe(false);
  });

  dbIt('spares an auction bot', async () => {
    const bot = await newUser({ is_ai: true, ai_kind: 'auction', is_seed: true });
    expect((await selectDeletable('legacy')).has(bot)).toBe(false);
  });

  dbIt('spares the mis-flagged admin account (role guard)', async () => {
    // The May-24 backfill flagged admin@quizball.com purely because it has no
    // user_identities row. It exists as is_seed=true on BOTH prod and staging.
    const admin = await newUser({ is_seed: true, role: 'admin' });
    expect((await selectDeletable('legacy')).has(admin)).toBe(false);
  });

  dbIt('spares a seed row that has since been claimed by a real login (identity guard)', async () => {
    const claimed = await newUser({ is_seed: true });
    await sql.unsafe(
      `INSERT INTO public.user_identities (user_id, provider, subject)
       VALUES ($1,'google',$2)`,
      [claimed, `${TAG}_${claimed}`],
    );
    expect((await selectDeletable('legacy')).has(claimed)).toBe(false);
  });

  dbIt('spares a befriended seed', async () => {
    const seed = await newUser({ is_seed: true });
    const human = await newUser({});
    const [low, high] = [seed, human].sort();
    await sql.unsafe(
      `INSERT INTO public.friendships (user_low_id, user_high_id) VALUES ($1,$2)`,
      [low, high],
    );
    expect((await selectDeletable('legacy')).has(seed)).toBe(false);
  });

  dbIt('spares a seed with a recent pending friend request', async () => {
    const seed = await newUser({ is_seed: true });
    const human = await newUser({});
    await sql.unsafe(
      `INSERT INTO public.friend_requests (sender_user_id, receiver_user_id, status)
       VALUES ($1,$2,'pending')`,
      [human, seed],
    );
    expect((await selectDeletable('legacy')).has(seed)).toBe(false);
  });

  dbIt('spares a seed inside a human’s 10-most-recent matches (visibility guard)', async () => {
    // Deleting this one would blank a row the recent-matches endpoint can still
    // return: match_players CASCADEs, so the opponent renders empty rather than
    // 'Deleted Player' (that label needs a row that no longer exists).
    const seed = await newUser({ is_seed: true });
    const human = await newUser({});
    await playMatch(seed, human, 1);
    expect((await selectDeletable('legacy')).has(seed)).toBe(false);
  });

  dbIt('deletes a seed whose only match has aged out of the window', async () => {
    const seed = await newUser({ is_seed: true });
    const human = await newUser({});
    await playMatch(seed, human, 400);
    // Push the shared match past rank 10 for this human.
    for (let i = 0; i < RECENT_WINDOW; i++) {
      const other = await newUser({});
      await playMatch(human, other, i + 1);
    }
    expect((await selectDeletable('legacy')).has(seed)).toBe(true);
  });

  dbIt('spares a seed currently in a live match (mid-match guard)', async () => {
    const seed = await newUser({ is_seed: true });
    const human = await newUser({});
    const [m] = await sql.unsafe<{ id: string }[]>(
      `INSERT INTO public.matches (mode, status, is_dev, started_at, category_a_id, category_b_id)
       VALUES ('ranked','active',false,NOW(),$1,$1) RETURNING id`,
      [categoryId],
    );
    plantedMatches.push(m.id);
    for (const [i, uid] of [seed, human].entries()) {
      await sql.unsafe(
        `INSERT INTO public.match_players (match_id, user_id, seat, goals, penalty_goals) VALUES ($1,$2,$3,0,0)`,
        [m.id, uid, i + 1],
      );
    }
    expect((await selectDeletable('legacy')).has(seed)).toBe(false);
  });

  dbIt('spares a mis-flagged seed created OUTSIDE the legacy batch window', async () => {
    // The legacy scope must identify the known Feb-17..Mar-07 batch POSITIVELY.
    // If it were merely "not load-test", any future wrongly-flagged real
    // account would fall into it with only the role guard left to save it.
    const recent = await newUser({
      is_seed: true,
      email: `${TAG}_recent@gmail.com`,
      created_at: new Date().toISOString(),
    });
    expect((await selectDeletable('legacy')).has(recent)).toBe(false);
  });

  dbIt('spares a mis-flagged seed on a non-gmail domain', async () => {
    const odd = await newUser({
      is_seed: true,
      email: `${TAG}@outlook.com`,
      created_at: '2026-02-20T00:00:00Z',
    });
    expect((await selectDeletable('legacy')).has(odd)).toBe(false);
  });

  dbIt('keeps the two scopes disjoint — neither reaches the other population', async () => {
    const legacy = await newUser({ is_seed: true, email: `${TAG}_l@gmail.com` });
    const load = await newUser({ is_seed: true, email: `${TAG}_l@example.invalid` });

    const legacyPick = await selectDeletable('legacy');
    expect(legacyPick.has(legacy)).toBe(true);
    expect(legacyPick.has(load)).toBe(false);

    const loadPick = await selectDeletable('loadtest');
    expect(loadPick.has(load)).toBe(true);
    expect(loadPick.has(legacy)).toBe(false);
  });
});

describe('ephemeral drain guard', () => {
  dbIt('accepts a cleanup_ai_users() that carries the ai_kind allowlist', async () => {
    // The local DB has the post-20260727150000 function.
    await expect(assertDrainSafe(sql)).resolves.toBeUndefined();
  });

  dbIt('refuses a cleanup_ai_users() with no ai_kind allowlist', async () => {
    // This is prod's CURRENT state (verified read-only): the pre-ai_kind
    // function selects a bare `is_ai = true`, so draining there would delete
    // every aged AI — including persistent roster bots once PR1 ships.
    const original = (await sql.unsafe<{ src: string }[]>(
      `SELECT pg_get_functiondef(oid) AS src FROM pg_proc WHERE proname = 'cleanup_ai_users'`,
    ))[0].src;
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION cleanup_ai_users() RETURNS integer
      LANGUAGE plpgsql AS $fn$
      BEGIN
        -- deliberately allowlist-free, mirroring the version live on prod
        PERFORM 1 FROM public.users WHERE is_ai = true;
        RETURN 0;
      END;
      $fn$;
    `);
    try {
      await expect(assertDrainSafe(sql)).rejects.toThrow(/no ai_kind allowlist/i);
    } finally {
      await sql.unsafe(original);
    }
  });
});

describe('seed-cleanup batched delete', () => {
  dbIt('clears the two blocking FKs and removes only in-scope rows', async () => {
    const seed = await newUser({ is_seed: true });
    const real = await newUser({});

    // Both no-ON-DELETE FKs pointing at the victim: a won match and a hosted lobby.
    const matchId = await playMatch(seed, real, 500);
    await sql.unsafe(`UPDATE public.matches SET winner_user_id = $1 WHERE id = $2`, [seed, matchId]);
    await sql.unsafe(
      `INSERT INTO public.lobbies (mode, host_user_id, status, game_mode, is_public, display_name)
       VALUES ('ranked',$1,'closed','ranked_sim',false,$2)`,
      [seed, `${TAG}_lobby`],
    );
    // Age the shared match out of the human's window.
    for (let i = 0; i < RECENT_WINDOW; i++) {
      const other = await newUser({});
      await playMatch(real, other, i + 1);
    }

    // Restricted to this test's own fixtures: the shared local DB holds ~24k
    // real load-test seeds, and a test must never be the thing that deletes them.
    const deleted = await deleteScope(sql, 'legacy', {
      batchSize: 500,
      recentWindow: RECENT_WINDOW,
      restrictToIds: planted,
    });
    expect(deleted).toBe(1);

    const [gone] = await sql.unsafe<{ n: string }[]>(
      `SELECT count(*) AS n FROM public.users WHERE id = $1`, [seed],
    );
    expect(Number(gone.n)).toBe(0);

    // The historic match survives with an unknown winner, rather than vanishing.
    const [kept] = await sql.unsafe<{ n: string; winner: string | null }[]>(
      `SELECT count(*) AS n, max(winner_user_id::text) AS winner FROM public.matches WHERE id = $1`,
      [matchId],
    );
    expect(Number(kept.n)).toBe(1);
    expect(kept.winner).toBeNull();

    // The real user is untouched.
    const [survivor] = await sql.unsafe<{ n: string }[]>(
      `SELECT count(*) AS n FROM public.users WHERE id = $1`, [real],
    );
    expect(Number(survivor.n)).toBe(1);
  });
});

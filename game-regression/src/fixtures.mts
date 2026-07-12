/**
 * Fixture seeder for the local regression DB.
 *
 * A fresh local Supabase DB has 0 questions, so a real ranked match cannot start.
 * This seeds the minimum deterministic data the ranked-AI path needs:
 *   - N ranked-ELIGIBLE categories. Per RANKED_ELIGIBILITY_HAVING each needs
 *     >= 4 valid MCQs + >= 1 each of put_in_order / clue_chain,
 *     all `published`, with payloads shaped exactly as matches.service.ts expects.
 *     Countdown questions are still seeded for daily/special regression coverage,
 *     but possession matches no longer require them.
 *   - A test user with a ranked ticket (tickets/coins are columns on `users`).
 *
 * Fixed fixtures also PIN the engine's ORDER BY RANDOM() selection: with a known
 * small set, question/category choice is effectively deterministic for Slice 1.
 *
 * Imported by the harness; run via backend-node's tsx so module resolution +
 * the `postgres` dep are shared.
 */
// Reuse the engine's own sql client so the harness and the in-process match
// engine share the exact same DB connection (config.DATABASE_URL). This avoids a
// second `postgres` dependency in this folder and guarantees they hit one DB.
import { sql } from '../../src/db/index.js';
import { invalidateCategoryCache } from '../../src/modules/lobbies/lobbies.service.js';

/** Name(s) the harness is allowed to TRUNCATE. Override via REGRESSION_DB_NAME. */
const REGRESSION_DB_NAME = process.env.REGRESSION_DB_NAME ?? 'quizball_regression';

/**
 * HARD safety guard. clearFixtures() truncates match/lobby tables, so before ANY
 * destructive write we require the live connection to actually be the dedicated
 * regression database — NOT just "localhost". A misconfigured DATABASE_URL pointing
 * at a real (even local) DB must never be wiped. Throws if the name doesn't match.
 */
let dbVerified = false;
async function assertRegressionDatabase(): Promise<void> {
  if (dbVerified) return;
  const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  if (row?.db !== REGRESSION_DB_NAME) {
    throw new Error(
      `Refusing destructive harness write: connected DB is "${row?.db}", expected "${REGRESSION_DB_NAME}". ` +
        `Point DATABASE_URL at the regression DB (or set REGRESSION_DB_NAME).`,
    );
  }
  dbVerified = true;
}

// A fixed advisory-lock key so ANY concurrent harness process/worker serializes
// the clear+seed critical section. Without this, two workers truncating the same
// match/lobby tables deadlock, and the fixed category slugs collide on the unique
// index. We hold the lock across the whole reseed, then release.
const FIXTURE_LOCK_KEY = 728_113n; // arbitrary but stable

async function withFixtureLock<T>(fn: () => Promise<T>): Promise<T> {
  await sql`SELECT pg_advisory_lock(${FIXTURE_LOCK_KEY})`;
  try {
    return await fn();
  } finally {
    await sql`SELECT pg_advisory_unlock(${FIXTURE_LOCK_KEY})`;
  }
}

export interface SeedOptions {
  categoryCount?: number; // ranked-eligible categories to create (default 3)
  friendlyCategoryCount?: number; // NON-featured categories for the friendly/party pool (default 2)
  mcqPerCategory?: number; // MCQs per category (>= 3; default 5)
}

export interface SeededFixtures {
  categoryIds: string[];
  friendlyCategoryIds: string[];
  /** All seeded question ids by category, for the score planner to reference. */
  questionIdsByCategory: Record<string, string[]>;
}

export interface SeededAuctionFixtures {
  footballPlayerIds: string[];
  clueCardIds: string[];
  countByPosition: Record<'GK' | 'DEF' | 'MID' | 'FWD', number>;
}

const i18n = (en: string) => ({ en, ka: en });

function mcqPayload(seedLabel: string) {
  // 4 options, exactly one correct, unique string ids — satisfies MCQ_VALIDATION_CONDITIONS.
  const options = [0, 1, 2, 3].map((i) => ({
    id: `${seedLabel}-opt-${i}`,
    text: i18n(`Option ${i} (${seedLabel})`),
    is_correct: i === 0,
  }));
  return { type: 'mcq_single', options };
}

function countdownPayload(seedLabel: string) {
  return {
    type: 'countdown_list',
    prompt: i18n(`Name items (${seedLabel})`),
    answer_groups: [
      { id: `${seedLabel}-g1`, display: i18n('Item One'), accepted_answers: ['one', 'item one'] },
      { id: `${seedLabel}-g2`, display: i18n('Item Two'), accepted_answers: ['two', 'item two'] },
      { id: `${seedLabel}-g3`, display: i18n('Item Three'), accepted_answers: ['three', 'item three'] },
    ],
  };
}

function putInOrderPayload(seedLabel: string) {
  return {
    type: 'put_in_order',
    prompt: i18n(`Order these (${seedLabel})`),
    direction: 'asc',
    items: [
      { id: `${seedLabel}-i1`, label: i18n('First'), sort_value: 1 },
      { id: `${seedLabel}-i2`, label: i18n('Second'), sort_value: 2 },
      { id: `${seedLabel}-i3`, label: i18n('Third'), sort_value: 3 },
    ],
  };
}

function clueChainPayload(seedLabel: string) {
  return {
    type: 'clue_chain',
    prompt: i18n(`Guess (${seedLabel})`),
    clues: [
      { type: 'text', content: i18n('Clue one') },
      { type: 'text', content: i18n('Clue two') },
      { type: 'text', content: i18n('Clue three') },
    ],
    accepted_answers: ['answer', `${seedLabel}-answer`],
    display_answer: i18n('The Answer'),
  };
}

/**
 * Reset the transient game state on the LOCAL harness DB so each run starts clean.
 * Categories are referenced by a web of tables (lobbies, lobby_categories,
 * lobby_category_bans, matches, match_questions, …), so we clear children first,
 * then the regression categories/questions. This is destructive — it wipes ALL
 * match/lobby rows — which is correct for an isolated local test DB.
 */
export async function clearFixtures(): Promise<void> {
  await assertRegressionDatabase(); // never truncate a non-regression DB
  // Children of matches.
  await sql`TRUNCATE
    match_answers, match_goal_events, match_players, match_questions,
    ranked_rp_changes
    RESTART IDENTITY CASCADE`;
  // Matches + lobbies + their category links.
  await sql`TRUNCATE
    matches, lobby_categories, lobby_category_bans, lobby_members,
    lobby_challenge_invitations, lobbies
    RESTART IDENTITY CASCADE`;
  // Regression-seeded questions/categories (payloads cascade from questions).
  await sql`DELETE FROM question_payloads WHERE question_id IN (
    SELECT q.id FROM questions q JOIN categories c ON c.id = q.category_id
    WHERE c.slug LIKE 'regression-%'
  )`;
  await sql`DELETE FROM questions WHERE category_id IN (
    SELECT id FROM categories WHERE slug LIKE 'regression-%'
  )`;
  await sql`DELETE FROM featured_categories WHERE category_id IN (
    SELECT id FROM categories WHERE slug LIKE 'regression-%'
  )`;
  await sql`DELETE FROM categories WHERE slug LIKE 'regression-%'`;
}

const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;

export async function seedFixtures(options: SeedOptions = {}): Promise<SeededFixtures> {
  const categoryCount = options.categoryCount ?? 3;
  // The friendly/party pool is NON-featured categories only
  // (listAllValidCategories excludes featured_categories), so without these the
  // friendly boot fails with INSUFFICIENT_CATEGORIES.
  const friendlyCategoryCount = options.friendlyCategoryCount ?? 2;
  // A full possession match consumes ~10 normal MCQs (2 halves) and the engine
  // prefers a difficulty per round (easy early, harder later) with no repeats —
  // so seed a generous pool PER difficulty, not just 5 medium ones, or the match
  // runs out of valid candidates mid-game and stalls.
  const mcqPerDifficulty = Math.max(4, options.mcqPerCategory ?? 8);

  const result: SeededFixtures = { categoryIds: [], friendlyCategoryIds: [], questionIdsByCategory: {} };

  // Serialize the whole clear+seed against any concurrent harness worker — the
  // truncates would deadlock and the fixed category slugs would collide otherwise.
  await withFixtureLock(async () => {
    await clearFixtures();
    for (let c = 0; c < categoryCount + friendlyCategoryCount; c++) {
      const isFriendly = c >= categoryCount;
      const label = isFriendly ? `friendly${c - categoryCount}` : `cat${c}`;
      const [category] = await sql<{ id: string }[]>`
        INSERT INTO categories (id, slug, name, icon, image_url, is_active)
        VALUES (gen_random_uuid(), ${`regression-${label}-${c}`},
                ${sql.json(i18n(`Regression Category ${c}`))}, '⚽', null, true)
        RETURNING id
      `;
      // The ranked draft pool is FEATURED categories only (featured_categories
      // join in listAllRankedEligibleCategories) — un-featured fixtures would
      // leave the ranked harness with an empty pool. Friendly/party pool is the
      // inverse (non-featured only), so friendly fixtures skip the insert.
      // clearFixtures() already deletes these rows symmetrically.
      if (!isFriendly) {
        await sql`
          INSERT INTO featured_categories (category_id)
          VALUES (${category.id})
          ON CONFLICT (category_id) DO NOTHING
        `;
      }
      (isFriendly ? result.friendlyCategoryIds : result.categoryIds).push(category.id);
      result.questionIdsByCategory[category.id] = [];

      // Build the per-type question list: a generous MCQ pool across all three
      // difficulties + a few of each special type per difficulty.
      const specs: Array<{ type: string; difficulty: string; payload: () => unknown }> = [];
      for (const difficulty of DIFFICULTIES) {
        for (let m = 0; m < mcqPerDifficulty; m++) {
          specs.push({ type: 'mcq_single', difficulty, payload: () => mcqPayload(`${label}-mcq-${difficulty}-${m}`) });
        }
        // 2 of each special kind per difficulty so specials don't run dry either.
        for (let s = 0; s < 2; s++) {
          specs.push({ type: 'countdown_list', difficulty, payload: () => countdownPayload(`${label}-cd-${difficulty}-${s}`) });
          specs.push({ type: 'put_in_order', difficulty, payload: () => putInOrderPayload(`${label}-pio-${difficulty}-${s}`) });
          specs.push({ type: 'clue_chain', difficulty, payload: () => clueChainPayload(`${label}-cc-${difficulty}-${s}`) });
        }
      }

      for (const spec of specs) {
        const [question] = await sql<{ id: string }[]>`
          INSERT INTO questions (id, category_id, type, difficulty, status, prompt)
          VALUES (gen_random_uuid(), ${category.id}, ${spec.type}, ${spec.difficulty}, 'published',
                  ${sql.json(i18n('Question prompt'))})
          RETURNING id
        `;
        await sql`
          INSERT INTO question_payloads (id, question_id, payload)
          VALUES (gen_random_uuid(), ${question.id}, ${sql.json(spec.payload() as object)})
        `;
        result.questionIdsByCategory[category.id].push(question.id);
      }
    }

    // CRITICAL across matches in one process: lobbiesService caches the valid/
    // ranked category list for 5 minutes. After re-seeding (which DELETED the
    // previous match's categories), the cache would still hand out stale (now
    // deleted) category IDs, and the next match's draft would fail with an FK
    // violation (lobby_categories_category_id_fkey). Invalidate it here.
    invalidateCategoryCache();
  });

  return result;
}

/**
 * Seed (or RESET) a test user to a known wallet/user baseline. Critical: the
 * ranked ticket preflight goes through storeService.getWallet, which hydrates
 * tickets from `tickets_refill_started_at`. So a per-scenario reset must clear
 * that anchor (and other state) — not just bump `tickets` — or refill logic can
 * mutate the ticket count between scenarios. Returns the user id.
 */
export async function seedTestUserWithTicket(
  opts: { userId: string; nickname?: string; tickets?: number; coins?: number },
): Promise<string> {
  await assertRegressionDatabase(); // never write a test user into a non-regression DB
  const tickets = opts.tickets ?? 1;
  const coins = opts.coins ?? 100;
  await sql`
    INSERT INTO users (
      id, nickname, onboarding_complete, is_ai, tickets, coins,
      tickets_refill_started_at, is_deleted, deleted_at, pending_deletion_at
    )
    VALUES (
      ${opts.userId}, ${opts.nickname ?? 'RegressionBot'}, true, false, ${tickets}, ${coins},
      NULL, false, NULL, NULL
    )
    ON CONFLICT (id) DO UPDATE SET
      nickname = EXCLUDED.nickname,
      onboarding_complete = true,
      is_ai = false,
      tickets = EXCLUDED.tickets,
      coins = EXCLUDED.coins,
      tickets_refill_started_at = NULL,
      is_deleted = false,
      deleted_at = NULL,
      pending_deletion_at = NULL,
      updated_at = NOW()
  `;
  return opts.userId;
}

const AUCTION_POSITIONS = ['GK', 'DEF', 'MID', 'FWD'] as const;
const AUCTION_FIXTURE_PROMPT_VERSION = 'regression-auction-v1';
const AUCTION_FIXTURE_TRANSFERMARKT_START = 9_100_000;

function auctionFixtureCounts(): Record<'GK' | 'DEF' | 'MID' | 'FWD', number> {
  return {
    GK: 12,
    DEF: 24,
    MID: 24,
    FWD: 24,
  };
}

function auctionValue(position: 'GK' | 'DEF' | 'MID' | 'FWD', index: number): number {
  const base = {
    GK: 25_000_000,
    DEF: 35_000_000,
    MID: 45_000_000,
    FWD: 55_000_000,
  }[position];
  return base + index * 1_000_000;
}

async function clearAuctionFixtures(): Promise<void> {
  await assertRegressionDatabase();
  await sql`
    DELETE FROM player_clue_cards
    WHERE prompt_version = ${AUCTION_FIXTURE_PROMPT_VERSION}
  `;
  await sql`
    DELETE FROM football_players
    WHERE transfermarkt_id LIKE 'regression-auction-%'
  `;
}

export async function seedAuctionFixtures(): Promise<SeededAuctionFixtures> {
  const result: SeededAuctionFixtures = {
    footballPlayerIds: [],
    clueCardIds: [],
    countByPosition: {
      GK: 0,
      DEF: 0,
      MID: 0,
      FWD: 0,
    },
  };

  await withFixtureLock(async () => {
    await clearAuctionFixtures();

    let ordinal = 0;
    const counts = auctionFixtureCounts();
    for (const position of AUCTION_POSITIONS) {
      for (let index = 0; index < counts[position]; index++) {
        const transfermarktNumber = AUCTION_FIXTURE_TRANSFERMARKT_START + ordinal;
        const transfermarktId = `regression-auction-${transfermarktNumber}`;
        const name = `Regression ${position} Player ${index + 1}`;
        const value = auctionValue(position, index);
        const [player] = await sql<{ id: string }[]>`
          INSERT INTO football_players (
            id,
            transfermarkt_id,
            name,
            display_name,
            nationality,
            position_group,
            current_club,
            active_status,
            image_url,
            current_value_eur,
            peak_value_eur,
            fame_bucket,
            data_quality_status,
            source_payload
          )
          VALUES (
            gen_random_uuid(),
            ${transfermarktId},
            ${name},
            ${sql.json({ en: name })},
            'Regressionland',
            ${position},
            ${`Regression ${position} FC`},
            'active',
            ${`https://images.quizball.local/regression-auction/${position.toLowerCase()}-${index + 1}.jpg`},
            ${value},
            ${value + 5_000_000},
            'known',
            'usable',
            ${sql.json({ source: 'regression_harness', position, index })}
          )
          RETURNING id
        `;

        const [card] = await sql<{ id: string }[]>`
          INSERT INTO player_clue_cards (
            id,
            football_player_id,
            transfermarkt_id,
            locale,
            clue_1,
            clue_2,
            clue_3,
            difficulty,
            status,
            source,
            generation_provider,
            generation_model,
            prompt_version,
            evidence,
            source_payload,
            review_notes
          )
          VALUES (
            gen_random_uuid(),
            ${player.id},
            ${transfermarktNumber},
            'en',
            ${`This ${position} fixture has regression clue one ${index + 1}.`},
            ${`This ${position} fixture has regression clue two ${index + 1}.`},
            ${`This ${position} fixture has regression clue three ${index + 1}.`},
            'easy',
            'published',
            'manual',
            'regression-harness',
            'fixture',
            ${AUCTION_FIXTURE_PROMPT_VERSION},
            ${sql.json({ source: 'regression_harness', evidence: [] })},
            ${sql.json({ source: 'regression_harness', position, index })},
            'Seeded by local Auction regression harness.'
          )
          RETURNING id
        `;

        result.footballPlayerIds.push(player.id);
        result.clueCardIds.push(card.id);
        result.countByPosition[position] += 1;
        ordinal += 1;
      }
    }
  });

  return result;
}

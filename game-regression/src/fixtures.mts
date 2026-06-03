/**
 * Fixture seeder for the local regression DB.
 *
 * A fresh local Supabase DB has 0 questions, so a real ranked match cannot start.
 * This seeds the minimum deterministic data the ranked-AI path needs:
 *   - N ranked-ELIGIBLE categories. Per RANKED_ELIGIBILITY_HAVING each needs
 *     >= 3 valid MCQs + >= 1 each of countdown_list / put_in_order / clue_chain,
 *     all `published`, with payloads shaped exactly as matches.service.ts expects.
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

export interface SeedOptions {
  categoryCount?: number; // ranked-eligible categories to create (default 3)
  mcqPerCategory?: number; // MCQs per category (>= 3; default 5)
}

export interface SeededFixtures {
  categoryIds: string[];
  /** All seeded question ids by category, for the score planner to reference. */
  questionIdsByCategory: Record<string, string[]>;
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

/** Remove previously-seeded regression fixtures so re-runs don't collide on slug. */
export async function clearFixtures(): Promise<void> {
  // questions + payloads cascade from categories via FK; delete the regression
  // categories (identified by slug prefix) and their dependents.
  await sql`DELETE FROM question_payloads WHERE question_id IN (
    SELECT q.id FROM questions q JOIN categories c ON c.id = q.category_id
    WHERE c.slug LIKE 'regression-%'
  )`;
  await sql`DELETE FROM questions WHERE category_id IN (
    SELECT id FROM categories WHERE slug LIKE 'regression-%'
  )`;
  await sql`DELETE FROM categories WHERE slug LIKE 'regression-%'`;
}

export async function seedFixtures(options: SeedOptions = {}): Promise<SeededFixtures> {
  const categoryCount = options.categoryCount ?? 3;
  const mcqPerCategory = Math.max(3, options.mcqPerCategory ?? 5);

  await clearFixtures();

  const result: SeededFixtures = { categoryIds: [], questionIdsByCategory: {} };

  {
    for (let c = 0; c < categoryCount; c++) {
      const label = `cat${c}`;
      const [category] = await sql<{ id: string }[]>`
        INSERT INTO categories (id, slug, name, icon, image_url, is_active)
        VALUES (gen_random_uuid(), ${`regression-${label}-${c}`},
                ${sql.json(i18n(`Regression Category ${c}`))}, '⚽', null, true)
        RETURNING id
      `;
      result.categoryIds.push(category.id);
      result.questionIdsByCategory[category.id] = [];

      // Build the per-type question list: M MCQs + 1 each special type.
      const specs: Array<{ type: string; payload: () => unknown }> = [];
      for (let m = 0; m < mcqPerCategory; m++) {
        specs.push({ type: 'mcq_single', payload: () => mcqPayload(`${label}-mcq${m}`) });
      }
      specs.push({ type: 'countdown_list', payload: () => countdownPayload(`${label}-cd`) });
      specs.push({ type: 'put_in_order', payload: () => putInOrderPayload(`${label}-pio`) });
      specs.push({ type: 'clue_chain', payload: () => clueChainPayload(`${label}-cc`) });

      for (const spec of specs) {
        const [question] = await sql<{ id: string }[]>`
          INSERT INTO questions (id, category_id, type, difficulty, status, prompt)
          VALUES (gen_random_uuid(), ${category.id}, ${spec.type}, 'medium', 'published',
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

    return result;
  }
}

/** Seed (or reset) a test user with a ranked ticket. Returns the user id. */
export async function seedTestUserWithTicket(
  opts: { userId: string; nickname?: string; tickets?: number },
): Promise<string> {
  await sql`
    INSERT INTO users (id, nickname, onboarding_complete, is_ai, tickets, coins)
    VALUES (${opts.userId}, ${opts.nickname ?? 'RegressionBot'}, true, false,
            ${opts.tickets ?? 1}, 100)
    ON CONFLICT (id) DO UPDATE SET tickets = ${opts.tickets ?? 1}
  `;
  return opts.userId;
}

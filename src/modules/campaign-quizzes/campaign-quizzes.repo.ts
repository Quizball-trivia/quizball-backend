import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  AdminCampaignQuizManualQuestion,
  AdminCampaignQuizListQuery,
  AdminCampaignQuizPageBody,
  AdminCampaignQuizRetireBody,
  CampaignQuizAboutBlock,
} from './campaign-quizzes.schemas.js';
import { ConflictError, ValidationError } from '../../core/errors.js';
import {
  CAMPAIGN_QUIZ_LOCALES,
  EDITION_LOCALES,
  EDITION_TEXT_FIELDS,
  FULL_COPY_LOCALES,
  editionColumns,
  type CampaignLocale,
  type EditionLocale,
  type EditionTextField,
} from './campaign-quizzes.editions.js';
import { existingOptionText, withKeptTranslations } from './campaign-quizzes.questions.js';

const RELATED_EDITION_FIELDS = ['breadcrumb_label', 'hero_image_alt'] as const;
const HUB_EDITION_FIELDS = ['h1', 'breadcrumb_label', 'hero_image_alt', 'seo_title', 'meta_description'] as const;
/** The catalog judges full-copy editions, so it reads their whole copy and the English it answers to. */
const HUB_COLUMNS = [...new Set([
  'slug', 'page_category', 'locale_mode', 'updated_at', 'content_modified_at', 'hub_order', 'is_hub_pinned', 'hero_image_url',
  ...EDITION_TEXT_FIELDS, 'about_blocks',
  ...editionColumns(HUB_EDITION_FIELDS),
  ...FULL_COPY_LOCALES.flatMap((locale) => [...EDITION_TEXT_FIELDS, 'about_blocks'].map((field) => `${locale}_${field}`)),
])];

type EditionTextColumns<Field extends string> = { [Column in `${EditionLocale}_${Field}`]: string | null };

export interface CampaignQuizRow extends
  EditionTextColumns<EditionTextField>,
  Record<`${EditionLocale}_about_blocks`, CampaignQuizAboutBlock[] | null> {
  slug: string;
  title: string;
  internal_name: string;
  page_category: 'team' | 'league' | 'quiz_type' | 'article';
  status: 'draft' | 'preview' | 'published' | 'archived';
  question_source: 'existing' | 'manual';
  question_set_slug: string;
  h1: string;
  lede: string | null;
  about_heading: string | null;
  about_blocks: CampaignQuizAboutBlock[];
  score_cta: string | null;
  footer_banner_text: string | null;
  footer_button_label: string;
  hero_image_url: string | null;
  hero_image_alt: string | null;
  seo_title: string;
  meta_description: string | null;
  og_image_url: string | null;
  og_image_alt: string | null;
  breadcrumb_label: string;
  locale_mode: 'en_only' | 'en_ka';
  scheduled_publish_at: string | null;
  published_at: string | null;
  unpublished_at: string | null;
  preview_token: string;
  hub_order: number;
  is_hub_pinned: boolean;
  created_at: string;
  updated_at: string;
  version: number;
  content_modified_at: string | null;
  last_reviewed_at: string | null;
  next_refresh_at: string | null;
  agent_locked: boolean;
  managed_by: 'cms' | 'agent';
}

export interface CampaignQuizQuestionRow {
  id: string;
  display_order: number;
  difficulty: 'easy' | 'medium' | 'hard';
  prompt: unknown;
  explanation: unknown;
  payload: unknown;
}

export interface CampaignQuizRatingRow {
  average: number | string | null;
  count: number;
}

export interface CampaignQuizRelatedRow extends EditionTextColumns<(typeof RELATED_EDITION_FIELDS)[number]> {
  slug: string;
  breadcrumb_label: string;
  hero_image_url: string | null;
  hero_image_alt: string | null;
}

export type CampaignQuizHubRow = Partial<CampaignQuizRow> & EditionTextColumns<(typeof HUB_EDITION_FIELDS)[number]> & Pick<
  CampaignQuizRow,
  'slug' | 'page_category' | 'h1' | 'breadcrumb_label' | 'hero_image_url' | 'hero_image_alt' | 'locale_mode' | 'updated_at' | 'hub_order' | 'is_hub_pinned' | 'content_modified_at'
>;

/** One question of a set version: the ids and their place in the set at that version. */
export interface CampaignQuizSetEntry {
  question_id: string;
  difficulty: 'easy' | 'medium' | 'hard';
  display_order: number;
}

export interface CampaignQuizSetVersionRow {
  version: number;
  questions: CampaignQuizSetEntry[];
  created_at: string;
  superseded_at: string | null;
}

export interface CampaignQuizSlugRow {
  quiz_slug: string;
  locale: CampaignLocale;
  public_slug: string;
}

/** Everything an edition write may set on the page row besides the English fields the CMS form already writes. */
export type CampaignQuizEditionColumns = Partial<Record<`${EditionLocale}_${EditionTextField}`, string | null>>
  & Partial<Record<`${EditionLocale}_about_blocks`, CampaignQuizAboutBlock[] | null>>;

export interface CampaignQuizAgentCommitInput {
  idempotencyKey: string;
  action: 'create' | 'refresh';
  slug: string;
  expectedVersion: number | null;
  internalName: string;
  category: 'team' | 'league' | 'quiz_type';
  english: Record<EditionTextField, string | null> & { about_blocks: CampaignQuizAboutBlock[] };
  editions: CampaignQuizEditionColumns;
  heroImageUrl: string;
  ogImageUrl: string | null;
  publicSlugs: Record<CampaignLocale, string>;
  questions: Array<{ id: string; difficulty: 'easy' | 'medium' | 'hard' }>;
  relatedSlugs: string[] | null;
  nextRefreshAt: string;
  userId: string;
  revisionSnapshot: (pageVersionBefore: number | null) => Json;
  requestHash: string;
  claim?: { backlogId: string; leaseToken: string };
  /** Rechecks the questions as read inside the transaction (locked): returns what keeps the page from going live. */
  verify: (rows: CampaignQuizQuestionRow[]) => string[];
}

/** What a CMS save writes besides the English form: other languages, URLs, the owner lock, the restored set. */
export interface CampaignQuizAdminWriteOptions {
  editions?: CampaignQuizEditionColumns;
  publicSlugs?: Partial<Record<CampaignLocale, string>>;
  agentLocked?: boolean;
  expectedVersion?: number;
  questions?: Array<{ id: string; difficulty: 'easy' | 'medium' | 'hard' }>;
}

export type CampaignQuizAgentWriteResult =
  | { kind: 'committed'; version: number }
  | { kind: 'replayed'; slug: string; action: string; version: number | null };

/** A question of a published page's set, with the page it belongs to (the hub checks question coverage). */
export interface CampaignQuizPageQuestionRow extends CampaignQuizQuestionRow {
  page_slug: string;
}

export interface AdminCampaignQuizRevisionRow {
  id: number;
  revision_number: number;
  action: 'created' | 'saved' | 'previewed' | 'published' | 'scheduled' | 'unpublished' | 'restored';
  snapshot: unknown;
  created_at: string;
  created_by: string | null;
  editor_name: string | null;
}

export interface CampaignQuizRouteRow {
  status_code: 301 | 410;
  target_slug: string | null;
}

export interface AdminCampaignQuizListRow extends CampaignQuizRow {
  question_count: number;
}

export interface AdminCampaignQuizQuestionSetRow {
  slug: string;
  name: string;
  count: number;
  easy: number;
  medium: number;
  hard: number;
  public_only: boolean;
}

export interface CampaignQuizQuestionSetHealthRow {
  count: number;
  public_only_count: number;
}

export interface AdminCampaignQuizManualQuestionRow {
  id: string;
  prompt: unknown;
  explanation: unknown;
  payload: unknown;
  difficulty: 'easy' | 'medium' | 'hard';
}

function publicWindowSql() {
  return sql`
    status = 'published'
    AND COALESCE(scheduled_publish_at, published_at, '-infinity'::timestamptz) <= NOW()
  `;
}

async function replaceRelatedPages(
  tx: typeof sql,
  slug: string,
  relatedSlugs: string[],
): Promise<void> {
  const current = (await tx<{ related_slug: string }[]>`
    SELECT related_slug FROM campaign_quiz_related_pages WHERE quiz_slug = ${slug} ORDER BY display_order
  `).map((row) => row.related_slug);
  if (current.length === relatedSlugs.length && current.every((related, index) => related === relatedSlugs[index])) return;
  // The related quizzes are part of what the page shows.
  await tx`UPDATE campaign_quizzes SET content_modified_at = NOW() WHERE slug = ${slug}`;
  await tx`DELETE FROM campaign_quiz_related_pages WHERE quiz_slug = ${slug}`;
  for (const [index, relatedSlug] of relatedSlugs.entries()) {
    await tx`
      INSERT INTO campaign_quiz_related_pages (quiz_slug, related_slug, display_order)
      VALUES (${slug}, ${relatedSlug}, ${index + 1})
    `;
  }
}

async function clearOwnedManualQuestions(tx: typeof sql, slug: string): Promise<void> {
  const ownedCategories = await tx<{ category_id: string }[]>`
    SELECT DISTINCT question.category_id
    FROM campaign_quiz_manual_questions managed
    JOIN questions question ON question.id = managed.question_id
    WHERE managed.quiz_slug = ${slug}
  `;
  if (ownedCategories.length === 0) return;

  await tx`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`;

  await tx`DELETE FROM campaign_quiz_questions WHERE quiz_slug = ${slug}`;
  await tx`
    DELETE FROM questions
    WHERE id IN (
      SELECT question_id
      FROM campaign_quiz_manual_questions
      WHERE quiz_slug = ${slug}
    )
  `;
  await tx`
    UPDATE categories category
    SET is_active = FALSE, updated_at = NOW()
    WHERE category.id = ANY(${sql.array(ownedCategories.map((row) => row.category_id))}::uuid[])
      AND NOT EXISTS (
        SELECT 1 FROM questions question WHERE question.category_id = category.id
      )
  `;
}

async function replaceManualQuestions(
  tx: typeof sql,
  slug: string,
  internalName: string,
  questions: AdminCampaignQuizManualQuestion[],
  userId: string,
): Promise<void> {
  // A database trigger protects CMS-owned questions from the general Questions
  // and Categories tools. This transaction-scoped flag is the only authorised
  // path for changing that content.
  await tx`SELECT set_config('quizball.campaign_quiz_write', 'on', true)`;

  const existingRows = await tx<{
    id: string;
    prompt: string;
    prompt_texts: unknown;
    explanation: unknown;
    payload: unknown;
  }[]>`
    SELECT
      question.id,
      COALESCE(question.prompt->>'en', '') AS prompt,
      question.prompt AS prompt_texts,
      question.explanation,
      payload.payload
    FROM campaign_quiz_manual_questions managed
    JOIN questions question ON question.id = managed.question_id
    JOIN campaign_quiz_questions assignment
      ON assignment.quiz_slug = managed.quiz_slug
     AND assignment.question_id = managed.question_id
    LEFT JOIN question_payloads payload ON payload.question_id = question.id
    WHERE managed.quiz_slug = ${slug}
    ORDER BY assignment.display_order
  `;
  const existingById = new Map(existingRows.map((row) => [row.id, row]));
  const existingIds = new Set(existingById.keys());
  const idsByPrompt = new Map<string, string[]>();
  for (const row of existingRows) {
    const prompt = row.prompt.trim().toLocaleLowerCase('en');
    idsByPrompt.set(prompt, [...(idsByPrompt.get(prompt) ?? []), row.id]);
  }
  const existingIdByPrompt = new Map(
    [...idsByPrompt.entries()]
      .filter(([, ids]) => ids.length === 1)
      .map(([prompt, ids]) => [prompt, ids[0]]),
  );
  const claimedExistingIds = new Set(
    questions.flatMap((question) => {
      const promptId = existingIdByPrompt.get(
        question.prompt.trim().toLocaleLowerCase('en'),
      );
      return [question.id, promptId].filter((id): id is string => Boolean(id));
    }),
  );

  await tx`DELETE FROM campaign_quiz_questions WHERE quiz_slug = ${slug}`;

  await tx`
    INSERT INTO categories (slug, name, is_active, campaign_only)
    VALUES (${slug}, ${sql.json({ en: internalName })}, FALSE, TRUE)
    ON CONFLICT (slug) DO UPDATE
    SET is_active = CASE
      WHEN NOT EXISTS (
        SELECT 1 FROM questions ranked_question
        WHERE ranked_question.category_id = categories.id
          AND ranked_question.status = 'published'
          AND ranked_question.visibility = 'public'
          AND ranked_question.ranked_eligible = TRUE
      ) THEN FALSE ELSE categories.is_active END, updated_at = NOW()
  `;
  const [category] = await tx<{ id: string }[]>`
    SELECT id FROM categories WHERE slug = ${slug} LIMIT 1
  `;
  if (!category) throw new Error('Could not create the manual question category');

  const optionIds = ['a', 'b', 'c', 'd'] as const;
  const retainedIds = new Set<string>();
  for (const [index, question] of questions.entries()) {
    const normalizedPrompt = question.prompt.trim().toLocaleLowerCase('en');
    const positionId = existingRows[index]?.id;
    const existingId = question.id
      ?? existingIdByPrompt.get(normalizedPrompt)
      ?? (positionId && !claimedExistingIds.has(positionId) ? positionId : null);
    if (existingId && !existingIds.has(existingId)) {
      throw new Error('A manual question ID does not belong to this quiz');
    }
    if (existingId && retainedIds.has(existingId)) {
      throw new Error('A manual question cannot be used twice in the same quiz');
    }

    const existing = existingId ? existingById.get(existingId) : undefined;
    const prompt = sql.json(withKeptTranslations(existing?.prompt_texts, question.prompt));
    const explanation = question.explanation
      ? sql.json(withKeptTranslations(existing?.explanation, question.explanation))
      : null;
    const [saved] = existingId
      ? await tx<{ id: string }[]>`
          UPDATE questions
          SET
            category_id = ${category.id},
            type = 'mcq_single',
            difficulty = ${question.difficulty},
            status = 'published',
            prompt = ${prompt},
            explanation = ${explanation},
            ranked_eligible = FALSE,
            visibility = 'public',
            updated_at = NOW()
          WHERE id = ${existingId}
          RETURNING id
        `
      : await tx<{ id: string }[]>`
          INSERT INTO questions (
            category_id, type, difficulty, status, prompt, explanation,
            created_by, ranked_eligible, visibility
          ) VALUES (
            ${category.id}, 'mcq_single', ${question.difficulty}, 'published',
            ${prompt},
            ${explanation},
            ${userId}, FALSE, 'public'
          )
          RETURNING id
        `;
    if (!saved) throw new Error('Could not save a manual campaign question');
    retainedIds.add(saved.id);

    const payload = {
      type: 'mcq_single',
      options: question.options.map((text, optionIndex) => ({
        id: optionIds[optionIndex],
        text: withKeptTranslations(existingOptionText(existing?.payload, optionIds[optionIndex]), text),
        is_correct: optionIds[optionIndex] === question.correct_option,
      })),
    };
    await tx`
      INSERT INTO question_payloads (question_id, payload)
      VALUES (${saved.id}, ${sql.json(payload)})
      ON CONFLICT (question_id) DO UPDATE
      SET payload = EXCLUDED.payload, updated_at = NOW()
    `;
    await tx`
      INSERT INTO campaign_quiz_questions (
        quiz_slug, question_id, difficulty, display_order
      ) VALUES (
        ${slug}, ${saved.id}, ${question.difficulty}, ${index + 1}
      )
    `;
    await tx`
      INSERT INTO campaign_quiz_manual_questions (question_id, quiz_slug)
      VALUES (${saved.id}, ${slug})
      ON CONFLICT (question_id) DO NOTHING
    `;
  }

  const removedIds = existingRows
    .map((row) => row.id)
    .filter((id) => !retainedIds.has(id));
  if (removedIds.length > 0) {
    await tx`
      DELETE FROM questions
      WHERE id = ANY(${sql.array(removedIds)}::uuid[])
    `;
  }
}

function pageValues(input: AdminCampaignQuizPageBody) {
  return {
    ...input,
    aboutBlocks: sql.json(input.about_blocks as unknown as Json),
  };
}

/** Every edition column, with null for a language or field the input leaves out (a write replaces the language). */
type ColumnValue = string | null | ReturnType<typeof sql.json>;

export function editionColumnValues(editions: CampaignQuizEditionColumns): Record<string, ColumnValue> {
  const values: Record<string, ColumnValue> = {};
  for (const locale of EDITION_LOCALES) {
    for (const field of EDITION_TEXT_FIELDS) {
      const key = `${locale}_${field}` as const;
      if (key in editions) values[key] = editions[key] ?? null;
    }
    const blocks = `${locale}_about_blocks` as const;
    if (blocks in editions) values[blocks] = editions[blocks] ? sql.json(editions[blocks] as unknown as Json) : null;
  }
  return values;
}

async function writeEditionColumns(tx: typeof sql, slug: string, editions: CampaignQuizEditionColumns): Promise<void> {
  const values = editionColumnValues(editions);
  const columns = Object.keys(values);
  if (columns.length === 0) return;
  await tx`UPDATE campaign_quizzes SET ${sql(values, columns)} WHERE slug = ${slug}`;
}

/** The slugs other pages already answer to in `locale`: their public slugs, their source slugs and retired routes. */
async function publicSlugConflicts(
  tx: typeof sql,
  slug: string,
  publicSlugs: Partial<Record<CampaignLocale, string>>,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const [locale, publicSlug] of Object.entries(publicSlugs)) {
    if (!publicSlug) continue;
    const [row] = await tx<{ taken: boolean }[]>`
      SELECT (
        EXISTS (SELECT 1 FROM campaign_quiz_slugs WHERE locale = ${locale} AND public_slug = ${publicSlug} AND quiz_slug <> ${slug})
        OR EXISTS (SELECT 1 FROM campaign_quizzes WHERE slug = ${publicSlug} AND slug <> ${slug})
        OR EXISTS (SELECT 1 FROM campaign_quiz_routes WHERE old_slug = ${publicSlug} AND old_slug <> ${slug})
      ) AS taken
    `;
    if (row?.taken) conflicts.push(`${locale}:${publicSlug}`);
  }
  return conflicts;
}

/** Sets the page's slugs; a language that already has a public slug keeps it unless `allowChange` (unpublished pages). */
async function writePublicSlugs(
  tx: typeof sql,
  slug: string,
  publicSlugs: Partial<Record<CampaignLocale, string>>,
  allowChange: boolean,
): Promise<void> {
  const existing = new Map((await tx<CampaignQuizSlugRow[]>`
    SELECT quiz_slug, locale, public_slug FROM campaign_quiz_slugs WHERE quiz_slug = ${slug}
  `).map((row) => [row.locale, row.public_slug]));
  const changed = Object.entries(publicSlugs).filter(([locale, value]) => value && existing.get(locale as CampaignLocale) !== value);
  if (changed.length === 0) return;
  if (changed.some(([locale, value]) => (locale === 'en' || locale === 'ka') && value !== slug)) {
    throw new ConflictError('English and Georgian use the page slug', { reason: 'shared_folder' });
  }
  if (!allowChange && changed.some(([locale]) => existing.has(locale as CampaignLocale))) {
    throw new ConflictError('A published page keeps its public URLs', { changed: changed.map(([locale]) => locale) });
  }
  const conflicts = await publicSlugConflicts(tx, slug, Object.fromEntries(changed));
  if (conflicts.length > 0) throw new ConflictError('Another page already uses this URL', { conflicts });
  for (const [locale, publicSlug] of changed) {
    await tx`
      INSERT INTO campaign_quiz_slugs (quiz_slug, locale, public_slug)
      VALUES (${slug}, ${locale}, ${publicSlug!})
      ON CONFLICT (quiz_slug, locale) DO UPDATE SET public_slug = EXCLUDED.public_slug
    `;
  }
}

/** A new page answers to its source slug in every language it has no public slug for, as the web did before. */
async function fillDefaultSlugs(tx: typeof sql, slug: string): Promise<void> {
  const present = new Set((await tx<{ locale: CampaignLocale }[]>`
    SELECT locale FROM campaign_quiz_slugs WHERE quiz_slug = ${slug}
  `).map((row) => row.locale));
  for (const locale of CAMPAIGN_QUIZ_LOCALES.filter((code) => !present.has(code))) {
    const conflicts = await publicSlugConflicts(tx, slug, { [locale]: slug });
    if (conflicts.length > 0) throw new ConflictError('Another page already uses this URL', { conflicts });
    await tx`
      INSERT INTO campaign_quiz_slugs (quiz_slug, locale, public_slug)
      VALUES (${slug}, ${locale}, ${slug})
    `;
  }
}

/**
 * Makes the page's own set exactly `questions`, in order. Every question must exist, be public and published, and
 * belong to no other set (a question is reserved by one page). Unchanged sets are left alone, so no version is cut.
 */
async function replaceOwnedSet(
  tx: typeof sql,
  slug: string,
  questions: Array<{ id: string; difficulty: 'easy' | 'medium' | 'hard' }>,
): Promise<void> {
  const ids = questions.map((question) => question.id);
  const current = await tx<{ question_id: string; difficulty: string }[]>`
    SELECT question_id, difficulty FROM campaign_quiz_questions WHERE quiz_slug = ${slug} ORDER BY display_order
  `;
  if (
    current.length === questions.length
    && current.every((row, index) => row.question_id === ids[index] && row.difficulty === questions[index].difficulty)
  ) {
    return;
  }
  const taken = await tx<{ question_id: string; quiz_slug: string }[]>`
    SELECT question_id, quiz_slug FROM campaign_quiz_questions
    WHERE question_id = ANY(${sql.array(ids)}::uuid[]) AND quiz_slug <> ${slug}
  `;
  if (taken.length > 0) throw new ConflictError('A question already belongs to another quiz page', { taken });
  const [usable] = await tx<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM questions q
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.id = ANY(${sql.array(ids)}::uuid[]) AND q.status = 'published' AND q.visibility = 'public'
  `;
  if ((usable?.count ?? 0) !== new Set(ids).size) {
    throw new ConflictError('Every question must exist, be published and public');
  }
  await tx`DELETE FROM campaign_quiz_questions WHERE quiz_slug = ${slug}`;
  for (const [index, question] of questions.entries()) {
    await tx`
      INSERT INTO campaign_quiz_questions (quiz_slug, question_id, difficulty, display_order)
      VALUES (${slug}, ${question.id}, ${question.difficulty}, ${index + 1})
    `;
  }
}

async function insertRevision(tx: typeof sql, slug: string, action: AdminCampaignQuizRevisionRow['action'], snapshot: Json, userId: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${slug}))`;
  await tx`
    INSERT INTO campaign_quiz_revisions (quiz_slug, revision_number, action, snapshot, created_by)
    SELECT ${slug}, COALESCE(MAX(revision_number), 0) + 1, ${action}, ${sql.json(snapshot)}, ${userId}
    FROM campaign_quiz_revisions WHERE quiz_slug = ${slug}
  `;
  await tx`
    DELETE FROM campaign_quiz_revisions
    WHERE quiz_slug = ${slug}
      AND id NOT IN (
        SELECT id FROM campaign_quiz_revisions WHERE quiz_slug = ${slug} ORDER BY revision_number DESC LIMIT 100
      )
  `;
}

/** Serializes requests that share a key, then answers a key seen before (the same request) from the ledger. */
async function replayedCommit(tx: typeof sql, key: string, requestHash: string): Promise<CampaignQuizAgentWriteResult | null> {
  await tx`SELECT pg_advisory_xact_lock(hashtext(${`campaign_quiz_agent_key:${key}`}))`;
  const [row] = await tx<{ quiz_slug: string; action: string; request_hash: string; result: { version?: number } }[]>`
    SELECT quiz_slug, action, request_hash, result FROM campaign_quiz_agent_commits WHERE idempotency_key = ${key}
  `;
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new ConflictError('This idempotency key was used for a different request');
  return { kind: 'replayed', slug: row.quiz_slug, action: row.action, version: row.result?.version ?? null };
}

/** Fires the deferred set-version trigger now, so the version recorded and returned is the page's final one. */
async function finalVersion(tx: typeof sql, slug: string): Promise<number> {
  await tx`SET CONSTRAINTS ALL IMMEDIATE`;
  const [row] = await tx<{ version: number }[]>`SELECT version FROM campaign_quizzes WHERE slug = ${slug}`;
  return row?.version ?? 0;
}

/** Locks the candidate's questions against edits for the rest of the transaction and reads them in the page's order. */
async function lockedQuestionRows(
  tx: typeof sql,
  questions: Array<{ id: string; difficulty: 'easy' | 'medium' | 'hard' }>,
): Promise<CampaignQuizQuestionRow[]> {
  const ids = questions.map((question) => question.id);
  const rows = await tx<Omit<CampaignQuizQuestionRow, 'display_order' | 'difficulty'>[]>`
    SELECT q.id, q.prompt, q.explanation, qp.payload
    FROM questions q
    JOIN question_payloads qp ON qp.question_id = q.id
    WHERE q.id = ANY(${sql.array(ids)}::uuid[]) AND q.status = 'published' AND q.visibility = 'public'
    ORDER BY q.id
    FOR NO KEY UPDATE OF q
    FOR SHARE OF qp
  `;
  const byId = new Map(rows.map((row) => [row.id, row]));
  return questions.flatMap((question, index) => {
    const row = byId.get(question.id);
    return row ? [{ ...row, difficulty: question.difficulty, display_order: index + 1 }] : [];
  });
}

const UNIQUE_VIOLATION = '23505';
const DEADLOCK = '40P01';

async function withConflictErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === UNIQUE_VIOLATION) {
      throw new ConflictError('Another page already holds this slug, URL or question', {
        constraint: (error as { constraint_name?: string }).constraint_name ?? null,
      });
    }
    if (code === DEADLOCK) throw new ConflictError('Another write touched the same page or questions; retry', { reason: 'retry' });
    throw error;
  }
}

/** The refresh/review preconditions: the page the agent read is still the page, and the owner has not locked it. */
async function lockAgentPage(tx: typeof sql, slug: string, expectedVersion: number | null): Promise<CampaignQuizRow> {
  const [page] = await tx<CampaignQuizRow[]>`SELECT * FROM campaign_quizzes WHERE slug = ${slug} FOR UPDATE`;
  if (!page) throw new ConflictError('Quiz page not found', { reason: 'missing' });
  if (page.version !== expectedVersion) {
    throw new ConflictError('The page changed since the agent read it', { reason: 'stale', version: page.version });
  }
  if (page.agent_locked) throw new ConflictError('The owner locked this page', { reason: 'locked' });
  if (page.status !== 'published') throw new ConflictError('Only published pages are refreshed', { reason: 'not_published' });
  if (page.question_source !== 'existing' || page.question_set_slug !== slug) {
    throw new ConflictError('The agent only refreshes pages that own their question set', { reason: 'not_owned_set' });
  }
  return page;
}

export const campaignQuizzesRepo = {
  async getVisibleQuiz(slug: string, previewToken?: string): Promise<CampaignQuizRow | null> {
    const [quiz] = await sql<CampaignQuizRow[]>`
      SELECT *
      FROM campaign_quizzes
      WHERE slug = ${slug}
        AND (
          (${publicWindowSql()})
          OR (
            ${previewToken ?? null}::uuid IS NOT NULL
            AND preview_token = ${previewToken ?? null}::uuid
          )
        )
      LIMIT 1
    `;
    return quiz ?? null;
  },

  async getPublishedQuiz(slug: string): Promise<CampaignQuizRow | null> {
    const [quiz] = await sql<CampaignQuizRow[]>`
      SELECT *
      FROM campaign_quizzes
      WHERE slug = ${slug}
        AND ${publicWindowSql()}
      LIMIT 1
    `;
    return quiz ?? null;
  },

  async listPublishedPages(): Promise<CampaignQuizHubRow[]> {
    return sql<CampaignQuizHubRow[]>`
      SELECT ${sql(HUB_COLUMNS)}
      FROM campaign_quizzes
      WHERE ${publicWindowSql()}
      ORDER BY page_category, is_hub_pinned DESC, hub_order, published_at, slug
    `;
  },

  async getQuestionSet(questionSetSlug: string): Promise<CampaignQuizQuestionRow[]> {
    return sql<CampaignQuizQuestionRow[]>`
      SELECT
        q.id,
        cqq.display_order,
        cqq.difficulty,
        q.prompt,
        q.explanation,
        qp.payload
      FROM campaign_quiz_questions cqq
      JOIN questions q ON q.id = cqq.question_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE cqq.quiz_slug = ${questionSetSlug}
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = false
      ORDER BY cqq.display_order ASC
    `;
  },

  /** The question sets of every published page, filtered as getQuestionSet filters one set. */
  async listPublishedPageQuestions(): Promise<CampaignQuizPageQuestionRow[]> {
    return sql<CampaignQuizPageQuestionRow[]>`
      SELECT
        page.slug AS page_slug,
        q.id,
        cqq.display_order,
        cqq.difficulty,
        q.prompt,
        q.explanation,
        qp.payload
      FROM campaign_quizzes page
      JOIN campaign_quiz_questions cqq ON cqq.quiz_slug = page.question_set_slug
      JOIN questions q ON q.id = cqq.question_id
      JOIN question_payloads qp ON qp.question_id = q.id
      WHERE page.status = 'published'
        AND COALESCE(page.scheduled_publish_at, page.published_at, '-infinity'::timestamptz) <= NOW()
        AND q.status = 'published'
        AND q.visibility = 'public'
        AND q.ranked_eligible = false
      ORDER BY page.slug, cqq.display_order ASC
    `;
  },

  async getPublishedQuestions(slug: string): Promise<CampaignQuizQuestionRow[]> {
    const quiz = await campaignQuizzesRepo.getPublishedQuiz(slug);
    return quiz ? campaignQuizzesRepo.getQuestionSet(quiz.question_set_slug) : [];
  },

  async getRating(slug: string): Promise<CampaignQuizRatingRow> {
    const [rating] = await sql<CampaignQuizRatingRow[]>`
      SELECT ROUND(AVG(rating)::numeric, 2) AS average, COUNT(*)::int AS count
      FROM campaign_quiz_ratings
      WHERE quiz_slug = ${slug}
    `;
    return rating ?? { average: null, count: 0 };
  },

  async getRelatedPages(slug: string): Promise<CampaignQuizRelatedRow[]> {
    return sql<CampaignQuizRelatedRow[]>`
      SELECT
        related.slug,
        related.breadcrumb_label,
        related.hero_image_url,
        related.hero_image_alt,
        ${sql(editionColumns(RELATED_EDITION_FIELDS).map((column) => `related.${column}`))}
      FROM campaign_quiz_related_pages relation
      JOIN campaign_quizzes related ON related.slug = relation.related_slug
      WHERE relation.quiz_slug = ${slug}
        AND related.status = 'published'
        AND COALESCE(related.scheduled_publish_at, related.published_at, '-infinity'::timestamptz) <= NOW()
      ORDER BY relation.display_order
    `;
  },

  async resolveRoute(slug: string): Promise<CampaignQuizRouteRow | null> {
    const [route] = await sql<CampaignQuizRouteRow[]>`
      SELECT status_code, target_slug
      FROM campaign_quiz_routes
      WHERE old_slug = ${slug}
      LIMIT 1
    `;
    return route ?? null;
  },

  async upsertRating(slug: string, userId: string, rating: number): Promise<void> {
    await sql`
      INSERT INTO campaign_quiz_ratings (quiz_slug, user_id, rating)
      VALUES (${slug}, ${userId}, ${rating})
      ON CONFLICT (quiz_slug, user_id) WHERE user_id IS NOT NULL
      DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()
    `;
  },

  async upsertGuestRating(slug: string, guestKey: string, rating: number): Promise<void> {
    await sql`
      INSERT INTO campaign_quiz_ratings (quiz_slug, guest_key, rating)
      VALUES (${slug}, ${guestKey}, ${rating})
      ON CONFLICT (quiz_slug, guest_key) WHERE guest_key IS NOT NULL
      DO UPDATE SET rating = EXCLUDED.rating, updated_at = NOW()
    `;
  },

  async listAdminPages(query: AdminCampaignQuizListQuery): Promise<AdminCampaignQuizListRow[]> {
    const search = query.search ? `%${query.search}%` : null;
    return sql<AdminCampaignQuizListRow[]>`
      SELECT quiz.*, COUNT(assignment.question_id)::int AS question_count
      FROM campaign_quizzes quiz
      LEFT JOIN campaign_quiz_questions assignment
        ON assignment.quiz_slug = quiz.question_set_slug
      WHERE (${query.status ?? null}::text IS NULL OR quiz.status = ${query.status ?? null})
        AND (${query.category ?? null}::text IS NULL OR quiz.page_category = ${query.category ?? null})
        AND (
          ${search}::text IS NULL
          OR quiz.internal_name ILIKE ${search}
          OR quiz.slug ILIKE ${search}
          OR quiz.h1 ILIKE ${search}
        )
      GROUP BY quiz.slug
      ORDER BY quiz.updated_at DESC, quiz.slug
    `;
  },

  async updateHubOrder(
    items: Array<{ slug: string; hub_order: number; is_pinned: boolean }>,
    userId: string,
  ): Promise<void> {
    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const slugs = items.map((item) => item.slug);
      await tx`
        SELECT slug
        FROM campaign_quizzes
        WHERE slug = ANY(${sql.array(slugs)}::text[])
        FOR UPDATE
      `;
      for (const item of items) {
        await tx`
          UPDATE campaign_quizzes
          SET hub_order = ${item.hub_order},
              is_hub_pinned = ${item.is_pinned},
              updated_by = ${userId}
          WHERE slug = ${item.slug}
            AND status = 'published'
        `;
      }
    });
  },

  async createRevision(
    slug: string,
    action: AdminCampaignQuizRevisionRow['action'],
    snapshot: Json,
    userId: string,
  ): Promise<void> {
    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      await tx`SELECT pg_advisory_xact_lock(hashtext(${slug}))`;
      await tx`
        INSERT INTO campaign_quiz_revisions (
          quiz_slug, revision_number, action, snapshot, created_by
        )
        SELECT
          ${slug},
          COALESCE(MAX(revision_number), 0) + 1,
          ${action},
          ${sql.json(snapshot)},
          ${userId}
        FROM campaign_quiz_revisions
        WHERE quiz_slug = ${slug}
      `;
      await tx`
        DELETE FROM campaign_quiz_revisions
        WHERE quiz_slug = ${slug}
          AND id NOT IN (
            SELECT id
            FROM campaign_quiz_revisions
            WHERE quiz_slug = ${slug}
            ORDER BY revision_number DESC
            LIMIT 100
          )
      `;
    });
  },

  async listRevisions(slug: string): Promise<AdminCampaignQuizRevisionRow[]> {
    return sql<AdminCampaignQuizRevisionRow[]>`
      SELECT
        revision.id,
        revision.revision_number,
        revision.action,
        revision.snapshot,
        revision.created_at,
        revision.created_by,
        editor.nickname AS editor_name
      FROM campaign_quiz_revisions revision
      LEFT JOIN users editor ON editor.id = revision.created_by
      WHERE revision.quiz_slug = ${slug}
      ORDER BY revision.revision_number DESC
      LIMIT 100
    `;
  },

  async getRevision(slug: string, revisionId: number): Promise<AdminCampaignQuizRevisionRow | null> {
    const [revision] = await sql<AdminCampaignQuizRevisionRow[]>`
      SELECT
        revision.id,
        revision.revision_number,
        revision.action,
        revision.snapshot,
        revision.created_at,
        revision.created_by,
        editor.nickname AS editor_name
      FROM campaign_quiz_revisions revision
      LEFT JOIN users editor ON editor.id = revision.created_by
      WHERE revision.quiz_slug = ${slug}
        AND revision.id = ${revisionId}
      LIMIT 1
    `;
    return revision ?? null;
  },

  async getAdminPage(slug: string): Promise<AdminCampaignQuizListRow | null> {
    const [page] = await sql<AdminCampaignQuizListRow[]>`
      SELECT quiz.*, COUNT(assignment.question_id)::int AS question_count
      FROM campaign_quizzes quiz
      LEFT JOIN campaign_quiz_questions assignment
        ON assignment.quiz_slug = quiz.question_set_slug
      WHERE quiz.slug = ${slug}
      GROUP BY quiz.slug
      LIMIT 1
    `;
    return page ?? null;
  },

  async listAdminRelatedSlugs(slug: string): Promise<string[]> {
    const rows = await sql<{ related_slug: string }[]>`
      SELECT related_slug
      FROM campaign_quiz_related_pages
      WHERE quiz_slug = ${slug}
      ORDER BY display_order
    `;
    return rows.map((row) => row.related_slug);
  },

  async listManualQuestions(slug: string): Promise<AdminCampaignQuizManualQuestionRow[]> {
    return sql<AdminCampaignQuizManualQuestionRow[]>`
      SELECT question.id, question.prompt, question.explanation, payload.payload, assignment.difficulty
      FROM campaign_quiz_manual_questions managed
      JOIN questions question ON question.id = managed.question_id
      JOIN question_payloads payload ON payload.question_id = question.id
      JOIN campaign_quiz_questions assignment
        ON assignment.quiz_slug = managed.quiz_slug
       AND assignment.question_id = managed.question_id
      WHERE managed.quiz_slug = ${slug}
      ORDER BY assignment.display_order
    `;
  },

  async listQuestionSets(): Promise<AdminCampaignQuizQuestionSetRow[]> {
    return sql<AdminCampaignQuizQuestionSetRow[]>`
      SELECT
        owner.slug,
        owner.internal_name AS name,
        COUNT(assignment.question_id)::int AS count,
        COUNT(*) FILTER (WHERE assignment.difficulty = 'easy')::int AS easy,
        COUNT(*) FILTER (WHERE assignment.difficulty = 'medium')::int AS medium,
        COUNT(*) FILTER (WHERE assignment.difficulty = 'hard')::int AS hard,
        BOOL_AND(
          question.status = 'published'
          AND question.visibility = 'public'
          AND question.ranked_eligible = false
        ) AS public_only
      FROM campaign_quizzes owner
      JOIN campaign_quiz_questions assignment ON assignment.quiz_slug = owner.slug
      JOIN questions question ON question.id = assignment.question_id
      WHERE owner.question_source = 'existing'
      GROUP BY owner.slug, owner.internal_name
      ORDER BY owner.internal_name, owner.slug
    `;
  },

  async getQuestionSetHealth(questionSetSlug: string): Promise<CampaignQuizQuestionSetHealthRow> {
    const [health] = await sql<CampaignQuizQuestionSetHealthRow[]>`
      SELECT
        COUNT(assignment.question_id)::int AS count,
        COUNT(assignment.question_id) FILTER (
          WHERE question.status = 'published'
            AND question.visibility = 'public'
            AND question.ranked_eligible = false
        )::int AS public_only_count
      FROM campaign_quiz_questions assignment
      JOIN questions question ON question.id = assignment.question_id
      WHERE assignment.quiz_slug = ${questionSetSlug}
    `;
    return health ?? { count: 0, public_only_count: 0 };
  },

  async isAttachableQuestionSet(questionSetSlug: string): Promise<boolean> {
    const [row] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM campaign_quizzes
        WHERE slug = ${questionSetSlug}
          AND question_source = 'existing'
      ) AS exists
    `;
    return row?.exists ?? false;
  },

  async countQuestionSetConsumers(
    questionSetSlug: string,
    excludingPageSlug?: string,
  ): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM campaign_quizzes
      WHERE question_set_slug = ${questionSetSlug}
        AND slug <> ${excludingPageSlug ?? ''}
    `;
    return row?.count ?? 0;
  },

  async slugExists(slug: string, exceptSlug?: string): Promise<boolean> {
    const [row] = await sql<{ exists: boolean }[]>`
      SELECT (
        EXISTS (
          SELECT 1 FROM campaign_quizzes
          WHERE slug = ${slug}
            AND (${exceptSlug ?? null}::text IS NULL OR slug <> ${exceptSlug ?? null})
        )
        OR EXISTS (
          SELECT 1 FROM campaign_quiz_routes
          WHERE old_slug = ${slug}
            AND (${exceptSlug ?? null}::text IS NULL OR old_slug <> ${exceptSlug ?? null})
        )
      ) AS exists
    `;
    return row?.exists ?? false;
  },

  async createAdminPage(
    input: AdminCampaignQuizPageBody,
    userId: string,
    options: CampaignQuizAdminWriteOptions = {},
  ): Promise<void> {
    const values = pageValues(input);
    await withConflictErrors(() => sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      await tx`
        INSERT INTO campaign_quizzes (
          slug, title, internal_name, page_category, question_source, question_set_slug,
          h1, lede, about_heading, about_blocks, score_cta,
          footer_banner_text, footer_button_label, hero_image_url, hero_image_alt,
          seo_title, meta_description, og_image_url, og_image_alt,
          breadcrumb_label, locale_mode, ka_seo_title, ka_meta_description,
          ka_h1, ka_lede, status, created_by, updated_by
        ) VALUES (
          ${input.slug}, ${input.title || input.h1 || input.internal_name}, ${input.internal_name},
          ${input.category}, ${input.question_source}, ${input.question_set_slug}, ${input.h1}, ${input.lede},
          ${input.about_heading}, ${values.aboutBlocks}, ${input.score_cta},
          ${input.footer_banner_text}, ${input.footer_button_label},
          ${input.hero_image_url}, ${input.hero_image_alt}, ${input.seo_title},
          ${input.meta_description}, ${input.og_image_url}, ${input.og_image_alt ?? null},
          ${input.breadcrumb_label}, ${input.locale_mode}, ${input.ka_seo_title ?? null},
          ${input.ka_meta_description ?? null}, ${input.ka_h1 ?? null}, ${input.ka_lede ?? null},
          'draft', ${userId}, ${userId}
        )
      `;
      await replaceRelatedPages(tx, input.slug, input.related_slugs);
      if (input.question_source === 'manual') {
        await replaceManualQuestions(
          tx,
          input.slug,
          input.internal_name,
          input.manual_questions,
          userId,
        );
      }
      if (options.editions) await writeEditionColumns(tx, input.slug, options.editions);
      if (options.agentLocked !== undefined) {
        await tx`UPDATE campaign_quizzes SET agent_locked = ${options.agentLocked} WHERE slug = ${input.slug}`;
      }
      await writePublicSlugs(tx, input.slug, options.publicSlugs ?? {}, true);
      await fillDefaultSlugs(tx, input.slug);
    }));
  },

  async updateAdminPage(
    currentSlug: string,
    input: AdminCampaignQuizPageBody,
    userId: string,
    options: CampaignQuizAdminWriteOptions = {},
  ): Promise<void> {
    const values = pageValues(input);
    const questionSetSlug = input.question_set_slug === currentSlug
      ? input.slug
      : input.question_set_slug;

    await withConflictErrors(() => sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const [before] = await tx<Pick<CampaignQuizRow, 'status' | 'published_at' | 'version' | 'managed_by' | 'last_reviewed_at'>[]>`
        SELECT status, published_at, version, managed_by, last_reviewed_at FROM campaign_quizzes
        WHERE slug = ${currentSlug}
        FOR UPDATE
      `;
      if (!before) return;
      if (options.expectedVersion !== undefined && options.expectedVersion !== before.version) {
        throw new ConflictError('This page was changed by someone else; reload it first', { version: before.version });
      }
      if (options.expectedVersion === undefined && (before.managed_by === 'agent' || before.last_reviewed_at)) {
        throw new ConflictError('The quiz agent maintains this page: reload it in the latest CMS before saving', { version: before.version });
      }

      await tx`
        UPDATE campaign_quizzes
        SET
          slug = ${input.slug},
          title = ${input.title || input.h1 || input.internal_name},
          internal_name = ${input.internal_name},
          page_category = ${input.category},
          question_source = ${input.question_source},
          question_set_slug = ${questionSetSlug},
          h1 = ${input.h1},
          lede = ${input.lede},
          about_heading = ${input.about_heading},
          about_blocks = ${values.aboutBlocks},
          score_cta = ${input.score_cta},
          footer_banner_text = ${input.footer_banner_text},
          footer_button_label = ${input.footer_button_label},
          hero_image_url = ${input.hero_image_url},
          hero_image_alt = ${input.hero_image_alt},
          seo_title = ${input.seo_title},
          meta_description = ${input.meta_description},
          og_image_url = ${input.og_image_url},
          og_image_alt = ${input.og_image_alt ?? null},
          breadcrumb_label = ${input.breadcrumb_label},
          locale_mode = ${input.locale_mode},
          ka_seo_title = ${input.ka_seo_title ?? null},
          ka_meta_description = ${input.ka_meta_description ?? null},
          ka_h1 = ${input.ka_h1 ?? null},
          ka_lede = ${input.ka_lede ?? null},
          updated_by = ${userId},
          updated_at = NOW()
        WHERE slug = ${currentSlug}
      `;

      if (
        currentSlug !== input.slug
        && (before.status === 'published' || before.published_at !== null)
      ) {
        await tx`
          INSERT INTO campaign_quiz_routes (old_slug, status_code, target_slug, created_by)
          VALUES (${currentSlug}, 301, ${input.slug}, ${userId})
          ON CONFLICT (old_slug) DO UPDATE
          SET status_code = 301, target_slug = EXCLUDED.target_slug, created_by = EXCLUDED.created_by
        `;
      }

      await replaceRelatedPages(tx, input.slug, input.related_slugs);
      if (input.question_source === 'manual') {
        await replaceManualQuestions(
          tx,
          input.slug,
          input.internal_name,
          input.manual_questions,
          userId,
        );
        if (currentSlug !== input.slug) {
          await tx`
            UPDATE categories category
            SET is_active = FALSE, updated_at = NOW()
            WHERE category.slug = ${currentSlug}
              AND NOT EXISTS (
                SELECT 1 FROM questions question WHERE question.category_id = category.id
              )
          `;
        }
      } else {
        await clearOwnedManualQuestions(tx, input.slug);
        if (options.questions && questionSetSlug === input.slug) {
          await replaceOwnedSet(tx, input.slug, options.questions);
        }
      }
      if (currentSlug !== input.slug) {
        await tx`
          UPDATE campaign_quiz_slugs SET public_slug = ${input.slug}
          WHERE quiz_slug = ${input.slug} AND public_slug = ${currentSlug}
        `;
      }
      if (options.editions) await writeEditionColumns(tx, input.slug, options.editions);
      if (options.agentLocked !== undefined) {
        await tx`UPDATE campaign_quizzes SET agent_locked = ${options.agentLocked} WHERE slug = ${input.slug}`;
      }
      const neverPublished = before.status !== 'published' && before.published_at === null;
      const submitted = Object.fromEntries(Object.entries(options.publicSlugs ?? {})
        .map(([locale, value]) => [locale, value === currentSlug ? input.slug : value]));
      await writePublicSlugs(tx, input.slug, submitted, neverPublished);
      await fillDefaultSlugs(tx, input.slug);
    }));
  },

  async setPreview(slug: string, userId: string): Promise<void> {
    await sql`
      UPDATE campaign_quizzes
      SET
        status = CASE WHEN status = 'published' THEN status ELSE 'preview' END,
        preview_token = gen_random_uuid(),
        updated_by = ${userId},
        updated_at = NOW()
      WHERE slug = ${slug}
    `;
  },

  async publish(slug: string, scheduledAt: string | null, userId: string): Promise<void> {
    await sql`
      UPDATE campaign_quizzes
      SET
        status = 'published',
        preview_token = gen_random_uuid(),
        scheduled_publish_at = ${scheduledAt},
        published_at = COALESCE(published_at, NOW()),
        unpublished_at = NULL,
        updated_by = ${userId},
        updated_at = NOW()
      WHERE slug = ${slug}
    `;
  },

  async retire(
    slug: string,
    input: AdminCampaignQuizRetireBody,
    userId: string,
    remove: boolean,
  ): Promise<void> {
    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      await tx`
        INSERT INTO campaign_quiz_routes (old_slug, status_code, target_slug, created_by)
        VALUES (
          ${slug},
          ${input.route_mode === 'redirect' ? 301 : 410},
          ${input.route_mode === 'redirect' ? input.target_slug : null},
          ${userId}
        )
        ON CONFLICT (old_slug) DO UPDATE
        SET status_code = EXCLUDED.status_code,
            target_slug = EXCLUDED.target_slug,
            created_by = EXCLUDED.created_by,
            created_at = NOW()
      `;

      // A published page can already be the target of older slug redirects.
      // Keep those routes valid when the final page is retired or removed,
      // otherwise the route foreign key would both block deletion and leave a
      // broken redirect chain.
      await tx`
        UPDATE campaign_quiz_routes
        SET
          status_code = ${input.route_mode === 'redirect' ? 301 : 410},
          target_slug = ${input.route_mode === 'redirect' ? input.target_slug : null},
          created_by = ${userId},
          created_at = NOW()
        WHERE target_slug = ${slug}
          AND old_slug <> ${slug}
      `;

      if (remove) {
        // The page's own URLs in other languages go with it; keep them answering 301/410 like its slug does.
        await tx`
          INSERT INTO campaign_quiz_routes (old_slug, status_code, target_slug, created_by)
          SELECT DISTINCT public_slug, ${input.route_mode === 'redirect' ? 301 : 410}::smallint,
            ${input.route_mode === 'redirect' ? input.target_slug : null}::text, ${userId}::uuid
          FROM campaign_quiz_slugs
          WHERE quiz_slug = ${slug} AND public_slug <> ${slug}
            AND NOT EXISTS (SELECT 1 FROM campaign_quizzes WHERE campaign_quizzes.slug = campaign_quiz_slugs.public_slug)
          ON CONFLICT (old_slug) DO NOTHING
        `;
        await clearOwnedManualQuestions(tx, slug);
        await tx`DELETE FROM campaign_quizzes WHERE slug = ${slug}`;
      } else {
        await tx`
          UPDATE campaign_quizzes
          SET status = 'draft', scheduled_publish_at = NULL,
              preview_token = gen_random_uuid(),
              unpublished_at = NOW(), updated_by = ${userId}, updated_at = NOW()
          WHERE slug = ${slug}
        `;
      }
    });
  },

  /**
   * A set version with its question rows in one read: the newest one, or `version` (null when the set has no such
   * version). Rows are filtered as getQuestionSet filters the live set and keep the version's order and difficulty.
   */
  async loadSetVersion(setSlug: string, version?: number): Promise<{
    version: number;
    superseded_at: string | null;
    rows: CampaignQuizQuestionRow[];
  } | null> {
    const records = await sql<Array<{
      version: number;
      superseded_at: string | null;
      id: string | null;
      display_order: number | null;
      difficulty: CampaignQuizQuestionRow['difficulty'] | null;
      prompt: unknown;
      explanation: unknown;
      payload: unknown;
    }>>`
      WITH chosen AS (
        SELECT current.version, current.questions, next.created_at AS superseded_at
        FROM campaign_quiz_set_versions current
        LEFT JOIN campaign_quiz_set_versions next
          ON next.set_slug = current.set_slug AND next.version = current.version + 1
        WHERE current.set_slug = ${setSlug}
          AND (${version ?? null}::int IS NULL OR current.version = ${version ?? null}::int)
        ORDER BY current.version DESC
        LIMIT 1
      )
      SELECT
        chosen.version,
        chosen.superseded_at,
        q.id,
        (entry->>'display_order')::int AS display_order,
        entry->>'difficulty' AS difficulty,
        q.prompt,
        q.explanation,
        qp.payload
      FROM chosen
      LEFT JOIN LATERAL jsonb_array_elements(chosen.questions) AS entry ON TRUE
      LEFT JOIN questions q
        ON q.id = (entry->>'question_id')::uuid
       AND q.status = 'published'
       AND q.visibility = 'public'
       AND q.ranked_eligible = false
      LEFT JOIN question_payloads qp ON qp.question_id = q.id
      ORDER BY (entry->>'display_order')::int
    `;
    const [first] = records;
    if (!first) return null;
    return {
      version: first.version,
      superseded_at: first.superseded_at,
      rows: records
        .filter((record) => record.id && record.payload !== null && record.payload !== undefined)
        .map((record) => ({
          id: record.id!,
          display_order: record.display_order!,
          difficulty: record.difficulty!,
          prompt: record.prompt,
          explanation: record.explanation,
          payload: record.payload,
        })),
    };
  },

  async getQuestionsByIds(ids: string[]): Promise<Array<Omit<CampaignQuizQuestionRow, 'display_order' | 'difficulty'> & { set_slug: string | null }>> {
    if (ids.length === 0) return [];
    return sql`
      SELECT q.id, q.prompt, q.explanation, qp.payload, assignment.quiz_slug AS set_slug
      FROM questions q
      JOIN question_payloads qp ON qp.question_id = q.id
      LEFT JOIN campaign_quiz_questions assignment ON assignment.question_id = q.id
      WHERE q.id = ANY(${sql.array(ids)}::uuid[])
        AND q.status = 'published'
        AND q.visibility = 'public'
    `;
  },

  /**
   * Public slugs of every page a visitor can reach: published ones, and retired ones whose slug now answers 301/410
   * (the web maps a localized URL to the slug, then to the route). Drafts stay private.
   */
  async listPublishedSlugs(): Promise<CampaignQuizSlugRow[]> {
    return sql<CampaignQuizSlugRow[]>`
      SELECT slug_row.quiz_slug, slug_row.locale, slug_row.public_slug
      FROM campaign_quiz_slugs slug_row
      JOIN campaign_quizzes page ON page.slug = slug_row.quiz_slug
      WHERE (
        page.status = 'published'
        AND COALESCE(page.scheduled_publish_at, page.published_at, '-infinity'::timestamptz) <= NOW()
      ) OR EXISTS (SELECT 1 FROM campaign_quiz_routes route WHERE route.old_slug = page.slug)
      ORDER BY slug_row.quiz_slug, slug_row.locale
    `;
  },

  async listAllSlugs(): Promise<CampaignQuizSlugRow[]> {
    return sql<CampaignQuizSlugRow[]>`SELECT quiz_slug, locale, public_slug FROM campaign_quiz_slugs`;
  },

  async findSlugByPublic(locale: CampaignLocale, publicSlug: string): Promise<string | null> {
    const [row] = await sql<{ quiz_slug: string }[]>`
      SELECT quiz_slug FROM campaign_quiz_slugs WHERE locale = ${locale} AND public_slug = ${publicSlug}
    `;
    return row?.quiz_slug ?? null;
  },

  async getPageSlugs(slug: string): Promise<Partial<Record<CampaignLocale, string>>> {
    const rows = await sql<CampaignQuizSlugRow[]>`
      SELECT quiz_slug, locale, public_slug FROM campaign_quiz_slugs WHERE quiz_slug = ${slug}
    `;
    return Object.fromEntries(rows.map((row) => [row.locale, row.public_slug]));
  },

  async findPublicSlugConflicts(slug: string, publicSlugs: Partial<Record<CampaignLocale, string>>): Promise<string[]> {
    return publicSlugConflicts(sql, slug, publicSlugs);
  },

  /** Published pages the refresh job may take: owned sets, not locked, due (never reviewed first). */
  async listDueForRefresh(limit: number): Promise<CampaignQuizRow[]> {
    return sql<CampaignQuizRow[]>`
      SELECT * FROM campaign_quizzes
      WHERE ${publicWindowSql()}
        AND agent_locked = false
        AND question_source = 'existing'
        AND question_set_slug = slug
        AND (next_refresh_at IS NULL OR next_refresh_at <= NOW())
      ORDER BY next_refresh_at NULLS FIRST, last_reviewed_at NULLS FIRST, slug
      LIMIT ${limit}
    `;
  },

  async getPage(slug: string): Promise<CampaignQuizRow | null> {
    const [page] = await sql<CampaignQuizRow[]>`SELECT * FROM campaign_quizzes WHERE slug = ${slug}`;
    return page ?? null;
  },

  /**
   * Creates or refreshes an agent page in one transaction: copy in every language, public slugs, the question set,
   * review dates, the revision and the idempotency record all land together or not at all. A retried key replays.
   */
  async agentCommit(input: CampaignQuizAgentCommitInput): Promise<CampaignQuizAgentWriteResult> {
    return withConflictErrors(() => sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const replay = await replayedCommit(tx, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      if (input.claim) {
        // A runner whose lease ran out (another runner took the item) must not publish.
        const [claim] = await tx<{ page_slug: string; live: boolean }[]>`
          SELECT page_slug, (status = 'building' AND lease_token = ${input.claim.leaseToken}::uuid
            AND lease_expires_at > clock_timestamp()) AS live
          FROM campaign_quiz_backlog WHERE id = ${input.claim.backlogId}::uuid FOR UPDATE
        `;
        if (!claim?.live || claim.page_slug !== input.slug) {
          throw new ConflictError('The work-list claim is no longer this runner\'s', { reason: 'claim_lost' });
        }
      }
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`campaign_quiz_page:${input.slug}`}))`;
      const problems = input.verify(await lockedQuestionRows(tx, input.questions));
      if (problems.length > 0) throw new ValidationError('The page is not ready to publish', { problems });

      let versionBefore: number | null = null;
      const english = input.english;
      const pageColumns = {
        title: english.title,
        internal_name: input.internalName,
        page_category: input.category,
        h1: english.h1,
        lede: english.lede,
        about_heading: english.about_heading,
        about_blocks: sql.json(english.about_blocks as unknown as Json),
        score_cta: english.score_cta,
        footer_banner_text: english.footer_banner_text,
        footer_button_label: english.footer_button_label,
        hero_image_url: input.heroImageUrl,
        hero_image_alt: english.hero_image_alt,
        seo_title: english.seo_title,
        meta_description: english.meta_description,
        og_image_url: input.ogImageUrl,
        og_image_alt: english.og_image_alt,
        breadcrumb_label: english.breadcrumb_label,
        locale_mode: 'en_ka',
        updated_by: input.userId,
        ...editionColumnValues(input.editions),
      };
      if (input.action === 'create') {
        const [taken] = await tx<{ taken: boolean }[]>`
          SELECT (
            EXISTS (SELECT 1 FROM campaign_quizzes WHERE slug = ${input.slug})
            OR EXISTS (SELECT 1 FROM campaign_quiz_routes WHERE old_slug = ${input.slug})
            OR EXISTS (SELECT 1 FROM campaign_quiz_slugs WHERE public_slug = ${input.slug})
          ) AS taken
        `;
        if (taken?.taken) throw new ConflictError('That quiz slug is already in use', { reason: 'slug_taken' });
        const row = {
          slug: input.slug,
          question_source: 'existing',
          question_set_slug: input.slug,
          status: 'published',
          published_at: new Date().toISOString(),
          managed_by: 'agent',
          created_by: input.userId,
          ...pageColumns,
        };
        await tx`INSERT INTO campaign_quizzes ${sql(row as Record<string, ColumnValue>)}`;
      } else {
        versionBefore = (await lockAgentPage(tx, input.slug, input.expectedVersion)).version;
        await tx`UPDATE campaign_quizzes SET ${sql(pageColumns as Record<string, ColumnValue>)} WHERE slug = ${input.slug}`;
      }

      await writePublicSlugs(tx, input.slug, input.publicSlugs, input.action === 'create');
      await replaceOwnedSet(tx, input.slug, input.questions);
      if (input.relatedSlugs) await replaceRelatedPages(tx, input.slug, input.relatedSlugs);
      await tx`
        UPDATE campaign_quizzes
        SET last_reviewed_at = NOW(), next_refresh_at = ${input.nextRefreshAt}
        WHERE slug = ${input.slug}
      `;
      await insertRevision(
        tx,
        input.slug,
        input.action === 'create' ? 'published' : 'saved',
        input.revisionSnapshot(versionBefore),
        input.userId,
      );
      const version = await finalVersion(tx, input.slug);
      await tx`
        INSERT INTO campaign_quiz_agent_commits (idempotency_key, quiz_slug, action, request_hash, result)
        VALUES (${input.idempotencyKey}, ${input.slug}, ${input.action}, ${input.requestHash},
          ${sql.json({ version_before: versionBefore, version })})
      `;
      if (input.claim) {
        await tx`
          UPDATE campaign_quiz_backlog
          SET status = 'published', stage = 'published', result = ${sql.json({ version, idempotency_key: input.idempotencyKey })},
              last_error = NULL, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
          WHERE id = ${input.claim.backlogId}::uuid
        `;
      }
      return { kind: 'committed', version } as const;
    }));
  },

  async findAgentCommit(key: string): Promise<{ slug: string; action: string; request_hash: string; version: number | null } | null> {
    const [row] = await sql<{ quiz_slug: string; action: string; request_hash: string; result: { version?: number } }[]>`
      SELECT quiz_slug, action, request_hash, result FROM campaign_quiz_agent_commits WHERE idempotency_key = ${key}
    `;
    return row ? { slug: row.quiz_slug, action: row.action, request_hash: row.request_hash, version: row.result?.version ?? null } : null;
  },

  /** The refresh job looked at a page and changed nothing: only the review dates move. */
  async agentReview(input: {
    idempotencyKey: string;
    requestHash: string;
    slug: string;
    expectedVersion: number;
    nextRefreshAt: string;
  }): Promise<CampaignQuizAgentWriteResult> {
    return sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const replay = await replayedCommit(tx, input.idempotencyKey, input.requestHash);
      if (replay) return replay;
      await lockAgentPage(tx, input.slug, input.expectedVersion);
      await tx`
        UPDATE campaign_quizzes
        SET last_reviewed_at = NOW(), next_refresh_at = ${input.nextRefreshAt}
        WHERE slug = ${input.slug}
      `;
      const version = await finalVersion(tx, input.slug);
      await tx`
        INSERT INTO campaign_quiz_agent_commits (idempotency_key, quiz_slug, action, request_hash, result)
        VALUES (${input.idempotencyKey}, ${input.slug}, 'review', ${input.requestHash}, ${sql.json({ version })})
      `;
      return { kind: 'committed', version } as const;
    });
  },
};

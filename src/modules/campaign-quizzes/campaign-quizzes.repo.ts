import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  AdminCampaignQuizManualQuestion,
  AdminCampaignQuizListQuery,
  AdminCampaignQuizPageBody,
  AdminCampaignQuizRetireBody,
  CampaignQuizAboutBlock,
} from './campaign-quizzes.schemas.js';

export interface CampaignQuizRow {
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
  ka_seo_title: string | null;
  ka_meta_description: string | null;
  ka_h1: string | null;
  ka_lede: string | null;
  scheduled_publish_at: string | null;
  published_at: string | null;
  unpublished_at: string | null;
  preview_token: string;
  hub_order: number;
  is_hub_pinned: boolean;
  created_at: string;
  updated_at: string;
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

export interface CampaignQuizRelatedRow {
  slug: string;
  breadcrumb_label: string;
  hero_image_url: string | null;
  hero_image_alt: string | null;
}

export interface CampaignQuizHubRow {
  slug: string;
  page_category: CampaignQuizRow['page_category'];
  h1: string;
  breadcrumb_label: string;
  hero_image_url: string | null;
  hero_image_alt: string | null;
  locale_mode: CampaignQuizRow['locale_mode'];
  updated_at: string;
  hub_order: number;
  is_hub_pinned: boolean;
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
  await tx`DELETE FROM campaign_quiz_related_pages WHERE quiz_slug = ${slug}`;
  for (const [index, relatedSlug] of relatedSlugs.entries()) {
    await tx`
      INSERT INTO campaign_quiz_related_pages (quiz_slug, related_slug, display_order)
      VALUES (${slug}, ${relatedSlug}, ${index + 1})
    `;
  }
}

async function clearOwnedManualQuestions(tx: typeof sql, slug: string): Promise<void> {
  const [ownership] = await tx<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM campaign_quiz_manual_questions
      WHERE quiz_slug = ${slug}
    ) AS exists
  `;
  if (!ownership?.exists) return;

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

  const existingRows = await tx<{ id: string; prompt: string }[]>`
    SELECT question.id, COALESCE(question.prompt->>'en', '') AS prompt
    FROM campaign_quiz_manual_questions managed
    JOIN questions question ON question.id = managed.question_id
    JOIN campaign_quiz_questions assignment
      ON assignment.quiz_slug = managed.quiz_slug
     AND assignment.question_id = managed.question_id
    WHERE managed.quiz_slug = ${slug}
    ORDER BY assignment.display_order
  `;
  const existingIds = new Set(existingRows.map((row) => row.id));
  const existingIdByPrompt = new Map(
    existingRows.map((row) => [row.prompt.trim().toLocaleLowerCase('en'), row.id]),
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
    INSERT INTO categories (slug, name, is_active)
    VALUES (${slug}, ${sql.json({ en: internalName })}, TRUE)
    ON CONFLICT (slug) DO UPDATE
    SET is_active = TRUE, updated_at = NOW()
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

    const [saved] = existingId
      ? await tx<{ id: string }[]>`
          UPDATE questions
          SET
            category_id = ${category.id},
            type = 'mcq_single',
            difficulty = ${question.difficulty},
            status = 'published',
            prompt = ${sql.json({ en: question.prompt })},
            explanation = ${question.explanation ? sql.json({ en: question.explanation }) : null},
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
            ${sql.json({ en: question.prompt })},
            ${question.explanation ? sql.json({ en: question.explanation }) : null},
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
        text: { en: text },
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
      SELECT
        slug,
        page_category,
        h1,
        breadcrumb_label,
        hero_image_url,
        hero_image_alt,
        locale_mode,
        updated_at,
        hub_order,
        is_hub_pinned
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
        related.hero_image_alt
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

  async createAdminPage(input: AdminCampaignQuizPageBody, userId: string): Promise<void> {
    const values = pageValues(input);
    await sql.begin(async (transaction) => {
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
          ${input.slug}, ${input.h1 || input.internal_name}, ${input.internal_name},
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
    });
  },

  async updateAdminPage(
    currentSlug: string,
    input: AdminCampaignQuizPageBody,
    userId: string,
  ): Promise<void> {
    const values = pageValues(input);
    const questionSetSlug = input.question_set_slug === currentSlug
      ? input.slug
      : input.question_set_slug;

    await sql.begin(async (transaction) => {
      const tx = transaction as unknown as typeof sql;
      const [before] = await tx<Pick<CampaignQuizRow, 'status' | 'published_at'>[]>`
        SELECT status, published_at FROM campaign_quizzes
        WHERE slug = ${currentSlug}
        FOR UPDATE
      `;
      if (!before) return;

      if (currentSlug !== input.slug) {
        await tx`DELETE FROM campaign_quiz_routes WHERE old_slug = ${input.slug}`;
      }

      await tx`
        UPDATE campaign_quizzes
        SET
          slug = ${input.slug},
          title = ${input.h1 || input.internal_name},
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
      } else {
        await clearOwnedManualQuestions(tx, input.slug);
      }
    });
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
};

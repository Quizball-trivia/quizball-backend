import { sql } from '../../db/index.js';
import { config } from '../../core/config.js';
import type { Category, I18nField, Json } from '../../db/types.js';

// Categories that are active but are NOT four-option MCQ quiz categories — they
// back daily challenges and special game modes (true/false, career-path,
// imposter, high-low, football-logic, etc.). The `min_questions` filter used to
// exclude them via a per-category JSONB validation subquery that scanned every
// question (~43ms / 13,789 buffers per request and the top DB hot spot under
// load — see scripts/chaos/FINDINGS.md). These categories have 0 valid MCQs by
// construction, so a slug exclusion is behaviour-identical (verified against
// prod: same 37 categories) and ~1000× cheaper (0.04ms / 4 buffers).
//
// Keep this in sync when adding a new daily-challenge / non-MCQ game-mode
// category. A category here is still fully active for its own game mode; it is
// only hidden from the MCQ quiz-match browse list (when min_questions is set).
const NON_MCQ_CATEGORY_SLUGS = [
  'badges-and-logos',
  'career-path',
  'club-world-cup',
  'daily-challenges',
  'daily-challenges-clues',
  'daily-challenges-countdown',
  'daily-challenges-put-in-order',
  'daily-challenges-true-false',
  'football-logic',
  'high-low',
  'imposter',
] as const;

export interface CreateCategoryData {
  slug: string;
  parentId?: string | null;
  name: I18nField;
  description?: I18nField | null;
  icon?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
  createdBy?: string;
}

export interface UpdateCategoryData {
  slug?: string;
  parentId?: string | null;
  name?: I18nField;
  description?: I18nField | null;
  icon?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
}

export interface ListCategoriesFilter {
  parentId?: string;
  isActive?: boolean;
  minQuestions?: number;
}

export interface ListCategoriesResult {
  categories: Category[];
  total: number;
}

export const categoriesRepo = {
  async list(
    filter?: ListCategoriesFilter,
    page = 1,
    limit = 50,
    locale = config.DEFAULT_LOCALE
  ): Promise<ListCategoriesResult> {
    const offset = (page - 1) * limit;
    const normalizedLocale = locale.trim() || config.DEFAULT_LOCALE;

    // Build conditional filters
    const parentIdFilter =
      filter?.parentId !== undefined
        ? sql`AND parent_id = ${filter.parentId}`
        : sql``;
    const isActiveFilter =
      filter?.isActive !== undefined
        ? sql`AND is_active = ${filter.isActive}`
        : sql``;
    // `min_questions` means "only MCQ quiz categories with enough playable
    // questions". Every active category except the non-MCQ game-mode ones above
    // clears the threshold, so we exclude by slug instead of running the old
    // per-category JSONB validation subquery (the load-test DB hot spot).
    const minQuestionsFilter =
      filter?.minQuestions !== undefined
        ? sql`AND slug <> ALL(${NON_MCQ_CATEGORY_SLUGS as unknown as string[]})`
        : sql``;

    // Split the page fetch from the total count. `COUNT(*) OVER()` forced the
    // window to run the WHERE clause for ALL matching rows on every request,
    // ignoring LIMIT; splitting lets the page query stop at `limit` and the
    // count run on its own. (chaos load test, 2026-06-09; see scripts/chaos)
    const whereClause = sql`WHERE 1=1 ${parentIdFilter} ${isActiveFilter} ${minQuestionsFilter}`;

    const pageQuery = sql<Category[]>`
      SELECT *
      FROM categories
      ${whereClause}
      ORDER BY COALESCE(name->>${normalizedLocale}, name->>${config.DEFAULT_LOCALE}) ASC
      LIMIT ${limit} OFFSET ${offset}
    `;
    const countQuery = sql<{ total: string }[]>`
      SELECT COUNT(*)::text AS total
      FROM categories
      ${whereClause}
    `;

    const [categories, countRows] = await Promise.all([pageQuery, countQuery]);
    const total = countRows.length > 0 ? parseInt(countRows[0].total, 10) : 0;

    return { categories, total };
  },

  async getById(id: string): Promise<Category | null> {
    const [category] = await sql<Category[]>`
      SELECT * FROM categories WHERE id = ${id}
    `;
    return category ?? null;
  },

  async getBySlug(slug: string): Promise<Category | null> {
    const [category] = await sql<Category[]>`
      SELECT * FROM categories WHERE slug = ${slug}
    `;
    return category ?? null;
  },

  async create(data: CreateCategoryData): Promise<Category> {
    const [category] = await sql<Category[]>`
      INSERT INTO categories (slug, parent_id, name, description, icon, image_url, is_active, created_by)
      VALUES (
        ${data.slug},
        ${data.parentId ?? null},
        ${sql.json(data.name as unknown as Json)},
        ${data.description ? sql.json(data.description as unknown as Json) : null},
        ${data.icon ?? null},
        ${data.imageUrl ?? null},
        ${data.isActive ?? true},
        ${data.createdBy ?? null}
      )
      RETURNING *
    `;
    return category;
  },

  async update(id: string, data: UpdateCategoryData): Promise<Category | null> {
    const [category] = await sql<Category[]>`
      UPDATE categories
      SET
        slug = CASE WHEN ${data.slug !== undefined} THEN ${data.slug ?? ''} ELSE slug END,
        parent_id = CASE WHEN ${data.parentId !== undefined} THEN ${data.parentId ?? null} ELSE parent_id END,
        name = CASE WHEN ${data.name !== undefined} THEN ${sql.json(data.name as unknown as Json)}::jsonb ELSE name END,
        description = CASE WHEN ${data.description !== undefined} THEN ${data.description ? sql.json(data.description as unknown as Json) : null}::jsonb ELSE description END,
        icon = CASE WHEN ${data.icon !== undefined} THEN ${data.icon ?? null} ELSE icon END,
        image_url = CASE WHEN ${data.imageUrl !== undefined} THEN ${data.imageUrl ?? null} ELSE image_url END,
        is_active = CASE WHEN ${data.isActive !== undefined} THEN ${data.isActive ?? true} ELSE is_active END,
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return category ?? null;
  },

  async delete(id: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM categories WHERE id = ${id}
    `;
    return result.count > 0;
  },

  async hasChildren(id: string): Promise<boolean> {
    const [result] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id = ${id}) as exists
    `;
    return result?.exists ?? false;
  },

  async hasQuestions(id: string): Promise<boolean> {
    const [result] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM questions WHERE category_id = ${id}) as exists
    `;
    return result?.exists ?? false;
  },

  async exists(id: string): Promise<boolean> {
    const [result] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM categories WHERE id = ${id}) as exists
    `;
    return result?.exists ?? false;
  },

  async getChildren(parentId: string): Promise<Pick<Category, 'id' | 'name' | 'slug'>[]> {
    return sql<Pick<Category, 'id' | 'name' | 'slug'>[]>`
      SELECT id, name, slug FROM categories WHERE parent_id = ${parentId}
      ORDER BY name->>'en' ASC
    `;
  },

  async listByIds(ids: string[]): Promise<Category[]> {
    if (ids.length === 0) return [];

    return sql<Category[]>`
      SELECT * FROM categories WHERE id = ANY(${sql.array(ids)}::uuid[])
    `;
  },
};

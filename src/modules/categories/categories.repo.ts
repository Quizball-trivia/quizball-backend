import { sql } from '../../db/index.js';
import type { Category, I18nField, Json } from '../../db/types.js';

export interface CreateCategoryData {
  slug: string;
  parentId?: string | null;
  name: I18nField;
  description?: I18nField | null;
  icon?: string | null;
  imageUrl?: string | null;
  isActive?: boolean;
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
}

export interface ListCategoriesResult {
  categories: Category[];
  total: number;
}

export const categoriesRepo = {
  async list(
    filter?: ListCategoriesFilter,
    page = 1,
    limit = 50
  ): Promise<ListCategoriesResult> {
    const offset = (page - 1) * limit;

    // Build conditional filters
    const parentIdFilter =
      filter?.parentId !== undefined
        ? sql`AND parent_id = ${filter.parentId}`
        : sql``;
    const isActiveFilter =
      filter?.isActive !== undefined
        ? sql`AND is_active = ${filter.isActive}`
        : sql``;

    // Get paginated results with total count in single query
    const results = await sql<(Category & { total_count: string })[]>`
      SELECT *, COUNT(*) OVER() as total_count
      FROM categories
      WHERE 1=1 ${parentIdFilter} ${isActiveFilter}
      ORDER BY name->>'en' ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const total = results.length > 0 ? parseInt(results[0].total_count, 10) : 0;
    const categories = results.map(({ total_count: _, ...c }) => c);

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
      INSERT INTO categories (slug, parent_id, name, description, icon, image_url, is_active)
      VALUES (
        ${data.slug},
        ${data.parentId ?? null},
        ${sql.json(data.name as unknown as Json)},
        ${data.description ? sql.json(data.description as unknown as Json) : null},
        ${data.icon ?? null},
        ${data.imageUrl ?? null},
        ${data.isActive ?? true}
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
};

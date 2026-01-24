import { sql } from '../../db/index.js';
import type { FeaturedCategory, Category } from '../../db/types.js';

export interface CreateFeaturedCategoryData {
  categoryId: string;
  sortOrder?: number;
}

export interface UpdateFeaturedCategoryData {
  sortOrder: number;
}

export interface ReorderItem {
  id: string;
  sortOrder: number;
}

export interface FeaturedCategoryWithCategory {
  featured: FeaturedCategory;
  category: Category;
}

export const featuredCategoriesRepo = {
  /**
   * List all featured categories with joined category data, ordered by sort_order.
   */
  async list(): Promise<FeaturedCategoryWithCategory[]> {
    const results = await sql<(FeaturedCategory & { category: Category })[]>`
      SELECT
        fc.id,
        fc.category_id,
        fc.sort_order,
        fc.created_at,
        json_build_object(
          'id', c.id,
          'slug', c.slug,
          'parent_id', c.parent_id,
          'name', c.name,
          'description', c.description,
          'icon', c.icon,
          'image_url', c.image_url,
          'is_active', c.is_active,
          'created_at', c.created_at,
          'updated_at', c.updated_at
        ) as category
      FROM featured_categories fc
      JOIN categories c ON fc.category_id = c.id
      ORDER BY fc.sort_order ASC
    `;

    return results.map((row) => ({
      featured: {
        id: row.id,
        category_id: row.category_id,
        sort_order: row.sort_order,
        created_at: row.created_at,
      },
      category: row.category,
    }));
  },

  /**
   * Get a featured category by ID.
   */
  async getById(id: string): Promise<FeaturedCategoryWithCategory | null> {
    const [result] = await sql<(FeaturedCategory & { category: Category })[]>`
      SELECT
        fc.id,
        fc.category_id,
        fc.sort_order,
        fc.created_at,
        json_build_object(
          'id', c.id,
          'slug', c.slug,
          'parent_id', c.parent_id,
          'name', c.name,
          'description', c.description,
          'icon', c.icon,
          'image_url', c.image_url,
          'is_active', c.is_active,
          'created_at', c.created_at,
          'updated_at', c.updated_at
        ) as category
      FROM featured_categories fc
      JOIN categories c ON fc.category_id = c.id
      WHERE fc.id = ${id}
    `;

    if (!result) {
      return null;
    }

    return {
      featured: {
        id: result.id,
        category_id: result.category_id,
        sort_order: result.sort_order,
        created_at: result.created_at,
      },
      category: result.category,
    };
  },

  /**
   * Get a featured category by category_id.
   */
  async getByCategoryId(categoryId: string): Promise<FeaturedCategory | null> {
    const [result] = await sql<FeaturedCategory[]>`
      SELECT * FROM featured_categories WHERE category_id = ${categoryId}
    `;
    return result ?? null;
  },

  /**
   * Create a new featured category.
   */
  async create(data: CreateFeaturedCategoryData): Promise<FeaturedCategory> {
    const sortOrderExpr =
      data.sortOrder === undefined
        ? sql`(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM featured_categories)`
        : sql`${data.sortOrder}`;

    const [featured] = await sql<FeaturedCategory[]>`
      INSERT INTO featured_categories (category_id, sort_order)
      VALUES (${data.categoryId}, ${sortOrderExpr})
      RETURNING *
    `;
    return featured;
  },

  /**
   * Update a featured category's sort_order.
   */
  async update(id: string, data: UpdateFeaturedCategoryData): Promise<FeaturedCategory | null> {
    const [featured] = await sql<FeaturedCategory[]>`
      UPDATE featured_categories
      SET sort_order = ${data.sortOrder}
      WHERE id = ${id}
      RETURNING *
    `;
    return featured ?? null;
  },

  /**
   * Delete a featured category.
   */
  async delete(id: string): Promise<boolean> {
    const result = await sql`
      DELETE FROM featured_categories WHERE id = ${id}
    `;
    return result.count > 0;
  },

  /**
   * Check if a featured category exists by ID.
   */
  async exists(id: string): Promise<boolean> {
    const [result] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM featured_categories WHERE id = ${id}) as exists
    `;
    return result?.exists ?? false;
  },

  /**
   * Find which IDs from the provided list do not exist in the database.
   * Returns array of missing IDs (empty if all exist).
   */
  async findMissingIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }

    const results = await sql<{ id: string }[]>`
      SELECT id FROM featured_categories WHERE id = ANY(${ids})
    `;

    const foundIds = new Set(results.map((row) => row.id));
    return ids.filter((id) => !foundIds.has(id));
  },

  /**
   * Bulk update sort_order for multiple featured categories.
   * Uses single UPDATE with unnest for efficiency.
   */
  async reorder(items: ReorderItem[]): Promise<void> {
    if (items.length === 0) return;

    const ids = items.map((i) => i.id);
    const sortOrders = items.map((i) => i.sortOrder);

    await sql`
      UPDATE featured_categories fc
      SET sort_order = v.sort_order
      FROM (
        SELECT unnest(${ids}::uuid[]) as id,
               unnest(${sortOrders}::int[]) as sort_order
      ) as v
      WHERE fc.id = v.id
    `;
  },
};

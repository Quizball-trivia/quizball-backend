import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type {
  ActivityUser,
  CategoryBreakdownItem,
  RecentActivityItem,
  ActionCounts,
  AuditLogInsert,
} from './activity.types.js';

export const activityRepo = {
  async insertAuditLog(params: AuditLogInsert): Promise<void> {
    await sql`
      INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
      VALUES (
        ${params.userId},
        ${params.action},
        ${params.entityType},
        ${params.entityId ?? null},
        ${params.metadata ? sql.json(params.metadata as unknown as Json) : null}
      )
    `;
  },

  async getDailyActivityCounts(
    userId: string,
    from: string,
    to: string
  ): Promise<{ date: string; action: string; entity_type: string; count: number }[]> {
    return sql<{ date: string; action: string; entity_type: string; count: number }[]>`
      SELECT DATE(created_at)::text as date, action, entity_type, COUNT(*)::int as count
      FROM (
        SELECT created_at, action, entity_type
        FROM audit_logs
        WHERE user_id = ${userId}
          AND created_at >= ${from}::date
          AND created_at < (${to}::date + interval '1 day')

        UNION ALL

        SELECT q.created_at, 'create' as action, 'question' as entity_type
        FROM questions q
        WHERE q.created_by = ${userId}
          AND q.created_at >= ${from}::date
          AND q.created_at < (${to}::date + interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.entity_id = q.id AND al.entity_type = 'question' AND al.action = 'create'
          )

        UNION ALL

        SELECT c.created_at, 'create' as action, 'category' as entity_type
        FROM categories c
        WHERE c.created_by = ${userId}
          AND c.created_at >= ${from}::date
          AND c.created_at < (${to}::date + interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.entity_id = c.id AND al.entity_type = 'category' AND al.action = 'create'
          )
      ) all_activity
      GROUP BY date, action, entity_type
      ORDER BY date
    `;
  },

  async getAdminUsers(): Promise<ActivityUser[]> {
    return sql<ActivityUser[]>`
      SELECT id, email FROM users WHERE role = 'admin' ORDER BY email
    `;
  },

  async getCategoryBreakdown(userId: string): Promise<CategoryBreakdownItem[]> {
    return sql<CategoryBreakdownItem[]>`
      SELECT c.id, c.name->>'en' as name, COUNT(q.id)::int as question_count, c.is_active
      FROM categories c
      LEFT JOIN questions q ON q.category_id = c.id AND q.created_by = ${userId}
      WHERE c.created_by = ${userId}
      GROUP BY c.id, c.name->>'en', c.is_active
      ORDER BY question_count DESC
    `;
  },

  async getRecentActivity(userId: string, limit: number): Promise<RecentActivityItem[]> {
    return sql<RecentActivityItem[]>`
      (
        SELECT id, action, entity_type, entity_id, metadata, created_at
        FROM audit_logs
        WHERE user_id = ${userId}
      )
      UNION ALL
      (
        SELECT q.id, 'create' as action, 'question' as entity_type, q.id as entity_id,
          jsonb_build_object(
            'title', COALESCE(NULLIF(q.prompt->>'en', ''), NULLIF(q.prompt->>'ka', ''), q.type),
            'category_name', COALESCE(NULLIF(c.name->>'en', ''), NULLIF(c.name->>'ka', '')),
            'legacy', true
          ) as metadata,
          q.created_at
        FROM questions q
        JOIN categories c ON c.id = q.category_id
        WHERE q.created_by = ${userId}
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.entity_id = q.id AND al.entity_type = 'question' AND al.action = 'create'
          )
      )
      UNION ALL
      (
        SELECT c.id, 'create' as action, 'category' as entity_type, c.id as entity_id,
          jsonb_build_object(
            'name', COALESCE(NULLIF(c.name->>'en', ''), NULLIF(c.name->>'ka', '')),
            'slug', c.slug,
            'legacy', true
          ) as metadata,
          c.created_at
        FROM categories c
        WHERE c.created_by = ${userId}
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.entity_id = c.id AND al.entity_type = 'category' AND al.action = 'create'
          )
      )
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  },

  async getActionCounts(
    userId: string,
    from: string,
    to: string
  ): Promise<ActionCounts> {
    const rows = await sql<{ action: string; count: number }[]>`
      SELECT action, COUNT(*)::int as count
      FROM (
        SELECT action
        FROM audit_logs
        WHERE user_id = ${userId}
          AND created_at >= ${from}::date
          AND created_at < (${to}::date + interval '1 day')

        UNION ALL

        SELECT 'create' as action
        FROM questions q
        WHERE q.created_by = ${userId}
          AND q.created_at >= ${from}::date
          AND q.created_at < (${to}::date + interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.entity_id = q.id AND al.entity_type = 'question' AND al.action = 'create'
          )

        UNION ALL

        SELECT 'create' as action
        FROM categories c
        WHERE c.created_by = ${userId}
          AND c.created_at >= ${from}::date
          AND c.created_at < (${to}::date + interval '1 day')
          AND NOT EXISTS (
            SELECT 1 FROM audit_logs al
            WHERE al.entity_id = c.id AND al.entity_type = 'category' AND al.action = 'create'
          )
      ) all_actions
      GROUP BY action
    `;
    const counts: ActionCounts = {};
    for (const row of rows) {
      counts[row.action] = row.count;
    }
    return counts;
  },
};

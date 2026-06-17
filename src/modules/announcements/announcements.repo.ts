import { sql } from '../../db/index.js';
import type { Json } from '../../db/types.js';
import type { I18nField } from '../../http/schemas/shared.js';
import type { AnnouncementType } from './announcements.schemas.js';

export interface AnnouncementRow {
  id: string;
  title: I18nField;
  body: I18nField;
  type: AnnouncementType;
  is_active: boolean;
  active_from: string | null;
  active_to: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateAnnouncementParams {
  title: I18nField;
  body: I18nField;
  type: AnnouncementType;
  isActive: boolean;
  activeFrom?: string | null;
  activeTo?: string | null;
  createdBy: string | null;
}

export interface UpdateAnnouncementParams {
  title?: I18nField;
  body?: I18nField;
  type?: AnnouncementType;
  isActive?: boolean;
  activeFrom?: string | null;
  activeTo?: string | null;
}

export const announcementsRepo = {
  /**
   * Active announcements visible right now (is_active + within the optional
   * active window), newest first. Drives the player News list.
   */
  async listActive(): Promise<AnnouncementRow[]> {
    return sql<AnnouncementRow[]>`
      SELECT *
      FROM announcements
      WHERE is_active = true
        AND (active_from IS NULL OR active_from <= NOW())
        AND (active_to IS NULL OR active_to > NOW())
      ORDER BY created_at DESC
    `;
  },

  /** All announcements (admin view), newest first. */
  async listAll(): Promise<AnnouncementRow[]> {
    return sql<AnnouncementRow[]>`
      SELECT * FROM announcements ORDER BY created_at DESC
    `;
  },

  async getById(id: string): Promise<AnnouncementRow | null> {
    const [row] = await sql<AnnouncementRow[]>`
      SELECT * FROM announcements WHERE id = ${id}
    `;
    return row ?? null;
  },

  async insert(params: CreateAnnouncementParams): Promise<AnnouncementRow> {
    const [row] = await sql<AnnouncementRow[]>`
      INSERT INTO announcements (title, body, type, is_active, active_from, active_to, created_by)
      VALUES (
        ${sql.json(params.title as unknown as Json)},
        ${sql.json(params.body as unknown as Json)},
        ${params.type},
        ${params.isActive},
        ${params.activeFrom ?? null},
        ${params.activeTo ?? null},
        ${params.createdBy}
      )
      RETURNING *
    `;
    return row;
  },

  async update(id: string, params: UpdateAnnouncementParams): Promise<AnnouncementRow | null> {
    // COALESCE-to-existing for each column: only the fields the caller provided
    // change; everything else keeps its current value. Avoids dynamic SET-clause
    // assembly. `active_from`/`active_to` are nullable, so `undefined` (omitted)
    // keeps the current value while an explicit `null` clears it — handled in the
    // service by only forwarding keys that were present.
    const [row] = await sql<AnnouncementRow[]>`
      UPDATE announcements
      SET
        title = ${params.title !== undefined ? sql.json(params.title as unknown as Json) : sql`title`},
        body = ${params.body !== undefined ? sql.json(params.body as unknown as Json) : sql`body`},
        type = ${params.type ?? sql`type`},
        is_active = ${params.isActive ?? sql`is_active`},
        active_from = ${params.activeFrom !== undefined ? params.activeFrom : sql`active_from`},
        active_to = ${params.activeTo !== undefined ? params.activeTo : sql`active_to`},
        updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
    return row ?? null;
  },

  async remove(id: string): Promise<boolean> {
    const result = await sql`DELETE FROM announcements WHERE id = ${id}`;
    return result.count > 0;
  },
};

import { NotFoundError } from '../../core/errors.js';
import { announcementsRepo, type AnnouncementRow } from './announcements.repo.js';
import type {
  Announcement,
  CreateAnnouncementBody,
  UpdateAnnouncementBody,
} from './announcements.schemas.js';

function toAnnouncement(row: AnnouncementRow): Announcement {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    type: row.type,
    isActive: row.is_active,
    activeFrom: row.active_from,
    activeTo: row.active_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const announcementsService = {
  /** Active announcements for the player News list (newest first). */
  async listActive(): Promise<{ items: Announcement[] }> {
    const rows = await announcementsRepo.listActive();
    return { items: rows.map(toAnnouncement) };
  },

  /** All announcements for the CMS admin list. */
  async listAll(): Promise<{ items: Announcement[] }> {
    const rows = await announcementsRepo.listAll();
    return { items: rows.map(toAnnouncement) };
  },

  async create(input: CreateAnnouncementBody, createdBy: string | null): Promise<Announcement> {
    const row = await announcementsRepo.insert({
      title: input.title,
      body: input.body,
      type: input.type,
      isActive: input.isActive,
      activeFrom: input.activeFrom ?? null,
      activeTo: input.activeTo ?? null,
      createdBy,
    });
    return toAnnouncement(row);
  },

  async update(id: string, input: UpdateAnnouncementBody): Promise<Announcement> {
    const row = await announcementsRepo.update(id, input);
    if (!row) throw new NotFoundError('Announcement not found');
    return toAnnouncement(row);
  },

  async remove(id: string): Promise<void> {
    const deleted = await announcementsRepo.remove(id);
    if (!deleted) throw new NotFoundError('Announcement not found');
  },
};

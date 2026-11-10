/**
 * Content gaps, admin side (CMS / HQ): what players typed that we could not judge well, newest and most typed first.
 * Admin-only: the rows hold typed text and the people the matcher took it for.
 */
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { GAP_VERDICTS } from './content-gaps.buffer.js';

export const GAP_STATUSES = ['open', 'checking', 'fixed', 'junk', 'correct', 'wontfix'] as const;

export const listGapsQuerySchema = z.object({
  game: z.string().min(1).max(40).optional(),
  verdict: z.enum(GAP_VERDICTS).optional(),
  status: z.enum(GAP_STATUSES).default('open'),
  locale: z.string().min(2).max(2).optional(),
  board: z.string().min(1).max(160).optional(),
  minCount: z.coerce.number().int().min(1).max(1_000_000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const gapIdParamSchema = z.object({ id: z.coerce.number().int().positive() });
export const updateGapBodySchema = z.object({ status: z.enum(GAP_STATUSES) }).strict();

type ListQuery = z.infer<typeof listGapsQuerySchema>;

export const contentGapsAdmin = {
  /**
   * Most typed first. Offset paging over live counts can skip or repeat a row while players keep typing: fine for
   * browsing; the agent claims work by status, not by page.
   */
  async list(q: ListQuery) {
    const rows = await sql`
      SELECT g.id, g.game, g.mode, g.board_key AS "boardKey", g.context_fp AS context, g.verdict, g.norm,
             g.resolved_id AS "resolvedId", g.candidate_ids AS "candidateIds", g.count, g.first_seen AS "firstSeen",
             g.last_seen AS "lastSeen", g.status,
             COALESCE((SELECT jsonb_agg(jsonb_build_object('locale', s.locale, 'typed', s.typed) ORDER BY s.seen_at)
                       FROM content_gap_samples s WHERE s.gap_id = g.id), '[]'::jsonb) AS samples
      FROM content_gaps g
      WHERE g.status = ${q.status} AND g.count >= ${q.minCount}
        ${q.game ? sql`AND g.game = ${q.game}` : sql``}
        ${q.verdict ? sql`AND g.verdict = ${q.verdict}` : sql``}
        ${q.board ? sql`AND g.board_key = ${q.board}` : sql``}
        ${q.locale ? sql`AND EXISTS (SELECT 1 FROM content_gap_samples s WHERE s.gap_id = g.id AND s.locale = ${q.locale})` : sql``}
      ORDER BY g.count DESC, g.last_seen DESC, g.id
      LIMIT ${q.limit} OFFSET ${q.offset}
    `;
    return { items: rows };
  },

  /** Counts per game, verdict and status, for the page header and the agent's planning. */
  async summary() {
    const rows = await sql`
      SELECT game, verdict, status, count(*)::int AS gaps, COALESCE(sum(count), 0)::bigint AS typed, max(last_seen) AS "lastSeen"
      FROM content_gaps GROUP BY game, verdict, status ORDER BY game, verdict, status
    `;
    return { items: rows.map((r) => ({ ...r, typed: Number(r.typed) })) };
  },

  async setStatus(id: number, status: (typeof GAP_STATUSES)[number]) {
    const rows = await sql`
      UPDATE content_gaps SET status = ${status}, lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = now()
      WHERE id = ${id} RETURNING id, status
    `;
    return rows[0] ?? null;
  },
};

const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

export const contentGapsAdminController = {
  list: handle(async (req, res) => { res.json(await contentGapsAdmin.list(req.validated.query as ListQuery)); }),
  summary: handle(async (_req, res) => { res.json(await contentGapsAdmin.summary()); }),
  update: handle(async (req, res) => {
    const { id } = req.validated.params as z.infer<typeof gapIdParamSchema>;
    const { status } = req.validated.body as z.infer<typeof updateGapBodySchema>;
    const row = await contentGapsAdmin.setStatus(id, status);
    if (!row) { res.status(404).json({ code: 'NOT_FOUND', message: 'Gap not found', details: null, request_id: null }); return; }
    res.json(row);
  }),
};

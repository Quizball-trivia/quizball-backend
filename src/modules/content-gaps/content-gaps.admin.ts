/**
 * Content gaps, admin side (CMS / HQ): what players typed that we could not judge well, newest and most typed first.
 * Admin-only: the rows hold typed text and the people the matcher took it for.
 */
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { sql } from '../../db/index.js';
import { GAP_VERDICTS } from './content-gaps.buffer.js';

export const GAP_STATUSES = ['open', 'checking', 'proposed', 'verified', 'held', 'fixed', 'junk', 'correct', 'wontfix'] as const;
/** What a person may set a gap to from the CMS (a gap bound to a fix changes through its fix). */
export const GAP_HUMAN_TARGETS = ['open', 'held', 'junk', 'correct', 'wontfix'] as const;
export const FIX_STATUSES = ['proposed', 'verified', 'held', 'rejected', 'published', 'failed', 'rolled_back'] as const;
/** What a person may set a fix to: reject it, hold it, or send it back to the verifier. */
export const FIX_HUMAN_TARGETS = ['rejected', 'held', 'proposed'] as const;

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
const reason = z.string().trim().min(3).max(400);
export const updateGapBodySchema = z.object({ status: z.enum(GAP_HUMAN_TARGETS), expectedRevision: z.number().int().min(0), reason }).strict();
export const listFixesQuerySchema = z.object({
  status: z.enum(FIX_STATUSES).optional(),
  game: z.string().min(1).max(40).optional(),
  kind: z.string().min(1).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export const updateFixBodySchema = z.object({ status: z.enum(FIX_HUMAN_TARGETS), expectedRevision: z.number().int().min(0), reason }).strict();

type ListQuery = z.infer<typeof listGapsQuerySchema>;
type FixQuery = z.infer<typeof listFixesQuerySchema>;
type Actor = string | null;

export const contentGapsAdmin = {
  /**
   * Most typed first. Offset paging over live counts can skip or repeat a row while players keep typing: fine for
   * browsing; the agent claims work by status, not by page.
   */
  async list(q: ListQuery) {
    const rows = await sql`
      SELECT g.id, g.game, g.mode, g.board_key AS "boardKey", g.context_fp AS context, g.verdict, g.norm,
             g.resolved_id AS "resolvedId", g.candidate_ids AS "candidateIds", g.count, g.first_seen AS "firstSeen",
             g.last_seen AS "lastSeen", g.status, g.revision, g.fix_id AS "fixId", g.audit,
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

  /**
   * A person's decision on a gap: compare-and-set on its revision (409 when it moved meanwhile); never on a gap bound to
   * a fix (proposed / verified), whose state follows the fix. Clears any lease.
   */
  async setGapStatus(id: number, status: (typeof GAP_HUMAN_TARGETS)[number], expectedRevision: number, why: string, actor: Actor) {
    const entry = { at: new Date().toISOString(), actor, to: status, reason: why };
    // A person's decision detaches the gap from any (held) fix: that fix can no longer verify for it.
    const rows = await sql`
      UPDATE content_gaps SET status = ${status}, fix_id = NULL, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
             audit = audit || jsonb_build_array(${sql.json(entry as never)}::jsonb || jsonb_build_object('from', status)),
             revision = revision + 1, updated_at = now()
      WHERE id = ${id} AND revision = ${expectedRevision} AND status NOT IN ('proposed', 'verified')
      RETURNING id, status, revision
    `;
    if (rows[0]) return { ok: true as const, row: rows[0] };
    const [exists] = await sql`SELECT id FROM content_gaps WHERE id = ${id}`;
    return { ok: false as const, code: exists ? 'conflict' as const : 'not_found' as const };
  },

  /** Fixes, newest first, with their gaps (what was typed) for the review page. */
  async listFixes(q: FixQuery) {
    const rows = await sql`
      SELECT f.id, f.kind, f.game, f.board_key AS "boardKey", f.gap_ids AS "gapIds", f.payload, f.evidence, f.context,
             f.status, f.proposer, f.verifier, f.verification, f.revision, f.audit, f.created_at AS "createdAt",
             f.verified_at AS "verifiedAt",
             COALESCE((SELECT jsonb_agg(jsonb_build_object('id', g.id, 'verdict', g.verdict, 'norm', g.norm, 'count', g.count, 'status', g.status) ORDER BY g.count DESC)
                       FROM content_gaps g WHERE g.id = ANY(f.gap_ids)), '[]'::jsonb) AS gaps
      FROM content_gap_fixes f
      WHERE TRUE
        ${q.status ? sql`AND f.status = ${q.status}` : sql``}
        ${q.game ? sql`AND f.game = ${q.game}` : sql``}
        ${q.kind ? sql`AND f.kind = ${q.kind}` : sql``}
      ORDER BY f.created_at DESC, f.id DESC
      LIMIT ${q.limit} OFFSET ${q.offset}
    `;
    return { items: rows };
  },

  /**
   * A person's decision on a fix, compare-and-set on its revision, audited (actor, from, to, reason). Rejected or held:
   * its gaps are held for a human (not reopened for the agent to propose the same again); sent back (proposed): the
   * verifier sees it again. Never on a published fix (that is P3's rollback).
   */
  async setFixStatus(id: number, status: (typeof FIX_HUMAN_TARGETS)[number], expectedRevision: number, why: string, actor: Actor) {
    return sql.begin(async (tx) => {
      const run = tx as unknown as typeof sql;
      const [fix] = await run<Array<{ id: string; status: string; gap_ids: string[] }>>`
        SELECT id, status, gap_ids FROM content_gap_fixes WHERE id = ${id} AND revision = ${expectedRevision} FOR UPDATE
      `;
      if (!fix) {
        const [exists] = await run`SELECT id FROM content_gap_fixes WHERE id = ${id}`;
        return { ok: false as const, code: exists ? 'conflict' as const : 'not_found' as const };
      }
      if (['published', 'failed', 'rolled_back'].includes(fix.status) || fix.status === status) return { ok: false as const, code: 'conflict' as const };
      // Back to the verifier only while every gap is still bound to this fix (none reopened or closed by a person).
      if (status === 'proposed') {
        const [{ bound }] = await run<Array<{ bound: boolean }>>`
          SELECT count(*) = ${fix.gap_ids.length} AS bound FROM content_gaps WHERE id = ANY(${fix.gap_ids}::bigint[]) AND fix_id = ${id} AND status IN ('held', 'verified')
        `;
        if (!bound) return { ok: false as const, code: 'conflict' as const };
      }
      const entry = { at: new Date().toISOString(), actor, from: fix.status, to: status, reason: why };
      const [row] = await run`
        UPDATE content_gap_fixes SET status = ${status}, lease_owner = NULL, lease_token = NULL, lease_until = NULL,
               audit = audit || ${run.json([entry] as never)}::jsonb, revision = revision + 1, updated_at = now()
        WHERE id = ${id} RETURNING id, status, revision
      `;
      await run`
        UPDATE content_gaps SET status = ${status === 'proposed' ? 'proposed' : 'held'}, revision = revision + 1, updated_at = now()
        WHERE id = ANY(${fix.gap_ids}::bigint[]) AND fix_id = ${id} AND status IN ('proposed', 'verified', 'held')
      `;
      return { ok: true as const, row };
    });
  },
};

const handle = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next);
};

const fail = (res: Response, code: 'conflict' | 'not_found', what: string) => {
  if (code === 'not_found') res.status(404).json({ code: 'NOT_FOUND', message: `${what} not found`, details: null, request_id: null });
  else res.status(409).json({ code: 'CONFLICT', message: `${what} changed meanwhile: reload`, details: null, request_id: null });
};

export const contentGapsAdminController = {
  list: handle(async (req, res) => { res.json(await contentGapsAdmin.list(req.validated.query as ListQuery)); }),
  summary: handle(async (_req, res) => { res.json(await contentGapsAdmin.summary()); }),
  update: handle(async (req, res) => {
    const { id } = req.validated.params as z.infer<typeof gapIdParamSchema>;
    const body = req.validated.body as z.infer<typeof updateGapBodySchema>;
    const out = await contentGapsAdmin.setGapStatus(id, body.status, body.expectedRevision, body.reason, req.user?.id ?? null);
    if (!out.ok) { fail(res, out.code, 'Gap'); return; }
    res.json(out.row);
  }),
  listFixes: handle(async (req, res) => { res.json(await contentGapsAdmin.listFixes(req.validated.query as FixQuery)); }),
  updateFix: handle(async (req, res) => {
    const { id } = req.validated.params as z.infer<typeof gapIdParamSchema>;
    const body = req.validated.body as z.infer<typeof updateFixBodySchema>;
    const out = await contentGapsAdmin.setFixStatus(id, body.status, body.expectedRevision, body.reason, req.user?.id ?? null);
    if (!out.ok) { fail(res, out.code, 'Fix'); return; }
    res.json(out.row);
  }),
};

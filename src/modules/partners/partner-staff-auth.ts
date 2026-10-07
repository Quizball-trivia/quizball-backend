/** Staff class (`/partner-admin/v1/partners/:slug/*`): a Supabase session sent as a bearer (the qb_access_token cookie
 *  is ignored), held by a Quizball admin or by a partner_staff member of this partner. Exported for the delivery
 *  stream's admin routes too. */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../../core/errors.js';
import { sql } from '../../db/index.js';
import { authenticateRequest } from '../../http/middleware/auth.js';
import { PartnerError } from './partner-errors.js';
import { requirePartnerConfig } from './partner-machine-auth.js';

export type PartnerStaffAccess = 'read' | 'write' | 'admin';

export interface PartnerStaffPrincipal {
  userId: string;
  /** 'admin' = Quizball admin; otherwise the partner membership role. */
  role: 'admin' | 'editor' | 'viewer';
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by partnerStaffAuth on /partner-admin/v1 routes. */
      partnerStaff?: PartnerStaffPrincipal;
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export function partnerStaffAuth(access: PartnerStaffAccess): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const config = requirePartnerConfig();
    const token = bearer(req);
    if (!token) throw new PartnerError('unauthorized');
    try {
      await authenticateRequest(req, token);
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 401) throw new PartnerError('unauthorized');
      if (error instanceof AppError && error.statusCode === 403) throw new PartnerError('forbidden');
      throw error;
    }
    const user = req.user!;
    let role: PartnerStaffPrincipal['role'] | null = null;
    if (user.role === 'admin') {
      role = 'admin';
    } else if (user.role === 'partner_staff') {
      const [membership] = await sql<{ role: 'viewer' | 'editor' }[]>`
        SELECT role FROM partner_operator_memberships WHERE partner_slug = ${config.slug} AND user_id = ${user.id}`;
      role = membership?.role ?? null;
    }
    if (!role) throw new PartnerError('forbidden');
    if (access === 'write' && role === 'viewer') throw new PartnerError('forbidden', 'Editor access is required');
    if (access === 'admin' && role !== 'admin') throw new PartnerError('forbidden', 'Quizball admin access is required');
    req.partnerStaff = { userId: user.id, role };
    next();
  };
}

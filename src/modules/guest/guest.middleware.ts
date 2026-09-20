import type { NextFunction, Request, Response } from 'express';
import { GUEST_TOKEN_HEADER, guestService } from './guest.service.js';

/** Requires a valid guest token (header `x-guest-token`) and attaches `req.guest`. */
export async function guestAuthMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const raw = req.headers[GUEST_TOKEN_HEADER];
    const token = Array.isArray(raw) ? raw[0] : raw;
    const guest = await guestService.resolve(token);
    req.guest = { id: guest.id, locale: guest.locale, linkedUserId: guest.linked_user_id };
    next();
  } catch (error) {
    next(error);
  }
}

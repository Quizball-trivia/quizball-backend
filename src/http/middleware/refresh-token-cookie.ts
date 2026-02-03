import type { Request, Response, NextFunction } from 'express';

export function injectRefreshTokenFromCookie(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  if (!req.body || typeof req.body !== 'object') {
    req.body = {};
  }

  const body = req.body as { refresh_token?: string };
  if (!body.refresh_token && typeof req.cookies?.qb_refresh_token === 'string') {
    body.refresh_token = req.cookies.qb_refresh_token;
  }

  next();
}

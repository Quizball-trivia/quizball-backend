import type { Request } from 'express';
import { marketsService } from './markets.service.js';

/**
 * Who is looking at a list of content.
 *   all: true   — staff: every item, in the list's own order.
 *   all: false  — a player (or a signed-out visitor) in `market`, null when
 *                 their country belongs to no market or is not known.
 */
export type MarketViewer = { all: true } | { all: false; market: string | null };

/**
 * The viewer of a public content list. Uses the profile country of a signed-in
 * player, else the country the edge reports for the request (a header read, no
 * network call). Needs optionalAuthMiddleware in front to see signed-in users.
 */
export async function marketViewerOf(req: Request): Promise<MarketViewer> {
  if (req.user?.role === 'admin') return { all: true };
  const header = req.headers['cf-ipcountry'];
  const country = req.user?.country ?? (typeof header === 'string' ? header : null);
  return { all: false, market: await marketsService.forCountry(country) };
}

import { Router } from 'express';
import { z } from 'zod';
import { requirePartnerConfig } from '../../modules/partners/partner-machine-auth.js';
import { parsePartnerInput, PartnerError } from '../../modules/partners/partner-errors.js';
import { signPartnerAccessToken } from '../../modules/partners/partner-token.js';
import { partnerPlayer } from '../../modules/partners/games/kit.js';
import {
  getOpenPartnerRankedEntry,
  getPartnerRankedResult,
} from '../../modules/partners/games/ranked/ranked-entries.js';

/** The realtime handshake token lives this long at most (and never past the partner session). */
const SOCKET_TOKEN_TTL_MS = 5 * 60_000;

const matchParamsSchema = z.object({ matchId: z.string().uuid() });

/**
 * /partner/v1/games/ranked: ranked itself runs on the socket (queue, draft, match); these calls give the page a
 * handshake token, its open play and a match's result for the "+N points" screen.
 */
export const partnerGameRankedRoutes = Router();

partnerGameRankedRoutes.post('/socket-token', async (req, res) => {
  const partner = partnerPlayer(req);
  const expiresAt = new Date(Math.min(Date.now() + SOCKET_TOKEN_TTL_MS, partner.sessionExpiresAt.getTime()));
  const accessToken = await signPartnerAccessToken(
    requirePartnerConfig(),
    { playerId: partner.playerId, sessionId: partner.sessionId },
    expiresAt,
  );
  res.json({ accessToken, expiresAt: expiresAt.toISOString(), userId: partner.userId });
});

partnerGameRankedRoutes.get('/state', async (req, res) => {
  const partner = partnerPlayer(req);
  const entry = await getOpenPartnerRankedEntry(partner.userId);
  res.json({
    userId: partner.userId,
    activePlay: entry ? { playId: entry.playId, state: entry.state, matchId: entry.matchId } : null,
  });
});

partnerGameRankedRoutes.get('/matches/:matchId/result', async (req, res) => {
  const partner = partnerPlayer(req);
  const { matchId } = parsePartnerInput(matchParamsSchema, req.params);
  const result = await getPartnerRankedResult(partner.userId, matchId);
  if (!result) throw new PartnerError('not_found', 'No ranked play of yours for this match');
  res.json(result);
});

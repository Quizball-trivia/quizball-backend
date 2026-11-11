import express, { type Express, type Request } from 'express';
import type { IncomingMessage } from 'node:http';
import { authMiddleware } from './middleware/auth.js';
import { requireRole } from './middleware/require-role.js';
import { campaignAgentAuth } from './middleware/campaign-agent-auth.js';
import { requireOpsToken } from '../modules/ops/ops.controller.js';

function keepRawBody(req: IncomingMessage, _res: unknown, buf: Buffer): void {
  (req as Request).rawBody = buf.toString('utf8');
}

const adminOnly = [authMiddleware, requireRole('admin')];

/**
 * The only routes allowed a body above the app-wide 1 MB, or given the raw body. Each runs its own caller check
 * before its parser, so a large body is only read for a caller the route would accept. Mounted before the app-wide
 * parsers, which then skip the already-parsed body.
 */
export function mountRouteBodyParsers(app: Express): void {
  // Signed over the exact raw JSON: the Supabase Auth SMS hook and the Resend webhook.
  const signedJson = express.json({ limit: '256kb', verify: keepRawBody });
  app.post(['/api/v1/auth/sms/supabase-hook', '/api/v1/email/resend/webhook'], signedJson);

  // Up to 3 data-URL attachments of 70 MiB each (feedback.schemas.ts). The feedback rate limiter runs before this.
  app.post('/api/v1/feedback', express.json({ limit: '215mb' }));

  // One image data URL of up to 16,000,000 characters.
  const imageUpload = express.json({ limit: '16mb' });
  app.post('/api/v1/admin/campaign-quizzes/images', ...adminOnly, imageUpload);
  app.post('/api/v1/agent/campaign-quizzes/images', campaignAgentAuth, imageUpload);

  // A page in 8 languages, each with up to 40 about blocks of 4,000 characters: ~1.4M characters, 3 bytes each in UTF-8.
  const campaignPage = express.json({ limit: '5mb' });
  app.post('/api/v1/admin/campaign-quizzes', ...adminOnly, campaignPage);
  app.put('/api/v1/admin/campaign-quizzes/:slug', ...adminOnly, campaignPage);
  app.post(['/api/v1/agent/campaign-quizzes/validate', '/api/v1/agent/campaign-quizzes/commit'], campaignAgentAuth, campaignPage);

  // Up to 200 generated cards, each with its PNG as a data URL the schema does not bound: kept at the old ceiling.
  app.post('/api/v1/questions/image-mcq/save-drafts', ...adminOnly, express.json({ limit: '500mb' }));

  // Content imports (100-124 questions, a pasted clue-card sheet) whose text fields have no length bound: 100x the
  // 100 kB default /questions/bulk, whose question shape the WL imports reuse, ran on before June 2026.
  app.post(
    [
      '/api/v1/questions/bulk',
      '/api/v1/admin/wl/content/check',
      '/api/v1/admin/wl/content/import',
      '/api/v1/admin/wl/content/lineup/preview',
      '/api/v1/admin/player-clue-cards/import/preview',
      '/api/v1/admin/player-clue-cards/import/commit',
    ],
    ...adminOnly,
    express.json({ limit: '10mb' }),
  );

  // Up to 50 texts of 20,000 characters each, 3 bytes each in UTF-8.
  app.post('/api/v1/admin/translation/translate', ...adminOnly, express.json({ limit: '3mb' }));

  // HTML and text of up to 500,000 characters each, 3 bytes each in UTF-8.
  app.post('/api/v1/internal/ops/daily-report', requireOpsToken, express.json({ limit: '3mb' }));
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express, { type Express, type Request } from 'express';
import { Webhook } from 'standardwebhooks';

import '../setup.js';

const mocks = vi.hoisted(() => ({
  submitFeedback: vi.fn(),
  sendSupabaseSmsHook: vi.fn(),
  handleProviderEvent: vi.fn(),
  constructEvent: vi.fn(),
  // A route's own handler, reached only once its real validation accepted the body.
  accept: vi.fn((_req: unknown, res: { status(code: number): { json(body: unknown): void } }) => res.status(200).json({ accepted: true })),
  wlService: vi.fn(async () => ({ accepted: true })),
}));

// Sessions: 'Bearer synthetic-admin' is an admin, 'Bearer synthetic-player' a player, anything else is refused.
vi.mock('../../src/http/middleware/auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/http/middleware/auth.js')>();
  const { AuthenticationError } = await import('../../src/core/errors.js');
  const roles: Record<string, string> = { 'Bearer synthetic-admin': 'admin', 'Bearer synthetic-player': 'user' };
  return {
    ...actual,
    authMiddleware: vi.fn((req: Request, _res: unknown, next: (err?: unknown) => void) => {
      const role = roles[req.headers.authorization ?? ''];
      if (!role) {
        next(new AuthenticationError('Missing auth token'));
        return;
      }
      req.user = { id: `synthetic-${role}`, role } as Request['user'];
      next();
    }),
  };
});

vi.mock('../../src/modules/feedback/feedback.service.js', () => ({
  feedbackService: { submit: mocks.submitFeedback },
}));

vi.mock('../../src/modules/auth/auth.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auth/auth.service.js')>();
  return { ...actual, authService: { ...actual.authService, sendSupabaseSmsHook: mocks.sendSupabaseSmsHook } };
});

vi.mock('../../src/modules/retention-email/retention-email.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/retention-email/retention-email.service.js')>();
  return { ...actual, handleRetentionEmailProviderEvent: mocks.handleProviderEvent };
});

vi.mock('../../src/modules/store/stripe.js', () => ({
  stripe: { webhooks: { constructEvent: mocks.constructEvent } },
}));

vi.mock('../../src/modules/store/store.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/store/store.service.js')>();
  return {
    ...actual,
    storeService: { ...actual.storeService, logWebhookReceived: vi.fn(), logWebhookSignatureInvalid: vi.fn() },
  };
});

vi.mock('../../src/modules/campaign-quizzes/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/campaign-quizzes/index.js')>();
  return {
    ...actual,
    adminCampaignQuizzesController: { ...actual.adminCampaignQuizzesController, uploadImage: mocks.accept, create: mocks.accept, update: mocks.accept },
    campaignQuizAgentController: { ...actual.campaignQuizAgentController, uploadImage: mocks.accept, validate: mocks.accept, commit: mocks.accept },
  };
});

vi.mock('../../src/modules/questions/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/questions/index.js')>();
  return { ...actual, questionsController: { ...actual.questionsController, bulkCreate: mocks.accept, saveImageMcqDrafts: mocks.accept } };
});

vi.mock('../../src/modules/translation/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/translation/index.js')>();
  return { ...actual, translationController: { ...actual.translationController, translate: mocks.accept } };
});

vi.mock('../../src/modules/auction/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/auction/index.js')>();
  return { ...actual, playerClueCardsController: { ...actual.playerClueCardsController, previewImport: mocks.accept, commitImport: mocks.accept } };
});

vi.mock('../../src/modules/ops/ops.controller.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/ops/ops.controller.js')>();
  return { ...actual, opsController: { ...actual.opsController, sendDailyReport: mocks.accept } };
});

// The WL routes validate in their controller, so the services behind it are mocked instead.
vi.mock('../../src/modules/weekend-league/wl-content.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/weekend-league/wl-content.service.js')>();
  return { ...actual, wlContentCheck: mocks.wlService, wlContentImport: mocks.wlService };
});

vi.mock('../../src/modules/weekend-league/wl-lineup.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/modules/weekend-league/wl-lineup.service.js')>();
  return { ...actual, wlLineupPreview: mocks.wlService };
});

import { createApp } from '../../src/app.js';
import { config } from '../../src/core/config.js';

const MIB = 1024 * 1024;
const AGENT_TOKEN = 'synthetic-agent-token';
const OPS_TOKEN = 'synthetic-ops-token';
const HOOK_SECRET = Buffer.from('synthetic-hook-secret-0123456789').toString('base64');
const RESEND_SECRET = Buffer.from('synthetic-resend-secret-01234567').toString('base64');

function jsonOfSize(bytes: number): string {
  const shell = JSON.stringify({ padding: '' });
  return JSON.stringify({ padding: 'a'.repeat(bytes - shell.length) });
}

let seen: Request | undefined;

/** The real app, wrapped so a test can look at the request it handled. */
function buildApp(): Express {
  const app = express();
  app.use((req, res, next) => {
    res.on('finish', () => {
      seen = req;
    });
    next();
  });
  app.use(createApp());
  return app;
}

/**
 * Sends the headers of a `declaredBytes` JSON body but only its first 1 KiB, and resolves with the status of a
 * response that arrives anyway: proof the route refused the caller without waiting to read the body.
 */
function statusWithoutSendingBody(
  app: Express,
  method: string,
  path: string,
  headers: Record<string, string>,
  declaredBytes = 2 * MIB,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      const timer = setTimeout(() => {
        req.destroy();
        server.close();
        reject(new Error(`${method} ${path}: no response before the body was sent`));
      }, 3_000);
      const req = http.request(
        {
          // The address supertest uses, so both count against the same per-IP limiter.
          host: '127.0.0.1',
          port,
          method,
          path,
          headers: { ...headers, 'content-type': 'application/json', 'content-length': String(declaredBytes) },
        },
        (res) => {
          clearTimeout(timer);
          res.resume();
          req.destroy();
          server.close();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', () => undefined);
      req.write(`{"padding":"${'a'.repeat(1024)}`);
    });
  });
}

const savedConfig = {
  SUPABASE_SMS_HOOK_SECRET: config.SUPABASE_SMS_HOOK_SECRET,
  RESEND_WEBHOOK_SECRET: config.RESEND_WEBHOOK_SECRET,
  STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET,
  CAMPAIGN_AGENT_TOKEN_SHA256: config.CAMPAIGN_AGENT_TOKEN_SHA256,
  CAMPAIGN_AGENT_USER_ID: config.CAMPAIGN_AGENT_USER_ID,
  OPS_REPORT_TOKEN: config.OPS_REPORT_TOKEN,
};

beforeAll(() => {
  config.SUPABASE_SMS_HOOK_SECRET = `v1,whsec_${HOOK_SECRET}`;
  config.RESEND_WEBHOOK_SECRET = `whsec_${RESEND_SECRET}`;
  config.STRIPE_WEBHOOK_SECRET = 'whsec_synthetic';
  config.CAMPAIGN_AGENT_TOKEN_SHA256 = createHash('sha256').update(AGENT_TOKEN).digest('hex');
  config.CAMPAIGN_AGENT_USER_ID = '00000000-0000-4000-8000-000000000001';
  config.OPS_REPORT_TOKEN = OPS_TOKEN;
});

afterAll(() => {
  Object.assign(config, savedConfig);
});

beforeEach(() => {
  vi.clearAllMocks();
  seen = undefined;
});

describe('Feedback body limit', () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  const feedback = (attachments?: string[]) => ({
    category: 'bug',
    message: 'Synthetic report',
    email: 'player@example.test',
    nickname: 'synthetic-player',
    ...(attachments ? { attachments } : {}),
  });

  it('accepts a ~2 MiB image attachment and validates it', async () => {
    mocks.submitFeedback.mockResolvedValue(undefined);
    const attachment = `data:image/png;base64,${'A'.repeat(2 * MIB)}`;
    const res = await request(app).post('/api/v1/feedback').send(feedback([attachment]));
    expect(res.status).toBe(200);
    expect(mocks.submitFeedback).toHaveBeenCalledTimes(1);
    expect(mocks.submitFeedback.mock.calls[0][0].attachments[0]).toBe(attachment);
    expect(seen?.rawBody).toBeUndefined();
  });

  it('keeps the 1 MB default on the season 3 sub-paths', async () => {
    const res = await request(app)
      .post('/api/v1/feedback/season3')
      .set('Content-Type', 'application/json')
      .send(jsonOfSize(MIB + 512 * 1024));
    expect(res.status).toBe(413);
  });

  it('rate-limits before reading a large attachment', async () => {
    const limited = buildApp();
    mocks.submitFeedback.mockResolvedValue(undefined);
    for (let i = 0; i < 5; i += 1) {
      expect((await request(limited).post('/api/v1/feedback').send(feedback())).status).toBe(200);
    }
    expect(await statusWithoutSendingBody(limited, 'POST', '/api/v1/feedback', {}, 3 * MIB)).toBe(429);
  });
});

describe('Raw body for signed webhooks', () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  // Odd spacing and non-ASCII text: any re-serialisation would change the bytes.
  const hookPayload = '{ "user" : { "phone": "+10000000000", "user_metadata": { "name": "Jögador ⚽" } },\n  "sms": { "otp": "123456" } }';

  function supabaseHeaders(payload: string): Record<string, string> {
    const now = new Date();
    return {
      'content-type': 'application/json',
      'webhook-id': 'msg_synthetic',
      'webhook-timestamp': Math.floor(now.getTime() / 1000).toString(),
      'webhook-signature': new Webhook(HOOK_SECRET).sign('msg_synthetic', now, payload),
    };
  }

  it('verifies a correctly signed Supabase SMS hook over the exact raw bytes', async () => {
    mocks.sendSupabaseSmsHook.mockResolvedValue(undefined);
    const res = await request(app).post('/api/v1/auth/sms/supabase-hook').set(supabaseHeaders(hookPayload)).send(hookPayload);
    expect(res.status).toBe(200);
    expect(mocks.sendSupabaseSmsHook).toHaveBeenCalledTimes(1);
    expect(seen?.rawBody).toBe(hookPayload);
  });

  it('still refuses a tampered Supabase SMS hook', async () => {
    const tampered = hookPayload.replace('123456', '654321');
    const res = await request(app).post('/api/v1/auth/sms/supabase-hook').set(supabaseHeaders(hookPayload)).send(tampered);
    expect(res.status).toBe(401);
    expect(mocks.sendSupabaseSmsHook).not.toHaveBeenCalled();
  });

  const resendPayload = '{"type":"email.delivered", "created_at":"2026-01-01T00:00:00.000Z","data":{"email_id":"synthetic-email"}}';

  function resendHeaders(payload: string): Record<string, string> {
    const now = new Date();
    return {
      'content-type': 'application/json',
      'svix-id': 'msg_synthetic_resend',
      'svix-timestamp': Math.floor(now.getTime() / 1000).toString(),
      'svix-signature': new Webhook(RESEND_SECRET).sign('msg_synthetic_resend', now, payload),
    };
  }

  it('verifies a correctly signed Resend webhook over the exact raw bytes', async () => {
    mocks.handleProviderEvent.mockResolvedValue(undefined);
    const res = await request(app).post('/api/v1/email/resend/webhook').set(resendHeaders(resendPayload)).send(resendPayload);
    expect(res.status).toBe(200);
    expect(mocks.handleProviderEvent).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'msg_synthetic_resend' }));
    expect(seen?.rawBody).toBe(resendPayload);
  });

  it('still refuses a tampered Resend webhook', async () => {
    const tampered = resendPayload.replace('delivered', 'opened');
    const res = await request(app).post('/api/v1/email/resend/webhook').set(resendHeaders(resendPayload)).send(tampered);
    expect(res.status).toBe(400);
    expect(mocks.handleProviderEvent).not.toHaveBeenCalled();
  });

  it('caps the signed webhooks at 256 kB', async () => {
    const res = await request(app)
      .post('/api/v1/email/resend/webhook')
      .set('Content-Type', 'application/json')
      .send(jsonOfSize(300 * 1024));
    expect(res.status).toBe(413);
  });

  it('still hands the Stripe webhook its raw bytes', async () => {
    const payload = '{ "id": "evt_synthetic", "type": "synthetic.event" }';
    mocks.constructEvent.mockReturnValue({ id: 'evt_synthetic', type: 'synthetic.event', data: { object: {} } });
    const res = await request(app)
      .post('/api/v1/store/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', 't=1,v1=synthetic')
      .send(payload);
    expect(res.status).toBe(200);
    const received = mocks.constructEvent.mock.calls[0][0] as Buffer;
    expect(Buffer.isBuffer(received)).toBe(true);
    expect(received.toString('utf8')).toBe(payload);
  });
});

type LargeRoute = { method: 'POST' | 'PUT'; path: string; credential: Record<string, string>; limitMiB: number };

const admin = { authorization: 'Bearer synthetic-admin' };
const LARGE_ROUTES: LargeRoute[] = [
  { method: 'POST', path: '/api/v1/admin/campaign-quizzes/images', credential: admin, limitMiB: 16 },
  { method: 'POST', path: '/api/v1/admin/campaign-quizzes', credential: admin, limitMiB: 5 },
  { method: 'PUT', path: '/api/v1/admin/campaign-quizzes/synthetic-page', credential: admin, limitMiB: 5 },
  { method: 'POST', path: '/api/v1/questions/image-mcq/save-drafts', credential: admin, limitMiB: 500 },
  { method: 'POST', path: '/api/v1/questions/bulk', credential: admin, limitMiB: 10 },
  { method: 'POST', path: '/api/v1/admin/wl/content/check', credential: admin, limitMiB: 10 },
  { method: 'POST', path: '/api/v1/admin/wl/content/import', credential: admin, limitMiB: 10 },
  { method: 'POST', path: '/api/v1/admin/wl/content/lineup/preview', credential: admin, limitMiB: 10 },
  { method: 'POST', path: '/api/v1/admin/player-clue-cards/import/preview', credential: admin, limitMiB: 10 },
  { method: 'POST', path: '/api/v1/admin/player-clue-cards/import/commit', credential: admin, limitMiB: 10 },
  { method: 'POST', path: '/api/v1/admin/translation/translate', credential: admin, limitMiB: 3 },
  { method: 'POST', path: '/api/v1/agent/campaign-quizzes/images', credential: { authorization: `Bearer ${AGENT_TOKEN}` }, limitMiB: 16 },
  { method: 'POST', path: '/api/v1/agent/campaign-quizzes/validate', credential: { authorization: `Bearer ${AGENT_TOKEN}` }, limitMiB: 5 },
  { method: 'POST', path: '/api/v1/agent/campaign-quizzes/commit', credential: { authorization: `Bearer ${AGENT_TOKEN}` }, limitMiB: 5 },
  { method: 'POST', path: '/api/v1/internal/ops/daily-report', credential: { 'x-ops-report-token': OPS_TOKEN }, limitMiB: 3 },
];

describe('Large-body routes are gated before their parser', () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  const send = (route: LargeRoute, headers: Record<string, string>, body: string) => {
    const req = route.method === 'PUT' ? request(app).put(route.path) : request(app).post(route.path);
    return req.set({ ...headers, 'content-type': 'application/json' }).send(body);
  };

  it.each(LARGE_ROUTES)('$method $path reads a body above 1 MiB for an authorised caller', async (route) => {
    const size = MIB + 512 * 1024;
    const res = await send(route, route.credential, jsonOfSize(size));
    // Parsed in full and handed to the route's own validation, which refuses the synthetic shape.
    expect(res.status).toBe(422);
    expect((seen?.body as { padding?: string }).padding?.length).toBe(size - JSON.stringify({ padding: '' }).length);
    expect(seen?.rawBody).toBeUndefined();
  });

  it.each(LARGE_ROUTES)('$method $path refuses an anonymous 2 MiB body with 401', async (route) => {
    const res = await send(route, {}, jsonOfSize(2 * MIB));
    expect(res.status).toBe(401);
  });

  it.each(LARGE_ROUTES)('$method $path refuses an anonymous caller without reading the body', async (route) => {
    expect(await statusWithoutSendingBody(app, route.method, route.path, {})).toBe(401);
  });

  it.each(LARGE_ROUTES.filter((route) => route.credential === admin))(
    '$method $path refuses a player session with 403 without reading the body',
    async (route) => {
      expect(await statusWithoutSendingBody(app, route.method, route.path, { authorization: 'Bearer synthetic-player' })).toBe(403);
    },
  );

  it.each(LARGE_ROUTES.filter((route) => route.limitMiB <= 16))(
    '$method $path refuses an authorised body just above its $limitMiB MiB limit with 413',
    async (route) => {
      const res = await send(route, route.credential, jsonOfSize(route.limitMiB * MIB + 64 * 1024));
      expect(res.status).toBe(413);
    },
  );
});

// Synthetic, schema-valid bodies above 1 MiB for every large route.
const LOCALES = ['en', 'ka', 'es', 'ru', 'pt', 'de', 'fr', 'tr'] as const;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const imageBody = { data_url: `data:image/webp;base64,${'A'.repeat(MIB + 256 * 1024)}`, kind: 'hero', slug: 'synthetic-page' };

const question = (index: number) => ({
  type: 'true_false',
  difficulty: 'easy',
  prompt: { en: `Synthetic statement ${index}` },
  explanation: Object.fromEntries(LOCALES.map((locale) => [locale, `${locale} ${'x'.repeat(1_500)}`])),
  payload: {
    type: 'true_false',
    options: [
      { id: 'true', text: { en: 'True' }, is_correct: true },
      { id: 'false', text: { en: 'False' }, is_correct: false },
    ],
  },
});
const questions = Array.from({ length: 100 }, (_, index) => question(index));

const aboutBlocks = (locale: string) =>
  Array.from({ length: 40 }, (_, index) => ({ id: `block-${index}`, type: 'paragraph', text: `${locale} ${'b'.repeat(3_990)}` }));
const pageCopy = (locale: string) => ({
  title: `${locale} synthetic quiz`,
  h1: `${locale} synthetic quiz`,
  seo_title: `${locale} synthetic quiz`,
  meta_description: `${locale} ten questions`,
  breadcrumb_label: `${locale} synthetic`,
  lede: `${locale} lede`,
  about_heading: `${locale} about`,
  hero_image_alt: `${locale} artwork`,
  og_image_alt: null,
  score_cta: `${locale} you scored {score}`,
  footer_banner_text: `${locale} banner`,
  footer_button_label: `${locale} play`,
  about_blocks: aboutBlocks(locale),
});
const adminPage = {
  ...pageCopy('en'),
  internal_name: 'Synthetic page',
  slug: 'synthetic-page',
  category: 'team',
  question_set_slug: 'synthetic-page',
  related_slugs: [],
  hero_image_url: null,
  og_image_url: null,
  locale_mode: 'en_ka',
  editions: Object.fromEntries(LOCALES.filter((locale) => locale !== 'en').map((locale) => [locale, pageCopy(locale)])),
};
const candidate = {
  action: 'create',
  slug: 'synthetic-page',
  expected_version: null,
  internal_name: 'Synthetic page',
  category: 'team',
  copy: Object.fromEntries(LOCALES.map((locale) => [locale, pageCopy(locale)])),
  public_slugs: Object.fromEntries(LOCALES.map((locale) => [locale, locale === 'en' || locale === 'ka' ? 'synthetic-page' : `${locale}-synthetic-page`])),
  hero_image_url: 'campaign-quizzes/synthetic.webp',
  og_image_url: null,
  questions: ['easy', 'easy', 'easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'hard'].map((difficulty, index) => ({ id: uuid(index + 1), difficulty })),
  next_refresh_at: '2099-01-01T00:00:00.000Z',
};
const imageCard = {
  id: 'synthetic-card',
  category_id: uuid(20),
  category_slug: 'synthetic',
  category_name: 'Synthetic',
  prompt: { en: 'Synthetic prompt' },
  difficulty: 'easy',
  options: ['a', 'b', 'c', 'd'].map((id, index) => ({ id, text: { en: `Option ${id}` }, is_correct: index === 0 })),
  explanation: { en: 'Synthetic explanation' },
  confidence: 0.5,
  image: {
    data_url: `data:image/png;base64,${'A'.repeat(MIB + 256 * 1024)}`,
    width: 1440,
    height: 1080,
    aspect_ratio: '4:3',
    source_url: 'https://example.test/synthetic.png',
    title: 'Synthetic image',
    author: null,
    license: null,
    license_url: null,
    provider: 'synthetic',
  },
};
const clueRows = Array.from({ length: 1_000 }, (_, index) => ({
  rowIndex: index,
  answerName: `Synthetic Player ${index}`,
  clue1: 'c'.repeat(150),
  clue2: 'c'.repeat(150),
  clue3: 'c'.repeat(150),
  footballPlayerId: uuid(1_000 + index),
  originalText: 'o'.repeat(800),
}));
// Two-byte UTF-8 letters: these routes' character caps only pass 1 MiB with non-ASCII text.
const wide = (chars: number) => 'ж'.repeat(chars);

const VALID_LARGE_BODIES: Record<string, unknown> = {
  'POST /api/v1/admin/campaign-quizzes/images': imageBody,
  'POST /api/v1/admin/campaign-quizzes': adminPage,
  'PUT /api/v1/admin/campaign-quizzes/synthetic-page': adminPage,
  'POST /api/v1/questions/image-mcq/save-drafts': { cards: [imageCard] },
  'POST /api/v1/questions/bulk': { category_id: uuid(30), questions },
  'POST /api/v1/admin/wl/content/check': { questions },
  'POST /api/v1/admin/wl/content/import': { kind: 'true_false', questions },
  'POST /api/v1/admin/wl/content/lineup/preview': {
    tournament_id: uuid(40),
    scope: 'game_0',
    questions,
    slots: questions.map(() => ({ game_index: 0, round_index: null, question_index: null, reserve_ordinal: 0 })),
  },
  'POST /api/v1/admin/player-clue-cards/import/preview': { text: 'Synthetic clue line\n'.repeat(70_000), locale: 'en' },
  'POST /api/v1/admin/player-clue-cards/import/commit': { locale: 'en', rows: clueRows },
  'POST /api/v1/admin/translation/translate': {
    target_locale: 'ka',
    items: Array.from({ length: 50 }, (_, index) => ({ id: `item-${index}`, text: wide(20_000) })),
  },
  'POST /api/v1/agent/campaign-quizzes/images': imageBody,
  'POST /api/v1/agent/campaign-quizzes/validate': candidate,
  'POST /api/v1/agent/campaign-quizzes/commit': { idempotency_key: 'synthetic-commit-0001', candidate },
  'POST /api/v1/internal/ops/daily-report': { to: 'ops@example.test', subject: 'Synthetic report', html: `<p>${wide(499_000)}</p>`, text: wide(400_000) },
};

describe('Large-body routes accept a valid body above 1 MiB', () => {
  let app: Express;
  beforeAll(() => {
    app = buildApp();
  });

  it('has a valid body for every large route', () => {
    expect(Object.keys(VALID_LARGE_BODIES).sort()).toEqual(LARGE_ROUTES.map((route) => `${route.method} ${route.path}`).sort());
  });

  it.each(LARGE_ROUTES)('$method $path accepts a valid body above 1 MiB from an authorised caller', async (route) => {
    const body = JSON.stringify(VALID_LARGE_BODIES[`${route.method} ${route.path}`]);
    expect(Buffer.byteLength(body)).toBeGreaterThan(MIB);
    expect(Buffer.byteLength(body)).toBeLessThan(route.limitMiB * MIB);
    const req = route.method === 'PUT' ? request(app).put(route.path) : request(app).post(route.path);
    const res = await req.set({ ...route.credential, 'content-type': 'application/json' }).send(body);
    expect(res.status, JSON.stringify(res.body).slice(0, 500)).toBeLessThan(300);
    expect(mocks.accept.mock.calls.length + mocks.wlService.mock.calls.length).toBe(1);
  });
});

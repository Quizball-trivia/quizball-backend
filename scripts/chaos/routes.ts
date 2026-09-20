// Route catalog for the chaos harness. Each entry is one endpoint the harness
// can drive at a target RPS. `auth` decides whether a bearer token is attached.
// `mutates` flags state-changing routes — these are gated to non-prod targets.
// `weight` lets the mixed-traffic mode bias toward hot paths.

export type RouteAuth = 'none' | 'bearer';

export interface ChaosRoute {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  // Path under the API base. `{userId}` is substituted with the caller's own id.
  path: string | ((ctx: RouteBodyContext) => string);
  auth: RouteAuth;
  mutates: boolean;
  // Static or per-call JSON body. A function receives the caller context.
  body?: (ctx: RouteBodyContext) => unknown;
  // Query string appended verbatim (already URL-encoded).
  query?: string | ((ctx: RouteBodyContext) => string);
  weight: number;
  // In the production-shaped mixed scheduler, stop selecting this action once
  // every test user has performed it this many times. This keeps one-time
  // journeys (daily session/complete) realistic while the remaining RPS is
  // redistributed to repeatable reads and writes.
  maxPerUser?: number;
  // Business-state responses that are valid for a repeated load-test action.
  // Any other 4xx remains an unexpected client error and fails the SLO gate.
  expectedStatuses?: number[];
  // Routes a real client hammers during normal play vs. economy/social writes.
  group: 'public-read' | 'auth-read' | 'economy-write' | 'social-write' | 'session-write';
}

export interface RouteBodyContext {
  userId: string;
  email: string;
  otherUserId: string;
  categoryId: string;
  questionId: string;
  featuredCategoryId: string;
}

export interface ChaosRouteFixtures {
  categoryId: string;
  questionId: string;
  featuredCategoryId: string;
}

const KNOWN_CHALLENGE = 'countdown';
const ADDITIONAL_DAILY_CHALLENGES = [
  'moneyDrop',
  'trueFalse',
  'clues',
  'putInOrder',
  'imposter',
  'careerPath',
  'highLow',
  'footballLogic',
] as const;

export const CHAOS_ROUTES: ChaosRoute[] = [
  // ── Public reads (no token) — the unauthenticated browse surface ──────────
  { name: 'categories.list', method: 'GET', path: '/api/v1/categories', query: 'limit=100&is_active=true&page=1', auth: 'none', mutates: false, weight: 6, group: 'public-read' },
  { name: 'categories.list.minq', method: 'GET', path: '/api/v1/categories', query: 'limit=100&is_active=true&min_questions=5', auth: 'none', mutates: false, weight: 4, group: 'public-read' },
  { name: 'categories.detail', method: 'GET', path: (ctx) => `/api/v1/categories/${ctx.categoryId}`, auth: 'none', mutates: false, weight: 1, group: 'public-read' },
  { name: 'questions.list', method: 'GET', path: '/api/v1/questions', query: 'limit=50&page=1&status=published', auth: 'bearer', mutates: false, weight: 5, group: 'auth-read' },
  { name: 'questions.detail', method: 'GET', path: (ctx) => `/api/v1/questions/${ctx.questionId}`, auth: 'bearer', mutates: false, weight: 1, group: 'auth-read' },
  { name: 'featured.list', method: 'GET', path: '/api/v1/featured-categories', auth: 'none', mutates: false, weight: 3, group: 'public-read' },
  { name: 'featured.detail', method: 'GET', path: (ctx) => `/api/v1/featured-categories/${ctx.featuredCategoryId}`, auth: 'none', mutates: false, weight: 1, group: 'public-read' },
  { name: 'store.products', method: 'GET', path: '/api/v1/store/products', auth: 'none', mutates: false, weight: 3, group: 'public-read' },

  // ── Authenticated reads — the hot client polling set during play/menus ────
  { name: 'users.me', method: 'GET', path: '/api/v1/users/me', auth: 'bearer', mutates: false, weight: 6, group: 'auth-read' },
  { name: 'users.me.achievements', method: 'GET', path: '/api/v1/users/me/achievements', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'ranked.profile', method: 'GET', path: '/api/v1/ranked/profile', auth: 'bearer', mutates: false, weight: 5, group: 'auth-read' },
  { name: 'ranked.leaderboard.global', method: 'GET', path: '/api/v1/ranked/leaderboard', query: 'scope=global&limit=50&offset=0', auth: 'bearer', mutates: false, weight: 5, group: 'auth-read' },
  { name: 'ranked.leaderboard.country', method: 'GET', path: '/api/v1/ranked/leaderboard', query: 'scope=country&limit=50&offset=0', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'ranked.leaderboard.me', method: 'GET', path: '/api/v1/ranked/leaderboard/me', query: 'scope=global', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'stats.summary', method: 'GET', path: '/api/v1/stats/summary', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'stats.head-to-head', method: 'GET', path: '/api/v1/stats/head-to-head', query: (ctx) => `userA=${ctx.userId}&userB=${ctx.otherUserId}`, auth: 'bearer', mutates: false, weight: 1, group: 'auth-read' },
  { name: 'stats.recent', method: 'GET', path: '/api/v1/stats/recent-matches', query: 'limit=10', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'store.wallet', method: 'GET', path: '/api/v1/store/wallet', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'store.inventory', method: 'GET', path: '/api/v1/store/inventory', auth: 'bearer', mutates: false, weight: 3, group: 'auth-read' },
  { name: 'daily.list', method: 'GET', path: '/api/v1/daily-challenges', auth: 'bearer', mutates: false, weight: 4, group: 'auth-read' },
  { name: 'objectives.list', method: 'GET', path: '/api/v1/objectives', auth: 'bearer', mutates: false, weight: 3, group: 'auth-read' },
  { name: 'lobbies.public', method: 'GET', path: '/api/v1/lobbies/public', auth: 'bearer', mutates: false, weight: 3, group: 'auth-read' },
  { name: 'friends.list', method: 'GET', path: '/api/v1/friends', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'friends.requests', method: 'GET', path: '/api/v1/friends/requests', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'announcements.list', method: 'GET', path: '/api/v1/announcements', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'notifications.list', method: 'GET', path: '/api/v1/notifications', query: 'limit=20', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'notifications.unread', method: 'GET', path: '/api/v1/notifications/unread-count', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'users.search', method: 'GET', path: '/api/v1/users/search', query: 'q=chaos&limit=20', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'users.profile.self', method: 'GET', path: '/api/v1/users/{userId}/profile', auth: 'bearer', mutates: false, weight: 2, group: 'auth-read' },
  { name: 'users.achievements.self', method: 'GET', path: '/api/v1/users/{userId}/achievements', auth: 'bearer', mutates: false, weight: 1, group: 'auth-read' },

  // ── Mutations (non-prod only) — economy / session / presence writes ───────
  {
    name: 'daily.session',
    method: 'POST',
    path: `/api/v1/daily-challenges/${KNOWN_CHALLENGE}/session`,
    auth: 'bearer',
    mutates: true,
    weight: 2,
    maxPerUser: 1,
    // A deployment with no active challenge returns 404; repeated session
    // creation for the same challenge returns 409. Both are valid business
    // states, not malformed load requests.
    expectedStatuses: [200, 404, 409],
    group: 'session-write',
  },
  ...ADDITIONAL_DAILY_CHALLENGES.map((challengeType): ChaosRoute => ({
    name: `daily.session.${challengeType}`,
    method: 'POST',
    path: `/api/v1/daily-challenges/${challengeType}/session`,
    auth: 'bearer',
    mutates: true,
    weight: 1,
    maxPerUser: 1,
    expectedStatuses: [200, 404, 409],
    group: 'session-write',
  })),
  {
    name: 'users.me.update',
    method: 'PUT',
    path: '/api/v1/users/me',
    auth: 'bearer',
    mutates: true,
    weight: 1,
    maxPerUser: 1,
    group: 'social-write',
    // No-op-ish profile write: re-set the locale, which always validates.
    body: () => ({ language: 'en' }),
  },
  {
    name: 'users.me.complete-onboarding',
    method: 'POST',
    path: '/api/v1/users/me/complete-onboarding',
    auth: 'bearer',
    mutates: true,
    weight: 1,
    maxPerUser: 1,
    expectedStatuses: [200],
    group: 'social-write',
  },
  {
    name: 'notifications.read-all',
    method: 'POST',
    path: '/api/v1/notifications/read-all',
    auth: 'bearer',
    mutates: true,
    weight: 1,
    expectedStatuses: [200],
    group: 'social-write',
  },
];

// Mutating routes that are SAFE to fire repeatedly (idempotent-ish / reversible)
// vs. ones that drain limited resources (tickets/coins) and should be sampled
// at low rate. purchase-coins and daily/complete are deliberately omitted from
// the default catalog to avoid bankrupting test wallets in seconds; they can be
// enabled explicitly with --include-spend.
export const SPEND_ROUTES: ChaosRoute[] = [
  {
    name: 'store.purchase.coins',
    method: 'POST',
    path: '/api/v1/store/purchase-coins',
    auth: 'bearer',
    mutates: true,
    weight: 1,
    expectedStatuses: [200],
    group: 'economy-write',
    body: () => ({ productSlug: 'chance_card_5050' }),
  },
  {
    name: 'daily.complete',
    method: 'POST',
    path: `/api/v1/daily-challenges/${KNOWN_CHALLENGE}/complete`,
    auth: 'bearer',
    mutates: true,
    weight: 1,
    maxPerUser: 1,
    expectedStatuses: [200, 409],
    group: 'economy-write',
    body: () => ({ score: 1, correctAnswers: 1, durationMs: 5000 }),
  },
  ...ADDITIONAL_DAILY_CHALLENGES.map((challengeType): ChaosRoute => ({
    name: `daily.complete.${challengeType}`,
    method: 'POST',
    path: `/api/v1/daily-challenges/${challengeType}/complete`,
    auth: 'bearer',
    mutates: true,
    weight: 1,
    maxPerUser: 1,
    expectedStatuses: [200, 404, 409],
    group: 'economy-write',
    body: () => ({ score: 1, correctAnswers: 1, durationMs: 5000 }),
  })),
];

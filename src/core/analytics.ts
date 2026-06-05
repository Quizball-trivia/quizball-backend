import { PostHog } from 'posthog-node';
import { logger } from './logger.js';
import { sql } from '../db/index.js';

let posthogClient: PostHog | null = null;

// ── AI-user suppression ──────────────────────────────────────────────────
// AI opponents are persisted as real `users` rows (is_ai=true) so they can
// take part in matches, but they are NOT real people and must never become
// PostHog persons. Backend gameplay analytics fan out over every match member,
// so we short-circuit any capture/identify for a known AI id here — one choke
// point that covers all call sites.
//
// The guard resolves `is_ai` directly from the database (cached in-process with
// a short TTL), so it works regardless of process restarts/redeploys and does
// NOT depend on AI ids being registered at creation time. A failed lookup fails
// OPEN (treat as non-AI) so a flaky DB never silently drops real users' events.
const AI_LOOKUP_TTL_MS = 5 * 60 * 1000; // 5 min — well within a match lifetime
const aiCache = new Map<string, { isAi: boolean; expiresAt: number }>();
const aiLookupInFlight = new Map<string, Promise<boolean>>();

// trackEvent/identifyUser defer the actual capture behind an async AI lookup
// (fire-and-forget for callers). Track those pending promises so shutdown can
// await them before closing the client — otherwise events emitted near shutdown
// are captured against a shut-down client (lost).
const pendingAnalytics = new Set<Promise<void>>();
function runDeferred(task: () => Promise<void>): void {
  const p = task().finally(() => pendingAnalytics.delete(p));
  pendingAnalytics.add(p);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function pruneAiCache(): void {
  const now = Date.now();
  for (const [id, entry] of aiCache) {
    if (entry.expiresAt <= now) aiCache.delete(id);
  }
}

/** Resolve whether a distinctId belongs to an AI user. Cached; fails open. */
async function isAiUser(userId: string): Promise<boolean> {
  // distinctIds that aren't user UUIDs (e.g. anonymous web-SDK ids) are never AI.
  if (!userId || !isUuid(userId)) return false;

  const cached = aiCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.isAi;

  const existing = aiLookupInFlight.get(userId);
  if (existing) return existing;

  const lookup = (async () => {
    try {
      const rows = await sql<{ is_ai: boolean }[]>`SELECT is_ai FROM users WHERE id = ${userId}`;
      const isAi = rows[0]?.is_ai === true;
      if (aiCache.size > 5000) pruneAiCache();
      aiCache.set(userId, { isAi, expiresAt: Date.now() + AI_LOOKUP_TTL_MS });
      return isAi;
    } catch (error) {
      // Fail open: never drop a real user's event because the DB hiccuped.
      logger.warn({ error, userId }, 'AI-user lookup failed; treating as non-AI');
      return false;
    } finally {
      aiLookupInFlight.delete(userId);
    }
  })();

  aiLookupInFlight.set(userId, lookup);
  return lookup;
}

/**
 * Warm the AI suppression cache for a freshly-created AI user. Optional —
 * the guard works without it (it falls back to a DB lookup) — but calling it
 * at AI-creation time avoids the first event for that user racing the lookup.
 * Kept as a stable export so existing call sites continue to compile.
 */
export function registerAiUserId(userId: string): void {
  if (!userId || !isUuid(userId)) return;
  aiCache.set(userId, { isAi: true, expiresAt: Date.now() + AI_LOOKUP_TTL_MS });
}

export function getPostHogClient(): PostHog | null {
  if (!process.env.POSTHOG_API_KEY) {
    return null;
  }

  if (!posthogClient) {
    posthogClient = new PostHog(process.env.POSTHOG_API_KEY, {
      host: process.env.POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 10, // Flush after 10 events
      flushInterval: 10000, // Flush every 10 seconds
    });

    logger.info('PostHog client initialized');
  }

  return posthogClient;
}

export async function shutdownPostHog(): Promise<void> {
  if (posthogClient) {
    // Let any in-flight deferred captures (behind the async AI lookup) settle so
    // their events reach the client before we flush + close it.
    if (pendingAnalytics.size > 0) {
      await Promise.allSettled([...pendingAnalytics]);
    }
    await posthogClient.shutdown();
    posthogClient = null;
    logger.info('PostHog client shutdown');
  }
}

// Helper function to track events
export function trackEvent(
  eventName: string,
  distinctId: string,
  properties?: Record<string, any>
): void {
  const client = getPostHogClient();
  if (!client) return;

  // Stamp the time the event actually occurred (now), BEFORE the async AI
  // lookup — otherwise a slow DB lookup would skew $timestamp later.
  const occurredAt = new Date().toISOString();

  // Resolve AI status asynchronously, then capture. Callers stay synchronous
  // (fire-and-forget); a known AI distinctId never reaches PostHog. Registered as
  // pending so shutdown awaits it.
  runDeferred(async () => {
    try {
      if (await isAiUser(distinctId)) return;
      client.capture({
        distinctId,
        event: eventName,
        properties: {
          ...properties,
          $timestamp: occurredAt,
          environment: process.env.NODE_ENV || 'development',
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to track PostHog event');
    }
  });
}

// Helper function to identify users (set user properties)
export function identifyUser(
  userId: string,
  properties: Record<string, any>
): void {
  const client = getPostHogClient();
  if (!client) return;

  runDeferred(async () => {
    try {
      if (await isAiUser(userId)) return;
      client.identify({
        distinctId: userId,
        properties: {
          ...properties,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to identify user in PostHog');
    }
  });
}

// Alias user (link anonymous ID to identified user)
export function aliasUser(alias: string, distinctId: string): void {
  const client = getPostHogClient();
  if (!client) return;

  try {
    client.alias({
      distinctId,
      alias,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to alias user in PostHog');
  }
}

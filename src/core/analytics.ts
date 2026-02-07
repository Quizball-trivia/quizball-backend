import { PostHog } from 'posthog-node';
import { logger } from './logger.js';

let posthogClient: PostHog | null = null;

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

  try {
    client.capture({
      distinctId,
      event: eventName,
      properties: {
        ...properties,
        $timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV || 'development',
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to track PostHog event');
  }
}

// Helper function to identify users (set user properties)
export function identifyUser(
  userId: string,
  properties: Record<string, any>
): void {
  const client = getPostHogClient();
  if (!client) return;

  try {
    client.identify({
      distinctId: userId,
      properties: {
        ...properties,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Failed to identify user in PostHog');
  }
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

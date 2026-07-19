import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

const RANKED_DEBUG_ENABLED = config.NODE_ENV === 'staging' && config.RANKED_DEBUG_ENABLED;

type DebugValue = string | number | boolean | null | undefined;

export function rankedDebugUser(userId: string | null | undefined): string {
  if (!userId) return 'none';
  return userId.slice(0, 8);
}

function formatValue(value: DebugValue): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  return String(value).replace(/\s+/g, '_');
}

export function rankedDebug(event: string, fields: Record<string, DebugValue> = {}): void {
  if (!RANKED_DEBUG_ENABLED) return;
  const suffix = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(' ');
  logger.info(
    { rankedDebug: true, event, ...fields },
    suffix ? `[ranked-debug] ${event} ${suffix}` : `[ranked-debug] ${event}`
  );
}

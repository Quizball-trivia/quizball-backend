import { normalizeCountryCode } from '../core/country.js';
import { logger } from '../core/logger.js';
import { getRedisClient } from './redis.js';

const CURRENT_COUNTRY_TTL_SEC = 6 * 60 * 60;

function currentCountryKey(userId: string): string {
  return `geo:current-country:${userId}`;
}

export async function rememberCurrentCountry(
  userId: string,
  country: string | null | undefined
): Promise<void> {
  const countryCode = normalizeCountryCode(country);
  if (!countryCode) return;

  const redis = getRedisClient();
  if (!redis?.isOpen) return;

  try {
    await redis.set(currentCountryKey(userId), countryCode, { EX: CURRENT_COUNTRY_TTL_SEC });
  } catch (err) {
    logger.debug({ err, userId }, 'Failed to cache current country');
  }
}

export async function getCurrentCountryForUser(userId: string): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis?.isOpen) return null;

  try {
    return normalizeCountryCode(await redis.get(currentCountryKey(userId)));
  } catch (err) {
    logger.debug({ err, userId }, 'Failed to read current country');
    return null;
  }
}

export async function getCurrentCountriesForUsers(userIds: string[]): Promise<Map<string, string>> {
  const uniqueUserIds = [...new Set(userIds)].filter(Boolean);
  if (uniqueUserIds.length === 0) return new Map();

  const entries = await Promise.all(
    uniqueUserIds.map(async (userId) => [userId, await getCurrentCountryForUser(userId)] as const)
  );

  return new Map(
    entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1]))
  );
}

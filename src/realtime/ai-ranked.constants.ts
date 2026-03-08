/**
 * AI Ranked Bot Configuration
 *
 * This module handles AI opponent profile generation for ranked matches.
 *
 * Features:
 * - In-memory caching of avatar URLs (keyed by seed + size)
 * - Fallback avatar when Dicebear API is unavailable
 * - Optional server-side validation with timeout protection
 * - Pre-generation support for build-time caching
 *
 * Usage:
 *
 * Basic (no validation, uses cache):
 *   const profile = generateRankedAiProfile();
 *
 * With validation (async, checks Dicebear availability):
 *   const profile = await generateRankedAiProfileValidated();
 *
 * Pre-generate at startup (optional):
 *   await preGenerateAiAvatars(96, true); // with validation
 *   await preGenerateAiAvatars(96, false); // just cache URLs
 */

export const RANKED_AI_CORRECTNESS = 0.45;

const AI_NICKNAMES = [
  // surname-style
  'lukaberidze', 'giorgimenbde', 'sandroavaliani', 'giorgizandukeli',
  'temogujejiani', 'datokhmaladze', 'nilogiorgadze', 'beaborjgali',
  'lazareishvili', 'tornibakuradze', 'gaborchiladze', 'leaborjgali',
  // stretched / repeated letters
  'sabaaa', 'romeoooo12', 'cotneee', 'benzooo', 'tamazaa', 'kobaaaa',
  'gagoshaa13', 'nikushaa', 'zukaaaa', 'datunaaaa', 'gioooo', 'beckaaaa',
  'lukaaaa7', 'shotaaaa', 'rezooo99', 'nugziii', 'giooo777', 'bekaaa11',
  // classic nicknames
  'elosha89', 'talakha', 'murtalo', 'somekhii', 'chatlakhi0000',
  'zveri007', 'nadiri99', 'khvedela', 'rostika', 'asata1111',
  'bitchiko', 'papunaa', 'makvala22', 'kachua', 'tsikaaa', 'batooo',
  'gujoo', 'dzmaaaa', 'bosikoo', 'jigaroo', 'zaqoo', 'patioo',
  // number combos
  'gio_2003', 'saba_04', 'luka2005', 'dato_99', 'beka777', 'tornike_01',
  'nika2004', 'gela_ge', 'levo_tb', 'sandro_11', 'giorgi_33', 'temoo_07',
  // stylized
  'xinkali_king', 'tbiliseli', 'kartuli_bichi', 'mziuri_park',
  'dinamo_fan', 'vefxistyao', 'rustaveli99', 'qartlosii',
  'kolxida', 'borjgalo', 'didostati', 'suliko_ge',
  // short punchy
  'zuraa', 'mamuka', 'otari', 'nodari', 'archili', 'tamazi',
  'vakhooo', 'zuraaa', 'jamboo', 'gotcha', 'mimino', 'kakhaberi',
];

// Keep this in sync with frontend-web-next/src/lib/avatars.ts.
const AI_AVATAR_SEEDS = [
  'striker',
  'goalkeeper',
  'defender',
  'midfielder',
  'captain',
  'coach',
  'ronaldo',
  'messi',
  'neymar',
  'mbappe',
  'haaland',
  'benzema',
  'liverpool',
  'barcelona',
  'madrid',
  'bayern',
  'arsenal',
  'chelsea',
  'legend',
  'rookie',
  'veteran',
  'champion',
  'winner',
  'pro',
];

const AI_AVATAR_BG = 'b6e3f4,c0aede,d1d4f9';

// Fallback avatar - base64 encoded minimal SVG or a static asset path
const FALLBACK_AVATAR_URL = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iOTYiIGhlaWdodD0iOTYiIHZpZXdCb3g9IjAgMCA5NiA5NiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48Y2lyY2xlIGN4PSI0OCIgY3k9IjQ4IiByPSI0OCIgZmlsbD0iI2I2ZTNmNCIvPjxjaXJjbGUgY3g9IjQ4IiBjeT0iNDAiIHI9IjE2IiBmaWxsPSIjMzMzIi8+PHBhdGggZD0iTTI0IDY0YzAtMTMuMyAxMC43LTI0IDI0LTI0czI0IDEwLjcgMjQgMjR2MzJIMjR6IiBmaWxsPSIjMzMzIi8+PC9zdmc+';

// In-memory cache: seed -> generated URL
const avatarCache = new Map<string, string>();

// Cache expiry (optional, in ms) - set to 0 to disable expiry
const CACHE_TTL = 0;

interface CacheEntry {
  url: string;
  timestamp: number;
}

const avatarCacheWithTTL = new Map<string, CacheEntry>();

function randomFrom<T>(values: T[]): T {
  if (values.length === 0) {
    throw new Error('randomFrom called with empty array');
  }
  return values[Math.floor(Math.random() * values.length)];
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export function generateRankedAiUsername(): string {
  return randomFrom(AI_NICKNAMES);
}

/**
 * Generate AI avatar URL with caching and fallback support.
 * Returns a Dicebear URL from cache if available, otherwise generates a new one.
 * In case of external API unavailability, use FALLBACK_AVATAR_URL.
 */
export function generateRankedAiAvatarUrl(size = 96, seed?: string): string {
  // Use provided seed or pick random one
  const avatarSeed = seed ?? randomFrom(AI_AVATAR_SEEDS);
  const cacheKey = `${avatarSeed}-${size}`;

  // Check cache with TTL
  if (CACHE_TTL > 0) {
    const cached = avatarCacheWithTTL.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.url;
    }
  } else {
    // Simple cache without TTL
    const cached = avatarCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // Generate Dicebear URL
  const url = `https://api.dicebear.com/7.x/big-smile/svg?seed=${encodeSegment(avatarSeed)}&backgroundColor=${encodeSegment(AI_AVATAR_BG)}&size=${size}`;

  // Store in cache
  if (CACHE_TTL > 0) {
    avatarCacheWithTTL.set(cacheKey, { url, timestamp: Date.now() });
  } else {
    avatarCache.set(cacheKey, url);
  }

  return url;
}

/**
 * Get fallback avatar URL when external service is unavailable.
 */
export function getFallbackAvatarUrl(): string {
  return FALLBACK_AVATAR_URL;
}

/**
 * Validate if a Dicebear URL is accessible (optional server-side check).
 * Returns the URL if valid, otherwise returns fallback.
 * Uses HEAD request to check availability without downloading the full avatar.
 */
export async function getValidatedAvatarUrl(size = 96, seed?: string): Promise<string> {
  const url = generateRankedAiAvatarUrl(size, seed);

  try {
    // Use HEAD request to check if URL is accessible without downloading content
    const response = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(3000), // 3 second timeout
    });

    if (response.ok) {
      return url;
    }

    // Non-2xx response, return fallback
    return FALLBACK_AVATAR_URL;
  } catch (error) {
    // Network error, timeout, or rate limit - return fallback
    return FALLBACK_AVATAR_URL;
  }
}

/**
 * Pre-generate and cache avatar URLs for all AI seeds.
 * Optionally validates URLs if `validate` is true.
 * Useful for build-time or startup caching.
 */
export async function preGenerateAiAvatars(size = 96, validate = false): Promise<void> {
  const promises = AI_AVATAR_SEEDS.map(async (seed) => {
    if (validate) {
      await getValidatedAvatarUrl(size, seed);
    } else {
      generateRankedAiAvatarUrl(size, seed);
    }
  });

  await Promise.all(promises);
}

const AI_GEO_POOL: Array<{ city: string; country: string; countryCode: string; flag: string; lat: number; lon: number }> = [
  { city: 'London',        country: 'United Kingdom', countryCode: 'GB', flag: '\u{1F1EC}\u{1F1E7}', lat: 51.51, lon: -0.13 },
  { city: 'Paris',         country: 'France',         countryCode: 'FR', flag: '\u{1F1EB}\u{1F1F7}', lat: 48.86, lon: 2.35 },
  { city: 'Madrid',        country: 'Spain',          countryCode: 'ES', flag: '\u{1F1EA}\u{1F1F8}', lat: 40.42, lon: -3.70 },
  { city: 'Rome',          country: 'Italy',          countryCode: 'IT', flag: '\u{1F1EE}\u{1F1F9}', lat: 41.90, lon: 12.50 },
  { city: 'Berlin',        country: 'Germany',        countryCode: 'DE', flag: '\u{1F1E9}\u{1F1EA}', lat: 52.52, lon: 13.40 },
  { city: 'Tokyo',         country: 'Japan',          countryCode: 'JP', flag: '\u{1F1EF}\u{1F1F5}', lat: 35.68, lon: 139.69 },
  { city: 'Seoul',         country: 'South Korea',    countryCode: 'KR', flag: '\u{1F1F0}\u{1F1F7}', lat: 37.57, lon: 126.98 },
  { city: 'Istanbul',      country: 'Turkey',         countryCode: 'TR', flag: '\u{1F1F9}\u{1F1F7}', lat: 41.01, lon: 28.98 },
  { city: 'Buenos Aires',  country: 'Argentina',      countryCode: 'AR', flag: '\u{1F1E6}\u{1F1F7}', lat: -34.60, lon: -58.38 },
  { city: 'Rio de Janeiro', country: 'Brazil',        countryCode: 'BR', flag: '\u{1F1E7}\u{1F1F7}', lat: -22.91, lon: -43.17 },
  { city: 'Lagos',         country: 'Nigeria',        countryCode: 'NG', flag: '\u{1F1F3}\u{1F1EC}', lat: 6.52, lon: 3.38 },
  { city: 'Cairo',         country: 'Egypt',          countryCode: 'EG', flag: '\u{1F1EA}\u{1F1EC}', lat: 30.04, lon: 31.24 },
  { city: 'Mumbai',        country: 'India',          countryCode: 'IN', flag: '\u{1F1EE}\u{1F1F3}', lat: 19.08, lon: 72.88 },
  { city: 'Mexico City',   country: 'Mexico',         countryCode: 'MX', flag: '\u{1F1F2}\u{1F1FD}', lat: 19.43, lon: -99.13 },
  { city: 'Sydney',        country: 'Australia',      countryCode: 'AU', flag: '\u{1F1E6}\u{1F1FA}', lat: -33.87, lon: 151.21 },
  { city: 'Casablanca',    country: 'Morocco',        countryCode: 'MA', flag: '\u{1F1F2}\u{1F1E6}', lat: 33.57, lon: -7.59 },
  { city: 'Amsterdam',     country: 'Netherlands',    countryCode: 'NL', flag: '\u{1F1F3}\u{1F1F1}', lat: 52.37, lon: 4.90 },
  { city: 'Lisbon',        country: 'Portugal',       countryCode: 'PT', flag: '\u{1F1F5}\u{1F1F9}', lat: 38.72, lon: -9.14 },
  { city: 'Nairobi',       country: 'Kenya',          countryCode: 'KE', flag: '\u{1F1F0}\u{1F1EA}', lat: -1.29, lon: 36.82 },
  { city: 'Riyadh',        country: 'Saudi Arabia',   countryCode: 'SA', flag: '\u{1F1F8}\u{1F1E6}', lat: 24.71, lon: 46.67 },
  { city: 'Jakarta',       country: 'Indonesia',      countryCode: 'ID', flag: '\u{1F1EE}\u{1F1E9}', lat: -6.21, lon: 106.85 },
  { city: 'Doha',          country: 'Qatar',          countryCode: 'QA', flag: '\u{1F1F6}\u{1F1E6}', lat: 25.29, lon: 51.53 },
  { city: 'New York',      country: 'USA',            countryCode: 'US', flag: '\u{1F1FA}\u{1F1F8}', lat: 40.71, lon: -74.01 },
  { city: 'Los Angeles',   country: 'USA',            countryCode: 'US', flag: '\u{1F1FA}\u{1F1F8}', lat: 34.05, lon: -118.24 },
  { city: 'Toronto',       country: 'Canada',         countryCode: 'CA', flag: '\u{1F1E8}\u{1F1E6}', lat: 43.65, lon: -79.38 },
  { city: 'Tbilisi',       country: 'Georgia',        countryCode: 'GE', flag: '\u{1F1EC}\u{1F1EA}', lat: 41.72, lon: 44.79 },
];

export function generateRankedAiGeo(playerCountryCode?: string | null): { city: string; country: string; countryCode: string; flag: string; lat: number; lon: number } {
  // 80% chance to pick same country as the player, 20% random worldwide
  if (playerCountryCode && Math.random() < 0.8) {
    const sameCountry = AI_GEO_POOL.filter(g => g.countryCode === playerCountryCode);
    if (sameCountry.length > 0) return randomFrom(sameCountry);
  }
  return randomFrom(AI_GEO_POOL);
}

/**
 * Generate a random AI profile (username + avatar URL).
 * Uses cached Dicebear URLs without validation.
 */
export function generateRankedAiProfile(): { username: string; avatarUrl: string } {
  return {
    username: generateRankedAiUsername(),
    avatarUrl: generateRankedAiAvatarUrl(96),
  };
}

/**
 * Generate a random AI profile with validated avatar URL.
 * Checks if Dicebear is accessible before returning URL.
 * Falls back to FALLBACK_AVATAR_URL if unavailable.
 */
export async function generateRankedAiProfileValidated(): Promise<{
  username: string;
  avatarUrl: string;
}> {
  return {
    username: generateRankedAiUsername(),
    avatarUrl: await getValidatedAvatarUrl(96),
  };
}

export function rankedAiLobbyKey(lobbyId: string): string {
  return `ranked:ai:lobby:${lobbyId}`;
}

export function rankedAiMatchKey(matchId: string): string {
  return `ranked:ai:match:${matchId}`;
}

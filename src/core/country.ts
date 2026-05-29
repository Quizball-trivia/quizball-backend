const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  argentina: 'AR',
  australia: 'AU',
  brazil: 'BR',
  canada: 'CA',
  egypt: 'EG',
  france: 'FR',
  georgia: 'GE',
  germany: 'DE',
  india: 'IN',
  indonesia: 'ID',
  italy: 'IT',
  japan: 'JP',
  kenya: 'KE',
  mexico: 'MX',
  morocco: 'MA',
  netherlands: 'NL',
  nigeria: 'NG',
  portugal: 'PT',
  qatar: 'QA',
  saudi: 'SA',
  'saudi arabia': 'SA',
  south_korea: 'KR',
  'south korea': 'KR',
  spain: 'ES',
  turkey: 'TR',
  uk: 'GB',
  united_kingdom: 'GB',
  'united kingdom': 'GB',
  britain: 'GB',
  'great britain': 'GB',
  usa: 'US',
  us: 'US',
  united_states: 'US',
  'united states': 'US',
  'united states of america': 'US',
  america: 'US',
};

export function normalizeCountryCode(country: string | null | undefined): string | null {
  const raw = country?.trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (upper === 'USA') return 'US';
  if (upper === 'GBR') return 'GB';
  if (upper === 'GEO') return 'GE';

  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return COUNTRY_NAME_TO_CODE[key] ?? COUNTRY_NAME_TO_CODE[key.replace(/_/g, ' ')] ?? null;
}

export function countryPayload(country: string | null | undefined): {
  country?: string;
  countryCode?: string;
} {
  const raw = country?.trim();
  const countryCode = normalizeCountryCode(raw);
  if (!raw && !countryCode) return {};
  return {
    country: raw ?? countryCode ?? undefined,
    ...(countryCode ? { countryCode } : {}),
  };
}

/**
 * ISO 3166-1 alpha-2 codes accepted for persisted user profiles.
 *
 * Keep this list explicit: accepting any two letters would let values such as
 * `ZZ` create private/fragmented country leaderboards. Display helpers below
 * may understand friendly names and legacy aliases, but profile storage only
 * accepts members of this set.
 */
export const SUPPORTED_ISO_COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ',
  'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN', 'CO', 'CR', 'CU', 'CV', 'CW',
  'CX', 'CY', 'CZ',
  'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ',
  'EC', 'EE', 'EG', 'EH', 'ER', 'ES', 'ET',
  'FI', 'FJ', 'FK', 'FM', 'FO', 'FR',
  'GA', 'GB', 'GD', 'GE', 'GF', 'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT',
  'GU', 'GW', 'GY',
  'HK', 'HM', 'HN', 'HR', 'HT', 'HU',
  'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT',
  'JE', 'JM', 'JO', 'JP',
  'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ',
  'LA', 'LB', 'LC', 'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY',
  'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK', 'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS',
  'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ',
  'NA', 'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ',
  'OM',
  'PA', 'PE', 'PF', 'PG', 'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY',
  'QA',
  'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ',
  'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO', 'TR', 'TT', 'TV', 'TW', 'TZ',
  'UA', 'UG', 'UM', 'US', 'UY', 'UZ',
  'VA', 'VC', 'VE', 'VG', 'VI', 'VN', 'VU',
  'WF', 'WS',
  'YE', 'YT',
  'ZA', 'ZM', 'ZW',
] as const;

export type SupportedIsoCountryCode = typeof SUPPORTED_ISO_COUNTRY_CODES[number];

const SUPPORTED_ISO_COUNTRY_CODE_SET = new Set<string>(SUPPORTED_ISO_COUNTRY_CODES);

export function isSupportedIsoCountryCode(value: string): value is SupportedIsoCountryCode {
  return SUPPORTED_ISO_COUNTRY_CODE_SET.has(value);
}

/** Strict normalization for values written to `users.country`. */
export function normalizeSupportedCountryCode(
  country: string | null | undefined,
): SupportedIsoCountryCode | null {
  const upper = country?.trim().toUpperCase();
  return upper && isSupportedIsoCountryCode(upper) ? upper : null;
}

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
  if (isSupportedIsoCountryCode(upper)) return upper;
  if (upper === 'USA') return 'US';
  if (upper === 'GBR') return 'GB';
  if (upper === 'GEO') return 'GE';

  const key = raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const mapped = COUNTRY_NAME_TO_CODE[key] ?? COUNTRY_NAME_TO_CODE[key.replace(/_/g, ' ')];
  return mapped && isSupportedIsoCountryCode(mapped) ? mapped : null;
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

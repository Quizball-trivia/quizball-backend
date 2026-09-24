/**
 * Career-path crest lookup for WL content tooling. Mirrors the web app's
 * findClubByName (frontend-web-next/src/lib/clubs.ts) over the vendored
 * registry so the CMS can warn the editor BEFORE publishing a career whose
 * club would render without a badge. A miss here is a warning, never a
 * block: the web app is the renderer of record and may know more aliases.
 */

import { config } from '../../core/config.js';
import { CREST_REGISTRY, type CrestRegistryRow } from './wl-crest-registry.data.js';

const LOGO_BUCKET_PATH = 'storage/v1/object/public/imgs/club-logos';

const CLUB_ALIASES: Record<string, string> = {
  'man united': 'manchester united',
  'man utd': 'manchester united',
  'man city': 'manchester city',
  spurs: 'tottenham hotspur',
  inter: 'inter milan',
  psg: 'paris saint germain',
  atleti: 'atletico madrid',
  barca: 'barcelona',
  bayern: 'bayern munich',
  gladbach: 'borussia monchengladbach',
  dortmund: 'borussia dortmund',
};

const GENERIC_CLUB_TOKENS = new Set(['fc', 'cf', 'ac', 'sc', 'afc', 'cfc', 'bsc', 'club', 'calcio']);

export function normalizeClubName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    // 'bc' added over the web app's list: "Atalanta" must resolve to "Atalanta BC" under the strict prefix rule below.
    .replace(/\b(fc|cf|ac|sc|sv|as|ss|ssc|afc|bsc|bc|rc|us|ud|cd|club|de|futbol|football)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looseName(value: string): string {
  return value.toLowerCase().replace(/\b(fc|afc|cf|sc|ac|ss|us)\b/g, '').trim().replace(/\s+/g, ' ');
}

function isGenericRemainder(remainder: string): boolean {
  const tokens = remainder.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => GENERIC_CLUB_TOKENS.has(t) || /^\d+$/.test(t));
}

const byId = new Map(CREST_REGISTRY.map((c) => [c.id, c]));
const byValue = new Map(CREST_REGISTRY.map((c) => [c.value.toLowerCase(), c]));
const byLoose = new Map(CREST_REGISTRY.map((c) => [looseName(c.value), c]));
const byNormValue = new Map(CREST_REGISTRY.map((c) => [normalizeClubName(c.value), c]));
const byNormLabel = new Map(CREST_REGISTRY.map((c) => [normalizeClubName(c.label), c]));
const byNormId = new Map(CREST_REGISTRY.map((c) => [normalizeClubName(c.id), c]));

export function findCrestClub(name: string | null | undefined): CrestRegistryRow | null {
  if (!name) return null;
  const direct = byId.get(name) ?? byValue.get(name.toLowerCase()) ?? byLoose.get(looseName(name));
  if (direct) return direct;
  const raw = normalizeClubName(name);
  const norm = CLUB_ALIASES[raw] ?? raw;
  if (norm === '') return null;
  const exact = byNormValue.get(norm) ?? byNormLabel.get(norm) ?? byNormId.get(norm);
  if (exact) return exact;
  // The web app's prefix fallback is deliberately STRICT here: "Santos Laguna"
  // must not resolve to Santos FC and "Lyon-Duchère" must not become Lyon —
  // both were false badges in the 2026-09-11 batch.
  if (norm.length < 5) return null;
  return (
    CREST_REGISTRY.find((c) => {
      const v = normalizeClubName(c.value);
      if (v.startsWith(`${norm} `)) return isGenericRemainder(v.slice(norm.length));
      if (norm.startsWith(`${v} `)) return isGenericRemainder(norm.slice(v.length));
      return false;
    }) ?? null
  );
}

export function crestUrl(row: CrestRegistryRow): string {
  if (/^https?:\/\//i.test(row.logo)) return row.logo;
  const base = (config.SUPABASE_URL ?? '').replace(/\/$/, '');
  return base ? `${base}/${LOGO_BUCKET_PATH}/${row.logo}` : `/${row.logo}`;
}

export interface CrestResolution {
  club: string;
  club_id: string | null;
  logo_url: string | null;
}

export function resolveCrests(clubs: readonly string[]): CrestResolution[] {
  return clubs.map((club) => {
    const hit = findCrestClub(club);
    return { club, club_id: hit?.id ?? null, logo_url: hit ? crestUrl(hit) : null };
  });
}

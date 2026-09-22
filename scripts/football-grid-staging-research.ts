/** Research content may be rehearsed on the named staging DB without granting production source approval. */
import { createHash } from 'node:crypto';
import type { Manifest } from './football-grid-content.js';

export const STAGING_GRID_PROJECT = 'nsdfiprfmhdqhbfxfwpv';
export const STAGING_RESEARCH_TRANSFORM = 'historical-staging-rehearsal-v1';

export function assertStagingResearchTarget(databaseUrl: string | undefined): void {
  if (!databaseUrl) throw new Error('Staging research requires an explicit database target');
  const url = new URL(databaseUrl);
  const direct = url.hostname === `db.${STAGING_GRID_PROJECT}.supabase.co` && url.username === 'postgres';
  const pooler = /^(aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com)$/.test(url.hostname)
    && decodeURIComponent(url.username) === `postgres.${STAGING_GRID_PROJECT}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || (!direct && !pooler)) {
    throw new Error('Research content is restricted to the Quizball staging database');
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v]) => v !== undefined)
    .sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function researchDigest(manifest: Manifest): string {
  return createHash('sha256').update(canonical(manifest)).digest('hex');
}

function unchangedSubset<T>(old: T[], next: T[], key: (row: T) => string, label: string): void {
  const rows = new Map(next.map(row => [key(row), row]));
  if (rows.size !== next.length) throw new Error(`Duplicate ${label}`);
  for (const row of old) if (canonical(rows.get(key(row))) !== canonical(row)) {
    throw new Error(`Historical rehearsal changed or removed existing ${label}`);
  }
}

/** Only inherited findings from an unchanged board roster/difficulty can carry over. */
export function assertAdditiveStagingResearch(source: Manifest, candidate: Manifest): void {
  const meta = candidate.release.relationshipSnapshot;
  if (meta.transform !== STAGING_RESEARCH_TRANSFORM || meta.stagingResearchOnly !== true
    || meta.stagingProjectRef !== STAGING_GRID_PROJECT || meta.transformedFromVersion !== source.release.version
    || meta.stagingSourceSha256 !== researchDigest(source)
    || candidate.release.version <= source.release.version
    || candidate.release.aliasVersion < source.release.aliasVersion
    || candidate.release.resolverPolicyVersion !== source.release.resolverPolicyVersion) {
    throw new Error('Historical staging rehearsal source or target does not match');
  }
  unchangedSubset(source.sources, candidate.sources, s => `${s.key}:${s.datasetVersion}`, 'source');
  unchangedSubset(source.players, candidate.players, p => p.id, 'player');
  unchangedSubset(source.memberships, candidate.memberships, m => `${m.criterionKey}:${m.playerId}`, 'membership');
  // Alias duplicates can exist in legacy exports; compare a multiset, not only normalized spelling.
  const aliases = new Map<string, number>();
  for (const a of candidate.aliases) aliases.set(canonical(a), (aliases.get(canonical(a)) ?? 0) + 1);
  for (const a of source.aliases) {
    const k = canonical(a), n = aliases.get(k) ?? 0;
    if (!n) throw new Error('Historical staging rehearsal removed or changed an alias');
    aliases.set(k, n - 1);
  }
  if (source.assetCatalog.some(key => !candidate.assetCatalog.includes(key))) throw new Error('Historical rehearsal removed an asset');
  const cleanCriterion = (c: Manifest['criteria'][number]) => ({...c,
    metadata: Object.fromEntries(Object.entries(c.metadata).filter(([k]) => k !== 'memberCount'))});
  unchangedSubset(source.criteria.map(cleanCriterion), candidate.criteria.map(cleanCriterion), c => c.key, 'criterion');
  if (source.criteria.length !== candidate.criteria.length || source.boards.length !== candidate.boards.length) {
    throw new Error('Historical rehearsal changed board or criterion scope');
  }
  const boards = new Map(candidate.boards.map(b => [b.key,b]));
  if (boards.size !== candidate.boards.length) throw new Error('Duplicate rehearsal board');
  for (const old of source.boards) {
    const next = boards.get(old.key);
    if (!next || next.version < old.version || canonical({...old,version:0,approvedBy:'',cells:[]})
      !== canonical({...next,version:0,approvedBy:'',cells:[]})) throw new Error('Historical rehearsal changed board definition');
    old.cells.forEach((cell,i) => {
      if (canonical(cell.recognizablePlayerIds) !== canonical(next.cells[i].recognizablePlayerIds)
        || cell.playerIds.some(id => !next.cells[i].playerIds.includes(id))) throw new Error('Historical rehearsal removed an answer or sample');
    });
  }
}

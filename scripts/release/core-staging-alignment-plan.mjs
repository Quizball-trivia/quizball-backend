import {contentHash} from './question-manifest.mjs';
import {buildReferencePackage, validateReferencePackage} from './reference-package.mjs';

const STAGING = 'nsdfiprfmhdqhbfxfwpv';
const PRODUCTION = 'lfbwhxvwubzeqkztghok';
const FIELDS = {
  football_players: ['image_url', 'current_value_eur', 'peak_value_eur'],
  fifa_cards: ['name_ka'],
  goal_choreographies: ['mirrored_url'],
  player_clue_cards: ['clue_3'],
};
const MEDIA = new Set(['image_url', 'mirrored_url']);
const LOCAL_PROVENANCE = {football_players: ['source_payload']};
const LOCAL_FIELDS = new Set(['created_at', 'updated_at', 'created_by', 'updated_by', 'generation_task_id', 'snapshot_id', 'last_seen_snapshot_id']);
export const coreAlignmentBaseline = row => Object.fromEntries(Object.entries(row).filter(([field]) => !LOCAL_FIELDS.has(field)));

/** A non-executable, pinned plan for existing staging catalogue rows only.
 * Reuse the reviewed importer mapping so historical local UUIDs are retained.
 * Production null-label fills remain owned by the additive reference importer.
 * Original full source rows stay in the pinned archive; an executor must also
 * journal live before/after rows atomically before applying these field changes.
 */
export function buildCoreStagingAlignmentPlan({staging, production, referencePackage}) {
  const pkg = validateReferencePackage(referencePackage);
  if (pkg.sourceProject !== STAGING || pkg.targetProject !== PRODUCTION) throw new Error('Unexpected reference projects');
  const rebuilt = buildReferencePackage({source: staging, target: production, sourceProject: STAGING, targetProject: PRODUCTION});
  if (rebuilt.sha256 !== pkg.sha256) throw new Error('Catalogue snapshots differ from the pinned reference package');
  const tables = pkg.tables.map(table => {
    const stageById = new Map(staging[table.table].map(row => [row.id, row]));
    const prodById = new Map(production[table.table].map(row => [row.id, row]));
    const rows = [], identityMap = [], preservedProvenance = [];
    for (const entry of table.rows) {
      identityMap.push({stagingId: entry.sourceId, productionId: entry.targetId});
      if (entry.disposition === 'insert') continue;
      const stage = stageById.get(entry.sourceId), prod = prodById.get(entry.targetId);
      const before = {}, after = {};
      for (const field of entry.preservedDifferences) {
        if (LOCAL_PROVENANCE[table.table]?.includes(field)) {
          preservedProvenance.push({stagingId: stage.id, field, stagingHash: contentHash(stage[field]), productionHash: contentHash(prod[field])});
          continue;
        }
        if (!FIELDS[table.table].includes(field)) throw new Error(`Unreviewed catalogue difference: ${table.table}.${field}`);
        if (!Object.hasOwn(stage, field) || !Object.hasOwn(prod, field)) throw new Error('Catalogue columns differ');
        // This release fills the known missing Georgian names; it must never
        // silently replace an editor's existing translation or remove a label.
        if (table.table === 'fifa_cards' && (stage[field] !== null || typeof prod[field] !== 'string' || !prod[field].trim())) throw new Error('Georgian name change is not a null-label fill');
        if (MEDIA.has(field)) {
          const url = new URL(prod[field]);
          if (url.protocol !== 'https:' || url.hostname !== PRODUCTION + '.supabase.co' || url.username || url.password || !url.pathname.startsWith('/storage/v1/object/public/')) throw new Error('Canonical media must be existing public production storage');
        }
        before[field] = stage[field]; after[field] = prod[field];
      }
      if (Object.keys(before).length) rows.push({stagingId: stage.id, productionId: prod.id, sourceRowHash: contentHash(stage), baseline: coreAlignmentBaseline(stage), before, after});
    }
    return {table: table.table, identityMap, rows, preservedProvenance};
  });
  const mediaUrls = [...new Set(tables.flatMap(table => table.rows.flatMap(row => Object.entries(row.after).filter(([field]) => MEDIA.has(field)).map(([,value]) => value))))].sort();
  const body = {
    format: 1, executable: false, operation: 'align-staging-existing-core-catalogue',
    sourceProject: PRODUCTION, targetProject: STAGING, referencePackageSha256: pkg.sha256,
    stagingSnapshotSha256: contentHash(staging), productionSnapshotSha256: contentHash(production), tables, mediaUrls,
    gates: ['Verified full staging backup and restore, source delta review and content reservation.',
      'Full restored history rehearsal; drain old staging writers before field alignment.',
      'Independently archive, decode and hash every canonical media URL; never overwrite existing production media.',
      'Atomically preserve original live rows and compare exact before fields; refuse later editor changes.',
      'Keep every local UUID, historical reference, account, balance and provenance record.',
      'Verify game readers, existing outcomes, retry and retaining undo before cloud execution.'],
  };
  return {...body, sha256: contentHash(body)};
}

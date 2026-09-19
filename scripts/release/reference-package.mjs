import { contentHash } from './question-manifest.mjs';

const TABLES = ['football_players', 'fifa_cards', 'goal_choreographies', 'player_clue_cards'];
const NONPORTABLE = new Set(['created_at', 'updated_at', 'created_by', 'updated_by', 'generation_task_id', 'snapshot_id', 'last_seen_snapshot_id']);
const portable = row => Object.fromEntries(Object.entries(row).filter(([key]) => !NONPORTABLE.has(key)));
const same = (a, b) => contentHash(a ?? null) === contentHash(b ?? null);
function indexed(rows, key, label) {
  const out = new Map();
  for (const row of rows) {
    const identity = key(row);
    if (!identity || out.has(identity)) throw new Error(`Ambiguous ${label} identity`);
    out.set(identity, row);
  }
  return out;
}

/** Compile an additive core-reference plan. This function performs no writes.
 * Shared production rows/IDs win. Only missing translated labels are fillable.
 * New playable card/goal/clue records enter inactive/review state first.
 */
export function buildReferencePackage({ source, target, sourceProject, targetProject }) {
  if (!sourceProject || !targetProject || sourceProject === targetProject) throw new Error('Distinct pinned projects required');
  for (const table of TABLES) if (!Array.isArray(source[table]) || !Array.isArray(target[table])) throw new Error(`Missing ${table} snapshot`);
  const playerMap = new Map(), tables = [];
  for (const table of TABLES) {
    const sourceIds = indexed(source[table], r => r.id, table + ' source UUID');
    const targetIds = indexed(target[table], r => r.id, table + ' target UUID');
    const natural = row => {
      if (table === 'football_players') return row.transfermarkt_id ? `tm:${row.transfermarkt_id}` : row.wikidata_id ? `wiki:${row.wikidata_id}` : `uuid:${row.id}`;
      if (table === 'fifa_cards') return row.source_key;
      if (table === 'goal_choreographies') return row.slug;
      return JSON.stringify([row.transfermarkt_id ?? null, row.locale, row.variant_key ?? null, row.football_player_id]);
    };
    const targets = indexed(target[table], natural, table + ' target natural');
    const targetWiki = table === 'football_players' ? indexed(target[table].filter(r => r.wikidata_id), r => r.wikidata_id, 'target Wikidata') : null;
    if (table === 'football_players') indexed(source[table].filter(r => r.wikidata_id), r => r.wikidata_id, 'source Wikidata');
    const converted = [...sourceIds.values()].map(row => {
      if (table !== 'player_clue_cards') return row;
      const playerId = playerMap.get(row.football_player_id);
      if (!playerId) throw new Error('Clue refers to an unmapped football player');
      return { ...row, football_player_id: playerId };
    });
    indexed(converted, natural, table + ' source natural');
    const rows = [];
    for (const src of converted) {
      let dst = targets.get(natural(src));
      if (targetWiki && src.wikidata_id) {
        const alternate = targetWiki.get(src.wikidata_id);
        if (dst && alternate && dst !== alternate) throw new Error('Player external identities disagree');
        dst ??= alternate;
      }
      if (targetIds.has(src.id) && targetIds.get(src.id) !== dst) throw new Error(`UUID collision with a different ${table} identity`);
      if (table === 'football_players') playerMap.set(src.id, dst?.id ?? src.id);
      if (!dst) {
        const insert = portable(src), publication = {};
        if (table === 'fifa_cards') { publication.is_active = src.is_active; insert.is_active = false; }
        if (table === 'goal_choreographies') { publication.status = src.status; publication.featured_rank = src.featured_rank; insert.status = 'draft'; insert.featured_rank = null; }
        if (table === 'player_clue_cards' && src.status === 'published') { publication.status = src.status; insert.status = 'needs_review'; }
        rows.push({ sourceId: src.id, targetId: src.id, disposition: 'insert', insert, publication, sourceHash: contentHash(src) });
        continue;
      }
      const fill = {}, allowed = table === 'fifa_cards' ? ['name_ka'] : table === 'goal_choreographies' ? ['match_label_es', 'match_label_tr'] : [];
      for (const key of allowed) if (dst[key] == null && typeof src[key] === 'string' && src[key].trim()) fill[key] = src[key];
      const differences = Object.keys(portable(src)).filter(key => key !== 'id' && !same(src[key], dst[key]));
      rows.push({ sourceId: src.id, targetId: dst.id, disposition: Object.keys(fill).length ? 'fill-null-labels' : 'preserve', fill,
        beforeFields: Object.keys(portable(dst)).sort(), beforeHash: contentHash(portable(dst)), sourceHash: contentHash(src), preservedDifferences: differences.filter(key => !Object.hasOwn(fill, key)) });
    }
    tables.push({ table, sourceRows: source[table].length, targetRows: target[table].length, rows });
  }
  const body = { format: 1, sourceProject, targetProject, policy: 'preserve-production-ids-and-content; null-label-fills-only; separate-publication', tables };
  return { ...body, sha256: contentHash(body) };
}

export function validateReferencePackage(pkg) {
  const { sha256, ...body } = pkg;
  if (pkg.format !== 1 || contentHash(body) !== sha256 || pkg.sourceProject === pkg.targetProject) throw new Error('Invalid core-reference package');
  if (pkg.tables.map(t => t.table).join(',') !== TABLES.join(',')) throw new Error('Unexpected reference tables/order');
  for (const table of pkg.tables) {
    indexed(table.rows, r => r.targetId, 'planned target');
    for (const row of table.rows) {
      if (!['preserve', 'insert', 'fill-null-labels'].includes(row.disposition)) throw new Error('Unknown disposition');
      if (row.disposition !== 'insert' && (!Array.isArray(row.beforeFields) || !row.beforeFields.includes('id') || row.beforeFields.some(k => typeof k !== 'string') || !/^[a-f0-9]{64}$/.test(row.beforeHash))) throw new Error('Missing target baseline');
      if (row.disposition === 'insert') {
        if (row.targetId !== row.insert.id || row.insert.created_by || row.insert.generation_task_id || row.insert.snapshot_id) throw new Error('Nonportable insertion');
        if (table.table === 'fifa_cards' && row.insert.is_active !== false) throw new Error('Card activation must be separate');
        if (['goal_choreographies', 'player_clue_cards'].includes(table.table) && row.insert.status === 'published') throw new Error('Publication must be separate');
      }
      const allowed = table.table === 'fifa_cards' ? ['name_ka'] : table.table === 'goal_choreographies' ? ['match_label_es', 'match_label_tr'] : [];
      if (Object.keys(row.fill ?? {}).some(k => !allowed.includes(k))) throw new Error('Update exceeds null-label policy');
    }
  }
  return pkg;
}

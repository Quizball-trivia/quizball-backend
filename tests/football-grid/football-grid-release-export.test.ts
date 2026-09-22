import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../setup.js';

const db = vi.hoisted(() => {
  const tables = new Map<string, unknown[]>();
  const queries: string[] = [];
  const sql = Object.assign(vi.fn(async (strings: TemplateStringsArray) => {
    const query = strings.join('?');
    queries.push(query);
    const table = /FROM (football_grid_\w+)/i.exec(query)?.[1];
    if (!table || !tables.has(table)) throw new Error(`Unexpected export query: ${query}`);
    return tables.get(table)!;
  }), {
    unsafe: vi.fn(async () => []),
    begin: vi.fn(async (_options: string, body: (tx: unknown) => unknown): Promise<unknown> => body(sql)),
  });
  return { sql, tables, queries };
});
vi.mock('../../src/db/index.js', () => ({ sql: db.sql }));

import { checksum, exportRelease } from '../../scripts/football-grid-content.js';
import { canonicalFootballGridBoardChecksum } from '../../src/modules/football-grid/football-grid.content-validator.js';

const originalEvidence = {
  sourceKey: 'reviewed-source', sourceLocator: 'https://example.org/match', capturedFact: 'Verified appearance',
  effectiveFrom: '2004-01-01', rightsClass: 'fixture', reviewedBy: 'reviewer',
  reviewedAt: '2026-09-22T13:22:22.123456Z',
};

beforeEach(() => {
  db.tables.clear(); db.queries.length = 0; vi.clearAllMocks();
  const reviewedAt = '2026-09-22 13:22:22+00';
  const criteria = Array.from({ length: 6 }, (_, i) => ({
    id: `criterion-id-${i}`, criterion_key: `criterion-${i}`, family: 'club', subtype: 'senior_appearance',
    label_en: `Criterion ${i}`, label_ka: `კრიტერიუმი ${i}`, asset_key: null, metadata: {},
    difficulty: 'normal', familiarity_score: '70',
  }));
  const players = Array.from({ length: 3 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
  const memberships = criteria.flatMap(c => players.map(p => ({
    id: `${c.id}:${p}`, criterion_id: c.id, football_player_id: p, relationship_subtype: 'senior_appearance',
    effective_from: '2004-01-01', effective_to: null, verified_by: 'reviewer', reviewed_at: reviewedAt,
  })));
  db.tables.set('football_grid_content_releases', [{ id: 'release-id', version: 1, alias_version: 1,
    resolver_policy_version: 1, relationship_snapshot: {}, approved_by: 'reviewer', approved_at: reviewedAt,
    manifest_checksum: 'stored-release-checksum', status: 'published' }]);
  db.tables.set('football_grid_criteria', criteria);
  db.tables.set('football_grid_data_sources', [{ id: 'source-id', source_key: 'reviewed-source',
    provider_name: 'Fixture', dataset_version: '1', permitted_use: 'test', attribution_requirements: null,
    retention_requirements: null, approval_owner: 'reviewer', approved_at: reviewedAt, database_rights_status: 'approved' }]);
  db.tables.set('football_grid_criterion_memberships', memberships);
  db.tables.set('football_grid_membership_evidence', memberships.map(m => ({
    membership_id: m.id, source_id: 'source-id', source_locator: originalEvidence.sourceLocator,
    captured_fact: originalEvidence.capturedFact, effective_from: '2004-01-01', effective_to: null,
    rights_class: 'fixture', reviewed_by: 'reviewer', reviewed_at: '2026-09-22 13:22:22.123456+00',
    evidence_checksum: checksum(originalEvidence),
  })));
  db.tables.set('football_grid_player_aliases', players.map((id, i) => ({
    football_player_id: id, alias: `Player ${i}`, normalized_alias: `player ${i}`, locale: 'en',
    alias_type: 'full_name', acceptance_policy: 'exact', reviewed_by: 'reviewer', reviewed_at: reviewedAt,
  })));
  db.tables.set('football_grid_boards', [{ id: 'board-id', version: 1,
    row_criteria: criteria.slice(0, 3).map(c => c.id), column_criteria: criteria.slice(3).map(c => c.id),
    difficulty: 'normal', familiarity_score: '70', approved_by: 'reviewer', theme: 'european',
    canonical_checksum: canonicalFootballGridBoardChecksum(
      criteria.slice(0, 3).map(c => c.criterion_key), criteria.slice(3).map(c => c.criterion_key)),
  }]);
  db.tables.set('football_grid_board_answers', Array.from({ length: 9 }, (_, cell) => players.map((id, i) => ({
    board_id: 'board-id', cell_index: cell, football_player_id: id,
    player_name_en: `Player ${i}`, player_name_ka: `მოთამაშე ${i}`, image_asset_key: `portrait-${i}`,
    recognizable_rank: i < 2 ? i + 1 : null, is_sample: i < 2,
  }))).flat());
});

describe('Release export evidence round-trip', () => {
  it('preserves dates and exact original evidence through the complete export path', async () => {
    const { manifest } = await exportRelease(1);
    expect(db.sql.begin).toHaveBeenCalledWith('isolation level repeatable read read only', expect.any(Function));
    expect(manifest.memberships).toHaveLength(18);
    for (const membership of manifest.memberships) {
      expect(membership.effectiveFrom).toBe('2004-01-01');
      expect(membership.effectiveTo).toBeNull();
      expect(membership.evidence).toEqual([originalEvidence]);
    }
    expect(manifest.boards).toHaveLength(1);
    expect(manifest.boards[0].cells).toHaveLength(9);
  });

  it('rejects altered evidence before fetching any board answers', async () => {
    const evidence = db.tables.get('football_grid_membership_evidence')!;
    evidence[0] = { ...evidence[0] as object, captured_fact: 'Changed relationship' };
    await expect(exportRelease(1)).rejects.toThrow('does not reproduce stored checksum');
    expect(db.queries.some(q => q.includes('FROM football_grid_board_answers'))).toBe(false);
  });
});

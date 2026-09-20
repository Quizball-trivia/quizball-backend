import { describe, expect, it } from 'vitest';
import '../setup.js';
import {
  generateCandidateBoards,
  manifestSchema,
  optionValue,
  validateManifest,
} from '../../scripts/football-grid-content.js';

function sourceManifest() {
  const players = Array.from(
    { length: 9 },
    (_, index) => `00000000-0000-4000-8000-${String(800001 + index).padStart(12, '0')}`,
  );
  const criteria = Array.from({ length: 6 }, (_, index) => ({
    key: `criterion-${index}`,
    family: index < 3 ? 'club' as const : 'country' as const,
    subtype: 'integration',
    labelEn: `Criterion ${index}`,
    labelKa: `კრიტერიუმი ${index}`,
    assetKey: `asset-${index}`,
    metadata: {},
    difficulty: index === 0 ? 'normal' as const : 'easy' as const,
    familiarityScore: 90,
  }));
  const evidence = {
    sourceKey: 'licensed-source',
    sourceLocator: 'fixture:1',
    capturedFact: 'verified relationship',
    rightsClass: 'licensed',
    reviewedBy: 'reviewer',
    reviewedAt: '2026-08-20T00:00:00.000Z',
  };
  return manifestSchema.parse({
    release: {
      version: 1,
      aliasVersion: 1,
      resolverPolicyVersion: 1,
      relationshipSnapshot: { version: 1 },
      approvedBy: 'reviewer',
      approvedAt: '2026-08-20T00:00:00.000Z',
    },
    sources: [{
      key: 'licensed-source',
      providerName: 'Fixture Provider',
      datasetVersion: '1',
      permittedUse: 'gameplay',
      databaseRightsStatus: 'approved',
      approvalOwner: 'legal',
      approvedAt: '2026-08-20T00:00:00.000Z',
    }],
    assetCatalog: [
      ...criteria.map((criterion) => criterion.assetKey),
      ...players.map((_, index) => `player-image-${index}`),
    ],
    players: players.map((id, index) => ({
      id,
      nameEn: `Player ${index}`,
      nameKa: `მოთამაშე ${index}`,
      imageAssetKey: `player-image-${index}`,
    })),
    criteria,
    memberships: criteria.flatMap((criterion) => players.map((playerId) => ({
      criterionKey: criterion.key,
      playerId,
      relationshipSubtype: 'senior_appearance',
      verifiedBy: 'reviewer',
      reviewedAt: '2026-08-20T00:00:00.000Z',
      evidence: [{ ...evidence }],
    }))),
    aliases: players.flatMap((playerId, index) => [
      {
        playerId,
        alias: `Player ${index}`,
        normalizedAlias: `player ${index}`,
        locale: 'en' as const,
        aliasType: 'full_name' as const,
        acceptancePolicy: 'exact' as const,
        reviewedBy: 'reviewer',
        reviewedAt: '2026-08-20T00:00:00.000Z',
      },
      {
        playerId,
        alias: `მოთამაშე ${index}`,
        normalizedAlias: `მოთამაშე ${index}`,
        locale: 'ka' as const,
        aliasType: 'georgian' as const,
        acceptancePolicy: 'exact' as const,
        reviewedBy: 'reviewer',
        reviewedAt: '2026-08-20T00:00:00.000Z',
      },
    ]),
  });
}

describe('Football Grid content CLI contracts', () => {
  it('rejects flags whose required path value is missing', () => {
    expect(() => optionValue(['--out'], '--out')).toThrow('--out requires a value');
    expect(() => optionValue(['--asset-registry', '--feasibility'], '--asset-registry')).toThrow(
      '--asset-registry requires a value',
    );
    expect(optionValue([], '--out')).toBeUndefined();
  });

  it('generates a viable review-required 3x3 candidate from normalized memberships', () => {
    const manifest = sourceManifest();
    const boards = generateCandidateBoards(manifest, 1);
    expect(boards).toHaveLength(1);
    expect(boards[0].approvedBy).toBe('UNREVIEWED');
    expect(boards[0].cells).toHaveLength(9);
    expect(boards[0].cells.every((cell) => cell.playerIds.length === 9)).toBe(true);
    expect(boards[0].cells.every((cell) => cell.recognizablePlayerIds.length === 2)).toBe(true);
  });

  it('blocks a generated board from launch until explicitly reviewed', () => {
    const manifest = sourceManifest();
    manifest.boards = generateCandidateBoards(manifest, 1);
    expect(validateManifest(manifest, true).errors).toContain(
      `${manifest.boards[0].key}: board is not explicitly approved`,
    );
  });

  it('blocks launch when a criterion asset is missing from the complete catalog', () => {
    const manifest = sourceManifest();
    manifest.assetCatalog = manifest.assetCatalog.slice(1);
    const errors = validateManifest(manifest, true).errors;
    expect(errors).toContain('Criterion criterion-0 references missing asset asset-0');
  });
});

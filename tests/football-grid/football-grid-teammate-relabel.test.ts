import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import '../setup.js';
import {
  TEAMMATE_LABEL,
  buildAssetRegistry,
  manifestContentDigest,
  manifestSchema,
  projectExportedBoards,
  relabelTeammateCriteria,
  storageObjectPathForAssetKey,
  validateManifest,
  type ExportedAnswerRow,
  type Manifest,
} from '../../scripts/football-grid-content.js';
import { objectIsMissing, planMirror } from '../../scripts/football-grid-mirror-assets.js';

// Owner report 2026-09-20: "played with Agüero" × Ligue 1 rejected Messi and
// Di María. The criterion means club-season overlap; the label did not say so.
// These fixtures pin (a) the relabel transform, (b) that a label-only release
// keeps every answer byte-identical, and (c) that rejection of a non-teammate
// comes from the answer set, not from the resolver.

const AGUERO = '00000000-0000-4000-8000-000000000001';
const MESSI = '00000000-0000-4000-8000-000000000002';
const DI_MARIA = '00000000-0000-4000-8000-000000000003';
const SILVA = '00000000-0000-4000-8000-000000000004';
const MBAPPE = '00000000-0000-4000-8000-000000000005';
const NEYMAR = '00000000-0000-4000-8000-000000000006';
const VERRATTI = '00000000-0000-4000-8000-000000000007';
const KOMPANY = '00000000-0000-4000-8000-000000000008';
const STERLING = '00000000-0000-4000-8000-000000000009';
const PLAYERS = [AGUERO, MESSI, DI_MARIA, SILVA, MBAPPE, NEYMAR, VERRATTI, KOMPANY, STERLING];

const reviewed = { verifiedBy: 'fixture', reviewedAt: '2026-09-20T00:00:00.000Z' };
const evidence = {
  sourceKey: 'transfermarkt-datasets',
  sourceLocator: 'appearances.csv:fixture',
  capturedFact: 'fixture',
  rightsClass: 'cc0',
  reviewedBy: 'fixture',
  reviewedAt: '2026-09-20T00:00:00.000Z',
};

function membership(criterionKey: string, playerId: string) {
  return { criterionKey, playerId, relationshipSubtype: 'fixture', ...reviewed, evidence: [{ ...evidence }] };
}

function alias(playerId: string, text: string, locale: 'en' | 'ka' = 'en') {
  return {
    playerId, alias: text, normalizedAlias: text.toLowerCase(), locale,
    aliasType: locale === 'ka' ? 'georgian' as const : 'full_name' as const,
    acceptancePolicy: 'exact' as const, reviewedBy: 'fixture', reviewedAt: '2026-09-20T00:00:00.000Z',
  };
}

/** A served-style manifest with the legacy teammate wording. */
function legacyManifest() {
  const teammateKey = `teammate:${AGUERO}`;
  const criteria = [
    { key: teammateKey, family: 'teammate' as const, subtype: 'same-club-season', labelEn: 'Played with Sergio Agüero', labelKa: 'ითამაშა სერხიო აგუერო-სთან ერთად', assetKey: `/assets/football-grid/players/${AGUERO}.webp`, metadata: {}, difficulty: 'normal' as const, familiarityScore: 80 },
    { key: 'league:ligue-1', family: 'league' as const, subtype: 'senior-league-appearance', labelEn: 'Ligue 1', labelKa: 'ლიგა 1', assetKey: 'ligue-1', metadata: {}, difficulty: 'easy' as const, familiarityScore: 90 },
    { key: 'league:serie-a', family: 'league' as const, subtype: 'senior-league-appearance', labelEn: 'Serie A', labelKa: 'სერია A', assetKey: 'serie-a', metadata: {}, difficulty: 'easy' as const, familiarityScore: 90 },
    { key: 'club:manchester-city', family: 'club' as const, subtype: 'senior-club-appearance', labelEn: 'Manchester City', labelKa: 'Manchester City', assetKey: 'manchester-city', metadata: {}, difficulty: 'easy' as const, familiarityScore: 95 },
    { key: 'club:psg', family: 'club' as const, subtype: 'senior-club-appearance', labelEn: 'Paris Saint-Germain', labelKa: 'Paris Saint-Germain', assetKey: 'psg', metadata: {}, difficulty: 'easy' as const, familiarityScore: 95 },
    { key: 'country:argentina', family: 'country' as const, subtype: 'nationality', labelEn: 'Argentina', labelKa: 'არგენტინა', assetKey: 'argentina', metadata: {}, difficulty: 'easy' as const, familiarityScore: 95 },
  ];
  // Club-season overlap only: Agüero's Man City years. Messi and Di María were
  // Argentina teammates, never club teammates in the data → not members.
  const memberships = [
    ...[SILVA, KOMPANY, STERLING].map((id) => membership(teammateKey, id)),
    ...[MESSI, DI_MARIA, MBAPPE, NEYMAR, VERRATTI].map((id) => membership('league:ligue-1', id)),
    ...[DI_MARIA].map((id) => membership('league:serie-a', id)),
    ...[AGUERO, SILVA, KOMPANY, STERLING].map((id) => membership('club:manchester-city', id)),
    ...[MESSI, DI_MARIA, MBAPPE, NEYMAR, VERRATTI].map((id) => membership('club:psg', id)),
    ...[AGUERO, MESSI, DI_MARIA].map((id) => membership('country:argentina', id)),
  ];
  return manifestSchema.parse({
    release: {
      version: 2026090403, aliasVersion: 1, resolverPolicyVersion: 1,
      relationshipSnapshot: { generator: 'fixture' }, approvedBy: 'football-grid-launch-audit-v1', approvedAt: '2026-09-04T00:00:00.000Z',
    },
    sources: [{
      key: 'transfermarkt-datasets', providerName: 'dcaribou/transfermarkt-datasets', datasetVersion: '2026-08-05',
      permittedUse: 'gameplay', databaseRightsStatus: 'approved', approvalOwner: 'owner', approvedAt: '2026-08-20T00:00:00.000Z',
    }],
    assetCatalog: [],
    players: PLAYERS.map((id, index) => ({ id, nameEn: `Player ${index}`, nameKa: `მოთამაშე ${index}`, imageAssetKey: `/assets/football-grid/players/${id}.webp` })),
    criteria,
    memberships,
    aliases: [
      alias(MESSI, 'Lionel Messi'), alias(MESSI, 'მესი', 'ka'), alias(DI_MARIA, 'Angel Di Maria'), alias(DI_MARIA, 'დი მარია', 'ka'),
      ...PLAYERS.filter((id) => id !== MESSI && id !== DI_MARIA).flatMap((id, index) => [alias(id, `Player ${index}`), alias(id, `მოთამაშე ${index}`, 'ka')]),
    ],
    boards: [],
  });
}

describe('teammate relabel transform', () => {
  it('rewrites every legacy teammate label in en/ka and leaves all content untouched', () => {
    const source = legacyManifest();
    const before = manifestContentDigest(source);
    const { manifest, relabelled, skipped } = relabelTeammateCriteria(source, {
      version: 2026092101, approvedBy: 'owner', approvedAt: '2026-09-21T00:00:00.000Z',
    });
    expect(relabelled).toBe(1);
    expect(skipped).toEqual([]);
    const teammate = manifest.criteria.find((criterion) => criterion.family === 'teammate')!;
    expect(teammate.labelEn).toBe('Club teammate of Sergio Agüero');
    expect(teammate.labelKa).toBe('ერთ კლუბში ითამაშა სერხიო აგუერო-სთან');
    expect(TEAMMATE_LABEL.es('Sergio Agüero')).toBe('Compañero de club de Sergio Agüero');
    expect(TEAMMATE_LABEL.tr('Sergio Agüero')).toBe('Sergio Agüero ile aynı kulüpte oynadı');
    // Non-teammate criteria are byte-identical; memberships/aliases/players too.
    expect(manifest.criteria.filter((c) => c.family !== 'teammate')).toEqual(source.criteria.filter((c) => c.family !== 'teammate'));
    expect(manifest.memberships).toEqual(source.memberships);
    expect(manifest.aliases).toEqual(source.aliases);
    expect(manifest.players).toEqual(source.players);
    expect(manifestContentDigest(manifest)).toBe(before);
    expect(manifest.release.version).toBe(2026092101);
    expect(manifest.release.relationshipSnapshot).toMatchObject({ transformedFromVersion: 2026090403, transform: 'teammate-relabel-v1' });
    // Source manifest is not mutated.
    expect(source.criteria.find((c) => c.family === 'teammate')!.labelEn).toBe('Played with Sergio Agüero');
  });

  it('refuses a version that does not move forward', () => {
    expect(() => relabelTeammateCriteria(legacyManifest(), { version: 2026090403, approvedBy: 'owner', approvedAt: '2026-09-21T00:00:00.000Z' }))
      .toThrow(/must exceed/);
  });

  it('reports teammate criteria whose labels do not follow the legacy pattern instead of guessing', () => {
    const source = legacyManifest();
    const custom = { ...source, criteria: source.criteria.map((criterion) => criterion.family === 'teammate' ? { ...criterion, labelEn: 'Agüero era' } : criterion) };
    const { relabelled, skipped } = relabelTeammateCriteria(manifestSchema.parse(custom), { version: 2026092101, approvedBy: 'owner', approvedAt: '2026-09-21T00:00:00.000Z' });
    expect(relabelled).toBe(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(`teammate:${AGUERO}`);
  });
});

describe('teammate semantics regression (owner report 2026-09-20)', () => {
  const board = {
    key: 'board:fixture', version: 1, theme: 'european' as const,
    rowCriteria: [`teammate:${AGUERO}`, 'club:manchester-city', 'country:argentina'] as [string, string, string],
    columnCriteria: ['league:ligue-1', 'club:psg', 'league:serie-a'] as [string, string, string],
    difficulty: 'normal' as const, familiarityScore: 80, approvedBy: 'fixture',
  };

  it('a cell answer must hold BOTH memberships: Di María is Ligue 1 but not a club teammate of Agüero', () => {
    const source = legacyManifest();
    const cells = Array.from({ length: 9 }, () => ({ playerIds: [MESSI, DI_MARIA, MBAPPE], recognizablePlayerIds: [MESSI, DI_MARIA] }));
    const manifest = manifestSchema.parse({ ...source, boards: [{ ...board, cells }] });
    const { errors } = validateManifest(manifest, false);
    // Cell 0 = teammate × Ligue 1: Messi and Di María lack the teammate membership.
    expect(errors).toEqual(expect.arrayContaining([
      `board:fixture cell 0: ${MESSI} lacks both criterion memberships`,
      `board:fixture cell 0: ${DI_MARIA} lacks both criterion memberships`,
    ]));
  });

  it('the same players are valid where the data supports them (Argentina × Ligue 1, Di María × Serie A)', () => {
    const source = legacyManifest();
    const cells = Array.from({ length: 9 }, () => ({ playerIds: [MESSI, DI_MARIA, MBAPPE], recognizablePlayerIds: [MESSI, DI_MARIA] }));
    // Cell 6 = Argentina × Ligue 1; cell 8 = Argentina × Serie A.
    cells[6] = { playerIds: [MESSI, DI_MARIA, MBAPPE], recognizablePlayerIds: [MESSI, DI_MARIA] };
    cells[8] = { playerIds: [DI_MARIA, MESSI, MBAPPE], recognizablePlayerIds: [DI_MARIA, MESSI] };
    const manifest = manifestSchema.parse({ ...source, boards: [{ ...board, cells }] });
    const { errors } = validateManifest(manifest, false);
    expect(errors).not.toContain(`board:fixture cell 6: ${MESSI} lacks both criterion memberships`);
    expect(errors).not.toContain(`board:fixture cell 6: ${DI_MARIA} lacks both criterion memberships`);
    expect(errors).not.toContain(`board:fixture cell 8: ${DI_MARIA} lacks both criterion memberships`);
    // Messi never played Serie A → still rejected in cell 8 (Argentina × Serie A).
    expect(errors).toContain(`board:fixture cell 8: ${MESSI} lacks both criterion memberships`);
  });
});

describe('export projection guards (round trip must be exact, never normalised)', () => {
  const boardRow = {
    id: 'b1', version: 1, difficulty: 'normal' as const, familiarity_score: '80', canonical_checksum: 'abc',
    approved_by: 'fixture', theme: 'european',
    rowCriteria: ['r1', 'r2', 'r3'] as [string, string, string], columnCriteria: ['c1', 'c2', 'c3'] as [string, string, string],
  };
  const answer = (overrides: Partial<ExportedAnswerRow>): ExportedAnswerRow => ({
    board_id: 'b1', cell_index: 0, football_player_id: MESSI, player_name_en: 'Lionel Messi', player_name_ka: 'ლიონელ მესი',
    image_asset_key: 'https://example.test/messi.webp', recognizable_rank: null, is_sample: false, ...overrides,
  });
  const fullBoard = (cell0: ExportedAnswerRow[]) => [
    ...cell0,
    ...Array.from({ length: 8 }, (_, i) => answer({ cell_index: i + 1, football_player_id: SILVA, player_name_en: 'David Silva', player_name_ka: 'დავიდ სილვა', image_asset_key: 'silva' })),
  ];

  it('rebuilds cells, sample order and one display record per player', () => {
    const rows = fullBoard([
      answer({ football_player_id: DI_MARIA, player_name_en: 'Di María', player_name_ka: 'დი მარია', image_asset_key: 'dm', recognizable_rank: 2, is_sample: true }),
      answer({ recognizable_rank: 1, is_sample: true }),
      answer({ football_player_id: MBAPPE, player_name_en: 'Mbappé', player_name_ka: 'მბაპე', image_asset_key: 'mb' }),
    ]);
    const { boards, players } = projectExportedBoards([boardRow], rows);
    expect(boards[0].key).toBe('board:abc');
    expect(boards[0].cells[0]).toEqual({ playerIds: [DI_MARIA, MESSI, MBAPPE], recognizablePlayerIds: [MESSI, DI_MARIA] });
    expect(players.map((p) => p.id)).toEqual([MESSI, DI_MARIA, SILVA, MBAPPE].sort());
  });

  it('rejects a player whose answer rows disagree on the display record', () => {
    const rows = fullBoard([answer({}), answer({ cell_index: 4, player_name_en: 'Leo Messi' })]);
    expect(() => projectExportedBoards([boardRow], rows)).toThrow(/different display records/);
  });

  it('rejects sample ranks that are not 1..n and sample flags that disagree with the rank', () => {
    expect(() => projectExportedBoards([boardRow], fullBoard([
      answer({ recognizable_rank: 1, is_sample: true }),
      answer({ football_player_id: DI_MARIA, player_name_en: 'Di María', player_name_ka: 'დი მარია', image_asset_key: 'dm', recognizable_rank: 3, is_sample: true }),
    ]))).toThrow(/sample ranks are not 1\.\.2/);
    expect(() => projectExportedBoards([boardRow], fullBoard([answer({ recognizable_rank: 1, is_sample: false })])))
      .toThrow(/sample flag and recognizable rank disagree/);
  });

  it('rejects incomplete display records instead of dropping the player', () => {
    expect(() => projectExportedBoards([boardRow], fullBoard([answer({ player_name_ka: null })]))).toThrow(/incomplete display record/);
  });
});

describe('asset registry for served releases', () => {
  it('resolves slug, launch-pool portrait and cached URL keys; prefers real crests over fallbacks; lists what is missing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'grid-assets-'));
    const base = path.join(root, 'assets', 'football-grid');
    for (const dir of ['clubs', 'leagues', 'flags', 'wildcards']) await mkdir(path.join(base, dir), { recursive: true });
    await writeFile(path.join(base, 'clubs', 'chelsea-fallback.svg'), '');
    await writeFile(path.join(base, 'clubs', 'chelsea.svg'), '');
    await writeFile(path.join(base, 'leagues', 'ligue-1-fallback.svg'), '');
    await writeFile(path.join(base, 'flags', 'ar.svg'), '');
    await writeFile(path.join(base, 'wildcards', 'position-fwd.svg'), '');
    const pool = path.join(root, 'pool');
    await mkdir(pool);
    await writeFile(path.join(pool, `${AGUERO}.webp`), '');
    const cache = path.join(root, 'cache');
    const url = 'https://example.test/storage/v1/object/public/imgs/football-grid/v1/players/x.webp';
    await mkdir(cache);
    await writeFile(path.join(cache, `${createHash('sha256').update(url).digest('hex').slice(0, 24)}.webp`), '');
    const manifest = { assetCatalog: ['chelsea', 'ligue-1', 'ar', 'position-fwd', `/assets/football-grid/players/${AGUERO}.webp`, url] } as Manifest;

    const { registry, fallbacks } = await buildAssetRegistry(manifest, { assetRoot: root, assetCache: cache, playerPool: pool, fetchUrls: false });
    expect(fallbacks).toEqual([]);
    expect(registry.chelsea).toBe(path.join(base, 'clubs', 'chelsea.svg'));
    expect(registry['ligue-1']).toBe(path.join(base, 'leagues', 'ligue-1-fallback.svg'));
    expect(registry.ar).toBe(path.join(base, 'flags', 'ar.svg'));
    expect(registry['position-fwd']).toBe(path.join(base, 'wildcards', 'position-fwd.svg'));
    expect(registry[`/assets/football-grid/players/${AGUERO}.webp`]).toBe(path.join(pool, `${AGUERO}.webp`));
    expect(registry[url]).toMatch(/cache\/[0-9a-f]{24}\.webp$/);

    // The fallback file only covers allow-listed keys, and every use is reported.
    const fallbackFile = path.join(base, 'clubs', 'chelsea-fallback.svg');
    const withFallback = await buildAssetRegistry({ assetCatalog: ['nowhere', 'chelsea'] } as Manifest, { assetRoot: root, fallbackFile, fallbackKeys: ['nowhere'], fetchUrls: false });
    expect(withFallback.registry.nowhere).toBe(fallbackFile);
    expect(withFallback.fallbacks).toEqual(['nowhere']);
    await expect(buildAssetRegistry({ assetCatalog: ['nowhere', 'elsewhere'] } as Manifest, { assetRoot: root, fallbackFile, fallbackKeys: ['nowhere'], fetchUrls: false }))
      .rejects.toThrow(/1 of 2 keys unresolved\nelsewhere/);
    await expect(buildAssetRegistry({ assetCatalog: ['nowhere'] } as Manifest, { assetRoot: root, fallbackFile, fetchUrls: false }))
      .rejects.toThrow(/1 of 1 keys unresolved/);

    const failure = await buildAssetRegistry({ assetCatalog: ['nowhere', url] } as Manifest, { assetRoot: root, fetchUrls: false })
      .then(() => null, (error: Error) => error.message);
    expect(failure).toMatch(/2 of 2 keys unresolved/);
    expect(failure).toContain('\nnowhere');
    expect(failure).toContain(`${url} (URL key; pass --asset-cache)`);
  });
});

describe('asset origin rewrite (portrait mirror to another project)', () => {
  const STAGING = 'https://nsdfiprfmhdqhbfxfwpv.supabase.co';
  const PROD = 'https://lfbwhxvwubzeqkztghok.supabase.co';

  it('rewrites only URL keys of the given origin, records the rewrite, and stays recomputable', () => {
    const source = legacyManifest();
    const url = `${STAGING}/storage/v1/object/public/imgs/football-grid/v1/players/${MESSI}.webp`;
    const withUrls = manifestSchema.parse({
      ...source,
      assetCatalog: [url, 'ligue-1', `/assets/football-grid/players/${AGUERO}.webp`],
      players: source.players.map((player) => (player.id === MESSI ? { ...player, imageAssetKey: url } : player)),
    });
    const options = { version: 2026092101, approvedBy: 'owner', approvedAt: '2026-09-21T00:00:00.000Z', assetOrigin: { from: STAGING, to: PROD } };
    const { manifest, rewritten, relabelled } = relabelTeammateCriteria(withUrls, options);
    expect(relabelled).toBe(1);
    expect(rewritten).toBe(2); // catalog entry + Messi's portrait
    expect(manifest.assetCatalog).toContain(url.replace(STAGING, PROD));
    expect(manifest.assetCatalog).toContain('ligue-1');
    expect(manifest.players.find((p) => p.id === MESSI)!.imageAssetKey).toBe(url.replace(STAGING, PROD));
    expect(manifest.release.relationshipSnapshot).toMatchObject({ assetOriginRewrite: { from: STAGING, to: PROD } });
    // Deterministic: the waiver recomputes the same manifest from the same source + options.
    expect(relabelTeammateCriteria(withUrls, options).manifest).toEqual(manifest);
    // Without the rewrite the content digest is untouched; with it, the catalog changed on purpose.
    expect(manifestContentDigest(relabelTeammateCriteria(withUrls, { ...options, assetOrigin: undefined }).manifest)).toBe(manifestContentDigest(withUrls));
    expect(manifestContentDigest(manifest)).not.toBe(manifestContentDigest(withUrls));
  });

  it('refuses malformed or identical origins', () => {
    const source = legacyManifest();
    const base = { version: 2026092101, approvedBy: 'owner', approvedAt: '2026-09-21T00:00:00.000Z' };
    expect(() => relabelTeammateCriteria(source, { ...base, assetOrigin: { from: STAGING, to: STAGING } })).toThrow(/two different/);
    expect(() => relabelTeammateCriteria(source, { ...base, assetOrigin: { from: 'https://evil.example', to: PROD } })).toThrow(/two different/);
  });

  it('maps served asset keys to storage object paths', () => {
    expect(storageObjectPathForAssetKey(`${STAGING}/storage/v1/object/public/imgs/football-grid/v1/players/${MESSI}.webp`)).toBe(`football-grid/v1/players/${MESSI}.webp`);
    expect(storageObjectPathForAssetKey(`${STAGING}/storage/v1/object/public/imgs/player-images/${MESSI}`)).toBe(`player-images/${MESSI}`);
    expect(storageObjectPathForAssetKey(`/assets/football-grid/players/${AGUERO}.webp`)).toBe(`football-grid/v1/players/${AGUERO}.webp`);
    expect(storageObjectPathForAssetKey('players/unknown.webp')).toBe('football-grid/v1/players/unknown.webp');
    expect(storageObjectPathForAssetKey(`${STAGING}/storage/v1/object/public/imgs/football-grid/v1/players/${MESSI}.webp?v=2#x`)).toBe(`football-grid/v1/players/${MESSI}.webp`);
    expect(storageObjectPathForAssetKey('ligue-1')).toBeNull();
    expect(storageObjectPathForAssetKey('https://evil.example/storage/v1/object/public/imgs/x.webp')).toBeNull();
  });

  it('plans a mirror from a registry: uploads storage-backed keys once per object, skips bundled and fallback entries', () => {
    const registry = {
      [`${STAGING}/storage/v1/object/public/imgs/football-grid/v1/players/${MESSI}.webp`]: '/cache/aa.webp',
      [`/assets/football-grid/players/${AGUERO}.webp`]: '/pool/ag.webp',
      'players/unknown.webp': '/web/assets/football-grid/managers/_launch-fallback.svg',
      'ligue-1': '/web/assets/football-grid/leagues/ligue-1-fallback.svg',
    };
    expect([400, 404].every(objectIsMissing)).toBe(true);
    expect([200, 429, 500, 503].some(objectIsMissing)).toBe(false);
    const { uploads, skipped } = planMirror(registry);
    expect(uploads.map((u) => u.objectPath).sort()).toEqual([`football-grid/v1/players/${AGUERO}.webp`, `football-grid/v1/players/${MESSI}.webp`].sort());
    expect(skipped.sort()).toEqual(['ligue-1', 'players/unknown.webp']);
  });
});

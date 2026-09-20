import 'dotenv/config';
import postgres from 'postgres';

const RELEASE_ID = '00000000-0000-4000-8000-000000980001';
const BOARD_ID = '00000000-0000-4000-8000-000000983001';
const RELEASE_VERSION = 980001;
const CRITERION_IDS = {
  arsenal: '00000000-0000-4000-8000-000000981001',
  barcelona: '00000000-0000-4000-8000-000000981002',
  realMadrid: '00000000-0000-4000-8000-000000981003',
  france: '00000000-0000-4000-8000-000000981004',
  brazil: '00000000-0000-4000-8000-000000981005',
  spain: '00000000-0000-4000-8000-000000981006',
} as const;

const CRITERIA = [
  { id: CRITERION_IDS.arsenal, key: 'arsenal', family: 'club', labelEn: 'Arsenal', labelKa: 'არსენალი', assetKey: 'arsenal' },
  { id: CRITERION_IDS.barcelona, key: 'fc-barcelona', family: 'club', labelEn: 'FC Barcelona', labelKa: 'ბარსელონა', assetKey: 'fc-barcelona' },
  { id: CRITERION_IDS.realMadrid, key: 'real-madrid-cf', family: 'club', labelEn: 'Real Madrid', labelKa: 'რეალ მადრიდი', assetKey: 'real-madrid-cf' },
  { id: CRITERION_IDS.france, key: 'france', family: 'country', labelEn: 'France', labelKa: 'საფრანგეთი', assetKey: 'fr' },
  { id: CRITERION_IDS.brazil, key: 'brazil', family: 'country', labelEn: 'Brazil', labelKa: 'ბრაზილია', assetKey: 'br' },
  { id: CRITERION_IDS.spain, key: 'spain', family: 'country', labelEn: 'Spain', labelKa: 'ესპანეთი', assetKey: 'es' },
] as const;

const CELL_PLAYERS = [
  { cell: 0, name: 'Thierry Henry', nameKa: 'თიერი ანრი', row: CRITERION_IDS.arsenal, column: CRITERION_IDS.france },
  { cell: 1, name: 'Gabriel Jesus', nameKa: 'გაბრიელ ჟეზუსი', row: CRITERION_IDS.arsenal, column: CRITERION_IDS.brazil },
  { cell: 2, name: 'Mikel Arteta', nameKa: 'მიკელ არტეტა', row: CRITERION_IDS.arsenal, column: CRITERION_IDS.spain },
  { cell: 3, name: 'Antoine Griezmann', nameKa: 'ანტუან გრიზმანი', row: CRITERION_IDS.barcelona, column: CRITERION_IDS.france },
  { cell: 4, name: 'Neymar', nameKa: 'ნეიმარი', row: CRITERION_IDS.barcelona, column: CRITERION_IDS.brazil },
  { cell: 5, name: 'Xavi', nameKa: 'ჩავი', row: CRITERION_IDS.barcelona, column: CRITERION_IDS.spain },
  { cell: 6, name: 'Karim Benzema', nameKa: 'ქარიმ ბენზემა', row: CRITERION_IDS.realMadrid, column: CRITERION_IDS.france },
  { cell: 7, name: 'Marcelo', nameKa: 'მარსელო', row: CRITERION_IDS.realMadrid, column: CRITERION_IDS.brazil },
  { cell: 8, name: 'Sergio Ramos', nameKa: 'სერხიო რამოსი', row: CRITERION_IDS.realMadrid, column: CRITERION_IDS.spain },
] as const;

function normalizeAlias(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\u10a0-\u10ff]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'local') {
    throw new Error('Refusing to seed Tic Tac Toe preview content outside NODE_ENV=local');
  }
  const databaseUrl = process.env.DATABASE_URL ?? process.env.STAGING_DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL or STAGING_DATABASE_URL is required');

  const db = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    await db.begin(async (tx) => {
      const playerNames = CELL_PLAYERS.map((player) => player.name.toLocaleLowerCase());
      const playerRows = await tx.unsafe<Array<{ id: string; name: string }>>(
        `SELECT DISTINCT ON (lower(name)) id, name
           FROM football_players
          WHERE lower(name) = ANY($1::text[])
          ORDER BY lower(name), (data_quality_status = 'usable') DESC,
                   (image_url LIKE '%/football-grid/%') DESC, id`,
        [playerNames],
      );
      const playersByName = new Map(playerRows.map((player) => [player.name.toLocaleLowerCase(), player]));
      const missing = CELL_PLAYERS.filter((player) => !playersByName.has(player.name.toLocaleLowerCase()));
      if (missing.length > 0) throw new Error(`Missing preview players: ${missing.map((player) => player.name).join(', ')}`);

      await tx.unsafe(
        `INSERT INTO football_grid_content_releases (
           id, version, status, relationship_snapshot, alias_version,
           resolver_policy_version, manifest_checksum, approved_by,
           approved_at, published_at
         ) VALUES (
           $1, $2, 'published', '{"developmentSeed":true}'::jsonb, 1, 1,
           $3, 'local-development-seed', now(), now()
         )
         ON CONFLICT (id) DO UPDATE
           SET status = 'published', approved_by = EXCLUDED.approved_by,
               approved_at = now(), published_at = now()`,
        [RELEASE_ID, RELEASE_VERSION, '9800010000000000000000000000000000000000000000000000000000000001'],
      );

      for (const item of CRITERIA) {
        await tx.unsafe(
          `INSERT INTO football_grid_criteria (
             id, release_id, criterion_key, family, subtype, label_en,
             label_ka, asset_key, metadata, difficulty, familiarity_score
           ) VALUES ($1, $2, $3, $4, 'local-preview', $5, $6, $7, '{"developmentSeed":true}'::jsonb, 'easy', 100)
           ON CONFLICT (id) DO UPDATE
             SET label_en = EXCLUDED.label_en, label_ka = EXCLUDED.label_ka,
                 asset_key = EXCLUDED.asset_key`,
          [item.id, RELEASE_ID, item.key, item.family, item.labelEn, item.labelKa, item.assetKey],
        );
      }

      await tx.unsafe(
        `INSERT INTO football_grid_boards (
           id, release_id, version, row_criteria, column_criteria,
           difficulty, familiarity_score, canonical_checksum, approved_by, published_at
         ) VALUES ($1, $2, 1, $3::uuid[], $4::uuid[], 'easy', 100, $5, 'local-development-seed', now())
         ON CONFLICT (id) DO UPDATE
           SET row_criteria = EXCLUDED.row_criteria,
               column_criteria = EXCLUDED.column_criteria,
               published_at = now()`,
        [
          BOARD_ID,
          RELEASE_ID,
          [CRITERION_IDS.arsenal, CRITERION_IDS.barcelona, CRITERION_IDS.realMadrid],
          [CRITERION_IDS.france, CRITERION_IDS.brazil, CRITERION_IDS.spain],
          '9800010000000000000000000000000000000000000000000000000000003001',
        ],
      );

      for (const cellPlayer of CELL_PLAYERS) {
        const player = playersByName.get(cellPlayer.name.toLocaleLowerCase())!;
        for (const criterionId of [cellPlayer.row, cellPlayer.column]) {
          await tx.unsafe(
            `INSERT INTO football_grid_criterion_memberships (
               release_id, criterion_id, football_player_id, relationship_subtype,
               verified_by, reviewed_at
             ) VALUES ($1, $2, $3, 'local-preview', 'local-development-seed', now())
             ON CONFLICT (criterion_id, football_player_id) DO NOTHING`,
            [RELEASE_ID, criterionId, player.id],
          );
        }

        const nameParts = cellPlayer.name.split(/\s+/);
        const englishAliases = nameParts.length === 1
          ? [{ alias: cellPlayer.name, type: 'mononym', policy: 'exact' }]
          : [
              { alias: cellPlayer.name, type: 'full_name', policy: 'exact' },
              { alias: nameParts[0], type: 'given_name', policy: 'unique_only' },
              { alias: nameParts.at(-1)!, type: 'family_name', policy: 'unique_only' },
            ];
        for (const alias of englishAliases) {
          await tx.unsafe(
            `INSERT INTO football_grid_player_aliases (
               release_id, football_player_id, alias, normalized_alias, locale,
               alias_type, acceptance_policy, reviewed_by, reviewed_at
             ) VALUES ($1, $2, $3, $4, 'en', $5, $6, 'local-development-seed', now())
             ON CONFLICT DO NOTHING`,
            [RELEASE_ID, player.id, alias.alias, normalizeAlias(alias.alias), alias.type, alias.policy],
          );
        }
        await tx.unsafe(
          `INSERT INTO football_grid_player_aliases (
             release_id, football_player_id, alias, normalized_alias, locale,
             alias_type, acceptance_policy, reviewed_by, reviewed_at
           ) VALUES ($1, $2, $3, $4, 'ka', 'georgian', 'exact', 'local-development-seed', now())
           ON CONFLICT DO NOTHING`,
          [RELEASE_ID, player.id, cellPlayer.nameKa, normalizeAlias(cellPlayer.nameKa)],
        );
        await tx.unsafe(
          `INSERT INTO football_grid_board_answers (
             board_id, release_id, cell_index, football_player_id,
             player_name_en, player_name_ka, recognizable_rank, is_sample
           ) VALUES ($1, $2, $3, $4, $5, $6, 1, true)
           ON CONFLICT (board_id, cell_index, football_player_id) DO UPDATE
             SET player_name_en = EXCLUDED.player_name_en,
                 player_name_ka = EXCLUDED.player_name_ka`,
          [BOARD_ID, RELEASE_ID, cellPlayer.cell, player.id, cellPlayer.name, cellPlayer.nameKa],
        );
      }
    });
    process.stdout.write(`Football Tic Tac Toe development content is ready (${CELL_PLAYERS.length} playable cells).\n`);
  } finally {
    await db.end();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

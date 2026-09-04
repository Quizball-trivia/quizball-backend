# Football Grid content generator

`football-grid-build-launch-manifest.py` builds the launch manifest (criteria,
memberships with CSV evidence, boards) that `npm run grid:content -- publish`
loads. Until 2026-09-04 it lived only as an untracked file in the
`grid-launch-content` worktree; this copy is the source of truth now.

Inputs
- Dataset: dcaribou/transfermarkt-datasets (CC0), snapshot 2026-08-05, at
  `/Users/user/dev/quizball-worktrees/grid-launch-data/transfermarkt/*.csv.gz`
  — checksums in `dataset-2026-08-05.sha256`.
- Criterion catalogs: web repo `src/data/football-grid/launch-assets/*.json`.
- Python 3 + duckdb; `DATABASE_URL` must point at STAGING (the script refuses prod).

Run
```
python football-grid-build-launch-manifest.py \
  --dataset-dir <dataset> --frontend-root <web repo> --output manifest.json \
  --asset-registry asset-registry.json --asset-cache <dir> \
  --boards 500 --release-version <int> --seed 20260826
```
Then `npm run grid:content -- validate|review|publish|activate|retire`.

## Legends (careers before the 2012 appearance data)
1. Curate `legends.txt` (one name per line, optional `|QID`).
2. `python football-grid-fetch-legends.py legends.txt legends.json` — Wikidata careers (P54 with years), nationality, birth date, position, awards, Transfermarkt id, portrait.
3. `DATABASE_URL=<staging> python football-grid-upsert-legends.py legends.json [--apply]` — upgrades `legend:*` player rows / inserts new ones (portrait via Commons Special:FilePath, mirrored by `football-grid-player-cdn.ts --pool`).
4. Georgian names: `football-grid-translate-player-names.ts --tm-ids=<ids file>`.
5. Build with `--legends legends.json`: club/country/teammate/wildcard memberships get `wikidata:` evidence locators under source `wikidata-legends`.

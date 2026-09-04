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

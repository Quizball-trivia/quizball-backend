# Football Tic Tac Toe — teammate relabel release (Phase 0 of the teammate/Georgia plan)

Purpose: replace "Played with X" with "Club teammate of X" (en/ka/es/tr) on a **new content release whose content is identical to the served release apart from labels**. No memberships, answers, aliases or boards change. Plan and Codex reviews: `docs/FOOTBALL-GRID-TEAMMATE-AND-GEORGIA-PLAN.md`.

Served releases today (prod == staging, same ids and checksums):

| version | release id | manifest checksum | boards |
|---|---|---|---|
| 2026082610 | `e03a943d-2b4b-4ae9-8a9d-592003f59af3` | `e64dfc89469aa6f84743a3d162c5c97572d3178f079fbb04a5cd1f1ed824b561` | 949 |
| 2026090403 | `c5a929be-dcc8-4f64-a679-0677a9d0887d` | `c081b72fc6a457bd4fc90d3f35a59f8cf60af656c24131102cbaab7cdf3f0abe` | 2,000 |

Phase 0 transforms **both**: v2026090403 → **v2026092101** (European boards, ~85 % of matches) and v2026082610 → **v2026092102**. v2026082610 cannot simply be retired: its 494 European boards are board-quarantined ("Superseded by release 2026090401 … themed packs stay live"), and the remaining 455 boards are the themed packs (England, Spain, … ) with no overlap with v2026090403. The transformed copy gets new board ids, so the *effective* board-level disables (a disable with no newer enable, not expired; the runtime's own precedence rule) are carried over with `transfer-quarantines` before activation; release-level rows are never carried. The original manifest files of both served releases are not on disk any more, so retirement uses `retire-release` (pinned by version + id + stored checksum) instead of `retire <manifest>`.

## 0. Preconditions
- `DATABASE_URL` points at the target project; the locale script refuses the wrong project when `--target`/`--confirm-production` are used.
- Web checkout with launch assets: `/Users/user/dev/quizball-worktrees/grid-ui-sample-web/public`.
- Launch portrait pool: `/Users/user/dev/quizball-worktrees/grid-launch-data/release-2026082601/player-assets`.
- A portrait cache dir (any path; filled by step 1, reused by later runs).
- Owner OK recorded for the prod cutover (step 4).

## 1. Export the served release (read-only) and build the asset registry
```
cd backend-node
WEB=/Users/user/dev/quizball-worktrees/grid-ui-sample-web/public
DATABASE_URL=<staging> npx tsx scripts/football-grid-content.ts export 2026090403 \
  --out /tmp/grid/src-2026090403.json \
  --asset-root $WEB \
  --player-pool /Users/user/dev/quizball-worktrees/grid-launch-data/release-2026082601/player-assets \
  --asset-cache /tmp/grid/cache \
  --cdn-base https://nsdfiprfmhdqhbfxfwpv.supabase.co/storage/v1/object/public/imgs/football-grid/v1 \
  --fallback-file $WEB/assets/football-grid/managers/_launch-fallback.svg \
  --fallback-keys docs/football-grid-relabel-fallback-keys.txt \
  --registry-out /tmp/grid/assets-2026090403.json
```
Repeat with `2026082610` (own `--out`/`--registry-out`; same cache). All reads run in one repeatable-read read-only transaction, so aliases, answers and boards come from a single snapshot.
What the command proves before it writes anything:
- counts and every canonical board checksum match the database; no empty cells;
- every stored evidence checksum is reproduced from the exported evidence (`Evidence checksums reproduced: 47421/47421`; a single mismatch aborts the export), so `publish` will write identical evidence rows;
- answer rows are representable exactly (one display record per player, sample ranks 1..n) — otherwise it refuses instead of normalising;
- every asset key resolves: slug keys to the web checkout (`clubs/`, `leagues/`, `flags/`, `competitions/`, `managers/`, `wildcards/`; real image preferred over `-fallback`), storage-URL keys and `/assets/football-grid/players/<uuid>.webp` keys to files fetched once into the cache (pool first, then the CDN base).

Record the printed **content digest** (2026-09-20 exports: `86f055f3586bd36f2e92c0b3ef8f93ae13d910a468b73aad09dfbd0c21b4b520` for v2026090403, `b80a65a9be9923fcc782f9000b30750c5af239e513a5d6da99f737b6642a76e6` for v2026082610). v2026082610: 440 criteria (80 teammate), 13,361 memberships, 949 boards, all evidence checksums reproduced; one allow-listed fallback key, `players/unknown.webp` (placeholder portrait of 243 players, no such object in any bucket — renders through the fallback chain today).

`--fallback-file` applies only to keys listed in `--fallback-keys` (`docs/football-grid-relabel-fallback-keys.txt`, committed); any other unresolved key fails the export. In v2026090403 that is **24 keys**: 20 teammate-anchor portraits (legends: Del Piero, Nesta, Shevchenko, Seedorf, Makélélé, Deco, Cannavaro, Rijkaard, Weah, Crespo, Thuram, Figo, Desailly, Kanu, Kahn, Maldini, Ronaldinho, Ronaldo Nazario, Henry, Zidane) and 4 wildcard icons without an SVG (`born-2000s`, `champions-league-2plus`, `played-for-rivals`, `treble-winner`). They already render through the runtime fallback chain on both environments; the command lists them as a WARNING so the PR records the set. Anything else unresolved fails the command. 2026-09-20 result: 5,217 keys → 4,908 cached from the staging bucket, 83 from the pool, 192 from the web checkout, 24 fallback.

## 2. Transform labels (pure, offline)
```
npx tsx scripts/football-grid-content.ts transform-labels /tmp/grid/src-2026090403.json \
  --version 2026092101 --approved-by "<owner name>" --out /tmp/grid/rel-2026092101.json
npx tsx scripts/football-grid-content.ts validate /tmp/grid/rel-2026092101.json
npx tsx scripts/football-grid-content.ts transform-labels /tmp/grid/src-2026082610.json \
  --version 2026092102 --approved-by "<owner name>" --out /tmp/grid/rel-2026092102.json
npx tsx scripts/football-grid-content.ts validate /tmp/grid/rel-2026092102.json
```
`transform-labels` refuses if any teammate label does not match the legacy pattern, and asserts the content digest is unchanged. `validate` (launch mode) must pass for v2026092101. **v2026092102 does not pass** — and neither does its source: v2026082610 predates the board-distribution rule and has 253 criteria without a launch asset key (259 findings, identical for source and transform). `publish`/`activate` therefore take `--transformed-from 2026082610`: they re-export the served source inside the same database, require the content digest to match, and waive exactly the findings the source produces under the same validator mode. Anything new still blocks.

## 3. Staging: publish, translate, carry quarantines, activate, play
For each pair (2026090403 → 2026092101, 2026082610 → 2026092102):
```
DATABASE_URL=<staging> npx tsx scripts/football-grid-content.ts publish /tmp/grid/rel-2026092101.json --transformed-from 2026090403
DATABASE_URL=<staging> npx tsx scripts/football-grid-label-locales.ts --build --release=2026092101   # rule-based es/tr for teammates; no OPENROUTER key needed unless it reports labels "to translate"
DATABASE_URL=<staging> npx tsx scripts/football-grid-label-locales.ts --apply --release=2026092101
DATABASE_URL=<staging> npx tsx scripts/football-grid-content.ts transfer-quarantines 2026090403 --to 2026092101   # 0 rows expected here, 494 for 2026082610 → 2026092102; idempotent
DATABASE_URL=<staging> npx tsx scripts/football-grid-content.ts activate /tmp/grid/rel-2026092101.json --asset-registry /tmp/grid/assets-2026090403.json --transformed-from 2026090403
```
For the themed pair add `--allow-fallback-assets` to `activate` as well (the 253 asset-less criteria ride the runtime fallback chain today, exactly as they do in v2026082610).
`--transformed-from` makes `publish` and `activate` re-export the source release live and refuse unless (a) its content digest matches the manifest and (b) the manifest is byte-for-byte what `transform-labels` produces from that export (same version/approval) — so nothing changed in the served content between export and cutover, and nothing but the prescribed teammate labels differs. The label fixture keeps the old and the new English label side by side (`<key>` and `<key>|<label_en>` entries), so `--apply --release=2026090403` would still be correct if the old release ever needed re-applying.

Then, on staging: verify the carried quarantines (`select count(*) from football_grid_content_quarantines q join football_grid_content_releases r on r.id=q.release_id where r.version=2026092102 and q.board_id is not null` = 494), quarantine the two old releases (admin `POST /api/v1/admin/football-grid/content/quarantines` with `{ releaseId, action: "disable", reason: "superseded-by-2026092101" }`, **no expiresAt**), play ≥ 20 boards as guest and member incl. teammate squares in ka/en/es/tr, run the two-replica Grid rehearsal, check `turn_wrong` rate on teammate boards ≤ current 55 %.

## 4. Production (after Codex + CodeRabbit on the PR and owner OK)
Same commands with `DATABASE_URL=<prod>` (`--target=production --confirm-production=lfbwhxvwubzeqkztghok` on the locale script). The export in step 1 is run against **prod** again (the manifest must round-trip from the database it will be published to; the digest must equal the staging one), the cache dir is reused. Order:
1. For both pairs: `publish` → `label-locales --apply --release=<new>` → `transfer-quarantines` → `activate` (verify `selectBoardIdForUsers` returns v20260921xx boards: play one guest match).
2. Quarantine v2026090403 and v2026082610 (`action: disable`, no expiry).
3. Observe 3 days: wrong-answer share on teammate boards **by release**, bot outcomes per tier, forfeits, `[ERROR]` logs.
4. Retire both old releases off-peak after the window:
   ```
   npx tsx scripts/football-grid-content.ts retire-release 2026090403 --release-id c5a929be-dcc8-4f64-a679-0677a9d0887d --manifest-checksum c081b72fc6a457bd4fc90d3f35a59f8cf60af656c24131102cbaab7cdf3f0abe
   npx tsx scripts/football-grid-content.ts retire-release 2026082610 --release-id e03a943d-2b4b-4ae9-8a9d-592003f59af3 --manifest-checksum e64dfc89469aa6f84743a3d162c5c97572d3178f079fbb04a5cd1f1ed824b561
   ```

## 5. Rollback (inside the window)
1. `action: enable` on **both** old releases (v2026090403, v2026082610) → verify their boards are selectable.
2. `action: disable` on **both** replacements (v2026092101, v2026092102).
Matches pin their release ids, so in-flight games are unaffected either way. After `retire-release` the only rollback is a new release version restoring the old content (retired releases are immutable); the exported `/tmp/grid/src-2026090403.json` is that restore manifest (bump its version first).

## 6. What this release does NOT fix
- Messi × "Club teammate of Agüero" is still a wrong answer — correctly, given the club-only data. Phase 1 (full careers + a separate national-team teammate square) is the fix for that; Phase 0 only stops the square from promising something else.
- **Pre-existing, found while building the registry:** the served content (prod and staging alike) references player portraits by *staging* storage URL (`https://nsdfiprfmhdqhbfxfwpv.supabase.co/…/imgs/football-grid/v1/players/<uuid>.webp`, 4,878 keys) and teammate-anchor portraits by `/assets/football-grid/players/<uuid>.webp`. The prod web bundle has no `NEXT_PUBLIC_FOOTBALL_GRID_CDN_BASE_URL`, so it resolves `/assets/…` keys against the **prod** bucket and its first-party check rejects the staging host. Prod bucket coverage: 1,214 of the 4,878 portrait keys and 26 of the 133 anchors (staging: all 4,878 and 113 anchors). Expected visible effect on prod: those portraits fall back to silhouettes. Phase 0 copies the keys unchanged (it must, to stay label-only); mirroring portraits to the prod bucket, or rewriting keys in a later content release, is a separate decision for the owner.

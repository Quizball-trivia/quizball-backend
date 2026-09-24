# Weekend League content import — plan (2026-09-19)

Goal: the editor uploads WL questions per round type in the CMS (same `.txt`
format family as the existing bulk uploader), the CMS validates + dedupes +
previews, publishes into the protected `wl_private` pool (prod, mirrored to
staging), and shows what the coming weekend will deal. Replaces the manual
Friday ingest (parse doc → fact/dupe/image/crest checks → scripts → reseed).

Worktrees: `quizball-worktrees/wl-import-backend` (backend-node,
`feat/wl-content-import` off staging) and `wl-import-cms` (CMS, same branch).

## What exists and is reused

| Piece | Where | Reuse |
|---|---|---|
| `.txt` per-type parser (MCQ, TF, PIO, career, clue chain) | CMS `src/lib/parsers/question-parser.ts` | as-is + `clueOrder:'as-listed'` option (editor numbers clues 5→1) |
| Bulk upload dialog (file → parse → dupe check → table → preview → create) | CMS `components/questions/bulk-upload-dialog.tsx` | forked into a WL panel; `ParsedQuestionPreviewDialog` exported and extended |
| `questionsService.bulkCreate` (image rehost via `storeQuestionPayloadImages`, payload validation) | backend | called by the WL import with `visibility:'wl_private'` |
| `translationService.translateQuestions(ids)` (covers all 5 payload types) | backend | KA fill after insert |
| `stagingSyncService.syncQuestions(ids)` | backend | mirror to staging |
| Admin WL surface `/api/v1/admin/wl/*` (bearer admin) + CMS `/weekend-league` page | both | new `content/*` routes + a `/weekend-league/content` page |
| Dedupe / accepted-name expansion / crest matching / plan seeding | my scripts (`wl-content` worktree, `wl-scoring/scripts/wl-seed-plan.ts`) | ported into a service |

## Backend

New: `src/modules/weekend-league/wl-content.service.ts`, `wl-content.controller.ts`,
`wl-crest-registry.ts` (+ `wl-crest-registry.json` vendored from FE `src/data/clubs.json`
on staging: id/value/label/logo, 296 clubs; `scripts/sync-wl-crest-registry.ts` re-copies it).

Migration `wl_content_batches` (id, created_by, created_at, kind, note, question_count,
sync_to_staging, staging_result jsonb) + `wl_content_batch_questions (batch_id, question_id)`.
Batch = the undo handle and the "editor-authored" marker (old script rows have
`created_by IS NULL`; agent rows have the admin user id — both distinguished today by
`created_by IS NULL`; a CMS import carries the editor's id, so membership in a batch is
what marks it editor content from now on).

Routes (all `authMiddleware, requireRole('admin')`, registered in `weekend-league.openapi.ts`;
spec baseline regenerated):

1. `POST /admin/wl/content/check` — body `{ questions: BulkQuestion[] }` (the exact shape
   the CMS already builds with `toBulkCreateQuestion`). Returns per-index:
   `status: 'ready' | 'duplicate' | 'played' | 'error' | 'warning'`, `issues[]`,
   `duplicate_of { question_id, status, last_week_key?, played }`, `crests[] { club, club_id, logo_url }`
   (career), `image { ok, width, height, bytes, content_type, reason? }` (mcq).
   Checks: content-level dedupe (normalized statement / career player / who-am-I player /
   PIO item-set / mcq prompt) against `wl_private` questions **and** every `wl_questions`
   row of non-test tournaments (played = has a non-void run) **and** within the batch;
   WL shape rules (mcq needs image; PIO exactly 4 items; who-am-I exactly 5 clues;
   1 correct option; difficulty set); image probe (GET, content-type image/*, ≥300px
   wide, aspect 0.5–2.5); career club → crest registry (missing → warning, not error).
2. `POST /admin/wl/content/import` — body `{ questions, note?, sync_to_staging }`.
   Runs the same checks server-side and refuses rows with `error`/`duplicate`/`played`
   unless `force_indexes` lists them. Then: `bulkCreate` (category = the WL category
   `world-cup`, `visibility:'wl_private'`, `status:'draft'`) → `translateQuestions(ids)` →
   accepted-answer expansion (career/clue: EN + KA full/family/given, KA −ი, particles) →
   `UPDATE status='published', ranked_eligible=false` → batch rows → optional staging
   sync. Returns `{ batch_id, created, translated, published, staging }` with per-row ids.
   Rows whose translation failed stay `draft` and are reported (never published half-bilingual).
3. `GET /admin/wl/content/batches` and `DELETE /admin/wl/content/batches/:id` (deletes
   the batch's questions that were never dealt into any tournament; reports skipped ones).
4. `GET /admin/wl/content/runway` — per kind × difficulty: published editor `wl_private`
   rows never dealt into a real tournament; `weeks_left` = floor(unused / per-event need)
   where need = 28 for TF/PIO/mcq/career and 12 for who-am-I (5 games? no: 4 games ×
   (5 played + 2 reserves); who-am-I 4 × (1 + 2)). Photo mcq counted separately from text.
5. `GET /admin/wl/content/next-event` — the next non-test tournament not yet played:
   if `wl_questions` exist, those rows; else a dry-run of the seeder draw (refactor
   `wlSeedTournamentContent` into `wlPlanTournamentContent` (pure) + insert). Output:
   games → rounds → questions with `prompt{en,ka}`, options (+correct), image url,
   clubs with crest url, clues, display answer, accepted answers, difficulty, `reserve`.

Crest URL = `${config.SUPABASE_URL}/storage/v1/object/public/imgs/club-logos/<logo>`.

Tests: unit (`wl-content.test.ts`): normalizers + content keys, crest matcher against
registry fixtures, accepted-name expansion, WL shape rules, runway math. Integration
(`wl-content.integration.test.ts`, `test:wl` tier): check → import (translation provider
mocked) → published rows bilingual, batch recorded, dedupe catches a twin that exists
only in `wl_questions` history, undo removes never-dealt rows only.

## CMS

`/weekend-league/content` (sidebar child "WL Content"), tabs:

- **Upload**: round type (TF / Put in order / Photo / Career path / Who am I), `.txt` file,
  format card + "Copy example" / "Download template" per type (PIO keeps the existing
  Direction/Items/Answer format — it is what the editor already writes), sync-to-staging
  checkbox (default on). Parse → `content/check` → table with status chips
  (Ready / Duplicate (twin shown) / Played on <week> / Needs fix / No crest for X),
  image thumbnails, KA not shown yet (translation happens on publish). Row click →
  preview dialog (existing one, plus crest chips and the check issues). Publish button
  → `content/import` → result panel (created / translated / published / staging) + link
  to "Next weekend".
- **Next weekend**: `content/next-event` rendered as Game 1/2/3/Final tabs, rounds,
  question cards (photo, options with the key highlighted, crest chain, clues, EN + KA),
  reserves collapsed. Same layout as the review artifact from 2026-09-11.
- **Runway**: kind × difficulty grid of unused counts + weeks-left bar per kind.
- **Batches**: list (who, when, kind, count, staging result) with Undo.

`npm run generate:api` against the local backend refreshes `api.generated.ts`.

## Out of scope (this PR)

Fact-checking (stays human), editing translations inline (CMS question editor already
does that), replacing the random seeder for the live event (the "Next weekend" tab is a
preview; a "swap slot" action can come next), TR/ES fills (content falls back to EN).

## Order of work

1. Backend: crest registry + normalizers + `check` (unit tests) → `import` + batches
   (integration test) → runway + next-event (+ seeder plan refactor) → openapi + baseline.
2. CMS: types regen → Upload tab (fork) → Next weekend → Runway/Batches.
3. Local end-to-end with the 2026-09-11 editor batch as the fixture; Codex review of the
   diff; PRs to staging (backend first, then CMS).

## Decisions after review (2026-09-19, Codex plan review)

- **Staging sync copied protected rows as public** — `staging-sync.repo.ts` omitted
  `visibility`/`ranked_eligible`; fixed in this PR (affects the existing CMS
  "sync to staging" too).
- **The coming weekend is frozen at creation**, so publishing on Friday alone
  changes nothing: added `POST /admin/wl/content/tournaments/:id/reseed`
  (guarded: no answers, status ≤ entry_closed; previous rows kept in
  `wl_content_reseeds` and restored on shortage) and a "Re-draw from pool"
  button on the Next weekend tab. The seeder now ranks editor content
  (batch member or `created_by IS NULL`) above agent rows.
- **No `bulkCreate` reuse**: it fires a background translation that would race
  the awaited one and overwrite the expanded aliases. The import inserts drafts
  itself (image rehost → question + payload + batch link in ONE transaction),
  then translates, re-reads every row, expands aliases, runs the same publish
  validation as the CMS status change, and only then publishes. Rows whose
  Georgian is incomplete or whose photo fell back to the external URL stay
  draft and are reported per row.
- **Batch first, async processing**: the batch row exists before any insert;
  `import` returns 202 with the batch id and the CMS polls (the CMS client
  times out at 2 min; image ingest + translation can exceed that). Imports are
  serialized in-process; `force_indexes` can override duplicates only, never
  shape errors.
- **Two-tier dedupe**: exact (prompt + answer for photos, item set + order for
  rankings, player for typed rounds) blocks; loose (same subject) warns.
  History keys are rebuilt from `wl_questions.payload` + `evaluation`.
- **Runway** reports both fresh editor inventory (per difficulty, photo vs text)
  and the seeder's own drawable count (35-day repeat window, bilingual), with
  demand from `wlSourceNeedPerKind`.
- **Next event** shows frozen rows only (difficulty/editor flag joined from the
  source); no provisional dry-run draw.
- PIO: ranks must be exactly 1..4 and item names unique (the parser gives an
  item missing from the Answer block rank 0). Undo also deletes never-dealt
  copies on staging when `STAGING_DATABASE_URL` is set.

## Round 2 (Codex diff review, 2026-09-19)

- Reseed: snapshot + delete now happen under `FOR UPDATE` on the tournament
  row with eligibility re-checked inside; allowed only in ready/entry_open/
  entry_closed (never while the orchestrator may still be seeding); restored
  on shortage AND on any thrown error; a crash between delete and re-insert is
  healed by `restoreInterruptedReseeds` on the next read/reseed. Reseeds are
  serialized in-process.
- Import: one `wl_content_batch_rows` row per uploaded question exists before
  processing (`question_id` nullable, `ON DELETE SET NULL`, PK batch+row_index),
  so pre-insert failures are reported at their file position and undo needs no
  FK games. The authoritative duplicate check runs inside the queue right
  before insert (a row that became a duplicate while waiting fails with that
  reason). Publish re-reads each row `FOR UPDATE` and validates + flips status
  in one transaction. Batches left `processing` >30 min by a restart are
  reconciled to `failed` (undoable). Client `storage_status` is stripped; the
  stored object is HEAD-verified in our storage before publish; the probe runs
  again at import time.
- Image probe: private/loopback/link-local hosts refused (DNS-resolved, every
  redirect hop), streamed with a 20 MB cap, 4 concurrent.
- Undo: also spares questions referenced by a reseed backup; staging cleanup
  runs first and a failure is recorded with the pending ids.
- Staging copy: question + payload commit in one transaction per question.
- Dedupe: PIO exact key includes the criterion (prompt); historical
  `money_drop` rows are keyed as MCQs. CMS parser rejects a PIO Answer block
  that is not a permutation of Items; publish is disabled until the pool check
  succeeded. Runway copy no longer claims difficulty allocation; MCQ shows
  photo / text counts.
- Known limits (documented, not fixed): the process-local queue does not
  serialize across backend replicas (Railway runs one); photo exact key does
  not include image identity.

## Round 3 (Codex browser QA, 2026-09-19 — 144 screenshots, report in session scratchpad)

Verdict was "do not ship" with 8 findings; fixed in the same day:
- P1 stale pool-check race (change round type while a check is pending → old file
  published under the new kind): upload tickets on the client drop superseded
  responses, publish refuses rows parsed for another kind, and the import schema
  now refuses a batch whose questions' types differ from `kind`.
- Dedupe scope: the published PUBLIC bank is indexed too (real events are launch
  editions that may draw from it); such twins report `where: 'public'`.
- Header checkbox computed over disabled rows → now over selectable rows only.
- Runway / Batches / Next weekend showed spinners or "no tournament" on 401 →
  explicit error state with Retry.
- Image probe timeout 15 s → 30 s; a duplicate verdict now outranks an image
  error (a published twin's source URL timing out is not "Needs fix").
- Copy example awaited; template photo example uses a real Wikimedia image.
- Next-weekend Georgian rendered under the English for clues/options/answers;
  club chips carry the Georgian name as a tooltip.
- Not a code defect: one reseed 500 came from the staging SESSION pooler's
  15-client cap being shared by the local backend, Codex's psql and mine
  (`EMAXCONNSESSION`); no partial state was left. Prod uses the transaction pooler.

## Round 4 (Codex final pre-merge review, 2026-09-19)

Verdict was still "no" on three groups; addressed:
- **Atomic reseed**: the seeder is split into `wlPlanTournamentContent` (draw, no
  insert; `reseedOf` keeps the tournament's own frozen rows eligible) and
  `wlInsertTournamentSlots`. Reseed plans first; a short draw touches nothing
  (audit row only). Otherwise, in ONE transaction under `FOR UPDATE` on the
  tournament: re-check eligibility → snapshot → delete → insert → record. The
  event is never observable empty; a crash rolls back. The legacy restore path
  now also takes the row lock.
- **Photos are server-owned**: import no longer calls the generic ingester with
  client data. The bytes our SSRF-safe probe downloaded are normalized and
  uploaded by us (`uploadQuestionImageBuffer`); a client URL already in our
  storage is accepted only after a HEAD check. `source_url`/`storage_status`
  from the client are ignored. Address policy moved to `wl-content-net.ts`
  (node `BlockList`, IPv4-mapped IPv6 handled; unit-tested against `::ffff:7f00:1`,
  `fe90::1`, …).
- **Force never waives image errors**: image problems stay `error`; a duplicate
  is displayed as such but any error-severity issue blocks import (server) and
  disables the row (CMS).
- **Publish invariants under lock**: WL shape re-checked, hosted photo HEAD-
  verified, bilingual, then `status='published', visibility='wl_private',
  ranked_eligible=false` in the same transaction.
- **Staging undo**: staging deletes also spare rows referenced by staging reseed
  backups; a failed staging cleanup leaves `staging_pending_ids` and calling
  undo again on the undone batch retries just those (CMS "Retry staging cleanup").
- Reconciliation also runs on the batch-detail endpoint the CMS polls; refresh
  failures with cached data toast; probe timeout message reflects the constant.
- Still documented, not built: cross-replica import serialization (single
  Railway instance), photo exact-key without image identity, capacity-error
  mapping for the staging session pooler.

## Round 5 (Codex confirmation review, 2026-09-19)

Reseed atomicity accepted; five P2s fixed:
- Image downloads go through one bounded fetcher built on node:http/https with
  the socket pinned to the address we validated (`lookup` override) — no second
  DNS resolution, so no rebinding; each redirect hop re-validated; byte cap
  enforced while streaming; single deadline.
- URLs already in our storage get the same download + decode + dimension checks
  and are re-normalized/re-uploaded — no trust in client dimensions.
- Check never retains image buffers; import re-downloads one image at a time
  while hosting it (memory = one image).
- Publish refuses a row whose submitted photo has been removed meanwhile.
- Undo commits production deletion and the staging-pending bookkeeping in one
  transaction under a batch row lock.

## Round 6 (Codex r5 review + browser QA round 2, 2026-09-19)

Browser QA round 2 (153 shots): all eight round-1 defects confirmed gone; every fixture
type uploaded, previewed, published, DB-verified (protected, unranked, bilingual, photos
in our storage), re-uploaded as duplicates, undone; two re-draws with 124 rows at every
sample. Two new findings, both fixed: batch-detail dialog overflowed at 1280 px (rows now
wrap, badge pinned), and the kind/type refine answers 422 (project-wide zod convention —
kept; the brief had said 400). Code review r5 left two P2s, fixed: undo now runs in two
locked phases with an `undoing` state (lock → claim → staging cleanup outside the txn →
lock → verify claim → delete + bookkeeping), reconciled back to `failed` if abandoned;
image fetches have a wall-clock deadline covering DNS, redirects and body, destroying the
live request on expiry. Migration status check widened (applied live to local + staging
with ALTER, no drop).

## Round 7 (2026-09-19, last blocker)

Undo claim made exclusive: phase 1 rejects a batch already `undoing` (409) and stamps a
per-request `undo_claim` token; phase 3 finalizes only if status is still `undoing` AND
the token matches; reconciliation of an abandoned `undoing` batch clears the token.
Verified live: two concurrent undos → one 200 (3 deleted), one 409 "already in progress";
a third → 409 "already undone".

## Round 8 (Codex browser QA round 3, 2026-09-22)

Root cause of the "database failures" and the stuck Undo: deleting a question makes
Postgres FK-check match_questions (1.2M staging / 1.6M prod rows), road_to_goal_zone_
question_calibrations and daily_challenge_served_questions — none had an index on
question_id, so each deleted row was a seq scan and 7 rows blew the 30 s statement
timeout (the ordinary CMS question delete has the same exposure). Migration
20260922120000 adds the four indexes (guarded per table; ~10 s on staging; plain
CREATE INDEX per the no-CONCURRENTLY rule). Undo now also releases its claim
immediately when finalize fails (status → failed with the reason, retry at once) and
clears stale error text on success. CMS: publish polling stops on session loss with a
persistent message + "Open Batches"; batch-detail click errors toast; a failed pool
check shows a persistent alert with "Retry check"; "Also copy to staging" is greyed
when the backend reports `staging_configured=false`; every row has a Preview button;
upload copy explains the 3+1 game structure and that uploads are by type, not by day.
The 503/slow checks in that run were the staging session pooler (15 connections shared
with Codex's psql), not application code.

## Query pass (2026-09-22) — every WL-content query EXPLAIN ANALYZEd on staging

| query | before | after |
|---|---|---|
| dedupe index: pool (wl_private + public published) | 3.3 s (shipped 25 MB of payload JSON) | ~1 s cold: keys extracted in SQL; cached 5 min in-process (check hits ≈ 5 ms); import always refreshes |
| dedupe index: history (wl_questions + played) | 680 ms | 20 ms (SQL keys + one DISTINCT join instead of per-row EXISTS) |
| runway drawable | 76 ms + payload transfer | count-only, bilingual as jsonpath (identical to the seeder walk) |
| runway fresh inventory | 26 ms | unchanged (indexed) |
| batches list / detail / reconcile / undo referenced | ≤ 6 ms | unchanged |
| next-event rows | 1 ms | unchanged |
| seeder draw page | 7 ms | unchanged (new wl_questions.source_question_id index) |
| question DELETE (undo) | 30 s timeout | 0.1 ms (FK indexes) |

Remaining wall-clock on the developer Mac is network: ~70 ms per round trip to the
Frankfurt pooler; in Railway (same region) it is negligible.

## Round 9 — Undo removes stored photos (2026-09-23)

Codex save/delete QA: Undo deleted the questions but every hosted photo still answered 200.
Two Codex review rounds on the first fix (reference scan of remembered paths) found races and
uncovered snapshot tables, so the design moved to *ownership enforced at write time*:
- Each imported photo is its own object, `question-images/wl-import/<batch>/<row>-<hash>.png`.
- Enforced in the database for every writer: trigger `question_payloads_wl_import_photo_owner`
  (migration 20260923120000) refuses a payload mentioning `wl-import/<batch>/<row>-` unless that
  batch row's question_id is this question (400 with a clear message). After undo the row's
  question_id is NULL, so the photo can never be attached again. Import links the row first.
- Friendlier path for MCQ images: `ensureQuestionImageStored` (question create / update / bulk)
  stores a private content-addressed copy (`provider: cms_copy`) instead, except when an update
  keeps the question's own current URL; campaign artwork refuses such paths on write. So only
  copies of the owning question can mention the object: its payload, dealt wl_questions,
  wl_events, reseed backups, release journals, staging copies.
- Undo lists the batch's storage folder (catches failed rows, lost upload responses, restarts),
  and deletes each object that none of question_payloads / wl_questions / wl_events /
  wl_content_reseeds / question_release_rows / campaign_quizzes(+revisions) mentions — locally and,
  on prod, on staging (staging copies point at prod objects). Prod without a staging connection
  records staging ids as pending and deletes no photos until that succeeds.
- An import with failed photo rows sweeps its folder before its final status update; a failed
  sweep sets `result.photos_pending` and is retried automatically on the next batches read.
- Import heartbeat (batch updated_at bumped per row) so another replica never sees it as stale.
- Staging sync re-reads its source after copying and removes copies whose source vanished.
- `result.undo.photos_pending` + `result.undo.photos {deleted, shared, error, at}`; CMS
  "Retry cleanup" covers staging + photos; a queued cleanup is polled until a new outcome lands.
- Reference check = one query with a literal folder prefilter (~1.3 s on staging); undo ~5 s.
- Verified on staging: stray object swept, referenced photo kept, unreferenced deleted, admin
  create with an owned URL got its own copy.

## Round 10 — where uploads are used + "Use in next weekend" (2026-09-23)

Codex browser recheck passed the upload/publish/undo/photo flow and asked for visible scheduling:
- Batch detail rows carry `placements` (event week, game, round, question or reserve); the CMS shows
  "In pool — not scheduled" or e.g. "Sat 26 Sep · Game 2 · Round 3 · Q4" / "Sun 27 Sep · Final · …".
- `POST /admin/wl/content/batches/:id/schedule` re-draws the coming event (or `tournament_id`)
  through the normal re-draw (plan first, atomic swap, backup, only before play) with the batch's
  published questions as a priority list; the response says how many landed in main slots,
  reserves, or nowhere (more than the weekend needs, or played in the last weeks).
- The draw now fills every game's main slots before any reserves (applies to all draws).
- Schedule vs undo: the batch is claimed on its row (`result.scheduling`, 10-min expiry, works
  through the transaction pooler); undo returns 409 while claimed; the re-draw re-checks the claim
  under the batch row lock before committing. Undo's final step locks its questions and keeps any
  that a concurrent re-draw dealt meanwhile instead of failing.
- Not built (follow-up): choosing an exact game/slot per question.

## Round 11 — lineup upload: one file for chosen games of a weekend (2026-09-24)

Owner asked for a simpler editor workflow: pick an upcoming editable weekend + scope (one game /
Saturday / Sunday final / whole weekend), upload ONE file with all five round types, see the exact
lineup before saving, save exact placements atomically. The one-type pool uploader stays ("Add to pool").
- Format: `=== SATURDAY GAME 1 ===` … `=== SUNDAY FINAL ===`, `--- Round N: Type ---`, optional
  `--- Reserves: Type ---` (≤2 per type; missing reserves come from the pool). Question syntax unchanged.
  CMS parser `src/lib/wl-lineup.ts` (errors with game · round · question · original line).
- API: `GET lineup/events`, `POST lineup/preview` (validates, picks pool reserves, stores a preview:
  manifest + canonical lineup fingerprint + pool content hashes, 30-min expiry), `POST lineup/save`
  (preview id only; idempotent).
- Save job: drafts (never drawable) → photos → Georgian → aliases; then ONE transaction: tournament
  lock → allocation lock → fingerprint → in-lock duplicate check (index excluding own drafts, on the
  txn connection) → pool reserves re-checked → drafts verified (prepared hash + English equals the
  previewed content) → publish → backup target games → replace them → batch done with placement
  manifest. Any failure: drafts + batch photos deleted, nothing scheduled.
- Editable = ready/entry_open/entry_closed with 0 answers; kept games must be complete (31 legal slots,
  right kinds). Seeding, re-draw, lineup save and pool publication share `wlLockContentAllocation`
  (tournament row first); seeding/re-draw re-check planned sources under it.
- Batches show the lineup manifest (current/replaced) and why Undo keeps scheduled questions; Next
  weekend has an event picker, persisted question numbers and the upload batch badge.
- Migration `20260924120000_wl_content_lineup_previews.sql` (applied to staging + local test DB).
- Verified: 7 lineup integration tests (single game keeps others byte-identical, full weekend with
  uploaded reserves, Saturday keeps Sunday, change-before-save 409, change-during-save → nothing,
  failed row → nothing, edited draft → nothing, locked after check-in); browser E2E on staging with
  real photos (Game 2 + Sunday Final), staging restored from snapshot afterwards.
- Limits: weekends exist only from 24 h before entry opens (usually one selectable weekend); Undo
  does not restore the replaced lineup; photos are large PNGs (1.4–4 MB) as with the pool uploader.

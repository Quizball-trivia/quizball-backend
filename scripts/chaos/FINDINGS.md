# Chaos run findings — staging, 2026-06-09

Run: `--target=staging --rps=30 --duration=20 --users=25` (≈630 req/s offered,
21 routes), against the **6543 transaction pooler** with the rate-limit bypass.

## Headline

Two list endpoints — `GET /categories` and `GET /questions` — collapse the whole
API under load. Both share one root cause: **`COUNT(*) OVER()` in the page query
forces a full-table read on every request, regardless of `LIMIT`.** Once these
saturate the connection pool, every other route starves (shed / timeout / 503).
All other routes are fast (<21 ms mean): leaderboard, stats, wallet, inventory,
objectives, friends, profile.

## Measured (pg_stat_statements, this run)

| Query | total | calls | mean |
|---|---|---|---|
| `categories … COUNT(*) OVER() … (min_questions subquery)` | 11,748 ms | 30 | **392 ms** |
| `questions q LEFT JOIN question_payloads … COUNT(*) OVER()` | 4,862 ms | 26 | **187 ms** |
| ranked leaderboard | 437 ms | 21 | 21 ms |
| stats CTE (`user_matches`) | 253 ms | 20 | 13 ms |
| everything else | — | — | <2 ms |

## Root cause #1 — `questions` list (EXPLAIN ANALYZE)

```
SELECT q.*, qp.payload, COUNT(*) OVER() AS total_count
FROM questions q LEFT JOIN question_payloads qp ON qp.question_id = q.id
ORDER BY q.created_at DESC LIMIT 50;
```
- Plan: `WindowAgg` over a **Merge Left Join of all 8,613 rows** (17,299 buffers,
  temp spill), then top-N sort, then LIMIT. **283 ms** to return 50 rows.
- The window count defeats the `created_at` index + LIMIT: Postgres must
  materialize every row to know the total.

**Fix (proven): split the count from the page.**
- Page only (no window): `… ORDER BY q.created_at DESC LIMIT 50` →
  **3.5 ms** (Index Scan Backward on `idx_questions_created_at_created_by`, 80× faster).
- Count only: `SELECT count(*) FROM questions [+ same filters]` →
  **26 ms** (Index-Only Scan), and is cacheable / can be debounced.

Net: **283 ms → ~3.5 ms** on the hot path (+ a cacheable 26 ms count).

## Root cause #2 — `categories` list with `min_questions` (EXPLAIN ANALYZE)

```
SELECT *, COUNT(*) OVER() FROM categories
WHERE is_active AND (
  SELECT COUNT(*) FROM questions q JOIN question_payloads qp …
  WHERE q.category_id = categories.id AND <MCQ JSONB validation>
) >= 5 …
```
- Plan: `Seq Scan on categories` (89 rows) with **SubPlan 1 executed per row**
  (loops=73), each a Nested Loop over that category's questions doing JSONB
  `jsonb_array_elements` validation. **629 ms**, 13,985 buffers.
- The join-key indexes (`idx_questions_category_status`,
  `question_payloads_question_id_key`) ARE used — the cost is the **per-category
  correlated subquery doing computed JSONB validation**, which no btree index can
  satisfy.

**Fix (architectural, pick one):**
1. **Precomputed `valid_mcq_count` column on `categories`** (maintained by a
   trigger or a periodic refresh job). Turns the filter into `valid_mcq_count >=
   $1` → ~1 ms. Best long-term.
2. **Partial expression index** to shrink the inner scan:
   `CREATE INDEX … ON questions (category_id) WHERE status='published' AND
   type='mcq_single';` — helps the inner loop but keeps the per-category fan-out.
3. Drop `COUNT(*) OVER()` here too and split the count (same as #1 above).

`min_questions` is a CMS/admin-style filter; the common public browse
(`is_active=true` without `min_questions`) is already fast (0.7 ms).

## Secondary findings

- **Seq Scan on `featured_categories`** (no index) — small today, but
  `featured_categories.category_id` and `sort_order` should be indexed.
- **Orphaned transaction on the 6543 pooler:** a client that aborts mid-
  transaction (15 s chaos timeout) left an `INSERT INTO ranked_profiles` in
  `ClientRead` for **148 s** — the `idle_in_transaction_session_timeout` (15 s,
  shown as set) did not reap it. Single occurrence under synthetic abuse, but
  **prod also runs 6543**, so worth confirming the reaper fires on the txn pooler
  between statements. (Manually terminated; staging recovered.)
- **503s are correct behavior:** under saturation the DB circuit breaker (PR #51)
  returned 503 / fail-fast instead of crashing — working as designed.

## Environment fix already applied

Staging `DATABASE_URL` was on the **session pooler (port 5432, 15-client cap)**,
which threw `EMAXCONNSESSION` 500s at ~15 concurrent requests. Switched to the
**6543 transaction pooler** (matching prod). Verified: 50 concurrent → 50×200.

## Recommended order of work

1. Split `COUNT(*) OVER()` → separate count + page query in `questions.repo.ts`
   and `categories.repo.ts` (biggest win, pure code, low risk). Cache the counts.
2. Index `featured_categories(category_id, sort_order)`.
3. Decide on `categories.min_questions`: precomputed count column (preferred) vs
   partial index.
4. Confirm the 6543 idle-in-tx reaper behavior (prod-relevant).

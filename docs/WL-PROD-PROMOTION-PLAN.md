# Weekend League — production promotion plan

Written 2026-08-06. Target: the live event on **Saturday 2026-08-08, 14:00 Georgia**,
which already has **88 real players registered**.

## What is live where

| Surface | Prod today | Staging |
|---|---|---|
| Backend | QP + entry/join only. No live game engine changes from this arc. | Everything |
| Web | League card, entry, QP. No live game UI. | Full live game UI |
| CMS | No WL admin panel | Registrants, test events, bot fill, agent panel |
| Env flags | `WL_ORCHESTRATION_ENABLED=true`, `WL_BOT_MIN_FIELD=100`, Resend keys — all already set | same |

Prod is missing two schema objects the new backend needs:

- `wl_email_log` (migration `20260803060000`)
- `wl_question_runs.revealed_at_ms` (migration `20260805120000`)

Both are additive: a new table and a nullable column. Neither rewrites data.

## The core risk

`staging` is **759 commits** ahead of `main`, spanning auction, agents, cards and
the bug-triage work — not just Weekend League. Promoting the branch wholesale
ships all of it at once, three days before a prize event.

Two options:

**A. Full branch promotion** (`staging` → `main`). Simplest to execute, and it is
what the team has done before. Risk is breadth: 27 migrations and hundreds of
non-WL commits land together.

**B. WL-only cherry-pick** onto a release branch off `main`. Much smaller blast
radius (17 WL files + 2 migrations), but cherry-picking across 759 commits will
hit conflicts, and the WL code depends on shared changes (openapi baseline,
socket types) that would have to come along anyway.

**Recommendation: A**, because the staging branch is the artifact that has
actually been load-tested end to end. A hand-assembled subset would be a
configuration nobody has ever run. Mitigate breadth with the rollback plan below
rather than by narrowing the diff.

## Sequence

Each step has a stop condition. Do not proceed past a failed check.

### 1. Freeze and snapshot (T-0)

- Announce a staging freeze so nothing new merges mid-promotion.
- Confirm a Supabase point-in-time-recovery window covers prod.
- Record current prod deploy id for rollback: `railway deployments --service quizball-backend --environment production`.

### 2. Migrations first, code second

Apply to prod **before** deploying code, since both are additive and the old
code ignores them:

```sql
-- 20260803060000_wl_email_log.sql
-- 20260805120000_wl_revealed_at.sql
```

Check: both objects exist, and the currently-deployed prod backend is still
healthy afterwards (it should be entirely unaffected).

### 3. Backend to prod

Merge `staging` → `main`; Railway deploys automatically.

Check:
- `/health` green
- The Aug-8 tournament still reads `entry_open` with 88 entries
- No error spike in Railway logs for 10 minutes
- `GET /api/v1/weekend-league/current` returns the new fields
  (`current_game_index`, `break_until_ms`)

### 4. Web to prod

Merge web `staging` → `main`; Vercel deploys.

Check: `/weekend-league` renders the league card, entry still works, and a
registered account sees the join path.

### 5. CMS to prod

Merge CMS `staging` → `main`. This is what gives prod the registrants table,
test-event controls and the agent panel.

Check: the WL tab lists the Aug-8 event and shows all 88 registrants.

### 6. Verify without real users — see below

### 7. Announce readiness

Only after step 6 passes.

## Testing on prod without involving real users

This is the part worth getting right. Three layers, in order of safety:

### Layer 1 — read-only inspection (zero risk)

- CMS WL tab: the Aug-8 event, its 88 registrants, QP at entry, states.
- CMS agent panel: `wl_private` stock per kind.
- Confirms the admin surface and the read paths work against real data without
  touching anything.

### Layer 2 — an `is_test` tournament on prod (isolated)

`wlCreateTestTournament` sets `is_test = true`, and the code paths treat those
rows as separate: the weekly calendar ignores them, awards are not paid, and
(after PR #401) **they never send email**.

```
POST /api/v1/internal/ops/wl/create-test
  x-wl-ops-token: <prod WL_OPS_TOKEN>
  { "actor": "ops:prod-verification",
    "compressed": { "entry_seconds": 120, "checkin_seconds": 60, "to_final_seconds": 1500 },
    "config": { "free_entry": true, "qp_target": 0, "bot_fill_min_field": 60 } }
```

Then fill it with bots (`/fill-bots`) and let it play itself. Bots are `is_ai`
users, so no real player is affected and no prizes are issued.

**Caveat, stated plainly:** `wlCreateTestTournament` currently **refuses to run
when `NODE_ENV === 'prod'`**. That guard exists for good reason. To use this
layer we would either relax it behind an explicit ops-token-only path, or accept
Layer 3 instead. My recommendation is to leave the guard alone before Saturday
and rely on Layers 1 and 3.

**Verify afterwards:** delete the test row via the CMS delete (test-only), and
confirm the real Aug-8 event is untouched.

### Layer 3 — join the real event as ourselves (what I recommend)

The Aug-8 event is genuinely running on Saturday with 88 people. Before then:

- Confirm your own account and a teammate's are registered.
- On Saturday, play it live and watch the CMS panel alongside.
- The bot floor (`WL_BOT_MIN_FIELD=100`) means the field fills to 100 regardless,
  so the ladder and cuts get exercised for real.

This is not a rehearsal, but it is the only fully faithful test, and the load
testing has already covered the parts a rehearsal would.

### What load testing already proved (staging, 2026-08-05)

- 1,000 players: ack p95 **199ms**, delivery p95 **82ms**, **0 lost answers**
  across 30,978, **0 score mismatches** over 1,500 player-games, ladder exact
  (1000 → 333 → 167 → 24), with 1,557 injected connection flaps.
- 500 players: same integrity results, ack p95 483ms.

## Rollback

- **Backend/web:** Railway and Vercel both support redeploying the previous
  deployment. Record the ids in step 1.
- **Migrations:** do NOT roll back. Both are additive and harmless to old code.
- **If the live game misbehaves during the event:** set
  `WL_ORCHESTRATION_ENABLED=false` on prod. The orchestrator stops advancing
  games; entry and QP keep working. This is the single biggest lever and it
  needs no deploy.

## Open decisions for the owner

1. Option A (full branch) vs B (WL-only) — recommendation above is A.
2. Whether to relax the prod test-tournament guard for Layer 2, or stay with
   Layers 1 and 3.
3. Whether to promote at all before Saturday, or run Aug-8 on the current prod
   code and promote after. The current prod code has **no live game UI**, so
   players would get entry and QP but no synchronized game — meaning promotion
   before Saturday is effectively required for the event to happen as designed.

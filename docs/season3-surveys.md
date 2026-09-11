# Season 3 player surveys

Authenticated POST endpoints under `/api/v1/feedback`:
- `/season3/claim` `{matchId}` → `{kind: 'vote'|'idea'|null}`.
- `/season3/dismiss` `{matchId}` → `{ok:true}`; snoozes both prompts seven days.
- `/season3` `{matchId,locale,kind:'vote',removeOrder,removeWho}` or `{matchId,locale,kind:'idea',idea}` → `{ok:true}` after durable save, not after email delivery.

Locale: en/ka/es/tr. Idea: 1–500 trimmed characters. Identity is derived from authentication, never a supplied recipient/user identifier. Participation must be in a completed, non-dev Ranked match ending within 30 minutes. The vote comes first; the idea requires a later match completed after the vote. At most one new prompt per day; one answer per kind per account. Claim repeats for the same match are idempotent. No login prompt, no A/B allocation. Client dismissal has a local seven-day fallback if the network fails.

`season3_survey_state` serializes per-player actions; `season3_survey_responses` stores the vote/idea and durable email outbox. RLS enabled, no anon/authenticated direct access. Only the backend accesses these tables. Votes remain in DB for aggregate reporting; written ideas are emailed to **nika@quizball.io**. Emails contain the authenticated account, language and escaped idea, with authenticated email as Reply-To when present. No idea/email contents are sent to analytics.

Production delivery requires both NODE_ENV=prod and production Supabase origin. Staging submissions are permanently `suppressed`, never picked up by the sender even after environment changes. Existing Resend credentials/from address reused. Worker checks every minute; atomic claim, frozen payload, fixed idempotency key, five-minute retries, automatic attempts stop after 23 hours from first attempt (`review`). `sent` means provider accepted, not inbox delivery. Inspect `review` rows manually; never blindly resend them. Resend deduplication lasts 24 hours: https://resend.com/docs/dashboard/emails/idempotency-keys.

Kill new prompts with `SEASON3_SURVEYS_ENABLED=false`; already queued mail still drains. To stop delivery, remove the Resend key or stop this worker. Preserve responses on rollback.

Release: deploy backend migration/code to staging before web; verify auth rejection, real staging match claim/save/snooze and suppressed emails; cherry-pick only these approved commits onto fresh main branches. Do not merge staging wholesale.

Read-only monitoring:
```sql
select kind,count(*) from season3_survey_responses group by kind;
select remove_order,remove_who,count(*) from season3_survey_responses where kind='vote' group by 1,2;
select email_status,count(*) from season3_survey_responses where kind='idea' group by 1;
```

Local integration tests require a dedicated localhost database whose name includes `season3_test`; never point them at shared staging/production.

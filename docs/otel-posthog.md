# OTel → PostHog: per-user activity, properties & logs (POSTPONED)

**Status:** Postponed / not started. This doc captures the plan + everything we need so
we can pick it up later without re-investigating.

## Why we looked at this

On a PostHog **person** page (e.g. `nakho2020@agruni.edu.ge`), the **Logs** tab is empty
and the **Events / Properties** tabs are thin. We want per-user activity (events, props)
and ideally per-user backend **logs** to show up on the person, so we can debug "what did
this specific user do / what went wrong for them."

### Root cause of the empty tabs
1. **Logs tab** is PostHog's separate **Logs product** (OTLP log ingestion). We ship `pino`
   → stdout + Grafana Loki, and **never** to PostHog Logs → the tab is always empty.
2. **Events/Properties thin**: the backend only calls `identifyUser(...)` inside
   `src/realtime/services/match-participants.helpers.ts` (when a match is assembled), and
   only captures gameplay events. A user who signed up / browsed but didn't play has almost
   no person profile. Frontend analytics DO run in prod (`instrumentation-client.ts` gates
   `posthog.init` on `NODE_ENV === 'production'`), but they don't identify at login either.

## Decision
Postpone the whole thing. This doc is the spec for when we resume.

---

## Scope (three independent pieces)

### B — Identify users at login (not just at match start)  ·  small
Add `identifyUser(user.id, { email, nickname, country, level, favorite_club,
preferred_language, signup_date })` at the single choke point where any identity resolves
to a user, so EVERY signed-up user gets a full person profile immediately.

- **Where:** `src/modules/users/users.service.ts` → `getOrCreateFromIdentity` (covers email,
  social, phone, AND the auth middleware's per-request resolution — one place).
- **Guards:** keep the existing AI-suppression (`isAiUser`); throttle so we don't `identify`
  on every request (e.g. only on user creation, or cache "identified this process/session").
- **Effect:** the person **Properties** tab fills for everyone.
- Reuses existing `identifyUser` in `src/core/analytics.ts` (already handles the async
  AI lookup + `client.identify`).

### C — Add missing activity events  ·  small, incremental
We have strong gameplay coverage (`match_*`, `answer_submitted`, `matchmaking_*`). Gaps:
- **Backend auth lifecycle** (highest value): `signup_completed`, `login_completed`,
  `account_deleted`, `pending_deletion_restored`. Today login/signup events only exist on
  the FRONTEND (`src/lib/analytics/game-events.ts`) and only fire on the callback path.
- **Navigation** (frontend): a lightweight `screen_viewed` / route-change event
  (we set `capture_pageview: false`, so nothing records navigation right now).
- **Commerce/progression/social**: `purchase_completed`, `daily_challenge_started/completed`,
  `level_up`, `friend_request_sent/accepted`.

All are additive `trackEvent(...)` calls at existing call sites. Start with backend auth
lifecycle + frontend `screen_viewed`.

### D — Ship pino logs to PostHog Logs, linked per-user  ·  moderate lift
This is the piece that fills the person **Logs** tab. **Feasible with what we already have.**

**We already have every dependency** (from `package.json`):
`@opentelemetry/sdk-node`, `@opentelemetry/exporter-logs-otlp-http`,
`@opentelemetry/api-logs`, `@opentelemetry/sdk-logs`, `@opentelemetry/resources` — and a
running `NodeSDK` in `src/core/otel.ts` (currently traces + metrics only, gated on
`OTEL_EXPORTER_OTLP_ENDPOINT`).

**How PostHog Logs works** (confirmed via PostHog docs, June 2026):
- Endpoint: `https://us.i.posthog.com/i/v1/logs` (OTLP/HTTP).
- Auth: `Authorization: Bearer <phc_project_token>` (or `?token=<phc_...>`).
- **Per-user link:** each log record must carry an OTel **log attribute** named
  **`posthogDistinctId`** (camelCase, lowercase `p`) whose value EXACTLY equals one of the
  person's `distinct_id`s. Our `distinct_id` = `user.id` (set by `identifyUser`). Not
  `distinct_id` / `user_id` / `posthog_distinct_id` — must be `posthogDistinctId` unless we
  configure a custom key. Docs: https://posthog.com/docs/logs/link-person
  and https://posthog.com/docs/logs/installation/nodejs

**Implementation steps:**
1. **Add a PostHog OTLP log pipeline** in `src/core/otel.ts`, alongside the existing
   trace/metric exporters:
   ```ts
   import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
   import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
   // in the NodeSDK config:
   logRecordProcessor: new BatchLogRecordProcessor(
     new OTLPLogExporter({
       url: 'https://us.i.posthog.com/i/v1/logs',
       headers: { Authorization: `Bearer ${config.POSTHOG_PROJECT_TOKEN}` },
     }),
   ),
   ```
   Use `BatchLogRecordProcessor` (not Simple) for throughput. Gate on a flag/env so it's
   off where unwanted.
2. **Bridge pino → OTel logs.** Mirror the existing **Loki multistream** pattern in
   `src/core/logger.ts` (it already adds a Loki stream next to stdout). Add a THIRD stream
   that emits each pino record as an OTel `LogRecord` via `@opentelemetry/api-logs`
   `logger.emit({ severityText, body, attributes })`. (Alternative: the auto-bridge
   `@opentelemetry/instrumentation-pino` — cleaner but less control over attribute mapping;
   we prefer the manual stream for control + to reuse the multistream pattern.)
3. **Stamp `posthogDistinctId` on every log (the key piece).** The pino `mixin()` in
   `logger.ts` already injects `request_id`/`trace_id`/`span_id` from
   `src/core/request-context.ts` (AsyncLocalStorage). Do the same for the user:
   - In `authMiddleware` (`src/http/middleware/auth.ts`), after `req.user` is resolved,
     stash `req.user.id` into the request context (same store `getRequestId()` reads).
   - Add `posthogDistinctId: getRequestUserId()` to the pino `mixin()` return.
   - The bridge (step 2) maps that field onto the OTel log attribute `posthogDistinctId`.
   Result: every backend log written during that user's request appears on their Logs tab.

**Cost & safety (decide before enabling):**
- **Volume/$$:** PostHog Logs is billed by volume. Ship **`warn` + `error` only** to start
  (filter by pino level in the bridge stream); raise to `info` later if useful.
- **PII:** keep pino's existing `redact` (`authorization`, `password`, `access_token`,
  `refresh_token`) on the OTel path too.
- **Don't disturb existing pipes:** this is an ADDITIONAL stream — stdout + Loki stay.
- Add the exporter shutdown to `shutdownPostHog`/SDK shutdown so near-shutdown logs flush.

---

## What we need to resume

| Need | Detail |
|---|---|
| **Project token** | `phc_...` PostHog **project** token (NOT the `phx_...` personal key — that's only for MCP/harness *queries*). It's the same token the frontend uses as `NEXT_PUBLIC_POSTHOG_KEY` (`phc_Ano8NR2C5uyDTj26It89T1XWm7gPsBl6atjyc0dDViL`). Wire as a backend env var, e.g. `POSTHOG_PROJECT_TOKEN`, set in Railway. |
| **Log-level decision** | warn+error (recommended start) vs info+warn+error vs everything. |
| **Logs product enabled** | Confirm the **Logs** product is enabled for the PostHog project. |
| **Env separation** | The user confirmed the affected person is on PROD, so no staging-mixing concern for B/C. If we ever enable FE/BE analytics on staging, stamp `environment` (backend already does on events) or use a separate project. |

## Suggested order when we resume
1. **B** — identify at `getOrCreateFromIdentity` (tiny; fills Properties for everyone).
2. **C (auth lifecycle)** — backend `login_completed` / `signup_completed` /
   `account_deleted` / `pending_deletion_restored`.
3. **D** — pino → PostHog Logs with `posthogDistinctId` via request context
   (needs `phc_` token in env + the volume/level decision).
4. **C (rest)** — `screen_viewed`, commerce, social.

## Key files (for whoever resumes)
- `src/core/otel.ts` — NodeSDK; add `logRecordProcessor` + OTLPLogExporter here.
- `src/core/logger.ts` — pino + `mixin()` + Loki multistream; add the OTel-log stream and
  the `posthogDistinctId` mixin field here.
- `src/core/request-context.ts` — AsyncLocalStorage store; add userId getter/setter.
- `src/http/middleware/auth.ts` — stash `req.user.id` into request context after resolve.
- `src/core/analytics.ts` — existing `identifyUser` / `trackEvent` (AI-suppression aware).
- `src/modules/users/users.service.ts` — `getOrCreateFromIdentity` (B: identify here).
- `src/realtime/services/match-participants.helpers.ts` — current (only) `identifyUser` call.
- `src/lib/analytics/game-events.ts` (frontend) — event catalogue for C.

## References
- Link logs to a person: https://posthog.com/docs/logs/link-person
- Node.js OTLP logs install: https://posthog.com/docs/logs/installation/nodejs
- Logs troubleshooting (person tab empty): https://posthog.com/docs/logs/troubleshooting

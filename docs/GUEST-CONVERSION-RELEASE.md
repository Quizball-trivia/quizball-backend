# Guest conversion tracking — release packet

Prepared 2026-09-21. Backend branch `feat/guest-conversion-analytics`, based on staging `84c185ddf5bf05c7dfa0cadf53bb267789b72a3d`. Web branch with same name is based on staging `d22433c4c07b225df99ad8ec51fa73bbffbf95a0`. Owner authorized the feature → staging → main release on 2026-09-21. Staging and production deployment evidence will be recorded after verification.

Dashboard: https://us.posthog.com/project/307329/dashboard/2118067
11 saved/validated charts plus an explicit awaiting-deployment note. Definitions and chart IDs are also in `/Users/user/dev/quizball/docs/guest-conversion-dashboard.json`.

## Implementation

- Browser retains its existing opaque guest token. Relevant browser game starts/completions feed a separate authenticated guest analytics collector. No raw token is sent to PostHog.
- Guest token is forwarded on auth/provisioning requests. Only the transaction that inserts a real member can mark `signup`; already-existing account authentication is `existing_member`.
- `guest_journeys` stores guest session ID, original multiplayer guest user ID if any, member ID, country/language, first play/game and link type/time. A guest can never be reassigned to another member. Guest-session cleanup does not delete the journey.
- Old `guest_sessions.linked_user_id` is populated too. It is attribution, not an auth grant: old guest credentials continue to authorize only guest play.
- No accounts, wallets, coins, progression or matches are merged or copied.
- Journey events and the signup link commit together. A bounded worker uses row leases across replicas and captureImmediate acknowledgement; failures retry with the original event UUID and timestamp.
- Dedicated PostHog distinct IDs are `guest-journey:<session uuid>`, with person profile creation disabled. They do not create extra registered persons or alter existing signup/DAU charts. No email, raw IP or guest credential enters the new event properties.
- Browser pending events use a bounded per-tab sessionStorage queue (memory fallback when blocked), retry UUIDs, and verified member headers. Account changes cancel/match-check queued member work. Retiring the guest token after successful link prevents subsequent shared-browser visits from reusing a claimed journey.
- Country uses the trusted client IP. Play is persisted before geo lookup; pending events are filled when geo returns. Unavailable geo remains Unknown. No server geolocation is used in PostHog.
- Production-only delivery prevents staging events leaking into the production project. Staging keeps local outbox evidence.

## Metrics and boundaries

- Guest player means a guest browser identity reporting a game start, not a new multiplayer users row and not a guaranteed unique human.
- Conversion means guest play followed by a database-confirmed new member insert on that linked journey. Returning logins are separate.
- Dashboard uses the last 30 days and a 7-day ordered conversion window, Asia/Tbilisi time. Recent cohorts are immature.
- Games are browser-reported starts/completions (nine existing start event families), not independently validated settlements. Anonymous automation/internal guests can be included. Known browser profiles are intentionally not merged into the journey identity.
- Flow shows gameplay/signup/onboarding/member play, including game labels. It does not yet include all page navigation or mobile-app activity.
- Authenticated web play on another browser/device follows the member's stored originating journey. Cross-device signup without possession of the original guest token cannot be inferred.
- Historical links are not guessed. Accounts provisioned by an old client or a path without the guest token have no confirmed signup link. Such later links classify as existing-member authentication, never guessed signup.
- Browser delivery can be missed when a tab closes before token creation/queue persistence, storage is cleared, or the network remains unavailable. Pending browser events expire after 24h and the queue is capped at 100. A play first received after linking is excluded rather than fabricated as pre-signup activity. Server-accepted events have durable retry.
- Durable database records are not automatically purged by the 45-day guest sweeper. Monitor volume and pending queue age. No scheduled recurring external notifications were added.

## Local verification

- Backend TypeScript build passed.
- Auth/guest/user regression suite: 201 tests passed with two workers (integration tier runs separately). A preceding parallel run hit a 5-second import/setup timeout in an existing public-profile test; the bounded-concurrency rerun passed without changing that test.
- Real isolated Postgres: 11 tests passed, including the actual usersRepo.createWithIdentity path, repeated signup, concurrency, expired tokens, guest/bot/deleted member rejection, rollback, country fill, cleanup survival, immutable linkage, multiplayer guest user mapping, RLS/client grants and member play.
- Web focused auth/guest/analytics suite: 81 tests passed. TypeScript and changed-source ESLint passed.
- Every dashboard query validated with PostHog; saved dashboard verified with 11 charts and 1 text note. Results are intentionally empty until deployment.
- No production events were fabricated, no emails sent, and no production account data changed.

Reproduce database tests in a NEW local database named `quizball_guest_journey_*`: apply `tests/guest/guest-journey.fixture.sql`, then the new migration. Set GUEST_JOURNEY_TEST_DATABASE_URL to that database on 127.0.0.1:5432 and run the guest-journey integration test. The test refuses remote/non-test database names.

## Authorized release sequence

1. Review the complete backend/web changes, commit under the owner identity, open feature-to-staging PRs. Merge fresh staging into the feature branch if it moved; review the entire staging-to-main diff, including separately authorized merged work.
2. Backend first: normal runner applies additive migration 20260921070625. Confirm table grants/RLS and backend health. No backfill and no alteration of existing user data beyond linking on future auth.
3. Deploy web staging. Manually exercise: guest mini-game then fresh signup, guest multiplayer then fresh signup, existing-member login, reload/retry, two tabs, logout and a different account, completed onboarding, first member game. Confirm exact database links and outbox events. No production-key override on staging.
4. Verify old/current gameplay and normal signup without a guest still work. Require the PR CI checks and review to pass.
5. Reviewed staging-to-main PRs, backend first then web. Confirm production health, a controlled guest flow and event delivery with the right country, event names and link classification. Keep test identities out of business interpretation; never use real user credentials for smoke tests.
6. Only after ingestion verification remove the dashboard's awaiting-deployment notice and record the exact live start time. Fast-forward staging to merged main, never force push.

## Rollback

Revert the feature through staging then main, web first if necessary. Keep the two additive tables and existing attribution records; the old code ignores them. No database restore or deletion is required. Restarting old code stops the new worker; any undelivered events remain recoverable. Do not clear linked_user_id or delete journeys as part of a code rollback.

## Read-only rollout checks

SELECT link_type, count(*) FROM guest_journeys GROUP BY 1;
SELECT count(*) AS pending, min(occurred_at) AS oldest_pending FROM guest_journey_events WHERE delivered_at IS NULL;
SELECT event, count(*) FROM guest_journey_events GROUP BY 1;
SELECT count(*) FROM guest_journey_events WHERE jsonb_typeof(properties) <> 'object'; -- must be zero
SELECT count(*) FROM guest_journeys WHERE link_type = 'signup' AND linked_at IS NULL; -- must be zero

## Guest Missing XI artwork correction

User reported the public guest landing page showing the teal star fallback. The daily page requests `daily-missingXi`, while the packaged illustration uses `lab-missing-xi`. Added the missing alias in the shared DemoModeArt renderer in the web worktree. It now resolves to the existing `/assets/demos/game-modes/lab-missing-xi.webp`, the same illustration used by the normal Missing XI card/modal, for every locale. Asset inspected; changed-file lint and existing public-games tests passed. Not deployed.
